import { readFile, readdir } from 'node:fs/promises'
import pg from 'pg'
import { newDb } from 'pg-mem'
import { hashPassword } from './auth.js'

const { Pool: PostgresPool } = pg
const seedUrl = new URL('./seed-data.json', import.meta.url)
const schemaUrl = new URL('./schema.sql', import.meta.url)
const bundledProductImagesUrl = new URL('../public/assets/products/', import.meta.url)

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
  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS department_code INTEGER')
  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS section_code INTEGER')
  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS sales_multiple INTEGER NOT NULL DEFAULT 1')
  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS manufacturer_code TEXT')
  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS ncm_code TEXT')
  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS image_data BYTEA')
  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS image_mime VARCHAR(50)')
  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS image_hidden BOOLEAN NOT NULL DEFAULT FALSE')
  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS image_updated_at TIMESTAMPTZ')
  await pool.query("ALTER TABLE customers ADD COLUMN IF NOT EXISTS sales_channel VARCHAR(20) NOT NULL DEFAULT 'Varejo'")
  await pool.query('ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash TEXT')
  await pool.query('ALTER TABLE customers ADD COLUMN IF NOT EXISTS supabase_user_id UUID')
  await pool.query("ALTER TABLE customers ADD COLUMN IF NOT EXISTS registration_status VARCHAR(20) NOT NULL DEFAULT 'approved'")
  await pool.query('ALTER TABLE customers ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP')
  await pool.query('ALTER TABLE customers ADD COLUMN IF NOT EXISTS approved_by_staff_user_id BIGINT')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_customers_registration_status ON customers(registration_status, created_at DESC)')
  await pool.query('ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS supabase_user_id UUID')
  await pool.query('ALTER TABLE staff_users DROP CONSTRAINT IF EXISTS staff_users_role_check')
  await pool.query("ALTER TABLE staff_users ADD CONSTRAINT staff_users_role_check CHECK (role IN ('ADMIN', 'COMERCIAL', 'MARKETING'))")
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_supabase_user ON customers(supabase_user_id)')
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_supabase_user ON staff_users(supabase_user_id)')
  await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP')
  await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS winthor_order_number BIGINT')
  await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS winthor_status_code VARCHAR(20)')
  await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS winthor_status_label VARCHAR(80)')
  await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS winthor_status_checked_at TIMESTAMP')
  await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS winthor_entered_by_staff_user_id BIGINT')
  await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS winthor_entered_at TIMESTAMP')
  await pool.query('ALTER TABLE order_items ADD COLUMN IF NOT EXISTS units INTEGER')
  await pool.query('UPDATE order_items SET units = boxes * units_per_box WHERE units IS NULL')
  await pool.query("ALTER TABLE banners ADD COLUMN IF NOT EXISTS placement VARCHAR(20) NOT NULL DEFAULT 'hero'")
  await pool.query('ALTER TABLE banners ADD COLUMN IF NOT EXISTS section_code INTEGER')
  await pool.query('ALTER TABLE banners ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ')
  await pool.query('ALTER TABLE banners ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ')
  await pool.query("ALTER TABLE banners ADD COLUMN IF NOT EXISTS destination_type VARCHAR(20) NOT NULL DEFAULT 'navigation'")
  await pool.query("ALTER TABLE banners ADD COLUMN IF NOT EXISTS destination_values INTEGER[] NOT NULL DEFAULT '{}'")
  await pool.query("ALTER TABLE banners ADD COLUMN IF NOT EXISTS navigation_path TEXT NOT NULL DEFAULT '/#produtos'")
  await pool.query('ALTER TABLE banners DROP CONSTRAINT IF EXISTS banners_destination_type_check')
  await pool.query("ALTER TABLE banners ADD CONSTRAINT banners_destination_type_check CHECK (destination_type IN ('navigation', 'sections', 'products', 'suppliers'))")
  if (process.env.DATABASE_URL) {
    await pool.query(`UPDATE banners
      SET destination_type='sections', destination_values=ARRAY[section_code]
      WHERE section_code IS NOT NULL AND destination_type='navigation' AND destination_values='{}'::integer[]`)
    await pool.query(`UPDATE banners SET navigation_path=CASE WHEN target_url='#produtos' THEN '/#produtos' ELSE target_url END
      WHERE destination_type='navigation' AND navigation_path='/#produtos'`)
  }
  await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_plan_label VARCHAR(160)')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_banners_section_code ON banners(section_code)')
  if (process.env.DATABASE_URL) {
    await pool.query(`CREATE TABLE IF NOT EXISTS customer_commercial_conditions (
      customer_id BIGINT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
      credit_limit NUMERIC(14,2) NOT NULL DEFAULT 0,
      payment_plans JSONB NOT NULL DEFAULT '[]'::jsonb,
      source_updated_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)
  }
  await pool.query('ALTER TABLE customer_commercial_conditions ADD COLUMN IF NOT EXISTS open_titles_amount NUMERIC(14,2) NOT NULL DEFAULT 0')
  await pool.query('ALTER TABLE customer_commercial_conditions ADD COLUMN IF NOT EXISTS open_orders_amount NUMERIC(14,2) NOT NULL DEFAULT 0')
  await pool.query('ALTER TABLE customer_commercial_conditions ADD COLUMN IF NOT EXISTS price_region INTEGER')
  await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP')
  await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(160)')
  if (process.env.DATABASE_URL) {
    // Preços da PCTABPR podem ter até 6 casas decimais.
    const unitPriceScale = await pool.query(
      `SELECT numeric_scale FROM information_schema.columns
       WHERE table_name='order_items' AND column_name='unit_price' AND table_schema=current_schema()`,
    )
    if (Number(unitPriceScale.rows[0]?.numeric_scale) !== 6) {
      await pool.query('ALTER TABLE order_items ALTER COLUMN unit_price TYPE NUMERIC(14,6)')
    }
  }
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_winthor_order_number ON orders(winthor_order_number)')
  await pool.query("UPDATE orders SET status='analysis' WHERE status='received'")
  await pool.query('UPDATE products SET retail_unit_price = unit_price WHERE retail_unit_price IS NULL')
  await pool.query('UPDATE products SET network_unit_price = unit_price WHERE network_unit_price IS NULL')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_products_department_section ON products(active, department_code, section_code)')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(active, supplier_id)')
  await pool.query('DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP')
  await pool.query('DELETE FROM staff_sessions WHERE expires_at <= CURRENT_TIMESTAMP')
  if (process.env.SUPABASE_URL) {
    await pool.query('UPDATE customers SET password_hash=NULL WHERE password_hash IS NOT NULL')
    await pool.query('DELETE FROM sessions')
  }

  await ensureDefaultBanners()
  await ensureBootstrapAdmin()

  const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM products')
  if (Number(countResult.rows[0].count) === 0) await seedDatabase()
  await ensureBundledProductImages()
  if (!process.env.DATABASE_URL) await ensureLocalCustomer()
}

async function ensureBundledProductImages() {
  let fileNames = []
  try {
    fileNames = await readdir(bundledProductImagesUrl)
  } catch {
    console.warn('[images] diretório de imagens iniciais não encontrado.')
    return
  }
  const imageByCode = new Map()
  for (const fileName of fileNames) {
    const match = /^(\d+)\.webp$/i.exec(fileName)
    if (match) imageByCode.set(Number(match[1]), `/assets/products/${fileName}?v=webp-v1`)
  }

  const migrationKey = 'product_images_webp_v1_imported'
  const migration = await pool.query('SELECT value FROM app_settings WHERE key=$1 LIMIT 1', [migrationKey])
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (!migration.rows.length) {
      // Substitui integralmente o acervo antigo, sem afetar futuros uploads feitos pela gestão.
      await client.query(`UPDATE products SET image_path=NULL, image_data=NULL, image_mime=NULL,
        image_hidden=FALSE, image_updated_at=NULL`)
    }
    for (const [code, imagePath] of imageByCode) {
      await client.query(
        `UPDATE products SET image_path=$1
         WHERE external_id=$2 AND image_data IS NULL AND image_hidden=FALSE
           AND COALESCE(image_path,'') <> $1`,
        [imagePath, code],
      )
    }
    await client.query(
      `INSERT INTO app_settings (key,value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=CURRENT_TIMESTAMP`,
      [migrationKey, String(imageByCode.size)],
    )
    await client.query('COMMIT')
    console.info(`[images] ${imageByCode.size} imagens WEBP iniciais disponíveis.`)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function ensureCatalogCategories() {
  const migration = await pool.query("SELECT value FROM app_settings WHERE key='catalog_categories_v1_migrated' LIMIT 1")
  if (migration.rows.length) return
  const defaults = ['Limpeza', 'Higiene', 'Utilidades', 'Alimentos']
  for (let index = 0; index < defaults.length; index += 1) {
    await pool.query(
      `INSERT INTO catalog_categories (name, position)
       VALUES ($1,$2) ON CONFLICT (name) DO NOTHING`,
      [defaults[index], index + 1],
    )
  }
  const legacyMappings = await pool.query(
    `SELECT p.id AS product_id, c.id AS category_id
     FROM products p JOIN catalog_categories c ON LOWER(c.name) = LOWER(p.category)
     WHERE p.category IS NOT NULL AND p.category <> ''`,
  )
  for (const mapping of legacyMappings.rows) {
    await pool.query(
      `INSERT INTO product_categories (product_id, category_id)
       VALUES ($1,$2) ON CONFLICT (product_id, category_id) DO NOTHING`,
      [mapping.product_id, mapping.category_id],
    )
  }
  await pool.query(
    `INSERT INTO app_settings (key,value) VALUES ('catalog_categories_v1_migrated','true')
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=CURRENT_TIMESTAMP`,
  )
}

async function ensureDefaultBanners() {
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM banners')
  if (Number(result.rows[0].count) > 0) return
  await pool.query(
    `INSERT INTO banners (title, alt_text, image_path, target_url, position) VALUES
      ('Institucional Ômega', 'Tudo que o seu negócio precisa, em um só lugar', '/assets/banner-omega.png', '#produtos', 1),
      ('Linha Bombril', 'Linha Bombril: mais limpeza para o seu dia a dia', '/assets/banner-bombril.png', '#produtos', 2)`,
  )
}

async function ensureBootstrapAdmin() {
  const password = process.env.ADMIN_PASSWORD || (!process.env.DATABASE_URL ? 'Admin@2026' : '')
  if (!password) {
    console.warn('[auth] ADMIN_PASSWORD ausente: a conta administrativa inicial não foi criada.')
    return
  }
  const email = String(process.env.ADMIN_EMAIL || 'admin@omegadistribuidora.com.br').trim().toLowerCase()
  const name = String(process.env.ADMIN_NAME || 'Administrador Ômega').trim()
  const existing = await pool.query('SELECT id FROM staff_users WHERE LOWER(email) = $1 LIMIT 1', [email])
  if (existing.rows.length) {
    // Redefinição explícita: ADMIN_PASSWORD_RESET=true grava ADMIN_PASSWORD na conta e encerra as sessões dela.
    // Remova a variável depois do primeiro acesso para que reinícios não sobrescrevam a senha.
    if (String(process.env.ADMIN_PASSWORD_RESET || '').trim().toLowerCase() === 'true') {
      await pool.query(
        `UPDATE staff_users SET password_hash=$2, active=TRUE, role='ADMIN', updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
        [existing.rows[0].id, hashPassword(password)],
      )
      await pool.query('DELETE FROM staff_sessions WHERE staff_user_id=$1', [existing.rows[0].id])
      console.warn(`[auth] senha da conta administrativa ${email} redefinida por ADMIN_PASSWORD_RESET. Remova essa variável.`)
    }
    return
  }
  await pool.query(
    `INSERT INTO staff_users (name, email, password_hash, role)
     VALUES ($1,$2,$3,'ADMIN')`,
    [name, email, hashPassword(password)],
  )
  console.info(`[auth] conta administrativa inicial criada para ${email}.`)
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
          units_per_box, sales_multiple, min_boxes, unit_price, list_unit_price, retail_unit_price,
          network_unit_price, department, section, source_category, category, ean,
          stock_units, image_path, active, price_date
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
        ) RETURNING id`,
        [
          seed.source, product.externalId, product.supplierId, product.brand, product.name,
          product.package, product.masterPackage, product.unitsPerBox, product.salesMultiple ?? product.unitsPerBox ?? 1, product.minBoxes,
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
