"""Sincroniza produtos e preços do WinThor com o e-commerce da Ômega.

Connections necessárias no Airflow:
- oracle_filial: Oracle do WinThor
- postgres_ecommerce: PostgreSQL público do serviço Railway
"""

from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal
import logging

from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.providers.oracle.hooks.oracle import OracleHook
from airflow.providers.postgres.hooks.postgres import PostgresHook
from psycopg2.extras import execute_values


ORACLE_CONN_ID = "oracle_filial"
ECOMMERCE_CONN_ID = "postgres_ecommerce"
COMPANY = "Filial"
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


def _category(name: str, supplier: str, department: str, section: str) -> str:
    value = " ".join((name, supplier, department, section)).lower()
    if any(term in value for term in ("deterg", "limpol", "bom bril", "bombril", "esponja", "sabao", "sabão", "limpeza", "vinagre")):
        return "Limpeza"
    if any(term in value for term in ("papel hig", "absorvente", "fralda", "higiene", "mili", "shampoo")):
        return "Higiene"
    if any(term in value for term in ("acucar", "açúcar", "azeite", "cafe", "café", "arroz", "feijao", "feijão", "farinha", "molho", "massa", "alimento", "bebida", "leite", "biscoito")):
        return "Alimentos"
    return "Utilidades"


