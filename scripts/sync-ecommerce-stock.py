"""Sincroniza o saldo disponivel por produto e filial com a API do e-commerce."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
import glob
import importlib.util
import os
from pathlib import Path

import oracledb
import requests


STOCK_QUERY = """
SELECT
    p.codprod,
    e.codfilial,
    NVL(e.qtestger, 0) AS estoque_total,
    NVL(e.qtreserv, 0) AS reservado,
    NVL(e.qtbloqueada, 0) AS bloqueado
FROM pcprodut p
JOIN pcest e ON e.codprod = p.codprod
WHERE e.codfilial IN (1, 3)
  AND p.codprod > 0
  AND NVL(UPPER(TRIM(p.obs2)), 'ATIVO') <> 'FL'
  AND NVL(UPPER(TRIM(p.enviarforcavendas)), 'N') = 'S'
ORDER BY e.codfilial, p.codprod
"""


def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Variavel obrigatoria ausente: {name}")
    return value


def initialize_oracle_client() -> None:
    candidates = [
        os.getenv("ORACLE_CLIENT_LIB", ""),
        r"C:\oracle\instantclient_21_19",
        r"C:\oracle\product\10.2.0\client_1\bin",
    ]
    for root in (r"C:\oracle", r"C:\Program Files\Oracle", r"C:\Program Files (x86)\Oracle"):
        candidates.extend(os.path.dirname(path) for path in glob.glob(os.path.join(root, "**", "oci.dll"), recursive=True))
    errors = []
    for candidate in dict.fromkeys(path for path in candidates if path and os.path.isdir(path)):
        try:
            oracledb.init_oracle_client(lib_dir=candidate)
            return
        except Exception as error:  # pragma: no cover - depende do Oracle Client local
            errors.append(str(error))
    raise RuntimeError(f"Oracle Client nao encontrado ou incompativel: {'; '.join(errors[-2:])}")


def number(value) -> float:
    if value is None:
        return 0.0
    if isinstance(value, Decimal):
        return float(value)
    return float(value)


def main() -> None:
    initialize_oracle_client()
    dsn = oracledb.makedsn(
        required("ORACLE_FILIAL_HOST"),
        int(os.getenv("ORACLE_FILIAL_PORT", "1521")),
        service_name=required("ORACLE_FILIAL_SERVICE"),
    )
    with oracledb.connect(
        user=required("ORACLE_FILIAL_USER"),
        password=required("ORACLE_FILIAL_PASSWORD"),
        dsn=dsn,
    ) as connection:
        with connection.cursor() as cursor:
            cursor.arraysize = 5000
            cursor.execute(STOCK_QUERY)
            rows = cursor.fetchall()

    compact_rows = [
        [int(code), int(branch), number(total), number(reserved), number(blocked)]
        for code, branch, total, reserved, blocked in rows
    ]
    minimum = max(1, int(os.getenv("STOCK_SYNC_MIN_COUNT", "100")))
    for branch in (1, 3):
        count = sum(1 for row in compact_rows if row[1] == branch)
        if count < minimum:
            raise RuntimeError(
                f"Carga cancelada: filial {branch} retornou {count} itens; minimo de seguranca e {minimum}."
            )

    snapshot_at = datetime.now().astimezone().isoformat()
    response = requests.post(
        f"{required('ECOMMERCE_API_URL').rstrip('/')}/api/integrations/stocks/sync",
        json={"sourceUpdatedAt": snapshot_at, "stocks": compact_rows},
        headers={"Authorization": f"Bearer {required('ECOMMERCE_PRODUCT_SYNC_TOKEN')}"},
        timeout=(15, 120),
    )
    if not response.ok:
        raise RuntimeError(f"API respondeu HTTP {response.status_code}: {response.text[:500]}")
    result = response.json()
    print(
        "Estoque sincronizado: "
        f"fonte={result.get('sourceCount')}, alterados={result.get('changedCount')}, "
        f"removidos={result.get('removedCount')}, filiais={result.get('branches')}"
    )


def sync_pending_customers() -> None:
    """Libera os precos de clientes recem-cadastrados sem esperar a carga de 30 minutos.

    So consulta o WinThor quando a API informa cliente aprovado ainda sem condicoes
    comerciais; nos demais minutos custa uma unica chamada HTTP.
    """
    base_url = required("ECOMMERCE_API_URL").rstrip("/")
    token = required("ECOMMERCE_PRODUCT_SYNC_TOKEN")
    response = requests.get(
        f"{base_url}/api/integrations/customers/pending",
        headers={"Authorization": f"Bearer {token}"},
        timeout=(15, 30),
    )
    if response.status_code == 404:
        return  # rota ainda nao publicada
    response.raise_for_status()
    pending = response.json().get("externalIds", [])
    if not pending:
        return
    print(f"Clientes novos sem condicoes comerciais: {pending}. Sincronizando agora.")

    spec = importlib.util.spec_from_file_location(
        "sync_ecommerce_winthor", Path(__file__).with_name("sync-ecommerce-winthor.py"),
    )
    catalog = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(catalog)
    dsn = oracledb.makedsn(
        required("ORACLE_FILIAL_HOST"),
        int(os.getenv("ORACLE_FILIAL_PORT", "1521")),
        service_name=required("ORACLE_FILIAL_SERVICE"),
    )
    # Mesma rotina da carga de 30 minutos: condicoes de todos os clientes aprovados e
    # precos de todas as regioes em uso (a carga de precos substitui o conjunto inteiro).
    regions = catalog.sync_customer_conditions(dsn, token)
    catalog.sync_region_prices(dsn, token, set(catalog.DEFAULT_PRICE_REGIONS) | regions)


if __name__ == "__main__":
    main()
    try:
        sync_pending_customers()
    except Exception as error:  # o estoque ja foi gravado; a carga de 30 minutos cobre a falha
        print(f"Aviso: condicoes de clientes novos nao sincronizadas agora: {error}")
