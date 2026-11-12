import 'dotenv/config'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { initializeDatabase, pool, sourcePool } from './db.js'
import { clearSessionCookie, clearStaffSessionCookie, createSession, getCookie, hashPassword, hashSessionToken, sessionCookie, staffSessionCookie, verifyPassword } from './auth.js'
import { createConfirmedSupabaseUser, deleteSupabaseUser, findSupabaseUserByEmail, verifySupabaseAccessToken, supabaseAuthConfigured } from './supabase-auth.js'
import { bannerSchema, bannersBulkSchema, customerConditionsSyncSchema, customerProfileSchema, customerUpdateSchema, digits, emailCheckSchema, loginSchema, lookupSchema, orderQuoteSchema, orderSchema, productSyncSchema, regionPricesSyncSchema, staffCustomerCreateSchema, staffOrderLinkSchema, staffPasswordSchema, staffUserSchema } from './validation.js'

const app = express()
app.set('trust proxy', 1)
const port = Number(process.env.PORT) || 3000
const currentDir = dirname(fileURLToPath(import.meta.url))
const distDir = resolve(currentDir, '../dist')
const orderStatusCacheMs = Math.max(1, Number(process.env.ORDER_STATUS_CACHE_MINUTES) || 15) * 60 * 1000
const customerOrderStatuses = new Set(['analysis', 'released', 'sent'])

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

class OmegaApiError extends Error {
  constructor(message, status = 502) {
    super(message)
    this.status = status
  }
}

app.disable('x-powered-by')
app.use(express.json({ limit: '25mb' }))

app.use(async (request, _response, next) => {
  try {
    const authUser = await verifySupabaseAccessToken(request)
    if (authUser) {
      request.authUser = authUser
      const [customerResult, staffResult] = await Promise.all([
        pool.query(
          `SELECT id, external_id, document, person_type, legal_name, trade_name, phone,
                  email, postal_code, address_line, address_number, address_complement,
                  neighborhood, city, state, sales_channel, registration_status
           FROM customers
           WHERE supabase_user_id = $1 AND active = TRUE
           LIMIT 1`,
          [authUser.id],
        ),
        pool.query(
          `SELECT id, name, email, role
           FROM staff_users
           WHERE supabase_user_id = $1 AND active = TRUE
           LIMIT 1`,
          [authUser.id],
        ),
      ])
      request.customer = customerResult.rows[0] ?? null
      request.staff = staffResult.rows[0] ?? null
      return next()
    }

    const token = getCookie(request, 'omega_session')
    if (!token) return next()
    const result = await pool.query(
      `SELECT c.id, c.external_id, c.document, c.person_type, c.legal_name, c.trade_name, c.phone,
              c.email, c.postal_code, c.address_line, c.address_number, c.address_complement,
              c.neighborhood, c.city, c.state, c.sales_channel, c.registration_status
       FROM sessions s
       JOIN customers c ON c.id = s.customer_id
       WHERE s.token_hash = $1 AND s.expires_at > CURRENT_TIMESTAMP AND c.active = TRUE
       LIMIT 1`,
      [hashSessionToken(token)],
    )
    request.customer = result.rows[0] ?? null
    return next()
  } catch (error) {
    request.authError = error
    return next()
  }
})

app.use(async (request, _response, next) => {
  try {
    if (request.staff || request.authUser) return next()
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
    externalId: customer.external_id == null ? null : Number(customer.external_id),
    document: customer.document,
    personType: customer.person_type,
    legalName: customer.legal_name,
    tradeName: customer.trade_name,
    phone: customer.phone,
    email: customer.email,
    postalCode: customer.postal_code || '',
    addressLine: customer.address_line || '',
    addressNumber: customer.address_number || '',
    addressComplement: customer.address_complement || '',
    neighborhood: customer.neighborhood || '',
    city: customer.city,
    state: customer.state,
    salesChannel: customer.sales_channel || 'Varejo',
    registrationStatus: customer.registration_status || 'approved',
    canOrder: (customer.registration_status || 'approved') === 'approved',
  }
}

function staffJson(staff) {
  return { id: Number(staff.id), name: staff.name, email: staff.email, role: staff.role }
}

function requireStaff(request, response, next) {
  if (request.authError) return response.status(401).json({ message: 'Sua sessão expirou. Entre novamente.' })
  if (!request.staff) return response.status(401).json({ message: 'Entre na área de gestão para continuar.' })
  return next()
}

function requireAdmin(request, response, next) {
  if (request.authError) return response.status(401).json({ message: 'Sua sessão expirou. Entre novamente.' })
  if (!request.staff) return response.status(401).json({ message: 'Entre na área de gestão para continuar.' })
  if (request.staff.role !== 'ADMIN') return response.status(403).json({ message: 'Esta ação é exclusiva do administrador.' })
  return next()
}

function requireCommercialAccess(request, response, next) {
  if (request.authError) return response.status(401).json({ message: 'Sua sessão expirou. Entre novamente.' })
  if (!request.staff) return response.status(401).json({ message: 'Entre na área de gestão para continuar.' })
  if (!['ADMIN', 'COMERCIAL'].includes(request.staff.role)) {
    return response.status(403).json({ message: 'Este perfil não possui acesso a pedidos ou clientes.' })
  }
  return next()
}

function requireMarketingAccess(request, response, next) {
  if (request.authError) return response.status(401).json({ message: 'Sua sessão expirou. Entre novamente.' })
  if (!request.staff) return response.status(401).json({ message: 'Entre na área de gestão para continuar.' })
  if (!['ADMIN', 'COMERCIAL', 'MARKETING'].includes(request.staff.role)) {
    return response.status(403).json({ message: 'Este perfil não possui acesso ao conteúdo da loja.' })
  }
  return next()
}

const authLinkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Muitas tentativas de vinculação. Aguarde alguns minutos e tente novamente.' },
})

const publicLookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Muitas consultas. Aguarde alguns minutos e tente novamente.' },
})

function omegaApiConfig() {
  const url = String(process.env.OMEGA_API_URL || '').trim().replace(/\/$/, '')
  const key = String(process.env.OMEGA_API_KEY || '').trim()
  return url && key ? { url, key } : null
}

async function fetchWinthorOrderStatuses(orderNumbers) {
  const config = omegaApiConfig()
  if (!config) throw new OmegaApiError('A consulta de pedidos do WinThor ainda não está configurada.', 503)
  let response
  try {
    response = await fetch(`${config.url}/v1/winthor/pedidos/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.key,
        'X-Client-Name': 'omega-ecommerce',
      },
      body: JSON.stringify({ numpeds: [...new Set(orderNumbers.map(Number))] }),
      signal: AbortSignal.timeout(12_000),
    })
  } catch {
    throw new OmegaApiError('Não foi possível consultar o status no WinThor agora.', 503)
  }
  const text = await response.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = {} }
  if (!response.ok) {
    const status = response.status === 401 ? 502 : (response.status >= 500 ? 503 : 502)
    throw new OmegaApiError(data.detail || 'Não foi possível consultar o status no WinThor.', status)
  }
  const statuses = new Map()
  for (const order of Array.isArray(data.pedidos) ? data.pedidos : []) {
    const number = Number(order.numped)
    if (Number.isSafeInteger(number) && customerOrderStatuses.has(order.status)) {
      statuses.set(number, {
        status: order.status,
        code: String(order.posicao || '').trim().slice(0, 20),
        label: String(order.statusReal || '').trim().slice(0, 80) || 'Em análise',
      })
    }
  }
  return statuses
}

async function fetchWinthorCustomerByDocument(document) {
  const config = omegaApiConfig()
  if (!config) throw new OmegaApiError('A consulta de clientes do WinThor ainda não está configurada.', 503)
  let response
  try {
    response = await fetch(`${config.url}/v1/winthor/clientes/por-documento`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.key,
        'X-Client-Name': 'omega-ecommerce',
      },
      body: JSON.stringify({ documento: document }),
      signal: AbortSignal.timeout(12_000),
    })
  } catch {
    throw new OmegaApiError('Não foi possível consultar o cliente no WinThor agora.', 503)
  }
  const text = await response.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = {} }
  if (response.status === 404 && data.detail === 'Not Found') {
    try {
      response = await fetch(`${config.url}/v1/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': config.key,
          'X-Client-Name': 'omega-ecommerce',
        },
        body: JSON.stringify({
          sql: `SELECT codcli AS codigo, cliente AS nome, fantasia,
                       regexp_replace(cnpj, '[^0-9]', '', 'g') AS documento
                FROM filial.dcliente
                WHERE regexp_replace(cnpj, '[^0-9]', '', 'g') = %s
                ORDER BY codcli
                LIMIT 1`,
          params: [document],
          max_rows: 1,
        }),
        signal: AbortSignal.timeout(12_000),
      })
      const fallbackText = await response.text()
      data = fallbackText ? JSON.parse(fallbackText) : {}
      if (response.ok && Array.isArray(data.rows) && data.rows.length) {
        const record = Object.fromEntries(data.columns.map((column, index) => [column, data.rows[0][index]]))
        data = { cliente: record }
      } else if (response.ok) {
        return null
      }
    } catch {
      throw new OmegaApiError('Não foi possível consultar o cliente no WinThor agora.', 503)
    }
  } else if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    const status = response.status === 401 ? 502 : (response.status >= 500 ? 503 : 502)
    throw new OmegaApiError(data.detail || 'Não foi possível consultar o cliente no WinThor.', status)
  }
  const customer = data.cliente
  const code = Number(customer?.codigo)
  if (!Number.isSafeInteger(code) || code < 1 || digits(customer?.documento) !== digits(document)) {
    throw new OmegaApiError('A API retornou um cadastro de cliente inválido.', 502)
  }
  return { code, name: String(customer.nome || ''), tradeName: String(customer.fantasia || '') }
}

async function refreshStaleOrderStatuses(orders) {
  if (!omegaApiConfig()) return
  const now = Date.now()
  const staleOrders = orders.filter((order) => order.winthor_order_number && (
    !order.winthor_status_checked_at
    || now - new Date(order.winthor_status_checked_at).getTime() >= orderStatusCacheMs
  ))
  if (!staleOrders.length) return
  try {
    const statuses = await fetchWinthorOrderStatuses(staleOrders.map((order) => order.winthor_order_number))
    await Promise.all(staleOrders.map(async (order) => {
      const winthorOrderNumber = Number(order.winthor_order_number)
      const winthorStatus = statuses.get(winthorOrderNumber)
      if (!winthorStatus) return
      const checkedAt = new Date()
      await pool.query(
        `UPDATE orders SET status=$2, winthor_status_code=$3, winthor_status_label=$4,
           winthor_status_checked_at=$5,
           updated_at=CASE WHEN status<>$2 THEN CURRENT_TIMESTAMP ELSE updated_at END
         WHERE id=$1 AND winthor_order_number=$6`,
        [order.id, winthorStatus.status, winthorStatus.code, winthorStatus.label, checkedAt, winthorOrderNumber],
      )
      order.status = winthorStatus.status
      order.winthor_status_code = winthorStatus.code
      order.winthor_status_label = winthorStatus.label
      order.winthor_status_checked_at = checkedAt
    }))
  } catch (error) {
    console.warn(`[orders] consulta de status adiada: ${error instanceof Error ? error.message : 'falha desconhecida'}`)
  }
}

