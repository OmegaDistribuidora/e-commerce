"""Extrai produtos ativos do WinThor e envia à API segura do e-commerce."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
import glob
import os
import re

import oracledb
import requests


PRODUCT_QUERY = """
SELECT
    p.codprod,
    p.codfornec,
    NVL(NULLIF(TRIM(f.fantasia), ''), NVL(f.fornecedor, 'Fornecedor ' || TO_CHAR(p.codfornec))) AS fornecedor,
    INITCAP(p.descricao) AS produto,
    p.embalagem,
    p.embalagemmaster,
    p.qtunit,
    p.qtunitcx,
    NVL(p.multiplo, 1) AS multiplo,
    NVL(p.codepto, 0) AS codigo_departamento,
    NVL(d.descricao, '') AS departamento,
    NVL(p.codsec, 0) AS codigo_secao,
    NVL(s.descricao, '') AS secao,
    p.codauxiliar AS ean,
    p.codfab AS codigo_fabricante,
    p.codncmex AS ncm,
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
  -- Nesta versao do WinThor, STATUSPROD e derivado de PCPRODUT.OBS2.
  AND NVL(UPPER(TRIM(p.obs2)), 'ATIVO') <> 'FL'
  -- O catalogo deve conter somente itens liberados para o Forca de Vendas.
  AND NVL(UPPER(TRIM(p.enviarforcavendas)), 'N') = 'S'
ORDER BY p.codprod
"""

# Cobrancas que nao representam divida do cliente e nao consomem limite.
NON_DEBT_BILLING_CODES = ("DESD", "ESTR", "CANC", "DEVP", "DEVT", "BNF", "BNFT", "BNFR", "BNTR", "BNRP", "CRED")
# Pedidos ainda nao faturados: L=liberado, M=montado, B=bloqueado, P=pendente.
OPEN_ORDER_POSITIONS = ("L", "M", "B", "P")
# CONDVENDA 5=bonificacao e 10=transferencia nao geram titulo a receber.
NON_RECEIVABLE_SALE_CONDITIONS = (5, 10)
# Planos oferecidos no e-commerce: ativos (STATUS = 'A') e que não são bonificação/troca (TIPOPRAZO = 'B').
SELLABLE_PLAN_FILTER = "NVL(status, 'X') = 'A' AND NVL(tipoprazo, 'N') <> 'B'"

# Regiões sempre enviadas: preço de referência para cadastros ainda sem condições sincronizadas
# (Varejo usa a região 1 e Redes a região 12).
DEFAULT_PRICE_REGIONS = (1, 12)

# Preços PTABELA1..7 da PCTABPR somente para os produtos do catálogo e as regiões em uso.
REGION_PRICE_QUERY = """
SELECT t.numregiao, t.codprod,
       t.ptabela1, t.ptabela2, t.ptabela3, t.ptabela4, t.ptabela5, t.ptabela6, t.ptabela7
FROM pctabpr t
JOIN pcprodut p ON p.codprod = t.codprod
WHERE t.numregiao IN ({regions})
  AND NVL(t.excluido, 'N') <> 'S'
  AND p.codprod > 0
  AND NVL(UPPER(TRIM(p.obs2)), 'ATIVO') <> 'FL'
  AND NVL(UPPER(TRIM(p.enviarforcavendas)), 'N') = 'S'
