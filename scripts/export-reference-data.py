"""Exporta um recorte real do DW da Ômega para o seed local do e-commerce.

Nenhuma credencial é copiada: o script apenas importa o config do projeto
Transf_Dados já existente nesta máquina. Em produção, a mesma estrutura pode
ser alimentada por um job de sincronização usando SOURCE_DATABASE_URL.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path

TRANSFER_ROOT = Path(os.environ.get(
    "OMEGA_TRANSFER_ROOT",
    r"C:\Users\POWERBI\OneDrive - omegadistribuidora.com.br\Projetos\Projetos\Transf_Dados",
))
PROJECT_ROOT = Path(__file__).resolve().parents[1]
OUTPUT = PROJECT_ROOT / "server" / "seed-data.json"
PHOTO_DIR = Path(os.environ.get("OMEGA_PRODUCT_PHOTOS", r"C:\Users\POWERBI\Desktop\produtos"))
LOCAL_PRODUCT_DIR = PROJECT_ROOT / "public" / "assets" / "products"
PHOTO_IDS = [15843, 16447, 16448, 16449, 16450, 16451, 17409, 17729, 17730, 18278, 18495, 18743]

sys.path.insert(0, str(TRANSFER_ROOT / "src"))
import config  # type: ignore  # noqa: E402
import psycopg2  # type: ignore  # noqa: E402
from database_helper import get_oracle_conn  # type: ignore  # noqa: E402


def clean_text(value: object) -> str:
    text = str(value or "").strip()
    replacements = {
        "A�ucar": "Açúcar",
        "A�o": "Aço",
        "Tripla��o": "Triplação",
        "Prote�ao": "Proteção",
        "Higienico": "Higiênico",
        "Limao": "Limão",
        "Maca": "Maçã",
    }
    for source, target in replacements.items():
        text = text.replace(source, target)
    return text.replace("�", "")


def catalog_category(name: str, supplier: str, department: str, section: str) -> str:
    haystack = " ".join((name, supplier, department, section)).lower()
    if any(term in haystack for term in ("deterg", "limpol", "bom bril", "bombril", "esponja", "sabao", "sabão", "limpeza", "vinagre")):
        return "Limpeza"
    if any(term in haystack for term in ("papel hig", "absorvente", "fralda", "higiene", "mili", "shampoo")):
        return "Higiene"
    if any(term in haystack for term in ("acucar", "açúcar", "azeite", "cafe", "café", "arroz", "feijao", "feijão", "farinha", "molho", "massa", "alimento", "bebida", "leite", "biscoito")):
        return "Alimentos"
    return "Utilidades"


def json_value(value: object):
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, date):
        return value.isoformat()
    return value


query = """
WITH weekly AS (
    SELECT codprod,
           SUM(qt) AS weekly_units,
           SUM(venda) AS weekly_revenue
    FROM filial.fvendas
    WHERE data >= CURRENT_DATE - INTERVAL '6 days'
      AND posicao = 'F'
    GROUP BY codprod
), stock AS (
    SELECT codprod, SUM(GREATEST(COALESCE(estoque, 0), 0)) AS stock_units
    FROM filial.festoque
    GROUP BY codprod
)
SELECT p.codprod, p.codfornec, p.fornecedor, p.produto, p.embalagem,
       p.embalagemmaster, p.qtunit, p.qtunitcx, p.departamento,
       p.secao, p.categoria, p.ean, p.statusprod,
       COALESCE(w.weekly_units, 0), COALESCE(w.weekly_revenue, 0),
       COALESCE(s.stock_units, 0)
FROM filial.dproduto p
LEFT JOIN weekly w USING (codprod)
LEFT JOIN stock s USING (codprod)
WHERE p.statusprod = 'Ativo'
  AND p.codprod > 0
ORDER BY (p.codprod = ANY(%s)) DESC,
         COALESCE(w.weekly_units, 0) DESC,
         p.codprod