async function listOrders(whereClause = '', params = []) {
  const result = await pool.query(
    `SELECT o.id, o.status, o.winthor_order_number, o.winthor_status_code,
            o.winthor_status_label, o.winthor_status_checked_at,
            o.winthor_entered_at, o.payment_plan, o.payment_plan_label, o.total, o.notes, o.created_at, o.updated_at,
            o.cancelled_at, o.cancelled_by,
            c.id AS customer_id, c.legal_name, c.trade_name, c.document, c.email, c.phone,
            su.name AS winthor_entered_by_name
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     LEFT JOIN staff_users su ON su.id = o.winthor_entered_by_staff_user_id
     ${whereClause}
     ORDER BY o.created_at DESC`,
    params,
  )
  await refreshStaleOrderStatuses(result.rows)
  const orderIds = result.rows.map((order) => Number(order.id))
  let itemRows = []
  if (orderIds.length) {
    const placeholders = orderIds.map((_, index) => `$${index + 1}`).join(',')
    const items = await pool.query(
      `SELECT oi.id, oi.order_id, p.id AS product_id, p.external_id AS code, p.name,
              oi.boxes, COALESCE(oi.units, oi.boxes * oi.units_per_box) AS units,
              oi.units_per_box, oi.unit_price, oi.line_total
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
    winthorOrderNumber: order.winthor_order_number == null ? null : Number(order.winthor_order_number),
    winthorStatusCode: order.winthor_status_code || '',
    winthorStatusLabel: order.winthor_status_label || '',
    statusUpdatedAt: order.winthor_status_checked_at,
    enteredAt: order.winthor_entered_at,
    enteredBy: order.winthor_entered_by_name || '',
    paymentPlan: order.payment_plan_label || order.payment_plan,
    paymentPlanLabel: order.payment_plan_label || '',
    total: Number(order.total),
    notes: order.notes || '',
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    cancelledAt: order.cancelled_at,
    cancelledBy: order.cancelled_by || '',
    canCancel: order.status === 'analysis' && order.winthor_order_number == null,
    customer: {
      id: Number(order.customer_id), legalName: order.legal_name, tradeName: order.trade_name,
      document: order.document, email: order.email, phone: order.phone,
    },
    items: itemRows.filter((item) => Number(item.order_id) === Number(order.id)).map((item) => ({
      id: Number(item.id), productId: Number(item.product_id), code: Number(item.code), name: item.name,
      boxes: Number(item.boxes), units: Number(item.units), unitsPerBox: Number(item.units_per_box),
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

async function findMissingBannerDestination(database, banners) {
  const configurations = {
    sections: { column: 'section_code', label: 'seção' },
    products: { column: 'external_id', label: 'produto' },
    suppliers: { column: 'supplier_id', label: 'fornecedor' },
  }
  for (const banner of banners) {
    if (banner.destinationType === 'navigation') continue
    const configuration = configurations[banner.destinationType]
    const codes = [...new Set(banner.destinationValues.map(Number))]
    const result = await database.query(
      `SELECT DISTINCT ${configuration.column} AS code FROM products
       WHERE active=TRUE AND ${configuration.column} = ANY($1::int[])`,
      [codes],
    )
    const availableCodes = new Set(result.rows.map((row) => Number(row.code)))
    const missingCode = codes.find((code) => !availableCodes.has(code))
    if (missingCode) return { label: configuration.label, code: missingCode }
  }
  return null
}

function bannerDestinationUrl(banner) {
  const codes = banner.destinationValues.join(',')
  if (banner.destinationType === 'sections') return `/?secoes=${codes}#produtos`
  if (banner.destinationType === 'products') return `/?produtos=${codes}#produtos`
  if (banner.destinationType === 'suppliers') return `/?fornecedores=${codes}#produtos`
  return banner.navigationPath || '/#produtos'
}

function postgresIntegerArray(values) {
  return `{${values.map(Number).join(',')}}`
}

function decodeProductImage(dataUrl) {
  const match = /^data:(image\/webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''))
  if (!match) throw new Error('Imagem inválida. A foto do produto deve estar no formato WEBP.')
  const data = Buffer.from(match[2], 'base64')
  if (!data.length || data.length > 5 * 1024 * 1024) throw new Error('A foto deve ter no máximo 5 MB.')
  return { mime: match[1], data }
}

function productImageUrl(row) {
  if (row.image_hidden) return null
  if (row.image_uploaded) {
    const version = row.image_updated_at ? new Date(row.image_updated_at).getTime() : Date.now()
    return `/api/products/${row.id}/image?v=${version}`
  }
  return row.image_path || null
}

const money2 = (value) => Math.round(Number(value || 0) * 100) / 100
const PRICE_TABLES = [1, 2, 3, 4, 5, 6, 7]
const priceTableOf = (value) => (PRICE_TABLES.includes(Number(value)) ? Number(value) : 1)
// Coluna segura: o número é validado contra PRICE_TABLES antes de entrar no SQL.
const priceColumn = (table) => `price_${priceTableOf(table)}`

// Região de preço e planos do cliente vindos do WinThor. Sem condições sincronizadas
// (cadastro em análise ou ainda sem CODCLI), o cliente não tem região e não vê preço.
async function customerPricing(database, customer) {
  if (!customer) return null
  const result = await database.query(
    'SELECT price_region, payment_plans FROM customer_commercial_conditions WHERE customer_id=$1',
    [customer.id],
  )
  const row = result.rows[0]
  const plans = (Array.isArray(row?.payment_plans) ? row.payment_plans : []).map((plan) => ({
    code: String(plan.code),
    label: String(plan.label),
    priceTable: priceTableOf(plan.priceTable),
  }))
  const region = row?.price_region != null ? Number(row.price_region) : null
  return { region, plans, priceTables: [...new Set(plans.map((plan) => plan.priceTable))] }
}

// Menor preço positivo entre as tabelas dos planos liberados para o cliente.
function lowestPlanPrice(row, priceTables) {
  const prices = priceTables.map((table) => Number(row?.[priceColumn(table)])).filter((price) => price > 0)
  return prices.length ? Math.min(...prices) : null
}

// Calcula as linhas do carrinho com o preço da região do cliente na tabela do plano escolhido.
async function priceCartItems(database, pricing, plan, items) {
  const productIds = [...new Set(items.map((item) => item.productId))]
  const placeholders = productIds.map((_, index) => `$${index + 2}`).join(',')
  const result = await database.query(
    `SELECT p.id, p.external_id, p.name, p.units_per_box, p.sales_multiple, CASE WHEN rp.${priceColumn(plan.priceTable)} > 0 THEN rp.${priceColumn(plan.priceTable)} END AS price
     FROM products p
     LEFT JOIN region_prices rp ON rp.product_id = p.id AND rp.region = $1
     WHERE p.active = TRUE AND p.id IN (${placeholders})`,
    [pricing.region, ...productIds],
  )
  const productMap = new Map(result.rows.map((product) => [Number(product.id), product]))
  if (productMap.size !== productIds.length) throw new RequestError('Um ou mais produtos não estão disponíveis.')
  const lines = items.map((item) => {
    const product = productMap.get(item.productId)
    if (product.price == null) {
      throw new RequestError(`O produto ${product.external_id} - ${product.name} está sem preço para o seu cadastro. Remova-o do carrinho.`)
    }
    const units = item.quantity
    const salesMultiple = Math.max(1, Number(product.sales_multiple))
    if (units < salesMultiple || units % salesMultiple !== 0) {
      throw new RequestError(`A quantidade do produto ${product.external_id} deve ser um múltiplo de ${salesMultiple} unidades.`)
    }
    const unitPrice = Number(product.price)
    return {
      product,
      units,
      boxes: Math.max(1, Math.ceil(units / Number(product.units_per_box))),
      unitPrice,
      lineTotal: money2(units * unitPrice),
    }
  })
  return { lines, total: money2(lines.reduce((sum, line) => sum + line.lineTotal, 0)) }
}

// Só pedidos ainda em análise e sem NUMPED podem ser cancelados.
async function cancelOrder(orderId, { customerId = null, cancelledBy }) {
  const ownerClause = customerId ? ' AND customer_id=$3' : ''
  const params = customerId ? [orderId, cancelledBy, customerId] : [orderId, cancelledBy]
  const result = await pool.query(
    `UPDATE orders SET status='cancelled', cancelled_at=CURRENT_TIMESTAMP, cancelled_by=$2, updated_at=CURRENT_TIMESTAMP
     WHERE id=$1${ownerClause} AND status='analysis' AND winthor_order_number IS NULL
     RETURNING id`,
    params,
  )
  if (result.rows.length) return
  const current = await pool.query(
    `SELECT status, winthor_order_number FROM orders WHERE id=$1${customerId ? ' AND customer_id=$2' : ''}`,
    customerId ? [orderId, customerId] : [orderId],
  )
  if (!current.rows.length) throw new RequestError('Pedido não encontrado.', 404)
  if (current.rows[0].status === 'cancelled') throw new RequestError('Este pedido já foi cancelado.', 409)
  throw new RequestError(
    `Este pedido já foi vinculado ao WinThor (NUMPED ${current.rows[0].winthor_order_number}) e não pode mais ser cancelado pelo e-commerce.`,
    409,
  )
}

// Crédito disponível = LIMCRED - títulos em aberto - pedidos não faturados no WinThor
// - pedidos do e-commerce que ainda não estavam no WinThor na última leitura.
async function customerCreditSummary(database, customerId, { lock = false } = {}) {
  const conditionsResult = await database.query(
    `SELECT credit_limit, open_titles_amount, open_orders_amount, payment_plans, source_updated_at, updated_at
     FROM customer_commercial_conditions WHERE customer_id=$1${lock ? ' FOR UPDATE' : ''}`,
    [customerId],
  )
  if (!conditionsResult.rows.length) return null
  const row = conditionsResult.rows[0]
  const pendingResult = await database.query(
    `SELECT COALESCE(SUM(total),0) AS total FROM orders
     WHERE customer_id=$1 AND status <> 'cancelled'
       AND (winthor_order_number IS NULL OR $2::timestamptz IS NULL OR winthor_entered_at::timestamptz > $2::timestamptz)`,
    [customerId, row.source_updated_at || null],
  )
  const creditLimit = money2(row.credit_limit)
  const openTitlesAmount = money2(row.open_titles_amount)
  const openOrdersAmount = money2(row.open_orders_amount)
  const pendingOrdersAmount = money2(pendingResult.rows[0].total)
  return {
    creditLimit,
    openTitlesAmount,
    openOrdersAmount,
    pendingOrdersAmount,
    availableCredit: Math.max(0, money2(creditLimit - openTitlesAmount - openOrdersAmount - pendingOrdersAmount)),
    paymentPlans: Array.isArray(row.payment_plans) ? row.payment_plans : [],
    updatedAt: row.source_updated_at || row.updated_at,
  }
}

function validIntegrationToken(request) {
  const expected = String(process.env.PRODUCT_SYNC_TOKEN || '')
  const received = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!expected || !received) return false
  const expectedBuffer = Buffer.from(expected)
  const receivedBuffer = Buffer.from(received)
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer)
}

app.post('/api/auth/check-email', publicLookupLimiter, async (request, response, next) => {
  try {
    const parsed = emailCheckSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
    const email = parsed.data.email
    const [staffResult, customerResult] = await Promise.all([
      pool.query(
        'SELECT id FROM staff_users WHERE LOWER(email)=LOWER($1) AND active=TRUE LIMIT 1',
        [email],
      ),
      pool.query(
        `SELECT id, supabase_user_id
         FROM customers WHERE LOWER(email)=LOWER($1) AND active=TRUE
         ORDER BY CASE WHEN supabase_user_id IS NOT NULL THEN 0 ELSE 1 END
         LIMIT 1`,
        [email],
      ),
    ])
    if (staffResult.rows.length) {
      return response.json({ exists: true, accountType: 'staff' })
    }
    if (customerResult.rows[0]?.supabase_user_id) {
      return response.json({ exists: true, accountType: 'customer' })
    }
    const authUser = await findSupabaseUserByEmail(email)
    if (authUser) {
      return response.json({
        exists: true,
        accountType: authUser.user_metadata?.account_type === 'staff' ? 'staff' : 'customer',
      })
    }
    return response.json({ exists: false, existingCustomerRecord: Boolean(customerResult.rows.length) })
  } catch (error) {
    return next(error)
  }
})

