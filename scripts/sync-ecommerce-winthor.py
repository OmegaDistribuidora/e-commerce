"""Extrai produtos ativos do WinThor e envia à API segura do e-commerce."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
import argparse
import glob
import hashlib
import json
import os
from pathlib import Path
import re

import oracledb
import requests


PRODUCT_QUERY = """
SELECT
    p.codprod,
    p.codfornec,
    NVL(NULLIF(TRIM(f.fantasia), ''), 'Fornecedor ' || TO_CHAR(p.codfornec)) AS fornecedor,
    INITCAP(p.descricao) AS produto,
    p.embalagem,
    p.embalagemmaster,
    p.qtunit,
    p.qtunitcx,
    NVL(p.multiplo, 1) AS multiplo,
    pf1.multiplo AS multiplo_filial_1,
    pf3.multiplo AS multiplo_filial_3,
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
LEFT JOIN pcprodfilial pf1 ON pf1.codprod = p.codprod AND pf1.codfilial = '1'
LEFT JOIN pcprodfilial pf3 ON pf3.codprod = p.codprod AND pf3.codfilial = '3'
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
  AND NVL(UPPER(TRIM(p.enviaecommerce)), 'N') = 'S'
ORDER BY p.codprod
"""

# Pedidos distintos por produto nos ultimos 30 dias (todas as filiais), usados para ordenar o
# catalogo do e-commerce. Ignora pedidos cancelados, bonificacao (5) e transferencia (10).
ORDERS_LAST_30_DAYS_QUERY = """
SELECT i.codprod, COUNT(DISTINCT i.numped) AS pedidos
FROM pcpedi i
JOIN pcpedc c ON c.numped = i.numped
WHERE c.data >= TRUNC(SYSDATE) - 30
  AND c.dtcancel IS NULL
  AND NVL(c.posicao, ' ') <> 'C'
  AND NVL(c.condvenda, 1) NOT IN (5, 10)
GROUP BY i.codprod
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
  AND NVL(UPPER(TRIM(p.enviaecommerce)), 'N') = 'S'
