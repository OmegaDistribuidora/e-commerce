import 'dotenv/config'
import express from 'express'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { initializeDatabase, pool, sourcePool } from './db.js'
import { clearSessionCookie, clearStaffSessionCookie, createSession, getCookie, hashPassword, hashSessionToken, sessionCookie, staffSessionCookie, verifyPassword } from './auth.js'
import { bannerSchema, customerSchema, digits, loginSchema, lookupSchema, orderSchema, staffUserSchema } from './validation.js'

const app = express()
const port = Number(process.env.PORT) || 3000
const currentDir = dirname(fileURLToPath(import.meta.url))
const distDir = resolve(currentDir, '../dist')

app.disable('x-powered-by')
app.use(express.json({ limit: '8mb' }))

app.use(async (request, _response, next) => {
  try {
    const token = getCookie(request, 'omega_session')
    if (!token) return next()
    const result = await pool.query(
      `SELECT c.id, c.document, c.person_type, c.legal_name, c.trade_name, c.phone,
              c.email, c.city, c.state, c.sales_channel
       FROM sessions s
       JOIN customers c ON c.id = s.customer_id
       WHERE s.token_hash = $1 AND s.expires_at > CURRENT_TIMESTAMP AND c.active = TRUE
       LIMIT 1`,
      [hashSessionToken(token)],
    )
    request.customer = result.rows[0] ?? null
    return next()
  } catch (error) {
    return next(error)
  }
})