app.post('/api/auth/link', authLinkLimiter, async (request, response, next) => {
  if (request.authError) return response.status(401).json({ message: 'Sua sessão expirou. Entre novamente.' })
  if (!request.authUser) return response.status(401).json({ message: 'Confirme seu e-mail antes de continuar.' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const existingStaff = await client.query(
      `SELECT id, name, email, role, supabase_user_id
       FROM staff_users
       WHERE LOWER(email) = LOWER($1) AND active = TRUE
       LIMIT 1 FOR UPDATE`,
      [request.authUser.email],
    )
    if (existingStaff.rows.length) {
      const staff = existingStaff.rows[0]
      if (staff.supabase_user_id === request.authUser.id) {
        await client.query('COMMIT')
        return response.json({ accountType: 'staff', user: staffJson(staff) })
      }
      if (staff.supabase_user_id && staff.supabase_user_id !== request.authUser.id) {
        await client.query('ROLLBACK')
        return response.status(409).json({ message: 'Este usuário interno já está vinculado a outra conta.' })
      }
      await client.query('ROLLBACK')
      return response.status(409).json({
        message: 'Este e-mail é reservado para uma conta de gestão. O acesso deve ser ativado pelo administrador.',
        code: 'STAFF_EMAIL_RESERVED',
      })
    }

    const parsedProfile = customerProfileSchema.safeParse(request.body?.profile)
    const profile = parsedProfile.success ? parsedProfile.data : null
    if (request.body?.profile && !parsedProfile.success) {
      await client.query('ROLLBACK')
      return response.status(400).json({ message: parsedProfile.error.issues[0].message, issues: parsedProfile.error.issues })
    }
    if (profile && profile.email.toLowerCase() !== request.authUser.email) {
      await client.query('ROLLBACK')
      return response.status(400).json({ message: 'O e-mail confirmado precisa ser o mesmo informado no cadastro.' })
    }

    const metadataDocument = digits(request.authUser.userMetadata?.document)
    if (profile && metadataDocument && profile.document !== metadataDocument) {
      await client.query('ROLLBACK')
      return response.status(400).json({ message: 'O CPF ou CNPJ não corresponde ao cadastro iniciado.' })
    }
    const document = profile?.document || ''
    let customerResult = await client.query(
      `SELECT id, external_id, document, person_type, legal_name, trade_name, phone, email,
              postal_code, address_line, address_number, address_complement, neighborhood, city, state,
              sales_channel, registration_status, supabase_user_id
       FROM customers
       WHERE supabase_user_id=$1
          OR LOWER(email)=LOWER($2)
          OR ($3<>'' AND document=$3)
       ORDER BY CASE WHEN supabase_user_id=$1 THEN 0 ELSE 1 END
       LIMIT 1 FOR UPDATE`,
      [request.authUser.id, request.authUser.email, document],
    )

    if ((!customerResult.rows.length || !customerResult.rows[0].supabase_user_id) && !profile) {
      await client.query('ROLLBACK')
      return response.status(409).json({
        message: 'Complete a identificação do cliente para vincular esta conta.',
        code: 'PROFILE_REQUIRED',
      })
    }

    if (profile) {
      const emailOwner = await client.query(
        'SELECT id FROM customers WHERE LOWER(email)=LOWER($1) AND document<>$2 LIMIT 1',
        [profile.email, profile.document],
      )
      if (emailOwner.rows.length) {
        await client.query('ROLLBACK')
        return response.status(409).json({ message: 'Este e-mail já está vinculado a outro cliente.' })
      }

      if (customerResult.rows.length) {
        const existing = customerResult.rows[0]
        if (existing.supabase_user_id && existing.supabase_user_id !== request.authUser.id) {
          await client.query('ROLLBACK')
          return response.status(409).json({ message: 'Este cliente já está vinculado a outra conta.' })
        }
        customerResult = await client.query(
          `UPDATE customers SET
             legal_name=$2, trade_name=$3, phone=$4, email=$5, supabase_user_id=$6,
             password_hash=NULL, postal_code=$7, address_line=$8, address_number=$9,
             address_complement=$10, neighborhood=$11, city=$12, state=$13,
             registration_status=CASE WHEN supabase_user_id IS NULL THEN 'pending' ELSE registration_status END,
             approved_at=CASE WHEN supabase_user_id IS NULL THEN NULL ELSE approved_at END,
             approved_by_staff_user_id=CASE WHEN supabase_user_id IS NULL THEN NULL ELSE approved_by_staff_user_id END,
             updated_at=CURRENT_TIMESTAMP
           WHERE id=$1
           RETURNING id, external_id, document, person_type, legal_name, trade_name, phone, email,
                     postal_code, address_line, address_number, address_complement, neighborhood,
                     city, state, sales_channel, registration_status`,
          [
            existing.id, profile.legalName, profile.tradeName, profile.phone, profile.email,
            request.authUser.id, profile.postalCode, profile.addressLine, profile.addressNumber,
            profile.addressComplement, profile.neighborhood, profile.city, profile.state,
          ],
        )
      } else {
        customerResult = await client.query(
          `INSERT INTO customers (
             document, person_type, legal_name, trade_name, phone, email, supabase_user_id,
             postal_code, address_line, address_number, address_complement, neighborhood, city, state,
             registration_status
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending')
           RETURNING id, external_id, document, person_type, legal_name, trade_name, phone, email,
                     postal_code, address_line, address_number, address_complement, neighborhood,
                     city, state, sales_channel, registration_status`,
          [
            profile.document, profile.document.length === 11 ? 'CPF' : 'CNPJ', profile.legalName,
            profile.tradeName, profile.phone, profile.email, request.authUser.id, profile.postalCode,
            profile.addressLine, profile.addressNumber, profile.addressComplement, profile.neighborhood,
            profile.city, profile.state,
          ],
        )
      }
    } else {
      const existing = customerResult.rows[0]
      if (existing.supabase_user_id && existing.supabase_user_id !== request.authUser.id) {
        await client.query('ROLLBACK')
        return response.status(409).json({ message: 'Este cliente já está vinculado a outra conta.' })
      }
      customerResult = await client.query(
        `UPDATE customers SET supabase_user_id=$1, password_hash=NULL, updated_at=CURRENT_TIMESTAMP
         WHERE id=$2
         RETURNING id, external_id, document, person_type, legal_name, trade_name, phone, email,
                   postal_code, address_line, address_number, address_complement, neighborhood,
                   city, state, sales_channel, registration_status`,
        [request.authUser.id, existing.id],
      )
    }

    await client.query('COMMIT')
    return response.json({ accountType: 'customer', customer: customerJson(customerResult.rows[0]) })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    if (error?.code === '23505') return response.status(409).json({ message: 'Este acesso já está vinculado a outro cadastro.' })
    return next(error)
  } finally {
    client.release()
  }
})

app.post('/api/auth/login', async (request, response, next) => {
  try {
    if (supabaseAuthConfigured()) {
      return response.status(410).json({ message: 'Use a autenticação segura do Supabase para entrar.' })
    }
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
    const result = await pool.query(
      `SELECT id, external_id, document, person_type, legal_name, trade_name, phone, email,
              postal_code, address_line, address_number, address_complement, neighborhood, city, state,
              sales_channel, registration_status, password_hash
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
  if (request.authError) return response.status(401).json({ message: 'Sua sessão expirou. Entre novamente.' })
  if (request.customer) return response.json({ accountType: 'customer', customer: customerJson(request.customer) })
  if (request.staff) return response.json({ accountType: 'staff', user: staffJson(request.staff) })
  return response.status(401).json({ message: 'Sessão não autenticada.' })
})

app.patch('/api/customer/profile', async (request, response, next) => {
  if (!request.customer) return response.status(401).json({ message: 'Entre na sua conta para alterar seus dados.' })
  try {
    const parsed = customerUpdateSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
    const profile = parsed.data
    const result = await pool.query(
      `UPDATE customers SET legal_name=$2, trade_name=$3, phone=$4,
         postal_code=$5, address_line=$6, address_number=$7, address_complement=$8,
         neighborhood=$9, city=$10, state=$11, updated_at=CURRENT_TIMESTAMP
       WHERE id=$1 AND active=TRUE
       RETURNING id, external_id, document, person_type, legal_name, trade_name, phone, email,
                 postal_code, address_line, address_number, address_complement, neighborhood,
                 city, state, sales_channel, registration_status`,
      [
        request.customer.id, profile.legalName, profile.tradeName, profile.phone,
        profile.postalCode, profile.addressLine, profile.addressNumber, profile.addressComplement,
        profile.neighborhood, profile.city, profile.state,
      ],
    )
    if (!result.rows.length) return response.status(404).json({ message: 'Cliente não encontrado.' })
    return response.json({ customer: customerJson(result.rows[0]) })
  } catch (error) {
    return next(error)
  }
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
  return response.json({ user: { ...staffJson(request.staff), authProvider: request.authUser ? 'supabase' : 'legacy' } })
})

app.put('/api/staff/password', requireStaff, async (request, response, next) => {
  try {
    if (request.authUser) {
      return response.status(400).json({ message: 'Altere a senha desta conta pelo provedor seguro de autenticação.' })
    }
    const parsed = staffPasswordSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
    const result = await pool.query('SELECT password_hash FROM staff_users WHERE id=$1 AND active=TRUE', [request.staff.id])
    if (!result.rows.length || !verifyPassword(parsed.data.currentPassword, result.rows[0].password_hash)) {
      return response.status(401).json({ message: 'A senha atual está incorreta.' })
    }
    await pool.query(
      'UPDATE staff_users SET password_hash=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$1',
      [request.staff.id, hashPassword(parsed.data.newPassword)],
    )
    return response.status(204).end()
  } catch (error) {
    return next(error)
  }
})

app.get('/api/banners', async (request, response, next) => {
  try {
    const placement = request.query.placement === 'catalog' ? 'catalog' : 'hero'
    const result = await pool.query(
      `SELECT b.id, b.title, b.alt_text, b.image_path, b.image_data IS NOT NULL AS uploaded,
              b.target_url, b.section_code, b.destination_type, b.destination_values, b.navigation_path,
              b.position, b.active, b.placement,
              b.starts_at, b.ends_at, b.updated_at,
              tx.section_name, tx.department_code, tx.department_name
       FROM banners b
       LEFT JOIN (
         SELECT section_code, MIN(section) AS section_name,
                MIN(department_code) AS department_code, MIN(department) AS department_name
         FROM products
         WHERE active=TRUE AND section_code IS NOT NULL
         GROUP BY section_code
       ) tx ON tx.section_code=b.section_code
       WHERE b.active = TRUE AND b.placement = $1
         AND (b.starts_at IS NULL OR b.starts_at <= CURRENT_TIMESTAMP)
         AND (b.ends_at IS NULL OR b.ends_at > CURRENT_TIMESTAMP)
       ORDER BY b.position, b.id`,
      [placement],
    )
    return response.json({ banners: result.rows.map((banner) => ({
      id: Number(banner.id),
      title: banner.title,
      altText: banner.alt_text,
      imageUrl: banner.uploaded ? `/api/banners/${banner.id}/image?v=${new Date(banner.updated_at).getTime()}` : banner.image_path,
      targetUrl: banner.target_url,
      sectionCode: banner.section_code === null ? null : Number(banner.section_code),
      destinationType: banner.destination_type,
      destinationValues: Array.isArray(banner.destination_values) ? banner.destination_values.map(Number) : [],
      navigationPath: banner.navigation_path,
      sectionName: banner.section_name || '',
      departmentCode: banner.department_code === null ? null : Number(banner.department_code),
      departmentName: banner.department_name || '',
      position: Number(banner.position),
      active: banner.active,
      placement: banner.placement,
      startsAt: banner.starts_at,
      endsAt: banner.ends_at,
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

app.get('/api/products/:id/image', async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT image_data, image_mime FROM products
       WHERE id=$1 AND active=TRUE AND image_hidden=FALSE LIMIT 1`,
      [request.params.id],
    )
    if (!result.rows[0]?.image_data) return response.status(404).end()
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    return response.type(result.rows[0].image_mime || 'image/webp').send(result.rows[0].image_data)
  } catch (error) {
    return next(error)
  }
})

app.post('/api/integrations/products/sync', async (request, response, next) => {
  if (!process.env.PRODUCT_SYNC_TOKEN) {
    return response.status(503).json({ message: 'Integração de produtos ainda não configurada.' })
  }
  if (!validIntegrationToken(request)) {
    return response.status(401).json({ message: 'Credencial de integração inválida.' })
  }
  const parsed = productSyncSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })

  const uniqueProducts = [...new Map(parsed.data.products.map((product) => [product.externalId, product])).values()]
  const minimumProducts = Math.max(1, Number(process.env.PRODUCT_SYNC_MIN_COUNT) || 100)
  if (uniqueProducts.length < minimumProducts) {
    return response.status(409).json({
      message: `Sincronização cancelada: foram recebidos ${uniqueProducts.length} produtos, abaixo do mínimo de segurança (${minimumProducts}).`,
    })
  }
  const currentCountResult = await pool.query("SELECT COUNT(*)::int AS count FROM products WHERE company='Filial' AND active=TRUE")
  const currentActiveCount = Number(currentCountResult.rows[0].count)
  if (currentActiveCount >= minimumProducts && uniqueProducts.length < Math.floor(currentActiveCount * 0.5)) {
    return response.status(409).json({
      message: `Sincronização cancelada: a carga reduziria o catálogo de ${currentActiveCount} para ${uniqueProducts.length} produtos ativos.`,
    })
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (process.env.DATABASE_URL) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('omega_ecommerce_product_sync'))")
    }
    await client.query('DROP TABLE IF EXISTS ecommerce_product_stage')
    await client.query(
      `CREATE TABLE ecommerce_product_stage (
        company VARCHAR(40), external_id INTEGER, supplier_id INTEGER, brand TEXT, name TEXT,
        package TEXT, master_package TEXT, units_per_box INTEGER, sales_multiple INTEGER, min_boxes INTEGER,
        unit_price NUMERIC(14,2), list_unit_price NUMERIC(14,2),
        retail_unit_price NUMERIC(14,2), network_unit_price NUMERIC(14,2),
        department_code INTEGER, department TEXT, section_code INTEGER, section TEXT,
        ean TEXT, manufacturer_code TEXT, ncm_code TEXT,
        active BOOLEAN, price_date DATE
      )`,
    )

    const rows = uniqueProducts.map((product) => [
      'Filial', product.externalId, product.supplierId, product.brand, product.name,
      product.package, product.masterPackage, product.unitsPerBox, product.salesMultiple, product.minBoxes,
      product.retailUnitPrice, product.retailUnitPrice, product.retailUnitPrice,
      product.networkUnitPrice || product.retailUnitPrice, product.departmentCode, product.department,
      product.sectionCode, product.section, product.ean, product.manufacturerCode, product.ncm, true, product.priceDate || null,
    ])
    const batchSize = 250
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize)
      const params = []
      const values = batch.map((row) => {
        const placeholders = row.map((value) => {
          params.push(value)
          return `$${params.length}`
        })
        return `(${placeholders.join(',')})`
      })
      await client.query(`INSERT INTO ecommerce_product_stage VALUES ${values.join(',')}`, params)
    }

    const insertedResult = await client.query(
      `SELECT COUNT(*)::int AS count FROM ecommerce_product_stage s
       LEFT JOIN products p ON p.company=s.company AND p.external_id=s.external_id
       WHERE p.id IS NULL`,
    )
    const updatedResult = await client.query(
      `SELECT COUNT(*)::int AS count FROM ecommerce_product_stage s
       JOIN products p ON p.company=s.company AND p.external_id=s.external_id
       WHERE COALESCE(p.supplier_id,-1)<>COALESCE(s.supplier_id,-1)
          OR COALESCE(p.brand,'')<>COALESCE(s.brand,'') OR COALESCE(p.name,'')<>COALESCE(s.name,'')
          OR COALESCE(p.package,'')<>COALESCE(s.package,'') OR COALESCE(p.master_package,'')<>COALESCE(s.master_package,'')
          OR p.units_per_box<>s.units_per_box OR p.sales_multiple<>s.sales_multiple OR p.min_boxes<>s.min_boxes
          OR p.unit_price<>s.unit_price OR COALESCE(p.list_unit_price,-1)<>COALESCE(s.list_unit_price,-1)
          OR COALESCE(p.retail_unit_price,-1)<>COALESCE(s.retail_unit_price,-1)
          OR COALESCE(p.network_unit_price,-1)<>COALESCE(s.network_unit_price,-1)
          OR COALESCE(p.department_code,-1)<>COALESCE(s.department_code,-1)
          OR COALESCE(p.department,'')<>COALESCE(s.department,'')
          OR COALESCE(p.section_code,-1)<>COALESCE(s.section_code,-1)
          OR COALESCE(p.section,'')<>COALESCE(s.section,'')
          OR COALESCE(p.ean,'')<>COALESCE(s.ean,'')
          OR COALESCE(p.manufacturer_code,'')<>COALESCE(s.manufacturer_code,'')
          OR COALESCE(p.ncm_code,'')<>COALESCE(s.ncm_code,'') OR p.active<>s.active
          OR COALESCE(p.price_date,DATE '1900-01-01')<>COALESCE(s.price_date,DATE '1900-01-01')`,
    )
    const deactivatedResult = await client.query(
      `SELECT COUNT(*)::int AS count FROM products p
       WHERE p.company='Filial' AND p.active=TRUE
         AND p.external_id NOT IN (SELECT s.external_id FROM ecommerce_product_stage s WHERE s.company='Filial')`,
    )

    await client.query(
      `INSERT INTO products (
         company,external_id,supplier_id,brand,name,package,master_package,units_per_box,
         sales_multiple,min_boxes,unit_price,list_unit_price,retail_unit_price,network_unit_price,
         department_code,department,section_code,section,ean,manufacturer_code,ncm_code,active,price_date,source_category,category
       )
       SELECT company,external_id,supplier_id,brand,name,package,master_package,units_per_box,
              sales_multiple,min_boxes,unit_price,list_unit_price,retail_unit_price,network_unit_price,
              department_code,department,section_code,section,ean,manufacturer_code,ncm_code,active,price_date,'','Sem categoria'
       FROM ecommerce_product_stage
       ON CONFLICT (company,external_id) DO UPDATE SET
         supplier_id=EXCLUDED.supplier_id, brand=EXCLUDED.brand, name=EXCLUDED.name,
         package=EXCLUDED.package, master_package=EXCLUDED.master_package,
         units_per_box=EXCLUDED.units_per_box, sales_multiple=EXCLUDED.sales_multiple, min_boxes=EXCLUDED.min_boxes,
         unit_price=EXCLUDED.unit_price, list_unit_price=EXCLUDED.list_unit_price,
         retail_unit_price=EXCLUDED.retail_unit_price, network_unit_price=EXCLUDED.network_unit_price,
         department_code=EXCLUDED.department_code, department=EXCLUDED.department,
         section_code=EXCLUDED.section_code, section=EXCLUDED.section, ean=EXCLUDED.ean,
         manufacturer_code=EXCLUDED.manufacturer_code, ncm_code=EXCLUDED.ncm_code,
         active=TRUE, price_date=EXCLUDED.price_date, updated_at=CURRENT_TIMESTAMP
       WHERE COALESCE(products.supplier_id,-1)<>COALESCE(EXCLUDED.supplier_id,-1)
          OR COALESCE(products.brand,'')<>COALESCE(EXCLUDED.brand,'') OR COALESCE(products.name,'')<>COALESCE(EXCLUDED.name,'')
          OR COALESCE(products.package,'')<>COALESCE(EXCLUDED.package,'') OR COALESCE(products.master_package,'')<>COALESCE(EXCLUDED.master_package,'')
          OR products.units_per_box<>EXCLUDED.units_per_box OR products.sales_multiple<>EXCLUDED.sales_multiple OR products.min_boxes<>EXCLUDED.min_boxes
          OR products.unit_price<>EXCLUDED.unit_price OR COALESCE(products.list_unit_price,-1)<>COALESCE(EXCLUDED.list_unit_price,-1)
          OR COALESCE(products.retail_unit_price,-1)<>COALESCE(EXCLUDED.retail_unit_price,-1)
          OR COALESCE(products.network_unit_price,-1)<>COALESCE(EXCLUDED.network_unit_price,-1)
          OR COALESCE(products.department_code,-1)<>COALESCE(EXCLUDED.department_code,-1)
          OR COALESCE(products.department,'')<>COALESCE(EXCLUDED.department,'')
          OR COALESCE(products.section_code,-1)<>COALESCE(EXCLUDED.section_code,-1)
          OR COALESCE(products.section,'')<>COALESCE(EXCLUDED.section,'')
          OR COALESCE(products.ean,'')<>COALESCE(EXCLUDED.ean,'')
          OR COALESCE(products.manufacturer_code,'')<>COALESCE(EXCLUDED.manufacturer_code,'')
          OR COALESCE(products.ncm_code,'')<>COALESCE(EXCLUDED.ncm_code,'') OR products.active<>EXCLUDED.active
          OR COALESCE(products.price_date,DATE '1900-01-01')<>COALESCE(EXCLUDED.price_date,DATE '1900-01-01')`,
    )
    await client.query(
      `UPDATE products SET active=FALSE, updated_at=CURRENT_TIMESTAMP
       WHERE company='Filial' AND active=TRUE
         AND external_id NOT IN (SELECT s.external_id FROM ecommerce_product_stage s WHERE s.company='Filial')`,
    )

    const stats = {
      sourceCount: uniqueProducts.length,
      insertedCount: Number(insertedResult.rows[0].count),
      updatedCount: Number(updatedResult.rows[0].count),
      deactivatedCount: Number(deactivatedResult.rows[0].count),
    }
    await client.query(
      `INSERT INTO product_sync_runs
       (finished_at,source_count,inserted_count,updated_count,deactivated_count,status,details)
       VALUES (CURRENT_TIMESTAMP,$1,$2,$3,$4,'success','WinThor via API HTTPS')`,
      [stats.sourceCount, stats.insertedCount, stats.updatedCount, stats.deactivatedCount],
    )
    await client.query('DROP TABLE ecommerce_product_stage')
    await client.query('COMMIT')
    return response.json({ synchronized: true, ...stats })
  } catch (error) {
    await client.query('ROLLBACK')
    return next(error)
  } finally {
    client.release()
  }
})