"""

STATE_DIR = Path(os.getenv('ECOMMERCE_SYNC_STATE_DIR', str(Path(__file__).resolve().parent.parent / '.sync-state')))


def row_hash(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def read_state(name: str) -> dict[str, str]:
    try:
        return json.loads((STATE_DIR / f'{name}.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def write_state(name: str, values: dict[str, str]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    target = STATE_DIR / f'{name}.json'
    temporary = STATE_DIR / f'{name}.{os.getpid()}.tmp'
    temporary.write_text(json.dumps(values, separators=(',', ':')), encoding='utf-8')
    os.replace(temporary, target)

def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Variável obrigatória ausente: {name}")
    return value


def digits(value: object, maximum: int = 14) -> str:
    return re.sub(r"\D", "", str(value or ""))[:maximum]


def official_email(*values: object) -> str:
    for value in values:
        for candidate in re.split(r"[;,\s]+", str(value or "")):
            normalized = candidate.strip().lower()
            if re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", normalized):
                return normalized[:180]
    return ""


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


def supplier_display_name(value) -> str:
    normalized = re.sub(r"\s+", " ", text(value))
    return normalized.lower().title()


def iso_date(value) -> str | None:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value).strip() or None if value is not None else None


def main(mode: str = 'full') -> None:
    full = mode == 'full'
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
            orders_last_30_days = {}
            if full:
                cursor.execute(ORDERS_LAST_30_DAYS_QUERY)
                orders_last_30_days = {int(code): int(total) for code, total in cursor.fetchall()}

    minimum = max(1, int(os.getenv("PRODUCT_SYNC_MIN_COUNT", "100")))
    if len(rows) < minimum:
        raise RuntimeError(f"Carga cancelada: WinThor retornou {len(rows)} produtos; mínimo de segurança é {minimum}.")

    products = []
    for row in rows:
        (
            code, supplier_id, supplier, name, package, master_package,
            unit_quantity, units_per_box, sales_multiple, sales_multiple_branch_1, sales_multiple_branch_3,
            department_code, department, section_code, section, ean,
            manufacturer_code, ncm,
            retail_price, network_price, price_date,
        ) = row
        retail = round(number(retail_price), 2)
        network = round(number(network_price) or retail, 2)
        products.append({
            "externalId": int(code),
            "supplierId": int(supplier_id or 0),
            "brand": supplier_display_name(supplier),
            "name": text(name),
            "package": text(package),
            "masterPackage": text(master_package),
            "unitsPerBox": max(1, int(number(units_per_box) or number(unit_quantity) or 1)),
            "salesMultiple": max(1, int(number(sales_multiple) or 1)),
            # Zero indica que a filial não tem múltiplo próprio; a API usa o cadastro geral.
            "salesMultipleBranch1": max(1, int(number(sales_multiple_branch_1))) if sales_multiple_branch_1 is not None else 0,
            "salesMultipleBranch3": max(1, int(number(sales_multiple_branch_3))) if sales_multiple_branch_3 is not None else 0,
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
            "ordersLast30Days": orders_last_30_days.get(int(code), 0),
        })

    # As tabelas auxiliares podem devolver mais de uma linha por codigo.
    # A API ja usava a ultima; repetir a regra aqui evita falsos deltas.
    products = list({p['externalId']: p for p in products}.values())
    product_state = {str(p['externalId']): row_hash({k: v for k, v in p.items() if k != 'ordersLast30Days'}) for p in products}
    previous = read_state('products')
    changed_products = products if full else [p for p in products if previous.get(str(p['externalId'])) != product_state[str(p['externalId'])]]
    if changed_products:
        endpoint = f"{required('ECOMMERCE_API_URL').rstrip('/')}/api/integrations/products/sync"
        response = requests.post(
            endpoint,
            json={"source": "WinThor", "mode": mode, "products": changed_products},
            headers={"Authorization": f"Bearer {required('ECOMMERCE_PRODUCT_SYNC_TOKEN')}"},
            timeout=(15, 180),
        )
        if not response.ok:
            raise RuntimeError(f"API respondeu HTTP {response.status_code}: {response.text[:500]}")
        result = response.json()
        print(f"Produtos ({mode}): fonte={len(products)}, enviados={len(changed_products)}, "
              f"inseridos={result.get('insertedCount')}, alterados={result.get('updatedCount')}, "
              f"inativados={result.get('deactivatedCount')}")
        write_state('products', product_state)
    else:
        print(f"Produtos ({mode}): {len(products)} conferidos, nenhuma alteracao enviada.")

    token = required("ECOMMERCE_PRODUCT_SYNC_TOKEN")
    customer_regions = sync_customer_conditions(dsn, token)
    sync_region_prices(dsn, token, set(DEFAULT_PRICE_REGIONS) | customer_regions, mode=mode)
    if full:
        write_state('schedule', {'lastFull': datetime.now().astimezone().isoformat()})


def price_value(value):
    if value is None:
        return None
    price = round(number(value), 6)
    return price if price > 0 else None


def sync_region_prices(dsn, token: str, regions: set[int], mode: str = 'full') -> None:
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
    rows = list({(row[0], row[1]): row for row in rows}.values())

    minimum = max(1, int(os.getenv('PRODUCT_SYNC_MIN_COUNT', '100')))
    counts = {region: 0 for region in region_list}
    for row in rows:
        counts[row[0]] += 1
    if len(rows) < minimum or any(count == 0 for count in counts.values()):
        raise RuntimeError(f'Carga de precos incompleta: contagens por regiao {counts}')
    price_state = {f'{row[0]}:{row[1]}': row_hash(row) for row in rows}
    previous = read_state('prices')
    changed_rows = rows if mode == 'full' else [row for row in rows if previous.get(f'{row[0]}:{row[1]}') != price_state[f'{row[0]}:{row[1]}']]
    if not changed_rows:
        print(f'Precos ({mode}): {len(rows)} conferidos, nenhuma alteracao enviada.')
        return

    response = requests.post(
        f"{required('ECOMMERCE_API_URL').rstrip('/')}/api/integrations/prices/sync",
        json={"mode": mode, "regions": region_list, "prices": changed_rows},
        headers={"Authorization": f"Bearer {token}"},
        timeout=(15, 180),
    )
    if response.status_code == 404:
        print("Preços por região: rota ainda não publicada na API; envio ignorado nesta execução.")
        return
    if not response.ok:
        raise RuntimeError(f"Preços por região: API respondeu HTTP {response.status_code}: {response.text[:500]}")
    result = response.json()
    write_state('prices', price_state)
    print(
        f"Precos ({mode}): regioes={result.get('regions')}, fonte={len(rows)}, enviados={len(changed_rows)}, "
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
            customer_restricted_suppliers = {}
            plaza_restricted_suppliers = {}
            for offset in range(0, len(customer_codes), 500):
                batch = customer_codes[offset:offset + 500]
                binds = ",".join(f":c{index}" for index in range(len(batch)))
                params = {f"c{index}": code for index, code in enumerate(batch)}
                # Região de preço: NUMREGIAOCLI do cliente ou, se vazia, a região da praça.
                cursor.execute(
                    f"""SELECT c.codcli, NVL(c.limcred, 0), c.codplpag,
                               NVL(NULLIF(c.numregiaocli, 0), pr.numregiao), c.codpraca,
                               COALESCE(
                                 CASE WHEN TRIM(TO_CHAR(c.codfilialestoque)) IN ('1','3') THEN TRIM(TO_CHAR(c.codfilialestoque)) END,
                                 CASE WHEN TRIM(TO_CHAR(c.codfilialnf)) IN ('1','3') THEN TRIM(TO_CHAR(c.codfilialnf)) END,
                                 CASE WHEN TRIM(TO_CHAR(u.codfilial)) IN ('1','3') THEN TRIM(TO_CHAR(u.codfilial)) END,
                                 (SELECT MAX(TRIM(TO_CHAR(ped.codfilial))) KEEP (DENSE_RANK LAST ORDER BY ped.data, ped.numped)
                                    FROM pcpedc ped
                                   WHERE ped.codcli=c.codcli AND ped.codfilial IN ('1','3'))
                               ) AS filial_estoque,
                               CASE WHEN NVL(UPPER(TRIM(c.bloqueio)), 'S') = 'N' THEN 0 ELSE 1 END AS bloqueado,
                               CASE WHEN NVL(UPPER(TRIM(c.validarmultiplovenda)), 'S') IN ('S','SIM','Y') THEN 1 ELSE 0 END AS permite_multiplo,
                               c.cgcent, c.cliente, c.fantasia, c.email, c.emailnfe,
                               c.telent, c.telcom, c.telcob, c.cepent, c.enderent,
                               c.numeroent, c.complementoent, c.bairroent, c.municent,
                               c.estent, c.codrede
                        FROM pcclient c
                        LEFT JOIN pcpraca pr ON pr.codpraca = c.codpraca
                        LEFT JOIN pcusuari u ON u.codusur = c.codusur1
                        WHERE c.codcli IN ({binds})""",
                    params,
                )
                batch_customer_rows = cursor.fetchall()
                customer_rows.extend(batch_customer_rows)
                plaza_codes = sorted({int(row[4]) for row in batch_customer_rows if row[4] is not None})
                restriction_params = dict(params)
                restriction_filters = [f"codcli IN ({binds})"]
                if plaza_codes:
                    plaza_binds = ",".join(f":p{index}" for index in range(len(plaza_codes)))
                    restriction_params.update({f"p{index}": code for index, code in enumerate(plaza_codes)})
                    restriction_filters.append(f"codpraca IN ({plaza_binds})")
                cursor.execute(
                    f"""SELECT codcli, codpraca, codfornec
                        FROM pcrestricaovenda
                        WHERE codfornec IS NOT NULL
                          AND ({' OR '.join(restriction_filters)})""",
                    restriction_params,
                )
                for restricted_customer, restricted_plaza, restricted_supplier in cursor.fetchall():
                    supplier_code = int(restricted_supplier)
                    if restricted_customer is not None:
                        customer_restricted_suppliers.setdefault(int(restricted_customer), set()).add(supplier_code)
                    elif restricted_plaza is not None:
                        plaza_restricted_suppliers.setdefault(int(restricted_plaza), set()).add(supplier_code)
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
    for row in customer_rows:
        (code, credit_limit, primary_plan, price_region, plaza_code, stock_branch, is_blocked, allow_sales_multiple,
         document, legal_name, trade_name, email, email_nfe, phone_delivery, phone_commercial,
         phone_billing, postal_code, address_line, address_number, address_complement,
         neighborhood, city, state, network_code) = row
        # PCPLPAGCLI define os planos do cliente; sem linhas nela, vale o plano do PCCLIENT.
        allowed_codes = customer_plans.get(int(code)) or ([int(primary_plan)] if primary_plan is not None else [])
        unique_codes = sorted(
            {value for value in allowed_codes if value in plan_map},
            key=lambda value: (plan_map[value]["days"], value),
        )
        region = int(price_region) if price_region is not None else None
        if region is not None:
            regions.add(region)
        restricted_suppliers = set(customer_restricted_suppliers.get(int(code), set()))
        if plaza_code is not None:
            restricted_suppliers.update(plaza_restricted_suppliers.get(int(plaza_code), set()))
        conditions.append({
            "externalId": int(code),
            "document": digits(document),
            "personType": "CPF" if len(digits(document)) == 11 else "CNPJ",
            "legalName": text(legal_name),
            "tradeName": text(trade_name),
            "phone": digits(phone_delivery or phone_commercial or phone_billing, 11),
            "email": official_email(email, email_nfe),
            "postalCode": digits(postal_code, 8),
            "addressLine": text(address_line),
            "addressNumber": text(address_number),
            "addressComplement": text(address_complement),
            "neighborhood": text(neighborhood),
            "city": text(city),
            "state": text(state).upper()[:2],
            "salesChannel": "Varejo" if int(number(network_code)) == 31 else "Redes",
            "creditLimit": round(number(credit_limit), 2),
            "openTitlesAmount": round(max(0.0, open_titles.get(int(code), 0.0)), 2),
            "openOrdersAmount": round(max(0.0, open_orders.get(int(code), 0.0)), 2),
            "priceRegion": region,
            "stockBranch": int(stock_branch) if stock_branch is not None and int(stock_branch) in (1, 3) else None,
            "isBlocked": bool(is_blocked),
            "allowSalesMultiple": bool(allow_sales_multiple),
            "restrictedSupplierIds": sorted(restricted_suppliers),
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
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=('full', 'delta', 'auto'), default='full')
    selected = parser.parse_args().mode
    if selected == 'auto':
        last_full = read_state('schedule').get('lastFull')
        try:
            age_seconds = (datetime.now().astimezone() - datetime.fromisoformat(last_full)).total_seconds()
        except (TypeError, ValueError):
            age_seconds = float('inf')
        selected = 'full' if age_seconds >= 6 * 60 or age_seconds < 0 else 'delta'
    main(selected)