app.use(async (request, _response, next) => {
  try {
    const token = getCookie(request, 'omega_staff')
    if (!token) return next()
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.role
       FROM staff_sessions s
       JOIN staff_users u ON u.id = s.staff_user_id
       WHERE s.token_hash = $1 AND s.expires_at > CURRENT_TIMESTAMP AND u.active = TRUE
       LIMIT 1`,
      [hashSessionToken(token)],
    )
    request.staff = result.rows[0] ?? null
    return next()
  } catch (error) {
    return next(error)
  }
})

function customerJson(customer) {
  return {
    id: Number(customer.id),
    document: customer.document,
    personType: customer.person_type,
    legalName: customer.legal_name,
    tradeName: customer.trade_name,
    phone: customer.phone,
    email: customer.email,
    city: customer.city,
    state: customer.state,
    salesChannel: customer.sales_channel || 'Varejo',
  }
}

function staffJson(staff) {
  return { id: Number(staff.id), name: staff.name, email: staff.email, role: staff.role }
}

function requireStaff(request, response, next) {
  if (!request.staff) return response.status(401).json({ message: 'Entre na área de gestão para continuar.' })
  return next()
}

function requireAdmin(request, response, next) {
  if (!request.staff) return response.status(401).json({ message: 'Entre na área de gestão para continuar.' })
  if (request.staff.role !== 'ADMIN') return response.status(403).json({ message: 'Esta ação é exclusiva do administrador.' })
  return next()
}

async function listOrders(whereClause = '', params = []) {
  const result = await pool.query(
    `SELECT o.id, o.status, o.payment_plan, o.total, o.notes, o.created_at, o.updated_at,
            c.id AS customer_id, c.legal_name, c.trade_name, c.document, c.email, c.phone
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     ${whereClause}
     ORDER BY o.created_at DESC`,
    params,
  )
  const orderIds = result.rows.map((order) => Number(order.id))
  let itemRows = []
  if (orderIds.length) {
    const placeholders = orderIds.map((_, index) => `$${index + 1}`).join(',')
    const items = await pool.query(
      `SELECT oi.id, oi.order_id, p.id AS product_id, p.external_id AS code, p.name,
              oi.boxes, oi.units_per_box, oi.unit_price, oi.line_total
       FROM order_items oi JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id IN (${placeholders}) ORDER BY oi.id`,
      orderIds,
    )
    itemRows = items.rows
  }
  return result.rows.map((order) => ({
    id: Number(order.id),
    number: `OMG-${String(order.id).padStart(6, '0')}`,
    status: order.status,
    paymentPlan: order.payment_plan,
    total: Number(order.total),
    notes: order.notes || '',
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    customer: {
      id: Number(order.customer_id), legalName: order.legal_name, tradeName: order.trade_name,
      document: order.document, email: order.email, phone: order.phone,
    },
    items: itemRows.filter((item) => Number(item.order_id) === Number(order.id)).map((item) => ({
      id: Number(item.id), productId: Number(item.product_id), code: Number(item.code), name: item.name,
      boxes: Number(item.boxes), unitsPerBox: Number(item.units_per_box),
      unitPrice: Number(item.unit_price), lineTotal: Number(item.line_total),
    })),
  }))
}

function decodeBannerImage(dataUrl) {
  if (!dataUrl) return null
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!match) throw new Error('Imagem inválida. Use PNG, JPG ou WEBP.')
  const data = Buffer.from(match[2], 'base64')
  if (!data.length || data.length > 5 * 1024 * 1024) throw new Error('A imagem deve ter no máximo 5 MB.')
  return { mime: match[1], data }
}

app.post('/api/auth/login', async (request, response, next) => {
  try {
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
    const result = await pool.query(
      `SELECT id, document, person_type, legal_name, trade_name, phone, email, city, state,
              sales_channel, password_hash
       FROM customers
       WHERE LOWER(email) = LOWER($1) AND active = TRUE
       LIMIT 1`,
      [parsed.data.email],
    )
    const customer = result.rows[0]
    if (!customer || !verifyPassword(parsed.data.password, customer.password_hash)) {
      return response.status(401).json({ message: 'E-mail ou senha incorretos.' })
    }
    const session = createSession()
    await pool.query(
      'INSERT INTO sessions (token_hash, customer_id, expires_at) VALUES ($1,$2,$3)',
      [session.tokenHash, customer.id, session.expiresAt],
    )
    response.setHeader('Set-Cookie', sessionCookie(session.token, session.expiresAt))
    return response.json({ customer: customerJson(customer) })
  } catch (error) {
    return next(error)
  }
})

app.post('/api/auth/logout', async (request, response, next) => {
  try {
    const token = getCookie(request, 'omega_session')
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashSessionToken(token)])
    response.setHeader('Set-Cookie', clearSessionCookie())
    return response.status(204).end()
  } catch (error) {
    return next(error)
  }
})

app.get('/api/auth/me', (request, response) => {
  if (!request.customer) return response.status(401).json({ message: 'Sessão não autenticada.' })
  return response.json({ customer: customerJson(request.customer) })
})

app.post('/api/staff/auth/login', async (request, response, next) => {
  try {
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
    const result = await pool.query(
      `SELECT id, name, email, role, password_hash
       FROM staff_users WHERE LOWER(email) = LOWER($1) AND active = TRUE LIMIT 1`,
      [parsed.data.email],
    )
    const staff = result.rows[0]
    if (!staff || !verifyPassword(parsed.data.password, staff.password_hash)) {
      return response.status(401).json({ message: 'E-mail ou senha incorretos.' })
    }
    const session = createSession()
    await pool.query(
      'INSERT INTO staff_sessions (token_hash, staff_user_id, expires_at) VALUES ($1,$2,$3)',
      [session.tokenHash, staff.id, session.expiresAt],
    )
    response.setHeader('Set-Cookie', staffSessionCookie(session.token, session.expiresAt))
    return response.json({ user: staffJson(staff) })
  } catch (error) {
    return next(error)
  }
})

app.post('/api/staff/auth/logout', async (request, response, next) => {
  try {
    const token = getCookie(request, 'omega_staff')
    if (token) await pool.query('DELETE FROM staff_sessions WHERE token_hash = $1', [hashSessionToken(token)])
    response.setHeader('Set-Cookie', clearStaffSessionCookie())
    return response.status(204).end()
  } catch (error) {
    return next(error)
  }
})

app.get('/api/staff/auth/me', (request, response) => {
  if (!request.staff) return response.status(401).json({ message: 'Sessão interna não autenticada.' })
  return response.json({ user: staffJson(request.staff) })
})

app.get('/api/banners', async (_request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT id, title, alt_text, image_path, image_data IS NOT NULL AS uploaded,
              target_url, position, active, updated_at
       FROM banners WHERE active = TRUE ORDER BY position, id`,
    )
    return response.json({ banners: result.rows.map((banner) => ({
      id: Number(banner.id),
      title: banner.title,
      altText: banner.alt_text,
      imageUrl: banner.uploaded ? `/api/banners/${banner.id}/image?v=${new Date(banner.updated_at).getTime()}` : banner.image_path,
      targetUrl: banner.target_url,
      position: Number(banner.position),
      active: banner.active,
    })) })
  } catch (error) {
    return next(error)
  }
})

