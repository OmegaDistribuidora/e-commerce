"""Extrai produtos ativos do WinThor e envia à API segura do e-commerce."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
import glob
import os

import oracledb
import requests


PRODUCT_QUERY = """
SELECT
    p.codprod,
    p.codfornec,
    NVL(f.fornecedor, 'Fornecedor ' || TO_CHAR(p.codfornec)) AS fornecedor,
    INITCAP(p.descricao) AS produto,
    p.embalagem,
    p.embalagemmaster,
    p.qtunit,
    p.qtunitcx,
    NVL(p.multiplo, 1) AS multiplo,
    NVL(d.descricao, '') AS departamento,
    NVL(s.descricao, '') AS secao,
    p.codauxiliar AS ean,
    NVL(v.pvenda, 0) AS preco_varejo,
    NVL(r.pvenda, v.pvenda) AS preco_redes,
    GREATEST(
        NVL(v.dtultaltpvenda, DATE '1900-01-01'),
        NVL(r.dtultaltpvenda, DATE '1900-01-01')
    ) AS data_preco
FROM pcprodut p
LEFT JOIN pcfornec f ON f.codfornec = p.codfornec
LEFT JOIN pcdepto d ON d.codepto = p.codepto
LEFT JOIN pcsecao s ON s.codsec = p.codsec
LEFT JOIN pctabpr v
       ON v.codprod = p.codprod
      AND v.numregiao = :retail_region
      AND NVL(v.excluido, 'N') <> 'S'
LEFT JOIN pctabpr r
       ON r.codprod = p.codprod
      AND r.numregiao = :network_region
      AND NVL(r.excluido, 'N') <> 'S'
WHERE p.codprod > 0
  AND NVL(UPPER(TRIM(p.statusprod)), 'ATIVO') <> 'FL'
ORDER BY p.codprod
"""


def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Variável obrigatória ausente: {name}")
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
    raise RuntimeError(f"Oracle Client não encontrado ou incompatível: {'; '.join(errors[-2:])}")


def number(value) -> float:
    if value is None:
        return 0.0
    if isinstance(value, Decimal):
        return float(value)
    return float(value)


def text(value) -> str:
    return str(value or "").strip()


def iso_date(value) -> str | None:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value).strip() or None if value is not None else None


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
            cursor.execute(PRODUCT_QUERY, {"retail_region": 1, "network_region": 12})
            rows = cursor.fetchall()

    minimum = max(1, int(os.getenv("PRODUCT_SYNC_MIN_COUNT", "100")))
    if len(rows) < minimum:
        raise RuntimeError(f"Carga cancelada: WinThor retornou {len(rows)} produtos; mínimo de segurança é {minimum}.")

    products = []
    for row in rows:
        (
            code, supplier_id, supplier, name, package, master_package,
            unit_quantity, units_per_box, sales_multiple, department, section, ean,
            retail_price, network_price, price_date,
        ) = row
        retail = round(number(retail_price), 2)
        network = round(number(network_price) or retail, 2)
        products.append({
            "externalId": int(code),
            "supplierId": int(supplier_id or 0),
            "brand": text(supplier),
            "name": text(name),
            "package": text(package),
            "masterPackage": text(master_package),
            "unitsPerBox": max(1, int(number(units_per_box) or number(unit_quantity) or 1)),
            "salesMultiple": max(1, int(number(sales_multiple) or 1)),
            "minBoxes": 1,
            "retailUnitPrice": retail,
            "networkUnitPrice": network,
            "department": text(department),
            "section": text(section),
            "ean": text(ean),
            "priceDate": iso_date(price_date),
        })

    endpoint = f"{required('ECOMMERCE_API_URL').rstrip('/')}/api/integrations/products/sync"
    response = requests.post(
        endpoint,
        json={"source": "WinThor", "products": products},
        headers={"Authorization": f"Bearer {required('ECOMMERCE_PRODUCT_SYNC_TOKEN')}"},
        timeout=(15, 180),
    )
    if not response.ok:
        raise RuntimeError(f"API respondeu HTTP {response.status_code}: {response.text[:500]}")
    result = response.json()
    print(
        "Sincronização concluída: "
        f"fonte={result.get('sourceCount')}, inseridos={result.get('insertedCount')}, "
        f"alterados={result.get('updatedCount')}, inativados={result.get('deactivatedCount')}"
    )


if __name__ == "__main__":
    main()