"""

SUPPLIER_DISPLAY_NAMES = {
    117: "Bombril S.A.",
}


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


def supplier_display_name(code, value) -> str:
    normalized = re.sub(r"\s+", " ", text(value))
    return SUPPLIER_DISPLAY_NAMES.get(int(code or 0), normalized)


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
            unit_quantity, units_per_box, sales_multiple,
            department_code, department, section_code, section, ean,
            manufacturer_code, ncm,
            retail_price, network_price, price_date,
        ) = row
        retail = round(number(retail_price), 2)
        network = round(number(network_price) or retail, 2)
        products.append({
            "externalId": int(code),
            "supplierId": int(supplier_id or 0),
            "brand": supplier_display_name(supplier_id, supplier),
            "name": text(name),
            "package": text(package),
            "masterPackage": text(master_package),
            "unitsPerBox": max(1, int(number(units_per_box) or number(unit_quantity) or 1)),
            "salesMultiple": max(1, int(number(sales_multiple) or 1)),
            "minBoxes": 1,
            "retailUnitPrice": retail,
            "networkUnitPrice": network,
            "departmentCode": int(department_code or 0),
            "department": text(department),
            "sectionCode": int(section_code or 0),
            "section": text(section),
            "ean": text(ean),
            "manufacturerCode": text(manufacturer_code),
            "ncm": re.sub(r"\D", "", text(ncm)),
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

    token = required("ECOMMERCE_PRODUCT_SYNC_TOKEN")
    customer_regions = sync_customer_conditions(dsn, token)
    sync_region_prices(dsn, token, set(DEFAULT_PRICE_REGIONS) | customer_regions)


def price_value(value):
    if value is None:
        return None
    price = round(number(value), 6)
    return price if price > 0 else None


def sync_region_prices(dsn, token: str, regions: set[int]) -> None:
    region_list = sorted(region for region in regions if region is not None)
    binds = ",".join(f":r{index}" for index in range(len(region_list)))
    with oracledb.connect(
        user=required("ORACLE_FILIAL_USER"),
        password=required("ORACLE_FILIAL_PASSWORD"),
        dsn=dsn,
    ) as connection:
        with connection.cursor() as cursor:
            cursor.arraysize = 5000
            cursor.execute(
                REGION_PRICE_QUERY.format(regions=binds),
                {f"r{index}": region for index, region in enumerate(region_list)},
            )
            rows = [
                [int(region), int(code), *(price_value(value) for value in prices)]
                for region, code, *prices in cursor.fetchall()
            ]

    response = requests.post(
        f"{required('ECOMMERCE_API_URL').rstrip('/')}/api/integrations/prices/sync",
        json={"regions": region_list, "prices": rows},
        headers={"Authorization": f"Bearer {token}"},
        timeout=(15, 180),
    )
    if response.status_code == 404:
        print("Preços por região: rota ainda não publicada na API; envio ignorado nesta execução.")
        return
    if not response.ok:
        raise RuntimeError(f"Preços por região: API respondeu HTTP {response.status_code}: {response.text[:500]}")
    result = response.json()
    print(
        "Preços por região concluídos: "
        f"regiões={result.get('regions')}, fonte={result.get('sourceCount')}, "
        f"alterados={result.get('changedCount')}, removidos={result.get('removedCount')}"
    )


def sync_customer_conditions(dsn, token: str) -> set[int]:
    customer_response = requests.get(
        f"{required('ECOMMERCE_API_URL').rstrip('/')}/api/integrations/customers",
        headers={"Authorization": f"Bearer {token}"},
        timeout=(15, 60),
    )
    customer_response.raise_for_status()
    customer_codes = [int(value) for value in customer_response.json().get("externalIds", []) if int(value) > 0]
    if not customer_codes:
        print("Condições comerciais: nenhum cliente aprovado para sincronizar.")
        return set()

    # Instante da leitura: pedidos vinculados ao WinThor depois dele ainda não estão nos totais abaixo.
    snapshot_at = datetime.now().astimezone().isoformat()
    non_debt_codes = ",".join(f"'{code}'" for code in NON_DEBT_BILLING_CODES)
    open_positions = ",".join(f"'{position}'" for position in OPEN_ORDER_POSITIONS)
    non_receivable_conditions = ",".join(str(value) for value in NON_RECEIVABLE_SALE_CONDITIONS)
    with oracledb.connect(
        user=required("ORACLE_FILIAL_USER"),
        password=required("ORACLE_FILIAL_PASSWORD"),
        dsn=dsn,
    ) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                f"""SELECT codplpag, descricao, numdias, numpr,
                           prazo1, prazo2, prazo3, prazo4, prazo5, prazo6,
                           prazo7, prazo8, prazo9, prazo10, prazo11, prazo12
                    FROM pcplpag
                    WHERE {SELLABLE_PLAN_FILTER}"""
            )
            plan_rows = cursor.fetchall()
            customer_rows = []
            customer_plans = {}
            open_titles = {}
            open_orders = {}
            for offset in range(0, len(customer_codes), 500):
                batch = customer_codes[offset:offset + 500]
                binds = ",".join(f":c{index}" for index in range(len(batch)))
                params = {f"c{index}": code for index, code in enumerate(batch)}
                # Região de preço: NUMREGIAOCLI do cliente ou, se vazia, a região da praça.
                cursor.execute(
                    f"""SELECT c.codcli, NVL(c.limcred, 0), c.codplpag,
                               NVL(NULLIF(c.numregiaocli, 0), pr.numregiao)
                        FROM pcclient c
                        LEFT JOIN pcpraca pr ON pr.codpraca = c.codpraca
                        WHERE c.codcli IN ({binds})""",
                    params,
                )
                customer_rows.extend(cursor.fetchall())
                # Planos liberados por cliente no WinThor.
                cursor.execute(
                    f"""SELECT codcli, codplpag FROM pcplpagcli WHERE codcli IN ({binds})""",
                    params,
                )
                for customer_code, plan_code in cursor.fetchall():
                    customer_plans.setdefault(int(customer_code), []).append(int(plan_code))
                cursor.execute(
                    f"""SELECT codcli, NVL(SUM(valor), 0)
                        FROM pcprest
                        WHERE codcli IN ({binds})
                          AND dtpag IS NULL AND dtcancel IS NULL AND dtestorno IS NULL
                          AND NVL(codcob, ' ') NOT IN ({non_debt_codes})
                        GROUP BY codcli""",
                    params,
                )
                open_titles.update({int(code): number(total) for code, total in cursor.fetchall()})
                cursor.execute(
                    f"""SELECT codcli, NVL(SUM(vltotal), 0)
                        FROM pcpedc
                        WHERE codcli IN ({binds})
                          AND posicao IN ({open_positions}) AND dtcancel IS NULL
                          AND NVL(condvenda, 1) NOT IN ({non_receivable_conditions})
                        GROUP BY codcli""",
                    params,
                )
                open_orders.update({int(code): number(total) for code, total in cursor.fetchall()})

    plan_map = {}
    for row in plan_rows:
        code, description, num_days, price_table, *deadlines = row
        values = [int(number(value)) for value in deadlines if value is not None and number(value) > 0]
        if not values and number(num_days) >= 0:
            values = [int(number(num_days))]
        automatic_label = "/".join(str(value) for value in values) + " dias"
        table = int(number(price_table)) if price_table is not None else 1
        plan_map[int(code)] = {
            "label": text(description) or automatic_label or f"Plano {int(code)}",
            "priceTable": table if 1 <= table <= 7 else 1,
            "days": int(number(num_days)) if num_days is not None else 0,
        }

    conditions = []
    regions = set()
    for code, credit_limit, primary_plan, price_region in customer_rows:
        # PCPLPAGCLI define os planos do cliente; sem linhas nela, vale o plano do PCCLIENT.
        allowed_codes = customer_plans.get(int(code)) or ([int(primary_plan)] if primary_plan is not None else [])
        unique_codes = sorted(
            {value for value in allowed_codes if value in plan_map},
            key=lambda value: (plan_map[value]["days"], value),
        )
        region = int(price_region) if price_region is not None else None
        if region is not None:
            regions.add(region)
        conditions.append({
            "externalId": int(code),
            "creditLimit": round(number(credit_limit), 2),
            "openTitlesAmount": round(max(0.0, open_titles.get(int(code), 0.0)), 2),
            "openOrdersAmount": round(max(0.0, open_orders.get(int(code), 0.0)), 2),
            "priceRegion": region,
            "paymentPlans": [
                {"code": str(value), "label": plan_map[value]["label"], "priceTable": plan_map[value]["priceTable"]}
                for value in unique_codes
            ],
            "sourceUpdatedAt": snapshot_at,
        })

    conditions_response = requests.post(
        f"{required('ECOMMERCE_API_URL').rstrip('/')}/api/integrations/customers/conditions",
        json={"customers": conditions},
        headers={"Authorization": f"Bearer {token}"},
        timeout=(15, 120),
    )
    if not conditions_response.ok:
        raise RuntimeError(
            f"Condições comerciais: API respondeu HTTP {conditions_response.status_code}: "
            f"{conditions_response.text[:500]}"
        )
    print(f"Condições comerciais atualizadas para {conditions_response.json().get('updatedCount', 0)} clientes.")
    return regions


if __name__ == "__main__":
    main()