def sync_products() -> None:
    logger = logging.getLogger("airflow.task")
    oracle = OracleHook(oracle_conn_id=ORACLE_CONN_ID)
    target = PostgresHook(postgres_conn_id=ECOMMERCE_CONN_ID)

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
        name = _text(name)
        supplier = _text(supplier)
        department = _text(department)
        section = _text(section)
        retail = round(_number(retail_price), 2)
        network = round(_number(network_price) or retail, 2)
        box_units = max(1, int(_number(units_per_box) or _number(unit_quantity) or 1))
        products.append((
            COMPANY, int(code), int(supplier_id or 0), supplier, name,
            _text(package), _text(master_package), box_units, 1,
            retail, retail, retail, network, department, section, "",
            _category(name, supplier, department, section), _text(ean), True,
            price_date.date() if isinstance(price_date, datetime) else price_date,
        ))

    if not products:
        raise RuntimeError("O WinThor não retornou produtos ativos; sincronização cancelada para evitar inativação em massa.")

    connection = target.get_conn()
    try:
        connection.autocommit = False
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(hashtext('omega_ecommerce_product_sync'))")
            cursor.execute(
                """CREATE TEMP TABLE ecommerce_product_stage (
                    company VARCHAR(40), external_id INTEGER, supplier_id INTEGER, brand TEXT,
                    name TEXT, package TEXT, master_package TEXT, units_per_box INTEGER,
                    min_boxes INTEGER, unit_price NUMERIC(14,2), list_unit_price NUMERIC(14,2),
                    retail_unit_price NUMERIC(14,2), network_unit_price NUMERIC(14,2),
                    department TEXT, section TEXT, source_category TEXT, category VARCHAR(40),
                    ean TEXT, active BOOLEAN, price_date DATE
                ) ON COMMIT DROP"""
            )
            execute_values(
                cursor,
                "INSERT INTO ecommerce_product_stage VALUES %s",
                products,
                page_size=1000,
            )
            cursor.execute(
                """SELECT COUNT(*) FROM ecommerce_product_stage s
                   LEFT JOIN products p ON p.company=s.company AND p.external_id=s.external_id
                   WHERE p.id IS NULL"""
            )
            inserted = cursor.fetchone()[0]
            cursor.execute(
                """SELECT COUNT(*) FROM ecommerce_product_stage s
                   JOIN products p ON p.company=s.company AND p.external_id=s.external_id
                   WHERE ROW(p.supplier_id,p.brand,p.name,p.package,p.master_package,p.units_per_box,
                             p.min_boxes,p.unit_price,p.list_unit_price,p.retail_unit_price,
                             p.network_unit_price,p.department,p.section,p.source_category,
                             p.category,p.ean,p.active,p.price_date)
                     IS DISTINCT FROM
                         ROW(s.supplier_id,s.brand,s.name,s.package,s.master_package,s.units_per_box,
                             s.min_boxes,s.unit_price,s.list_unit_price,s.retail_unit_price,
                             s.network_unit_price,s.department,s.section,s.source_category,
                             s.category,s.ean,s.active,s.price_date)"""
            )
            updated = cursor.fetchone()[0]
            cursor.execute(
                """SELECT COUNT(*) FROM products p
                   WHERE p.company=%s AND p.active=TRUE
                     AND NOT EXISTS (
                       SELECT 1 FROM ecommerce_product_stage s
                       WHERE s.company=p.company AND s.external_id=p.external_id
                     )""",
                (COMPANY,),
            )
            deactivated = cursor.fetchone()[0]
            cursor.execute(
                """INSERT INTO products (
                     company,external_id,supplier_id,brand,name,package,master_package,
                     units_per_box,min_boxes,unit_price,list_unit_price,retail_unit_price,
                     network_unit_price,department,section,source_category,category,ean,active,price_date
                   ) SELECT * FROM ecommerce_product_stage
                   ON CONFLICT (company,external_id) DO UPDATE SET
                     supplier_id=EXCLUDED.supplier_id, brand=EXCLUDED.brand, name=EXCLUDED.name,
                     package=EXCLUDED.package, master_package=EXCLUDED.master_package,
                     units_per_box=EXCLUDED.units_per_box, min_boxes=EXCLUDED.min_boxes,
                     unit_price=EXCLUDED.unit_price, list_unit_price=EXCLUDED.list_unit_price,
                     retail_unit_price=EXCLUDED.retail_unit_price,
                     network_unit_price=EXCLUDED.network_unit_price,
                     department=EXCLUDED.department, section=EXCLUDED.section,
                     source_category=EXCLUDED.source_category, category=EXCLUDED.category,
                     ean=EXCLUDED.ean, active=TRUE, price_date=EXCLUDED.price_date,
                     updated_at=CURRENT_TIMESTAMP
                   WHERE ROW(products.supplier_id,products.brand,products.name,products.package,
                             products.master_package,products.units_per_box,products.min_boxes,
                             products.unit_price,products.list_unit_price,products.retail_unit_price,
                             products.network_unit_price,products.department,products.section,
                             products.source_category,products.category,products.ean,
                             products.active,products.price_date)
                     IS DISTINCT FROM
                         ROW(EXCLUDED.supplier_id,EXCLUDED.brand,EXCLUDED.name,EXCLUDED.package,
                             EXCLUDED.master_package,EXCLUDED.units_per_box,EXCLUDED.min_boxes,
                             EXCLUDED.unit_price,EXCLUDED.list_unit_price,EXCLUDED.retail_unit_price,
                             EXCLUDED.network_unit_price,EXCLUDED.department,EXCLUDED.section,
                             EXCLUDED.source_category,EXCLUDED.category,EXCLUDED.ean,
                             EXCLUDED.active,EXCLUDED.price_date)"""
            )
            cursor.execute(
                """UPDATE products p SET active=FALSE, updated_at=CURRENT_TIMESTAMP
                   WHERE p.company=%s AND p.active=TRUE
                     AND NOT EXISTS (
                       SELECT 1 FROM ecommerce_product_stage s
                       WHERE s.company=p.company AND s.external_id=p.external_id
                     )""",
                (COMPANY,),
            )
            cursor.execute(
                """INSERT INTO product_sync_runs
                     (finished_at,source_count,inserted_count,updated_count,deactivated_count,status,details)
                   VALUES (CURRENT_TIMESTAMP,%s,%s,%s,%s,'success',%s)""",
                (len(products), inserted, updated, deactivated, f"PCTABPR regiões {RETAIL_REGION}/{NETWORK_REGION}"),
            )
        connection.commit()
        logger.info(
            "Sincronização concluída: fonte=%s, inseridos=%s, alterados=%s, inativados=%s",
            len(products), inserted, updated, deactivated,
        )
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


default_args = {
    "owner": "omega",
    "retries": 2,
    "retry_delay": timedelta(minutes=5),
    "depends_on_past": False,
}

with DAG(
    dag_id="ecommerce_produtos_precos",
    default_args=default_args,
    description="Sincronização incremental de produtos ativos e preços PCTABPR",
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
