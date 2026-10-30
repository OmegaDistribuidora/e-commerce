import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { newDb } from 'pg-mem'
import { hashPassword } from './auth.js'

const { Pool: PostgresPool } = pg
const seedUrl = new URL('./seed-data.json', import.meta.url)
const schemaUrl = new URL('./schema.sql', import.meta.url)

function createPool() {
  if (process.env.DATABASE_URL) {
    return new PostgresPool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined,
      max: 10,
    })
  }

  const memoryDb = newDb({ autoCreateForeignKeyIndices: true })
  memoryDb.public.registerFunction({ name: 'current_database', returns: 'text', implementation: () => 'omega_memory' })
  const adapter = memoryDb.adapters.createPg()
  console.info('[db] DATABASE_URL ausente: usando PostgreSQL temporário em memória.')
  return new adapter.Pool()
}

export const pool = createPool()
export const sourcePool = process.env.SOURCE_DATABASE_URL
  ? new PostgresPool({
      connectionString: process.env.SOURCE_DATABASE_URL,
      ssl: process.env.SOURCE_PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined,
      max: 4,
    })
  : null

export async function initializeDatabase() {
  const schema = await readFile(schemaUrl, 'utf8')
  await pool.query(schema)
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_plan VARCHAR(30) NOT NULL DEFAULT 'avista'")
  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS retail_unit_price NUMERIC(14,2)')
  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS network_unit_price NUMERIC(14,2)')
  await pool.query("ALTER TABLE customers ADD COLUMN IF NOT EXISTS sales_channel VARCHAR(20) NOT NULL DEFAULT 'Varejo'")
  await pool.query('ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash TEXT')
  await pool.query('UPDATE products SET retail_unit_price = unit_price WHERE retail_unit_price IS NULL')
  await pool.query('UPDATE products SET network_unit_price = unit_price WHERE network_unit_price IS NULL')
  await pool.query('DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP')

  const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM products')
  if (Number(countResult.rows[0].count) === 0) await seedDatabase()
  if (!process.env.DATABASE_URL) await ensureLocalCustomer()
}

async function seedDatabase() {
  const seed = JSON.parse(await readFile(seedUrl, 'utf8'))
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const productIds = new Map()
    for (const product of seed.products) {
      const result = await client.query(
        `INSERT INTO products (
          company, external_id, supplier_id, brand, name, package, master_package,
          units_per_box, min_boxes, unit_price, list_unit_price, retail_unit_price,
          network_unit_price, department, section, source_category, category, ean,
          stock_units, image_path, active, price_date
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
        ) RETURNING id`,
        [
          seed.source, product.externalId, product.supplierId, product.brand, product.name,
          product.package, product.masterPackage, product.unitsPerBox, product.minBoxes,
          product.unitPrice, product.listUnitPrice,
          product.retailUnitPrice ?? product.unitPrice,
          product.networkUnitPrice ?? product.unitPrice,
          product.department, product.section, product.sourceCategory, product.category,
          product.ean, product.stockUnits, product.image, product.active, product.priceDate,
        ],
      )
      productIds.set(product.externalId, result.rows[0].id)
    }

    for (const sale of seed.sales) {
      const productId = productIds.get(sale.externalProductId)
      if (productId) {
        await client.query(
          'INSERT INTO sales (product_id, sold_at, quantity, revenue) VALUES ($1,$2,$3,$4)',
          [productId, sale.soldAt, sale.quantity, sale.revenue],
        )
      }
    }

    await client.query('COMMIT')
    console.info(`[db] Seed carregado: ${seed.products.length} produtos reais da ${seed.source}.`)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function ensureLocalCustomer() {
  const passwordHash = hashPassword('Omega@2026')
  await pool.query(
    `INSERT INTO customers (
       external_id, document, person_type, legal_name, trade_name, phone, email,
       password_hash, sales_channel, postal_code, address_line, neighborhood, city, state, source
     ) VALUES ($1,$2,'CNPJ',$3,$4,$5,$6,$7,'Varejo',$8,$9,$10,$11,$12,'erp-snapshot')
     ON CONFLICT (document) DO UPDATE SET
       email = CASE WHEN customers.email = '' THEN EXCLUDED.email ELSE customers.email END,
       password_hash = COALESCE(customers.password_hash, EXCLUDED.password_hash),
       sales_channel = COALESCE(customers.sales_channel, EXCLUDED.sales_channel)`,
    [
      22132, '41600131000197', 'Omega Dist. De Prod. Alimenticios Eireli', 'Omega Matriz',
      '8592020207', 'ecommerce@omegadistribuidora.com.br', passwordHash, '60015141',
      'Rua Teresa Cristina, 1258', 'Centro', 'Fortaleza', 'CE',
    ],
  )
}