app.get('/api/integrations/customers', async (request, response) => {
  if (!validIntegrationToken(request)) return response.status(401).json({ message: 'Credencial de integração inválida.' })
  const result = await pool.query(
    `SELECT DISTINCT external_id FROM customers
     WHERE active=TRUE AND registration_status='approved' AND external_id IS NOT NULL
     ORDER BY external_id`,
  )
  return response.json({ externalIds: result.rows.map((row) => Number(row.external_id)) })
})

app.post('/api/integrations/customers/conditions', async (request, response, next) => {
  if (!validIntegrationToken(request)) return response.status(401).json({ message: 'Credencial de integração inválida.' })
  const parsed = customerConditionsSyncSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    let updatedCount = 0
    for (const condition of parsed.data.customers) {
      const result = await client.query(
        `INSERT INTO customer_commercial_conditions
           (customer_id, credit_limit, open_titles_amount, open_orders_amount, price_region, payment_plans, source_updated_at)
         SELECT id,$2::numeric,$5::numeric,$6::numeric,$7::int,$3::jsonb,$4::timestamptz FROM customers WHERE external_id=$1 AND active=TRUE
         ON CONFLICT (customer_id) DO UPDATE SET credit_limit=EXCLUDED.credit_limit,
           open_titles_amount=EXCLUDED.open_titles_amount, open_orders_amount=EXCLUDED.open_orders_amount,
           price_region=COALESCE(EXCLUDED.price_region, customer_commercial_conditions.price_region),
           payment_plans=EXCLUDED.payment_plans, source_updated_at=EXCLUDED.source_updated_at,
           updated_at=CURRENT_TIMESTAMP
         RETURNING customer_id`,
        [condition.externalId, condition.creditLimit, JSON.stringify(condition.paymentPlans), condition.sourceUpdatedAt || null,
          condition.openTitlesAmount, condition.openOrdersAmount, condition.priceRegion ?? null],
      )
      updatedCount += result.rowCount
    }
    await client.query('COMMIT')
    return response.json({ updatedCount })
  } catch (error) {
    await client.query('ROLLBACK')
    return next(error)
  } finally {
    client.release()
  }
})