LIMIT 180
"""


def load_winthor_prices(product_codes: list[int]) -> dict[int, dict[int, dict[str, object]]]:
    """Carrega o preço vigente da PCTABPR para Varejo (região 1) e Redes (região 12)."""
    if not product_codes:
        return {}

    placeholders = ",".join(f":code{index}" for index in range(len(product_codes)))
    binds = {f"code{index}": code for index, code in enumerate(product_codes)}
    connection = get_oracle_conn()
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                f"""
                SELECT codprod, numregiao, pvenda, dtultaltpvenda
                FROM pctabpr
                WHERE codprod IN ({placeholders})
                  AND numregiao IN (1, 12)
                  AND NVL(excluido, 'N') <> 'S'
                  AND NVL(pvenda, 0) > 0
                """,
                binds,
            )
            prices: dict[int, dict[int, dict[str, object]]] = {}
            for code, region, price, updated_at in cursor.fetchall():
                prices.setdefault(int(code), {})[int(region)] = {
                    "price": float(price),
                    "updatedAt": updated_at,
                }
            return prices
    finally:
        connection.close()


def main() -> None:
    connection = psycopg2.connect(**config.POSTGRES_CONFIG)
    try:
        with connection.cursor() as cursor:
            cursor.execute(query, (PHOTO_IDS,))
            rows = cursor.fetchall()
            cursor.execute("SELECT MAX(data) FROM filial.fvendas")
            sales_reference_date = cursor.fetchone()[0]
    finally:
        connection.close()

    winthor_prices = load_winthor_prices([int(row[0]) for row in rows])

    photo_extensions = {}
    for directory in (PHOTO_DIR, LOCAL_PRODUCT_DIR):
        if directory.exists():
            photo_extensions.update({
                int(path.stem): path.suffix.lower()
                for path in directory.iterdir()
                if path.is_file() and path.stem.isdigit()
            })

    products = []
    sales = []
    for row in rows:
        (
            code, supplier_code, supplier, name, package, master_package,
            unit_quantity, units_per_box, department, section, source_category,
            ean, status, weekly_units, weekly_revenue, stock_units,
        ) = row

        retail = winthor_prices.get(int(code), {}).get(1)
        network = winthor_prices.get(int(code), {}).get(12) or retail
        if not retail:
            continue
        retail_price = round(float(retail["price"]), 2)
        network_price = round(float(network["price"]), 2)

        name = clean_text(name)
        supplier = clean_text(supplier)
        department = clean_text(department)
        section = clean_text(section)
        extension = photo_extensions.get(int(code))
        image = f"/assets/products/{code}{extension}" if extension else None
        box_units = max(1, int(units_per_box or unit_quantity or 1))

        products.append({
            "externalId": int(code),
            "supplierId": int(supplier_code or 0),
            "brand": supplier,
            "name": name,
            "package": clean_text(package),
            "masterPackage": clean_text(master_package),
            "unitsPerBox": box_units,
            "minBoxes": 1,
            "unitPrice": retail_price,
            "listUnitPrice": retail_price,
            "retailUnitPrice": retail_price,
            "networkUnitPrice": network_price,
            "department": department,
            "section": section,
            "sourceCategory": clean_text(source_category),
            "category": catalog_category(name, supplier, department, section),
            "ean": clean_text(ean),
            "stockUnits": float(stock_units or 0),
            "image": image,
            "active": status == "Ativo",
            "priceDate": json_value(retail["updatedAt"]),
            "priceSource": "PCTABPR",
            "retailPriceRegion": 1,
            "networkPriceRegion": 12,
        })
        if weekly_units and float(weekly_units) > 0:
            sales.append({
                "externalProductId": int(code),
                "soldAt": json_value(sales_reference_date),
                "quantity": float(weekly_units),
                "revenue": float(weekly_revenue or 0),
            })

    payload = {
        "source": "Filial",
        "exportedAt": date.today().isoformat(),
        "salesReferenceDate": json_value(sales_reference_date),
        "priceSource": "PCTABPR",
        "priceRegions": {"retail": 1, "network": 12},
        "products": products,
        "sales": sales,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Exportados {len(products)} produtos ativos e {len(sales)} agregados de venda para {OUTPUT}")


if __name__ == "__main__":
    main()
