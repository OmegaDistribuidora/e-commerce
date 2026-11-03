"""Sincroniza produtos e preços do WinThor pela API HTTPS do e-commerce.

O PostgreSQL do Railway permanece privado. A DAG acessa apenas o site público,
usando um token secreto compartilhado com PRODUCT_SYNC_TOKEN.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal
import logging

import requests
from airflow import DAG
from airflow.hooks.base import BaseHook
from airflow.operators.python import PythonOperator
from airflow.providers.oracle.hooks.oracle import OracleHook


ORACLE_CONN_ID = "oracle_filial"
ECOMMERCE_API_CONN_ID = "ecommerce_api"
RETAIL_REGION = 1
NETWORK_REGION = 12

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
  AND UPPER(TRIM(NVL(p.obs2, ''))) <> 'FL'
ORDER BY p.codprod
"""


def _text(value) -> str:
    return str(value or "").strip()


def _number(value) -> float:
    if value is None:
        return 0.0
    if isinstance(value, Decimal):
        return float(value)
    return float(value)


def _api_credentials() -> tuple[str, str]:
    connection = BaseHook.get_connection(ECOMMERCE_API_CONN_ID)
    base_url = (connection.host or "").strip().rstrip("/")
    if not base_url:
        raise RuntimeError("A Connection ecommerce_api precisa informar a URL do site no campo Host.")
    if not base_url.startswith(("http://", "https://")):
        scheme = connection.schema or "https"
        base_url = f"{scheme}://{base_url}"
        if connection.port:
            base_url = f"{base_url}:{connection.port}"
    token = connection.password or ""
    if not token:
        raise RuntimeError("A Connection ecommerce_api precisa informar o token no campo Password.")
    return base_url, token


def sync_products() -> None:
    logger = logging.getLogger("airflow.task")
    oracle = OracleHook(oracle_conn_id=ORACLE_CONN_ID)
    with oracle.get_conn() as oracle_connection:
        with oracle_connection.cursor() as cursor:
            cursor.execute(
                PRODUCT_QUERY,
                {"retail_region": RETAIL_REGION, "network_region": NETWORK_REGION},
            )
            source_rows = cursor.fetchall()

    products = []
    for row in source_rows:
        (
            code, supplier_id, supplier, name, package, master_package,
            unit_quantity, units_per_box, department, section, ean,
            retail_price, network_price, price_date,
        ) = row
        retail = round(_number(retail_price), 2)
        network = round(_number(network_price) or retail, 2)
        box_units = max(1, int(_number(units_per_box) or _number(unit_quantity) or 1))
        products.append({
            "externalId": int(code),
            "supplierId": int(supplier_id or 0),
            "brand": _text(supplier),
            "name": _text(name),
            "package": _text(package),
            "masterPackage": _text(master_package),
            "unitsPerBox": box_units,
            "minBoxes": 1,
            "retailUnitPrice": retail,
            "networkUnitPrice": network,
            "department": _text(department),
            "section": _text(section),
            "ean": _text(ean),
            "priceDate": price_date.date().isoformat() if isinstance(price_date, datetime) else str(price_date or "") or None,
        })

    if not products:
        raise RuntimeError("O WinThor não retornou produtos ativos; envio cancelado para evitar inativação em massa.")

    base_url, token = _api_credentials()
    endpoint = f"{base_url}/api/integrations/products/sync"
    response = requests.post(
        endpoint,
        json={"source": "WinThor", "products": products},
        headers={"Authorization": f"Bearer {token}"},
        timeout=(15, 180),
    )
    if not response.ok:
        raise RuntimeError(f"API do e-commerce respondeu HTTP {response.status_code}: {response.text[:500]}")
    result = response.json()
    logger.info(
        "Sincronização concluída: fonte=%s, inseridos=%s, alterados=%s, inativados=%s",
        result.get("sourceCount"), result.get("insertedCount"),
        result.get("updatedCount"), result.get("deactivatedCount"),
    )


default_args = {
    "owner": "omega",
    "retries": 2,
    "retry_delay": timedelta(minutes=5),
    "depends_on_past": False,
}

with DAG(
    dag_id="ecommerce_produtos_precos",
    default_args=default_args,
    description="Produtos ativos e preços PCTABPR enviados à API segura do e-commerce",
    schedule_interval="*/30 * * * *",
    start_date=datetime(2026, 1, 1),
    catchup=False,
    tags=["omega", "ecommerce", "winthor", "produtos", "precos"],
    max_active_runs=1,
) as dag:
    PythonOperator(
        task_id="sincronizar_produtos_e_precos",
        python_callable=sync_products,
        pool="postgres_omega",
        execution_timeout=timedelta(minutes=20),
    )