app.post('/api/integrations/prices/sync', async (request, response, next) => {
  if (!validIntegrationToken(request)) return response.status(401).json({ message: 'Credencial de integração inválida.' })
  const parsed = regionPricesSyncSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
  const regions = [...new Set(parsed.data.regions)]
  const regionSet = new Set(regions)
  const rowMap = new Map()
  for (const row of parsed.data.prices) {
    if (regionSet.has(row[0])) rowMap.set(`${row[0]}:${row[1]}`, row)
  }
  const rows = [...rowMap.values()]
  const minimum = Math.max(1, Number(process.env.PRODUCT_SYNC_MIN_COUNT) || 100)
  if (rows.length < minimum) {
    return response.status(409).json({ message: `Sincronização de preços cancelada: ${rows.length} preços recebidos, abaixo do mínimo de segurança (${minimum}).` })
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (process.env.DATABASE_URL) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('omega_ecommerce_price_sync'))")
    }
    await client.query('DROP TABLE IF EXISTS ecommerce_price_stage')
    await client.query(
      `CREATE TABLE ecommerce_price_stage (
        region INTEGER, external_id INTEGER,
        price_1 NUMERIC(14,6), price_2 NUMERIC(14,6), price_3 NUMERIC(14,6), price_4 NUMERIC(14,6),
        price_5 NUMERIC(14,6), price_6 NUMERIC(14,6), price_7 NUMERIC(14,6)
      )`,
    )
    for (let offset = 0; offset < rows.length; offset += 500) {
      const batch = rows.slice(offset, offset + 500)
      const params = []
      const values = batch.map((row) => `(${row.map((value) => { params.push(value); return `$${params.length}` }).join(',')})`)
      await client.query(`INSERT INTO ecommerce_price_stage VALUES ${values.join(',')}`, params)
    }
    const columns = PRICE_TABLES.map((table) => `price_${table}`)
    // Grava somente preços novos ou alterados.
    const changed = await client.query(
      `INSERT INTO region_prices (region, product_id, ${columns.join(', ')})
       SELECT s.region, p.id, ${columns.map((column) => `s.${column}`).join(', ')}
       FROM ecommerce_price_stage s
       JOIN products p ON p.company='Filial' AND p.external_id=s.external_id
       ON CONFLICT (region, product_id) DO UPDATE SET
         ${columns.map((column) => `${column}=EXCLUDED.${column}`).join(', ')}, updated_at=CURRENT_TIMESTAMP
       WHERE ${columns.map((column) => `COALESCE(region_prices.${column},-1)<>COALESCE(EXCLUDED.${column},-1)`).join(' OR ')}`,
    )
    // Remove regiões que nenhum cliente usa mais e preços excluídos no WinThor.
    const productIds = new Map((await client.query(
      "SELECT id, external_id FROM products WHERE company='Filial'",
    )).rows.map((product) => [Number(product.external_id), Number(product.id)]))
    const incoming = new Set(rows.map((row) => `${row[0]}:${productIds.get(row[1])}`))
    const staleByRegion = new Map()
    for (const current of (await client.query('SELECT region, product_id FROM region_prices')).rows) {
      const region = Number(current.region)
      const productId = Number(current.product_id)
      if (incoming.has(`${region}:${productId}`)) continue
      staleByRegion.set(region, [...(staleByRegion.get(region) || []), productId])
    }
    let removedCount = 0
    for (const [region, staleIds] of staleByRegion) {
      for (let offset = 0; offset < staleIds.length; offset += 1000) {
        const removed = await client.query(
          'DELETE FROM region_prices WHERE region=$1 AND product_id = ANY($2::bigint[])',
          [region, staleIds.slice(offset, offset + 1000)],
        )
        removedCount += removed.rowCount
      }
    }
    await client.query('DROP TABLE ecommerce_price_stage')
    await client.query('COMMIT')
    return response.json({ regions: regions.length, sourceCount: rows.length, changedCount: changed.rowCount, removedCount })
  } catch (error) {
    await client.query('ROLLBACK')
    return next(error)
  } finally {
    client.release()
  }
})

app.post('/api/customer/quote', async (request, response, next) => {
  if (!request.customer) return response.status(401).json({ message: 'Entre na sua conta para calcular o pedido.' })
  const parsed = orderQuoteSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
  try {
    const pricing = await customerPricing(pool, request.customer)
    if (pricing.region == null || !pricing.plans.length) {
      return response.status(503).json({ message: 'As condições comerciais deste cadastro ainda estão sendo atualizadas pelo WinThor.' })
    }
    const requested = parsed.data.paymentPlan
    if (requested && !pricing.plans.some((item) => item.code === requested)) {
      return response.status(400).json({ message: 'O plano de pagamento selecionado não está liberado para este cliente.' })
    }
    const quotes = []
    for (const plan of pricing.plans) {
      try {
        quotes.push({ plan, ...(await priceCartItems(pool, pricing, plan, parsed.data.items)) })
      } catch (error) {
        if (!(error instanceof RequestError)) throw error
        quotes.push({ plan, error })
      }
    }
    const available = quotes.filter((quote) => !quote.error).sort((a, b) => a.total - b.total)
    const selected = requested ? quotes.find((quote) => quote.plan.code === requested) : available[0] || quotes[0]
    if (selected.error) return response.status(selected.error.status).json({ message: selected.error.message })
    return response.json({
      paymentPlan: { code: selected.plan.code, label: selected.plan.label },
      items: selected.lines.map((line) => ({ productId: Number(line.product.id), units: line.units, unitPrice: line.unitPrice, lineTotal: line.lineTotal })),
      total: selected.total,
      planTotals: quotes.map((quote) => ({ code: quote.plan.code, label: quote.plan.label, total: quote.error ? null : quote.total })),
    })
  } catch (error) {
    if (error instanceof RequestError) return response.status(error.status).json({ message: error.message })
    return next(error)
  }
})