app.get('/api/banners/:id/image', async (request, response, next) => {
  try {
    const result = await pool.query(
      'SELECT image_data, image_mime FROM banners WHERE id = $1 LIMIT 1',
      [request.params.id],
    )
    if (!result.rows[0]?.image_data) return response.status(404).end()
    response.setHeader('Cache-Control', 'public, max-age=3600')
    return response.type(result.rows[0].image_mime || 'image/jpeg').send(result.rows[0].image_data)
  } catch (error) {
    return next(error)
  }
})

app.get('/api/health', async (_request, response, next) => {
  try {
    const result = await pool.query('SELECT COUNT(*)::int AS products FROM products WHERE active = TRUE')
    response.json({ status: 'ok', database: process.env.DATABASE_URL ? 'postgres' : 'memory', products: Number(result.rows[0].products) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/products', async (request, response, next) => {
  try {
    const search = String(request.query.search ?? '').trim()
    const category = String(request.query.category ?? '').trim()
    const sort = request.query.sort === 'bestsellers' ? 'bestsellers' : 'featured'
    const limit = Math.min(Math.max(Number(request.query.limit) || 180, 1), 200)
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 6)

    const params = [cutoff.toISOString().slice(0, 10)]
    const conditions = ['p.active = TRUE']
    if (search) {
      params.push(`%${search}%`)
      conditions.push(`(p.name ILIKE $${params.length} OR p.brand ILIKE $${params.length} OR p.external_id::text ILIKE $${params.length})`)
    }
    if (category && category !== 'Todos') {
      params.push(category)
      conditions.push(`p.category = $${params.length}`)
    }
    params.push(limit)

    const orderBy = sort === 'bestsellers'
      ? 'weekly_sales DESC, (p.image_path IS NOT NULL) DESC, p.name'
      : '(p.image_path IS NOT NULL) DESC, weekly_sales DESC, p.name'

    const result = await pool.query(
      `WITH weekly AS (
         SELECT product_id, SUM(quantity) AS units
         FROM sales
         WHERE sold_at >= $1
         GROUP BY product_id
       )
       SELECT p.id, p.external_id, p.supplier_id, p.brand, p.name, p.package, p.master_package,
              p.units_per_box, p.min_boxes, p.unit_price, p.list_unit_price,
              p.retail_unit_price, p.network_unit_price,
              p.category, p.department, p.section, p.stock_units, p.image_path,
              p.price_date, COALESCE(w.units, 0) AS weekly_sales
       FROM products p
       LEFT JOIN weekly w ON w.product_id = p.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT $${params.length}`,
      params,
    )

    response.json({
      products: result.rows.map((row) => {
        const authenticated = Boolean(request.customer)
        const channelPrice = request.customer?.sales_channel === 'Redes'
          ? row.network_unit_price
          : row.retail_unit_price
        return {
        id: row.id,
        code: row.external_id,
        supplierId: row.supplier_id,
        brand: row.brand,
        name: row.name,
        package: row.package,
        masterPackage: row.master_package,
        unitsPerBox: Number(row.units_per_box),
        minBoxes: Number(row.min_boxes),
        unitPrice: authenticated ? Number(channelPrice ?? row.unit_price) : null,
        listUnitPrice: authenticated ? Number(row.list_unit_price ?? channelPrice ?? row.unit_price) : null,
        priceChannel: authenticated ? request.customer.sales_channel : null,
        category: row.category,
        department: row.department,
        section: row.section,
        stockUnits: Number(row.stock_units),
        image: row.image_path,
        priceDate: row.price_date,
        weeklySales: Number(row.weekly_sales),
      }}),
      sort,
      count: result.rows.length,
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/customers/lookup', async (request, response, next) => {
  try {
    const parsed = lookupSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
    let result = await pool.query(
      `SELECT id, document, person_type, legal_name, trade_name, phone, email, city, state, sales_channel, password_hash
       FROM customers WHERE document = $1 AND active = TRUE LIMIT 1`,
      [parsed.data.document],
    )
    if (!result.rows.length && sourcePool) {
      const sourceSchema = /^[a-z_][a-z0-9_]*$/i.test(process.env.SOURCE_SCHEMA ?? '') ? process.env.SOURCE_SCHEMA : 'filial'
      const sourceResult = await sourcePool.query(
        `SELECT codcli, cnpj, cliente, fantasia, cidade, uf, status, canal_venda
         FROM ${sourceSchema}.dcliente
         WHERE regexp_replace(cnpj, '[^0-9]', '', 'g') = $1
         ORDER BY CASE WHEN status = 'Desbloqueado' THEN 0 ELSE 1 END
         LIMIT 1`,
        [parsed.data.document],
      )
      if (sourceResult.rows.length) {
        const sourceCustomer = sourceResult.rows[0]
        if (sourceCustomer.status !== 'Desbloqueado') {
          return response.status(403).json({ message: 'Cadastro localizado, mas precisa de liberação comercial. Fale com a equipe Ômega.' })
        }
        await pool.query(
          `INSERT INTO customers (
             external_id, document, person_type, legal_name, trade_name, phone, email,
             city, state, sales_channel, active, source
           ) VALUES ($1,$2,$3,$4,$5,'','',$6,$7,$8,TRUE,'erp')
           ON CONFLICT (document) DO UPDATE SET
             external_id = EXCLUDED.external_id,
             legal_name = EXCLUDED.legal_name,
             trade_name = EXCLUDED.trade_name,
             city = EXCLUDED.city,
             state = EXCLUDED.state,
             sales_channel = EXCLUDED.sales_channel,
             active = TRUE,
             updated_at = CURRENT_TIMESTAMP`,
          [
            sourceCustomer.codcli, parsed.data.document,
            parsed.data.document.length === 11 ? 'CPF' : 'CNPJ',
            sourceCustomer.cliente, sourceCustomer.fantasia,
            sourceCustomer.cidade, sourceCustomer.uf,
            sourceCustomer.canal_venda === 'Redes' ? 'Redes' : 'Varejo',
          ],
        )
        result = await pool.query(
          `SELECT id, document, person_type, legal_name, trade_name, phone, email, city, state, sales_channel, password_hash
           FROM customers WHERE document = $1 AND active = TRUE LIMIT 1`,
          [parsed.data.document],
        )
      }
    }
    if (!result.rows.length) return response.json({ found: false, document: parsed.data.document })
    const customer = result.rows[0]
    return response.json({ found: true, hasAccess: Boolean(customer.password_hash), customer: customerJson(customer) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/customers', async (request, response, next) => {
  try {
    const parsed = customerSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message, issues: parsed.error.issues })
    const customer = parsed.data
    const existing = await pool.query('SELECT id, password_hash FROM customers WHERE document = $1 LIMIT 1', [customer.document])
    if (existing.rows[0]?.password_hash) return response.status(409).json({ message: 'Este cliente já possui acesso. Entre com seu e-mail e senha.' })
    const emailOwner = await pool.query('SELECT id FROM customers WHERE LOWER(email) = LOWER($1) AND document <> $2 LIMIT 1', [customer.email, customer.document])
    if (emailOwner.rows.length) return response.status(409).json({ message: 'Este e-mail já está vinculado a outro cliente.' })
    const passwordHash = hashPassword(customer.password)

    const result = existing.rows.length ? await pool.query(
      `UPDATE customers SET
         legal_name=$2, trade_name=$3, phone=$4, email=$5, password_hash=$6,
         postal_code=$7, address_line=$8, address_number=$9, address_complement=$10,
         neighborhood=$11, city=$12, state=$13, updated_at=CURRENT_TIMESTAMP
       WHERE id=$1
       RETURNING id, document, person_type, legal_name, trade_name, phone, email, city, state, sales_channel`,
      [
        existing.rows[0].id, customer.legalName, customer.tradeName, customer.phone, customer.email,
        passwordHash, customer.postalCode, customer.addressLine, customer.addressNumber,
        customer.addressComplement, customer.neighborhood, customer.city, customer.state,
      ],
    ) : await pool.query(
      `INSERT INTO customers (
        document, person_type, legal_name, trade_name, phone, email, password_hash, postal_code,
        address_line, address_number, address_complement, neighborhood, city, state
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, document, person_type, legal_name, trade_name, phone, email, city, state, sales_channel`,
      [
        customer.document, customer.document.length === 11 ? 'CPF' : 'CNPJ', customer.legalName,
        customer.tradeName, customer.phone, customer.email, passwordHash, customer.postalCode, customer.addressLine,
        customer.addressNumber, customer.addressComplement, customer.neighborhood, customer.city, customer.state,
      ],
    )
    const row = result.rows[0]
    return response.status(existing.rows.length ? 200 : 201).json({ customer: customerJson(row) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/orders', async (request, response, next) => {
  if (!request.customer) return response.status(401).json({ message: 'Entre na sua conta para consultar seus pedidos.' })
  try {
    return response.json({ orders: await listOrders('WHERE o.customer_id = $1', [request.customer.id]) })
  } catch (error) {
    return next(error)
  }
})

app.get('/api/staff/orders', requireStaff, async (_request, response, next) => {
  try {
    return response.json({ orders: await listOrders() })
  } catch (error) {
    return next(error)
  }
})

app.get('/api/staff/users', requireAdmin, async (_request, response, next) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, role, active, created_at FROM staff_users ORDER BY name',
    )
    return response.json({ users: result.rows.map((user) => ({
      ...staffJson(user), active: user.active, createdAt: user.created_at,
    })) })
  } catch (error) {
    return next(error)
  }
})

app.post('/api/staff/users', requireAdmin, async (request, response, next) => {
  try {
    const parsed = staffUserSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
    const user = parsed.data
    const result = await pool.query(
      `INSERT INTO staff_users (name, email, password_hash, role)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, name, email, role, active, created_at`,
      [user.name, user.email, hashPassword(user.password), user.role],
    )
    if (!result.rows.length) return response.status(409).json({ message: 'Já existe um usuário com este e-mail.' })
    return response.status(201).json({ user: { ...staffJson(result.rows[0]), active: true, createdAt: result.rows[0].created_at } })
  } catch (error) {
    return next(error)
  }
})

app.get('/api/staff/banners', requireStaff, async (_request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT id, title, alt_text, image_path, image_data IS NOT NULL AS uploaded,
              target_url, position, active, updated_at
       FROM banners ORDER BY position, id`,
    )
    return response.json({ banners: result.rows.map((banner) => ({
      id: Number(banner.id), title: banner.title, altText: banner.alt_text,
      imageUrl: banner.uploaded ? `/api/banners/${banner.id}/image?v=${new Date(banner.updated_at).getTime()}` : banner.image_path,
      targetUrl: banner.target_url, position: Number(banner.position), active: banner.active,
    })) })
  } catch (error) {
    return next(error)
  }
})

app.put('/api/staff/banners/:id', requireStaff, async (request, response, next) => {
  try {
    const parsed = bannerSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
    let image = null
    try { image = decodeBannerImage(parsed.data.imageDataUrl) } catch (error) {
      return response.status(400).json({ message: error.message })
    }
    const values = [
      parsed.data.title, parsed.data.altText, parsed.data.targetUrl || '#produtos',
      parsed.data.position, parsed.data.active, image?.data ?? null, image?.mime ?? null,
      request.params.id,
    ]
    const result = await pool.query(
      `UPDATE banners SET title=$1, alt_text=$2, target_url=$3, position=$4, active=$5,
         image_data=COALESCE($6, image_data), image_mime=COALESCE($7, image_mime),
         image_path=CASE WHEN $6::bytea IS NOT NULL THEN NULL ELSE image_path END,
         updated_at=CURRENT_TIMESTAMP
       WHERE id=$8 RETURNING id`,
      values,
    )
    if (!result.rows.length) return response.status(404).json({ message: 'Banner não encontrado.' })
    return response.json({ saved: true })
  } catch (error) {
    return next(error)
  }
})

app.post('/api/staff/banners', requireStaff, async (request, response, next) => {
  try {
    const parsed = bannerSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
    let image
    try { image = decodeBannerImage(parsed.data.imageDataUrl) } catch (error) {
      return response.status(400).json({ message: error.message })
    }
    if (!image) return response.status(400).json({ message: 'Selecione uma imagem para o novo banner.' })
    const result = await pool.query(
      `INSERT INTO banners (title, alt_text, image_data, image_mime, target_url, position, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [parsed.data.title, parsed.data.altText, image.data, image.mime, parsed.data.targetUrl || '#produtos', parsed.data.position, parsed.data.active],
    )
    return response.status(201).json({ id: Number(result.rows[0].id), saved: true })
  } catch (error) {
    return next(error)
  }
})

app.post('/api/orders', async (request, response, next) => {
  if (!request.customer) return response.status(401).json({ message: 'Entre na sua conta para finalizar o pedido.' })
  const parsed = orderSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (Number(parsed.data.customerId) !== Number(request.customer.id)) {
      await client.query('ROLLBACK')
      return response.status(403).json({ message: 'O cliente do pedido não corresponde à sessão atual.' })
    }

    const uniqueProductIds = [...new Set(parsed.data.items.map((item) => item.productId))]
    const placeholders = uniqueProductIds.map((_, index) => `$${index + 1}`).join(',')
    const productsResult = await client.query(
      `SELECT id, unit_price, retail_unit_price, network_unit_price, units_per_box, min_boxes
       FROM products WHERE active = TRUE AND id IN (${placeholders})`,
      uniqueProductIds,
    )
    const productMap = new Map(productsResult.rows.map((product) => [Number(product.id), product]))
    if (productMap.size !== uniqueProductIds.length) {
      await client.query('ROLLBACK')
      return response.status(400).json({ message: 'Um ou mais produtos não estão disponíveis.' })
    }

    let total = 0
    const lines = parsed.data.items.map((item) => {
      const product = productMap.get(item.productId)
      const boxes = Math.max(item.quantity, Number(product.min_boxes))
      const unitPrice = Number(request.customer.sales_channel === 'Redes'
        ? product.network_unit_price ?? product.unit_price
        : product.retail_unit_price ?? product.unit_price)
      const lineTotal = boxes * Number(product.units_per_box) * unitPrice
      total += lineTotal
      return { product, boxes, unitPrice, lineTotal }
    })

    if (total < 200) {
      await client.query('ROLLBACK')
      return response.status(400).json({ message: `O pedido mínimo é R$ 200,00. Adicione mais R$ ${(200 - total).toFixed(2).replace('.', ',')}.` })
    }

    const orderResult = await client.query(
      'INSERT INTO orders (customer_id, payment_plan, total, notes) VALUES ($1,$2,$3,$4) RETURNING id, created_at',
      [request.customer.id, parsed.data.paymentPlan, total.toFixed(2), parsed.data.notes],
    )
    const order = orderResult.rows[0]
    for (const line of lines) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, boxes, units_per_box, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [order.id, line.product.id, line.boxes, line.product.units_per_box, line.unitPrice, line.lineTotal.toFixed(2)],
      )
    }
    await client.query('COMMIT')
    return response.status(201).json({
      order: {
        id: Number(order.id),
        number: `OMG-${String(order.id).padStart(6, '0')}`,
        total,
        paymentPlan: parsed.data.paymentPlan,
        createdAt: order.created_at,
      },
    })
  } catch (error) {
    await client.query('ROLLBACK')
    next(error)
  } finally {
    client.release()
  }
})

if (existsSync(distDir)) {
  app.use(express.static(distDir, { maxAge: '1h' }))
  app.use((request, response, next) => {
    if (request.method === 'GET' && !request.path.startsWith('/api/')) {
      return response.sendFile(resolve(distDir, 'index.html'))
    }
    return next()
  })
}

app.use((error, _request, response, _next) => {
  console.error(error)
  response.status(500).json({ message: 'Não foi possível concluir a operação. Tente novamente.' })
})

initializeDatabase()
  .then(() => app.listen(port, '0.0.0.0', () => console.info(`[api] disponível em http://localhost:${port}`)))
  .catch((error) => {
    console.error('[api] falha ao iniciar', error)
    process.exit(1)
  })