app.get('/api/products', async (request, response, next) => {
  try {
    const search = String(request.query.search ?? '').trim()
    const supplier = Number(request.query.supplier)
    const department = Number(request.query.department)
    const section = Number(request.query.section)
    const sort = request.query.sort === 'bestsellers' ? 'bestsellers' : 'featured'
    const limit = Math.min(Math.max(Number(request.query.limit) || 180, 1), 5000)
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 6)

    const params = [cutoff.toISOString().slice(0, 10)]
    const conditions = ['p.active = TRUE']
    if (search) {
      params.push(`%${search}%`)
      conditions.push(`(p.name ILIKE $${params.length} OR p.brand ILIKE $${params.length} OR p.external_id::text ILIKE $${params.length})`)
    }
    if (Number.isSafeInteger(supplier) && supplier > 0) {
      params.push(supplier)
      conditions.push(`p.supplier_id = $${params.length}`)
    }
    if (Number.isSafeInteger(department) && department > 0) {
      params.push(department)
      conditions.push(`p.department_code = $${params.length}`)
    }
    if (Number.isSafeInteger(section) && section > 0) {
      params.push(section)
      conditions.push(`p.section_code = $${params.length}`)
    }
    const pricing = await customerPricing(pool, request.customer)
    const priceTables = pricing?.region != null ? pricing.priceTables : []
    params.push(priceTables.length ? pricing.region : -1)
    const regionParam = params.length
    const priceColumns = priceTables.map((table) => `, rp.${priceColumn(table)}`).join('')
    params.push(limit)

    const hasImage = `(p.image_hidden=FALSE AND (p.image_data IS NOT NULL OR p.image_path IS NOT NULL))`
    const orderBy = sort === 'bestsellers'
      ? `weekly_sales DESC, ${hasImage} DESC, p.name`
      : `${hasImage} DESC, weekly_sales DESC, p.name`

    const result = await pool.query(
      `WITH weekly AS (
         SELECT product_id, SUM(quantity) AS units
         FROM sales
         WHERE sold_at >= $1
         GROUP BY product_id
       )
       SELECT p.id, p.external_id, p.supplier_id, p.brand, p.name, p.package, p.master_package,
              p.units_per_box, p.sales_multiple, p.min_boxes, p.unit_price, p.list_unit_price,
              p.retail_unit_price, p.network_unit_price,
              p.category, p.department_code, p.department, p.section_code, p.section, p.stock_units, p.image_path,
              p.image_data IS NOT NULL AS image_uploaded, p.image_hidden, p.image_updated_at, p.ean,
              p.manufacturer_code, p.ncm_code,
              p.price_date, COALESCE(w.units, 0) AS weekly_sales${priceColumns}
       FROM products p
       LEFT JOIN weekly w ON w.product_id = p.id
       LEFT JOIN region_prices rp ON rp.product_id = p.id AND rp.region = $${regionParam}
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT $${params.length}`,
      params,
    )

    response.json({
      products: result.rows.map((row) => {
        const customerPrice = request.customer ? lowestPlanPrice(row, priceTables) : null
        return {
        id: row.id,
        code: row.external_id,
        supplierId: row.supplier_id,
        brand: row.brand,
        name: row.name,
        package: row.package,
        masterPackage: row.master_package,
        unitsPerBox: Number(row.units_per_box),
        salesMultiple: Number(row.sales_multiple),
        minBoxes: Number(row.min_boxes),
        unitPrice: customerPrice,
        listUnitPrice: customerPrice,
        category: row.section || 'Sem seção',
        categories: row.section ? [row.section] : [],
        departmentCode: Number(row.department_code || 0),
        department: row.department,
        sectionCode: Number(row.section_code || 0),
        section: row.section,
        stockUnits: Number(row.stock_units),
        image: productImageUrl(row),
        ean: row.ean || '',
        manufacturerCode: row.manufacturer_code || '',
        ncm: row.ncm_code || '',
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

const partnerLogoBySupplier = new Map([
  [117, '/assets/partners/117.png'],
  [967, '/assets/partners/967.png'],
  [1481, '/assets/partners/1481.png'],
  [1630, '/assets/partners/1630.png'],
  [4698, '/assets/partners/4698.png'],
])
const partnerNameBySupplier = new Map([
  [117, 'Bombril S.A.'],
  [967, 'Maratá'],
  [1481, 'Realeza'],
  [1630, 'Panasonic'],
  [4698, 'Assim'],
])

app.get('/api/catalog/navigation', async (_request, response, next) => {
  try {
    const taxonomyResult = await pool.query(
      `SELECT department_code, department, section_code, section, COUNT(*)::int AS product_count
       FROM products
       WHERE active=TRUE
         AND COALESCE(department,'') <> '' AND COALESCE(section,'') <> ''
       GROUP BY department_code, department, section_code, section
       ORDER BY department, section`,
    )
    const departmentMap = new Map()
    for (const row of taxonomyResult.rows) {
      const code = Number(row.department_code || 0)
      const productCount = Number(row.product_count)
      const departmentKey = code > 0 ? `code:${code}` : `name:${row.department}`
      const department = departmentMap.get(departmentKey) || {
        code,
        name: row.department,
        productCount: 0,
        sections: [],
      }
      department.productCount += productCount
      department.sections.push({
        code: Number(row.section_code),
        name: row.section,
        productCount,
      })
      departmentMap.set(departmentKey, department)
    }
    const departments = [...departmentMap.values()].sort((a, b) =>
      a.name.localeCompare(b.name, 'pt-BR'),
    )

    const supplierIds = [...partnerLogoBySupplier.keys()]
    const partnerResult = await pool.query(
      `SELECT supplier_id, MIN(brand) AS name, COUNT(*)::int AS product_count
       FROM products
       WHERE active=TRUE AND supplier_id = ANY($1::int[])
       GROUP BY supplier_id
       ORDER BY MIN(brand)`,
      [supplierIds],
    )
    const partnerData = new Map(partnerResult.rows.map((row) => [Number(row.supplier_id), row]))
    const partners = supplierIds.map((supplierId) => {
      const row = partnerData.get(supplierId)
      return {
        supplierId,
        name: partnerNameBySupplier.get(supplierId) || row?.name || `Fornecedor ${supplierId}`,
        productCount: Number(row?.product_count || 0),
        logo: partnerLogoBySupplier.get(supplierId),
      }
    })
    return response.json({ departments, partners })
  } catch (error) {
    return next(error)
  }
})

app.get('/api/products/:code', async (request, response, next) => {
  try {
    const code = Number(request.params.code)
    if (!Number.isSafeInteger(code) || code < 1) return response.status(400).json({ message: 'Código de produto inválido.' })
    const result = await pool.query(
      `SELECT id, external_id, supplier_id, brand, name, package, master_package, units_per_box,
              sales_multiple, min_boxes, unit_price, list_unit_price, retail_unit_price,
              network_unit_price, category, department_code, department, section_code, section, stock_units, image_path,
              image_data IS NOT NULL AS image_uploaded, image_hidden, image_updated_at,
              ean, manufacturer_code, ncm_code, price_date
       FROM products WHERE external_id=$1 AND active=TRUE LIMIT 1`,
      [code],
    )
    if (!result.rows.length) return response.status(404).json({ message: 'Produto não encontrado ou indisponível.' })
    const row = result.rows[0]
    const pricing = await customerPricing(pool, request.customer)
    let unitPrice = null
    let planPrices = []
    if (pricing?.region != null && pricing.plans.length) {
      const priceResult = await pool.query(
        `SELECT ${PRICE_TABLES.map((table) => `price_${table}`).join(', ')} FROM region_prices WHERE region=$1 AND product_id=$2`,
        [pricing.region, row.id],
      )
      const prices = priceResult.rows[0]
      const priceFor = (table) => (prices && Number(prices[priceColumn(table)]) > 0 ? Number(prices[priceColumn(table)]) : null)
      planPrices = pricing.plans
        .map((plan) => ({ code: plan.code, label: plan.label, unitPrice: priceFor(plan.priceTable) }))
        .filter((plan) => plan.unitPrice !== null)
        .sort((a, b) => a.unitPrice - b.unitPrice)
      unitPrice = planPrices[0]?.unitPrice ?? null
    }
    return response.json({ product: {
      id: Number(row.id), code: Number(row.external_id), supplierId: Number(row.supplier_id || 0),
      brand: row.brand, name: row.name, package: row.package || '', masterPackage: row.master_package || '',
      unitsPerBox: Number(row.units_per_box), salesMultiple: Number(row.sales_multiple), minBoxes: Number(row.min_boxes),
      unitPrice, listUnitPrice: unitPrice, planPrices,
      category: row.category || 'Sem categoria', categories: [],
      departmentCode: Number(row.department_code || 0), department: row.department || '',
      sectionCode: Number(row.section_code || 0), section: row.section || '',
      stockUnits: Number(row.stock_units), image: productImageUrl(row), priceDate: row.price_date, weeklySales: 0,
      ean: row.ean || '', manufacturerCode: row.manufacturer_code || '', ncm: row.ncm_code || '',
    } })
  } catch (error) {
    return next(error)
  }
})

app.get('/api/customer/commercial-conditions', async (request, response, next) => {
  if (!request.customer) return response.status(401).json({ message: 'Entre na sua conta para consultar as condições comerciais.' })
  try {
    const summary = await customerCreditSummary(pool, request.customer.id)
    if (!summary) {
      return response.status(503).json({ message: 'As condições comerciais deste cadastro ainda estão sendo atualizadas pelo WinThor.' })
    }
    return response.json(summary)
  } catch (error) {
    return next(error)
  }
})

app.post('/api/customers/lookup', publicLookupLimiter, async (request, response, next) => {
  try {
    const parsed = lookupSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
    let result = await pool.query(
      `SELECT id, external_id, document, person_type, legal_name, trade_name, phone, email,
              postal_code, address_line, address_number, address_complement, neighborhood, city, state,
              sales_channel, registration_status, supabase_user_id
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
          `SELECT id, external_id, document, person_type, legal_name, trade_name, phone, email,
                  postal_code, address_line, address_number, address_complement, neighborhood, city, state,
                  sales_channel, registration_status, supabase_user_id
           FROM customers WHERE document = $1 AND active = TRUE LIMIT 1`,
          [parsed.data.document],
        )
      }
    }
    if (!result.rows.length) return response.json({ found: false, document: parsed.data.document })
    const customer = result.rows[0]
    return response.json({ found: true, hasAccess: Boolean(customer.supabase_user_id), customer: customerJson(customer) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/customers', (_request, response) => response.status(410).json({
  message: 'O cadastro agora é concluído com confirmação de e-mail pelo Supabase.',
}))

app.get('/api/orders', async (request, response, next) => {
  if (!request.customer) return response.status(401).json({ message: 'Entre na sua conta para consultar seus pedidos.' })
  try {
    return response.json({ orders: await listOrders('WHERE o.customer_id = $1', [request.customer.id]) })
  } catch (error) {
    return next(error)
  }
})

app.post('/api/orders/:id/cancel', async (request, response, next) => {
  if (!request.customer) return response.status(401).json({ message: 'Entre na sua conta para cancelar o pedido.' })
  const orderId = Number(request.params.id)
  if (!Number.isSafeInteger(orderId) || orderId < 1) return response.status(400).json({ message: 'Pedido inválido.' })
  try {
    await cancelOrder(orderId, { customerId: request.customer.id, cancelledBy: 'Cliente' })
    const orders = await listOrders('WHERE o.id = $1', [orderId])
    return response.json({ order: orders[0] })
  } catch (error) {
    if (error instanceof RequestError) return response.status(error.status).json({ message: error.message })
    return next(error)
  }
})

app.post('/api/staff/orders/:id/cancel', requireCommercialAccess, async (request, response, next) => {
  const orderId = Number(request.params.id)
  if (!Number.isSafeInteger(orderId) || orderId < 1) return response.status(400).json({ message: 'Pedido do e-commerce inválido.' })
  try {
    await cancelOrder(orderId, { cancelledBy: String(request.staff.name || 'Equipe Ômega').slice(0, 160) })
    const orders = await listOrders('WHERE o.id = $1', [orderId])
    return response.json({ order: orders[0] })
  } catch (error) {
    if (error instanceof RequestError) return response.status(error.status).json({ message: error.message })
    return next(error)
  }
})

app.get('/api/staff/customers', requireCommercialAccess, async (request, response, next) => {
  try {
    const status = request.query.status === 'approved' ? 'approved' : 'pending'
    const result = await pool.query(
      `SELECT id, external_id, document, person_type, legal_name, trade_name, phone, email,
              postal_code, address_line, address_number, address_complement, neighborhood,
              city, state, sales_channel, registration_status, created_at, approved_at
       FROM customers
       WHERE active=TRUE AND registration_status=$1
       ORDER BY created_at ASC`,
      [status],
    )
    return response.json({
      customers: result.rows.map((customer) => ({
        ...customerJson(customer),
        createdAt: customer.created_at,
        approvedAt: customer.approved_at,
      })),
    })
  } catch (error) {
    return next(error)
  }
})

// Cadastra cliente já aprovado e vinculado ao CODCLI do WinThor, com acesso confirmado.
app.post('/api/staff/customers', requireCommercialAccess, async (request, response, next) => {
  const parsed = staffCustomerCreateSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
  const data = parsed.data
  let authUser = null
  try {
    const conflicts = await pool.query(
      `SELECT 'customer' AS kind FROM customers WHERE active=TRUE AND (document=$1 OR LOWER(email)=LOWER($2))
       UNION ALL
       SELECT 'staff' AS kind FROM staff_users WHERE LOWER(email)=LOWER($2)
       LIMIT 1`,
      [data.document, data.email],
    )
    if (conflicts.rows.length) {
      return response.status(409).json({
        message: conflicts.rows[0].kind === 'staff'
          ? 'Este e-mail pertence a um usuário da gestão.'
          : 'Já existe um cliente com este CPF/CNPJ ou e-mail.',
      })
    }
    const winthorCustomer = await fetchWinthorCustomerByDocument(data.document)
    if (!winthorCustomer) return response.status(422).json({ message: 'CPF ou CNPJ não encontrado no WinThor.' })
    const linked = await pool.query('SELECT id FROM customers WHERE external_id=$1 AND active=TRUE LIMIT 1', [winthorCustomer.code])
    if (linked.rows.length) {
      return response.status(409).json({ message: `O código WinThor ${winthorCustomer.code} já está vinculado a outro cliente do e-commerce.` })
    }
    authUser = await createConfirmedSupabaseUser({
      email: data.email,
      password: data.password,
      metadata: { document: data.document, legal_name: data.legalName },
    })
    const result = await pool.query(
      `INSERT INTO customers (
         external_id, document, person_type, legal_name, trade_name, phone, email, supabase_user_id,
         postal_code, address_line, address_number, address_complement, neighborhood, city, state,
         registration_status, approved_at, approved_by_staff_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'approved',CURRENT_TIMESTAMP,$16)
       RETURNING id, external_id, document, person_type, legal_name, trade_name, phone, email,
                 postal_code, address_line, address_number, address_complement, neighborhood,
                 city, state, sales_channel, registration_status, approved_at`,
      [
        winthorCustomer.code, data.document, data.document.length === 11 ? 'CPF' : 'CNPJ', data.legalName,
        data.tradeName, data.phone, data.email, authUser.id, data.postalCode, data.addressLine,
        data.addressNumber, data.addressComplement, data.neighborhood, data.city, data.state, request.staff.id,
      ],
    )
    return response.status(201).json({
      customer: { ...customerJson(result.rows[0]), approvedAt: result.rows[0].approved_at },
      winthorCustomer,
    })
  } catch (error) {
    if (authUser?.id) await deleteSupabaseUser(authUser.id)
    if (error instanceof OmegaApiError) return response.status(error.status).json({ message: error.message })
    if (error?.status === 409 || error?.status === 502) return response.status(error.status).json({ message: error.message })
    if (error?.code === '23505') return response.status(409).json({ message: 'Já existe um cliente com estes dados.' })
    return next(error)
  }
})

app.post('/api/staff/customers/:id/approve', requireCommercialAccess, async (request, response, next) => {
  try {
    const customerId = Number(request.params.id)
    if (!Number.isSafeInteger(customerId) || customerId < 1) {
      return response.status(400).json({ message: 'Cliente inválido.' })
    }
    const current = await pool.query(
      `SELECT id, document, registration_status
       FROM customers WHERE id=$1 AND active=TRUE LIMIT 1`,
      [customerId],
    )
    if (!current.rows.length) return response.status(404).json({ message: 'Cliente não encontrado.' })
    if (current.rows[0].registration_status === 'approved') {
      return response.status(409).json({ message: 'Este cadastro já foi aprovado.' })
    }
    const winthorCustomer = await fetchWinthorCustomerByDocument(current.rows[0].document)
    if (!winthorCustomer) {
      return response.status(422).json({
        message: 'CPF ou CNPJ não encontrado no WinThor. O cadastro continua em análise.',
      })
    }
    const result = await pool.query(
      `UPDATE customers SET external_id=$2, registration_status='approved',
         approved_at=CURRENT_TIMESTAMP, approved_by_staff_user_id=$3,
         updated_at=CURRENT_TIMESTAMP
       WHERE id=$1 AND registration_status='pending'
       RETURNING id, external_id, document, person_type, legal_name, trade_name, phone, email,
                 postal_code, address_line, address_number, address_complement, neighborhood,
                 city, state, sales_channel, registration_status, approved_at`,
      [customerId, winthorCustomer.code, request.staff.id],
    )
    if (!result.rows.length) return response.status(409).json({ message: 'O cadastro já foi analisado por outro usuário.' })
    return response.json({
      customer: { ...customerJson(result.rows[0]), approvedAt: result.rows[0].approved_at },
      winthorCustomer,
    })
  } catch (error) {
    if (error instanceof OmegaApiError) return response.status(error.status).json({ message: error.message })
    return next(error)
  }
})

app.get('/api/staff/orders', requireCommercialAccess, async (_request, response, next) => {
  try {
    return response.json({ orders: await listOrders() })
  } catch (error) {
    return next(error)
  }
})

app.put('/api/staff/orders/:id/winthor', requireCommercialAccess, async (request, response, next) => {
  try {
    const orderId = Number(request.params.id)
    if (!Number.isSafeInteger(orderId) || orderId < 1) return response.status(400).json({ message: 'Pedido do e-commerce inválido.' })
    const parsed = staffOrderLinkSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
    const winthorOrderNumber = parsed.data.winthorOrderNumber
    const statuses = await fetchWinthorOrderStatuses([winthorOrderNumber])
    const winthorStatus = statuses.get(winthorOrderNumber)
    if (!winthorStatus) return response.status(404).json({ message: 'NUMPED não encontrado no WinThor.' })
    const result = await pool.query(
      `UPDATE orders SET winthor_order_number=$2, status=$3,
         winthor_status_code=$4, winthor_status_label=$5,
         winthor_status_checked_at=CURRENT_TIMESTAMP,
         winthor_entered_by_staff_user_id=$6,
         winthor_entered_at=CURRENT_TIMESTAMP,
         updated_at=CURRENT_TIMESTAMP
       WHERE id=$1 AND status <> 'cancelled' RETURNING id`,
      [orderId, winthorOrderNumber, winthorStatus.status, winthorStatus.code, winthorStatus.label, request.staff.id],
    )
    if (!result.rows.length) {
      const exists = await pool.query('SELECT 1 FROM orders WHERE id=$1', [orderId])
      return exists.rows.length
        ? response.status(409).json({ message: 'Este pedido foi cancelado e não pode ser vinculado ao WinThor.' })
        : response.status(404).json({ message: 'Pedido do e-commerce não encontrado.' })
    }
    const orders = await listOrders('WHERE o.id = $1', [orderId])
    return response.json({ order: orders[0] })
  } catch (error) {
    if (error?.code === '23505') return response.status(409).json({ message: 'Este NUMPED já está vinculado a outro pedido do e-commerce.' })
    if (error instanceof OmegaApiError) return response.status(error.status).json({ message: error.message })
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
    const customerOwner = await pool.query(
      'SELECT id FROM customers WHERE LOWER(email)=LOWER($1) AND active=TRUE LIMIT 1',
      [user.email],
    )
    if (customerOwner.rows.length) {
      return response.status(409).json({ message: 'Este e-mail já pertence a uma conta de cliente e não pode ser usado na gestão.' })
    }
    const authOwner = await findSupabaseUserByEmail(user.email)
    if (authOwner) {
      return response.status(409).json({ message: 'Este e-mail já possui uma conta de autenticação e não pode ser usado na gestão.' })
    }
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

app.all(/^\/api\/staff\/categories(?:\/.*)?$/, requireStaff, (_request, response) => (
  response.status(410).json({ message: 'As categorias manuais foram desativadas. Use os departamentos e seções sincronizados do WinThor.' })
))

app.get('/api/staff/categories', requireStaff, async (_request, response, next) => {
  try {
    const categoriesResult = await pool.query(
      `SELECT id, name, position, active, created_at, updated_at
       FROM catalog_categories ORDER BY position, name`,
    )
    const assignmentsResult = await pool.query(
      `SELECT pc.category_id, pc.product_id
       FROM product_categories pc JOIN products p ON p.id=pc.product_id
       WHERE p.active=TRUE ORDER BY pc.product_id`,
    )
    const productMap = new Map()
    for (const item of assignmentsResult.rows) {
      const ids = productMap.get(Number(item.category_id)) || []
      ids.push(Number(item.product_id))
      productMap.set(Number(item.category_id), ids)
    }
    return response.json({ categories: categoriesResult.rows.map((category) => ({
      id: Number(category.id), name: category.name, position: Number(category.position),
      active: category.active, productIds: productMap.get(Number(category.id)) || [],
    })) })
  } catch (error) {
    return next(error)
  }
})

app.post('/api/staff/categories', requireStaff, async (request, response, next) => {
  try {
    const parsed = categorySchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
    const duplicate = await pool.query('SELECT id FROM catalog_categories WHERE LOWER(name)=LOWER($1) LIMIT 1', [parsed.data.name])
    if (duplicate.rows.length) return response.status(409).json({ message: 'Já existe uma categoria com este nome.' })
    const positionResult = await pool.query('SELECT COALESCE(MAX(position),0)+1 AS position FROM catalog_categories')
    const position = parsed.data.position || Number(positionResult.rows[0].position)
    const result = await pool.query(
      `INSERT INTO catalog_categories (name,position,created_by)
       VALUES ($1,$2,$3) RETURNING id,name,position,active`,
      [parsed.data.name, position, request.staff.id],
    )
    return response.status(201).json({ category: { ...result.rows[0], id: Number(result.rows[0].id), productIds: [] } })
  } catch (error) {
    return next(error)
  }
})

app.delete('/api/staff/categories/:id', requireStaff, async (request, response, next) => {
  try {
    const result = await pool.query('DELETE FROM catalog_categories WHERE id=$1 RETURNING id', [request.params.id])
    if (!result.rows.length) return response.status(404).json({ message: 'Categoria não encontrada.' })
    return response.status(204).end()
  } catch (error) {
    return next(error)
  }
})

app.put('/api/staff/categories/:id/products', requireStaff, async (request, response, next) => {
  const parsed = categoryProductsSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
  const productIds = [...new Set(parsed.data.productIds)]
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const category = await client.query('SELECT id FROM catalog_categories WHERE id=$1 FOR UPDATE', [request.params.id])
    if (!category.rows.length) {
      await client.query('ROLLBACK')
      return response.status(404).json({ message: 'Categoria não encontrada.' })
    }
    await client.query('DELETE FROM product_categories WHERE category_id=$1', [request.params.id])
    if (productIds.length) {
      const placeholders = productIds.map((_, index) => `$${index + 3}`).join(',')
      await client.query(
        `INSERT INTO product_categories (product_id,category_id,assigned_by)
         SELECT id,$1::bigint,$2::bigint FROM products WHERE active=TRUE AND id IN (${placeholders})`,
        [request.params.id, request.staff.id, ...productIds],
      )
    }
    await client.query('UPDATE catalog_categories SET updated_at=CURRENT_TIMESTAMP WHERE id=$1', [request.params.id])
    await client.query('COMMIT')
    return response.json({ saved: true, productCount: productIds.length })
  } catch (error) {
    await client.query('ROLLBACK')
    return next(error)
  } finally {
    client.release()
  }
})

app.get('/api/staff/catalog-products', requireMarketingAccess, async (request, response, next) => {
  try {
    const search = String(request.query.search || '').trim()
    const supplierId = Number(request.query.supplierId || 0)
    const params = []
    const conditions = ['p.active=TRUE']
    if (supplierId > 0) {
      params.push(supplierId)
      conditions.push(`p.supplier_id=$${params.length}`)
    }
    if (search) {
      const tokens = search.split(/[\s,;]+/).filter(Boolean).slice(0, 8)
      for (const token of tokens) {
        params.push(`%${token}%`)
        conditions.push(`(p.name ILIKE $${params.length} OR p.brand ILIKE $${params.length} OR p.external_id::text ILIKE $${params.length} OR COALESCE(p.ean,'') ILIKE $${params.length})`)
      }
    }
    const result = await pool.query(
      `SELECT p.id,p.external_id,p.supplier_id,p.brand,p.name,p.package,p.units_per_box,p.image_path,
              p.image_data IS NOT NULL AS image_uploaded,p.image_hidden,p.image_updated_at
       FROM products p WHERE ${conditions.join(' AND ')}
       ORDER BY (p.image_hidden=FALSE AND (p.image_data IS NOT NULL OR p.image_path IS NOT NULL)) DESC,p.brand,p.name LIMIT 20000`,
      params,
    )
    const suppliersResult = await pool.query(
      `SELECT supplier_id,MIN(brand) AS name,COUNT(*)::int AS product_count
       FROM products WHERE active=TRUE AND supplier_id IS NOT NULL
       GROUP BY supplier_id ORDER BY MIN(brand)`,
    )
    return response.json({
      products: result.rows.map((product) => ({
        id: Number(product.id), code: Number(product.external_id), supplierId: Number(product.supplier_id),
        brand: product.brand, name: product.name, package: product.package,
        unitsPerBox: Number(product.units_per_box), image: productImageUrl(product),
      })),
      suppliers: suppliersResult.rows.map((supplier) => ({
        id: Number(supplier.supplier_id), name: supplier.name, productCount: Number(supplier.product_count),
      })),
    })
  } catch (error) {
    return next(error)
  }
})

app.put('/api/staff/products/:id/image', requireMarketingAccess, async (request, response, next) => {
  try {
    let image
    try { image = decodeProductImage(request.body?.imageDataUrl) } catch (error) {
      return response.status(400).json({ message: error.message })
    }
    const result = await pool.query(
      `UPDATE products SET image_data=$1,image_mime=$2,image_path=NULL,image_hidden=FALSE,
         image_updated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
       WHERE id=$3 AND active=TRUE
       RETURNING id,image_updated_at`,
      [image.data, image.mime, request.params.id],
    )
    if (!result.rows.length) return response.status(404).json({ message: 'Produto não encontrado ou inativo.' })
    const version = new Date(result.rows[0].image_updated_at).getTime()
    return response.json({ image: `/api/products/${result.rows[0].id}/image?v=${version}` })
  } catch (error) {
    return next(error)
  }
})

app.delete('/api/staff/products/:id/image', requireMarketingAccess, async (request, response, next) => {
  try {
    const result = await pool.query(
      `UPDATE products SET image_data=NULL,image_mime=NULL,image_path=NULL,image_hidden=TRUE,
         image_updated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
       WHERE id=$1 AND active=TRUE RETURNING id`,
      [request.params.id],
    )
    if (!result.rows.length) return response.status(404).json({ message: 'Produto não encontrado ou inativo.' })
    return response.json({ deleted: true })
  } catch (error) {
    return next(error)
  }
})

app.get('/api/staff/banners', requireMarketingAccess, async (_request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT b.id, b.title, b.alt_text, b.image_path, b.image_data IS NOT NULL AS uploaded,
              b.target_url, b.section_code, b.destination_type, b.destination_values, b.navigation_path,
              b.position, b.active, b.placement,
              b.starts_at, b.ends_at, b.updated_at,
              tx.section_name, tx.department_code, tx.department_name
       FROM banners b
       LEFT JOIN (
         SELECT section_code, MIN(section) AS section_name,
                MIN(department_code) AS department_code, MIN(department) AS department_name
         FROM products
         WHERE active=TRUE AND section_code IS NOT NULL
         GROUP BY section_code
       ) tx ON tx.section_code=b.section_code
       ORDER BY b.position, b.id`,
    )
    return response.json({ banners: result.rows.map((banner) => ({
      id: Number(banner.id), title: banner.title, altText: banner.alt_text,
      imageUrl: banner.uploaded ? `/api/banners/${banner.id}/image?v=${new Date(banner.updated_at).getTime()}` : banner.image_path,
      targetUrl: banner.target_url, position: Number(banner.position), active: banner.active, placement: banner.placement,
      sectionCode: banner.section_code === null ? null : Number(banner.section_code),
      destinationType: banner.destination_type,
      destinationValues: Array.isArray(banner.destination_values) ? banner.destination_values.map(Number) : [],
      navigationPath: banner.navigation_path,
      sectionName: banner.section_name || '', departmentCode: banner.department_code === null ? null : Number(banner.department_code),
      departmentName: banner.department_name || '',
      startsAt: banner.starts_at, endsAt: banner.ends_at,
    })) })
  } catch (error) {
    return next(error)
  }
})

app.put('/api/staff/banners', requireMarketingAccess, async (request, response, next) => {
  const parsed = bannersBulkSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const missingDestination = await findMissingBannerDestination(client, parsed.data.banners)
    if (missingDestination) {
      await client.query('ROLLBACK')
      return response.status(400).json({ message: `O ${missingDestination.label} ${missingDestination.code} não está disponível no catálogo ativo.` })
    }
    if (parsed.data.deletedIds.length) {
      await client.query('DELETE FROM banners WHERE id = ANY($1::bigint[])', [parsed.data.deletedIds])
    }
    for (const banner of parsed.data.banners) {
      let image = null
      try { image = decodeBannerImage(banner.imageDataUrl) } catch (error) {
        await client.query('ROLLBACK')
        return response.status(400).json({ message: error.message })
      }
      if (banner.id) {
        const result = await client.query(
          `UPDATE banners SET title=$1, alt_text=$2, target_url=$3, section_code=$4,
             destination_type=$5, destination_values=$6, navigation_path=$7,
             position=$8, active=$9, placement=$10,
             starts_at=$11, ends_at=$12, image_data=COALESCE($13, image_data), image_mime=COALESCE($14, image_mime),
             image_path=CASE WHEN $13::bytea IS NOT NULL THEN NULL ELSE image_path END,
             updated_at=CURRENT_TIMESTAMP
           WHERE id=$15 RETURNING id`,
          [banner.title, banner.altText, bannerDestinationUrl(banner),
            banner.destinationType === 'sections' ? banner.destinationValues[0] : null,
            banner.destinationType, postgresIntegerArray(banner.destinationValues), banner.navigationPath,
            banner.position, banner.active, banner.placement, banner.startsAt || null, banner.endsAt || null,
            image?.data ?? null, image?.mime ?? null, banner.id],
        )
        if (!result.rows.length) throw new Error('Um dos banners editados não existe mais.')
      } else {
        if (!image) {
          await client.query('ROLLBACK')
          return response.status(400).json({ message: `Selecione uma imagem para o banner â€œ${banner.title}â€.` })
        }
        await client.query(
          `INSERT INTO banners (title, alt_text, image_data, image_mime, target_url, section_code,
             destination_type, destination_values, navigation_path, position, active, placement, starts_at, ends_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [banner.title, banner.altText, image.data, image.mime, bannerDestinationUrl(banner),
            banner.destinationType === 'sections' ? banner.destinationValues[0] : null,
            banner.destinationType, postgresIntegerArray(banner.destinationValues), banner.navigationPath,
            banner.position, banner.active, banner.placement, banner.startsAt || null, banner.endsAt || null],
        )
      }
    }
    await client.query('COMMIT')
    return response.json({ saved: true })
  } catch (error) {
    await client.query('ROLLBACK')
    return next(error)
  } finally {
    client.release()
  }
})

app.put('/api/staff/banners/:id', requireMarketingAccess, async (request, response, next) => {
  try {
    const parsed = bannerSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
    const missingDestination = await findMissingBannerDestination(pool, [parsed.data])
    if (missingDestination) return response.status(400).json({ message: `O ${missingDestination.label} ${missingDestination.code} não está disponível no catálogo ativo.` })
    let image = null
    try { image = decodeBannerImage(parsed.data.imageDataUrl) } catch (error) {
      return response.status(400).json({ message: error.message })
    }
    const values = [
      parsed.data.title, parsed.data.altText, bannerDestinationUrl(parsed.data),
      parsed.data.destinationType === 'sections' ? parsed.data.destinationValues[0] : null,
      parsed.data.destinationType, postgresIntegerArray(parsed.data.destinationValues), parsed.data.navigationPath,
      parsed.data.position, parsed.data.active, parsed.data.placement,
      parsed.data.startsAt || null, parsed.data.endsAt || null, image?.data ?? null, image?.mime ?? null,
      request.params.id,
    ]
    const result = await pool.query(
      `UPDATE banners SET title=$1, alt_text=$2, target_url=$3, section_code=$4,
         destination_type=$5, destination_values=$6, navigation_path=$7,
         position=$8, active=$9, placement=$10,
         starts_at=$11, ends_at=$12,
         image_data=COALESCE($13, image_data), image_mime=COALESCE($14, image_mime),
         image_path=CASE WHEN $13::bytea IS NOT NULL THEN NULL ELSE image_path END,
         updated_at=CURRENT_TIMESTAMP
       WHERE id=$15 RETURNING id`,
      values,
    )
    if (!result.rows.length) return response.status(404).json({ message: 'Banner não encontrado.' })
    return response.json({ saved: true })
  } catch (error) {
    return next(error)
  }
})

app.post('/api/staff/banners', requireMarketingAccess, async (request, response, next) => {
  try {
    const parsed = bannerSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
    const missingDestination = await findMissingBannerDestination(pool, [parsed.data])
    if (missingDestination) return response.status(400).json({ message: `O ${missingDestination.label} ${missingDestination.code} não está disponível no catálogo ativo.` })
    let image
    try { image = decodeBannerImage(parsed.data.imageDataUrl) } catch (error) {
      return response.status(400).json({ message: error.message })
    }
    if (!image) return response.status(400).json({ message: 'Selecione uma imagem para o novo banner.' })
    const result = await pool.query(
      `INSERT INTO banners (title, alt_text, image_data, image_mime, target_url, section_code,
         destination_type, destination_values, navigation_path, position, active, placement, starts_at, ends_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [parsed.data.title, parsed.data.altText, image.data, image.mime, bannerDestinationUrl(parsed.data),
        parsed.data.destinationType === 'sections' ? parsed.data.destinationValues[0] : null,
        parsed.data.destinationType, postgresIntegerArray(parsed.data.destinationValues), parsed.data.navigationPath,
        parsed.data.position, parsed.data.active, parsed.data.placement,
        parsed.data.startsAt || null, parsed.data.endsAt || null],
    )
    return response.status(201).json({ id: Number(result.rows[0].id), saved: true })
  } catch (error) {
    return next(error)
  }
})

app.delete('/api/staff/banners/:id', requireMarketingAccess, async (request, response, next) => {
  try {
    const result = await pool.query('DELETE FROM banners WHERE id=$1 RETURNING id', [request.params.id])
    if (!result.rows.length) return response.status(404).json({ message: 'Banner não encontrado.' })
    return response.status(204).end()
  } catch (error) {
    return next(error)
  }
})

app.post('/api/orders', async (request, response, next) => {
  if (!request.customer) return response.status(401).json({ message: 'Entre na sua conta para finalizar o pedido.' })
  if ((request.customer.registration_status || 'approved') !== 'approved') {
    return response.status(403).json({ message: 'Seu cadastro está em análise. Os pedidos serão liberados após a aprovação da equipe Ômega.' })
  }
  const parsed = orderSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (Number(parsed.data.customerId) !== Number(request.customer.id)) {
      await client.query('ROLLBACK')
      return response.status(403).json({ message: 'O cliente do pedido não corresponde à sessão atual.' })
    }

    const conditions = await customerCreditSummary(client, request.customer.id, { lock: true })
    if (!conditions) {
      await client.query('ROLLBACK')
      return response.status(503).json({ message: 'As condições comerciais deste cadastro ainda não foram sincronizadas com o WinThor.' })
    }
    const pricing = await customerPricing(client, request.customer)
    if (pricing.region == null) {
      await client.query('ROLLBACK')
      return response.status(503).json({ message: 'As condições comerciais deste cadastro ainda não foram sincronizadas com o WinThor.' })
    }
    const selectedPlan = pricing.plans.find((plan) => plan.code === parsed.data.paymentPlan)
    if (!selectedPlan) {
      await client.query('ROLLBACK')
      return response.status(400).json({ message: 'O plano de pagamento selecionado não está liberado para este cliente.' })
    }
    const { lines, total } = await priceCartItems(client, pricing, selectedPlan, parsed.data.items)

    if (total < 200) {
      await client.query('ROLLBACK')
      return response.status(400).json({ message: `O pedido mínimo é R$ 200,00. Adicione mais R$ ${(200 - total).toFixed(2).replace('.', ',')}.` })
    }
    if (total > conditions.availableCredit) {
      await client.query('ROLLBACK')
      return response.status(400).json({
        message: `O total do pedido excede o limite de crédito disponível de R$ ${conditions.availableCredit.toFixed(2).replace('.', ',')}.`,
      })
    }

    const orderResult = await client.query(
      'INSERT INTO orders (customer_id, payment_plan, payment_plan_label, total, notes) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at',
      [request.customer.id, parsed.data.paymentPlan, String(selectedPlan.label).slice(0, 160), total.toFixed(2), parsed.data.notes],
    )
    const order = orderResult.rows[0]
    for (const line of lines) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, boxes, units, units_per_box, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [order.id, line.product.id, line.boxes, line.units, line.product.units_per_box, line.unitPrice, line.lineTotal.toFixed(2)],
      )
    }
    await client.query('COMMIT')
    return response.status(201).json({
      order: {
        id: Number(order.id),
        number: `OMG-${String(order.id).padStart(6, '0')}`,
        total,
        paymentPlan: parsed.data.paymentPlan,
        paymentPlanLabel: selectedPlan.label,
        createdAt: order.created_at,
      },
    })
  } catch (error) {
    await client.query('ROLLBACK')
    if (error instanceof RequestError) return response.status(error.status).json({ message: error.message })
    next(error)
  } finally {
    client.release()
  }
})

if (existsSync(distDir)) {
  app.use(express.static(distDir, {
    index: false,
    setHeaders: (response, filePath) => {
      const isVersionedBuildAsset = /[\\/]assets[\\/]index-[A-Za-z0-9_-]+\.(?:js|css)$/.test(filePath)
      response.setHeader('Cache-Control', isVersionedBuildAsset
        ? 'public, max-age=31536000, immutable'
        : 'no-cache')
    },
  }))
  app.use((request, response, next) => {
    if (request.method === 'GET' && !request.path.startsWith('/api/')) {
      response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
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
