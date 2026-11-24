import 'dotenv/config'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { initializeDatabase, pool, sourcePool } from './db.js'
import { isForwardStage, queueOrderStage, startOrderEmailWorker } from './order-email.js'
import { clearSessionCookie, clearStaffSessionCookie, createSession, getCookie, hashPassword, hashSessionToken, sessionCookie, staffSessionCookie, verifyPassword } from './auth.js'
import { findCustomerInvitesByDocument, findSupabaseUserByEmail, inviteSupabaseUser, removeSupabaseUser, updateSupabaseUser, verifySupabaseAccessToken, supabaseAuthConfigured } from './supabase-auth.js'
import { bannerSchema, bannersBulkSchema, campaignSyncSchema, cartQuantitySchema, couponSchema, customerConditionsSyncSchema, customerProfileSchema, customerUpdateSchema, digits, emailCheckSchema, institutionalPageSchema, loginSchema, lookupSchema, orderQuoteSchema, orderSchema, productStocksSyncSchema, productSyncSchema, regionPricesSyncSchema, staffCustomerApproveSchema, staffOrderLinkSchema, staffPasswordSchema, staffUserSchema, stockCheckSchema } from './validation.js'

const app = express()
app.set('trust proxy', 1)
const port = Number(process.env.PORT) || 3000
const currentDir = dirname(fileURLToPath(import.meta.url))
const distDir = resolve(currentDir, '../dist')
const orderStatusCacheMs = Math.max(1, Number(process.env.ORDER_STATUS_CACHE_MINUTES) || 3) * 60 * 1000
const stockMaxAgeMs = Math.max(2, Number(process.env.STOCK_MAX_AGE_MINUTES) || 5) * 60 * 1000
const customerOrderStatuses = new Set(['analysis', 'released', 'sent', 'delivered', 'cancelled'])

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
                  neighborhood, city, state, sales_channel, registration_status,
                  COALESCE(cc.is_blocked, FALSE) AS commercial_blocked,
                  cc.customer_id IS NULL AS prices_pending
           FROM customers
           LEFT JOIN customer_commercial_conditions cc ON cc.customer_id=customers.id
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
              c.neighborhood, c.city, c.state, c.sales_channel, c.registration_status,
              COALESCE(cc.is_blocked, FALSE) AS commercial_blocked,
              cc.customer_id IS NULL AS prices_pending
       FROM sessions s
       JOIN customers c ON c.id = s.customer_id
       LEFT JOIN customer_commercial_conditions cc ON cc.customer_id=c.id
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

// Exibe só parte do e-mail oficial (ex.: jo****ste@g**.com) para quem pediu o acesso.
function maskEmail(email) {
  const [local = '', domain = ''] = String(email || '').split('@')
  const keep = Math.max(1, Math.floor(local.length / 4))
  const maskedLocal = local.length <= 2
    ? `${local[0] || ''}*`
    : `${local.slice(0, keep)}${'*'.repeat(Math.max(3, local.length - keep * 2))}${local.slice(-keep)}`
  const dot = domain.indexOf('.')
  const domainName = dot > 0 ? domain.slice(0, dot) : domain
  const suffix = dot > 0 ? domain.slice(dot) : ''
  return `${maskedLocal}@${domainName[0] || ''}**${suffix}`
}

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
    commercialBlocked: Boolean(customer.commercial_blocked),
    canOrder: (customer.registration_status || 'approved') === 'approved' && !customer.commercial_blocked,
    // Cliente aprovado cujas condições comerciais (região e planos) ainda não chegaram do WinThor.
    pricesPending: (customer.registration_status || 'approved') === 'approved'
      && customer.external_id != null && Boolean(customer.prices_pending),
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

function requireTelevendasAccess(request, response, next) {
  if (request.authError) return response.status(401).json({ message: 'Sua sessão expirou. Entre novamente.' })
  if (!request.staff) return response.status(401).json({ message: 'Entre na área de gestão para continuar.' })
  if (!['ADMIN', 'TELEVENDAS'].includes(request.staff.role)) return response.status(403).json({ message: 'Este perfil não possui acesso aos carrinhos.' })
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

const firstAccessLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Muitas tentativas de primeiro acesso. Aguarde alguns minutos e tente novamente.' },
})

function omegaApiConfig() {
  const url = String(process.env.OMEGA_API_URL || '').trim().replace(/\/$/, '')
  const key = String(process.env.OMEGA_API_KEY || '').trim()
  return url && key ? { url, key } : null
}

async function fetchWinthorOrderStatuses(orderNumbers) {
  const config = omegaApiConfig()
  if (!config) throw new OmegaApiError('A consulta de pedidos do sistema comercial ainda não está configurada.', 503)
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
    throw new OmegaApiError('Não foi possível consultar o status do pedido agora.', 503)
  }
  const text = await response.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = {} }
  if (!response.ok) {
    const status = response.status === 401 ? 502 : (response.status >= 500 ? 503 : 502)
    throw new OmegaApiError('Não foi possível consultar o status do pedido.', status)
  }
  const statuses = new Map()
  for (const order of Array.isArray(data.pedidos) ? data.pedidos : []) {
    const number = Number(order.numped)
    if (!Number.isSafeInteger(number)) continue
    const label = String(order.statusReal || '').trim().slice(0, 80) || 'Em análise'
    statuses.set(number, {
      // Status desconhecido (API mais nova que o e-commerce) mantém o status atual do pedido.
      status: customerOrderStatuses.has(order.status) ? order.status : null,
      code: String(order.posicao || '').trim().slice(0, 20),
      label,
      deliveryDate: /^\d{4}-\d{2}-\d{2}$/.test(String(order.previsaoEntrega || '')) ? order.previsaoEntrega : null,
      // Sem DTLIBERA, o pedido foi liberado ao ser registrado no WinThor.
      releasedAt: winthorLocalTime(order.liberadoEm) || winthorLocalTime(order.registradoEm),
      invoicedAt: winthorLocalTime(order.faturadoEm),
    })
  }
  return statuses
}

// Datas do WinThor chegam no horário local (Brasília, sem horário de verão) e sem fuso.
function winthorLocalTime(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/.exec(String(value || ''))
  return match ? `${match[1]}T${match[2]}:00-03:00` : null
}

function firstOfficialEmail(...values) {
  for (const value of values) {
    for (const candidate of String(value || '').split(/[;,\s]+/)) {
      const email = candidate.trim().toLowerCase()
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 180) return email
    }
  }
  return ''
}

function winthorCustomerPayload(customer, expected = {}) {
  const code = Number(customer?.codigo)
  const document = digits(customer?.documento)
  if (!Number.isSafeInteger(code) || code < 1
    || (expected.document && document !== digits(expected.document))
    || (expected.code && code !== Number(expected.code))) {
    throw new OmegaApiError('A API retornou um cadastro de cliente inválido.', 502)
  }
  return {
    code,
    document,
    personType: document.length === 11 ? 'CPF' : 'CNPJ',
    name: String(customer.nome || '').trim(),
    tradeName: String(customer.fantasia || '').trim(),
    email: firstOfficialEmail(customer.email, customer.emailNfe),
    phone: digits(customer.telefoneEntrega || customer.telefoneComercial || customer.telefoneCobranca, 11),
    postalCode: digits(customer.cep, 8),
    addressLine: String(customer.endereco || '').trim(),
    addressNumber: String(customer.numero || '').trim(),
    addressComplement: String(customer.complemento || '').trim(),
    neighborhood: String(customer.bairro || '').trim(),
    city: String(customer.cidade || '').trim(),
    state: String(customer.uf || '').trim().toUpperCase().slice(0, 2),
    salesChannel: Number(customer.codigoRede) === 31 ? 'Varejo' : 'Redes',
    plazaCode: customer.codigoPraca == null ? null : Number(customer.codigoPraca),
    creditLimit: Number(customer.limiteCredito || 0),
    blocked: Boolean(customer.bloqueado),
  }
}

async function fetchWinthorCustomer({ document, code }) {
  const config = omegaApiConfig()
  if (!config) throw new OmegaApiError('A consulta do cadastro comercial ainda não está configurada.', 503)
  const endpoint = code ? 'por-codigo' : 'por-documento'
  const requestBody = code ? { codigo: Number(code) } : { documento: document }
  let response
  try {
    response = await fetch(`${config.url}/v1/winthor/clientes/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.key,
        'X-Client-Name': 'omega-ecommerce',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(12_000),
    })
  } catch {
    throw new OmegaApiError('Não foi possível consultar o cadastro do cliente agora.', 503)
  }
  const text = await response.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = {} }
  if (!code && response.status === 404 && data.detail === 'Not Found') {
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
      throw new OmegaApiError('Não foi possível consultar o cadastro do cliente agora.', 503)
    }
  } else if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    const status = response.status === 401 ? 502 : (response.status >= 500 ? 503 : 502)
    throw new OmegaApiError('Não foi possível consultar o cadastro do cliente.', status)
  }
  return winthorCustomerPayload(data.cliente, { document, code })
}

const fetchWinthorCustomerByDocument = (document) => fetchWinthorCustomer({ document })
const fetchWinthorCustomerByCode = (code) => fetchWinthorCustomer({ code })

async function refreshStaleOrderStatuses(orders) {
  if (!omegaApiConfig()) return
  const now = Date.now()
  // Pedidos cancelados não mudam mais: só os demais são consultados no WinThor.
  const staleOrders = orders.filter((order) => order.winthor_order_number && order.status !== 'cancelled' && (
    !order.winthor_status_checked_at
    || now - new Date(order.winthor_status_checked_at).getTime() >= orderStatusCacheMs
  ))
  if (!staleOrders.length) return
  try {
    const statuses = await fetchWinthorOrderStatuses(staleOrders.map((order) => order.winthor_order_number))
    await Promise.all(staleOrders.map(async (order) => {
      const winthorOrderNumber = Number(order.winthor_order_number)
      // O vínculo só é criado depois que o NUMPED é confirmado pela API. Se um pedido
      // anteriormente confirmado desaparece da PCPEDC/PCPEDI, ele foi removido no WinThor
      // (caso observado em cancelamentos) e não deve permanecer como liberado no e-commerce.
      const found = statuses.get(winthorOrderNumber)
      const winthorStatus = found ? { ...found, status: found.status || order.status } : {
        status: 'cancelled', code: 'C', label: 'Cancelado no sistema comercial', deliveryDate: null,
        releasedAt: null, invoicedAt: null,
      }
      const checkedAt = new Date()
      const statusClient = await pool.connect()
      try {
        await statusClient.query('BEGIN')
        const lockedOrder = await statusClient.query('SELECT status FROM orders WHERE id=$1 FOR UPDATE', [order.id])
        if (!lockedOrder.rows.length || lockedOrder.rows[0].status === 'cancelled') {
          await statusClient.query('COMMIT')
          return
        }
        const previousStatus = lockedOrder.rows[0].status
        await statusClient.query(
        `UPDATE orders SET status=$2::varchar, winthor_status_code=$3, winthor_status_label=$4,
           winthor_status_checked_at=$5, winthor_delivery_date=$7::date,
           winthor_released_at=COALESCE($8::timestamptz, winthor_released_at),
           winthor_invoiced_at=COALESCE($9::timestamptz, winthor_invoiced_at),
           cancelled_at=CASE WHEN $2::varchar='cancelled' THEN COALESCE(cancelled_at,$5) ELSE cancelled_at END,
           cancelled_by=CASE WHEN $2::varchar='cancelled' THEN COALESCE(NULLIF(cancelled_by,''),'Sistema comercial') ELSE cancelled_by END,
           updated_at=CASE WHEN status<>$2::varchar THEN CURRENT_TIMESTAMP ELSE updated_at END
         WHERE id=$1 AND winthor_order_number=$6 AND status<>'cancelled'`,
        [order.id, winthorStatus.status, winthorStatus.code, winthorStatus.label, checkedAt, winthorOrderNumber,
          winthorStatus.deliveryDate, winthorStatus.releasedAt, winthorStatus.invoicedAt],
        )
        if (isForwardStage(previousStatus, winthorStatus.status)) await queueOrderStage(statusClient, order.id, winthorStatus.status)
        await statusClient.query('COMMIT')
      } catch (error) {
        await statusClient.query('ROLLBACK')
        throw error
      } finally { statusClient.release() }
      order.status = winthorStatus.status
      order.winthor_status_code = winthorStatus.code
      order.winthor_status_label = winthorStatus.label
      order.winthor_status_checked_at = checkedAt
      order.winthor_delivery_date = winthorStatus.deliveryDate
      order.winthor_released_at = winthorStatus.releasedAt || order.winthor_released_at
      order.winthor_invoiced_at = winthorStatus.invoicedAt || order.winthor_invoiced_at
      if (winthorStatus.status === 'cancelled') {
        order.cancelled_at ||= checkedAt
        order.cancelled_by ||= 'Sistema comercial'
      }
    }))
  } catch (error) {
    console.warn(`[orders] consulta de status adiada: ${error instanceof Error ? error.message : 'falha desconhecida'}`)
  }
}

// Previsão mostrada ao cliente: DTENTREGA do WinThor + 2 dias úteis (pula sábado e domingo).
function deliveryForecast(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
  if (!match) return null
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  for (let added = 0; added < 2;) {
    date.setUTCDate(date.getUTCDate() + 1)
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) added += 1
  }
  return date.toISOString().slice(0, 10)
}

async function listOrders(whereClause = '', params = []) {
  const result = await pool.query(
    `SELECT o.id, o.status, o.winthor_order_number, o.winthor_status_code,
            o.winthor_status_label, o.winthor_status_checked_at,
            to_char(o.winthor_delivery_date, 'YYYY-MM-DD') AS winthor_delivery_date,
            o.winthor_released_at, o.winthor_invoiced_at,
            o.winthor_entered_at, o.payment_plan, o.payment_plan_label, o.total, o.notes, o.created_at, o.updated_at,
            o.cancelled_at, o.cancelled_by,
            c.id AS customer_id, c.legal_name, c.trade_name, c.document, c.email, c.phone,
            su.name AS winthor_entered_by_name,
            oc.code AS coupon_code,oc.description AS coupon_description,oc.discount_amount AS coupon_discount_amount
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     LEFT JOIN staff_users su ON su.id = o.winthor_entered_by_staff_user_id
     LEFT JOIN order_coupons oc ON oc.order_id=o.id
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
              p.image_path, p.image_data IS NOT NULL AS image_uploaded, p.image_hidden, p.image_updated_at,
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
    number: order.winthor_order_number == null ? 'Pedido pendente' : String(order.winthor_order_number),
    status: order.status,
    winthorOrderNumber: order.winthor_order_number == null ? null : Number(order.winthor_order_number),
    winthorStatusCode: order.winthor_status_code || '',
    winthorStatusLabel: order.winthor_status_label || '',
    statusUpdatedAt: order.winthor_status_checked_at,
    // Previsão de entrega (AAAA-MM-DD) só existe depois que o pedido recebe o NUMPED.
    deliveryDate: order.winthor_order_number == null ? null : deliveryForecast(order.winthor_delivery_date),
    // Datas das etapas para a barra de progresso (liberação e faturamento vêm do WinThor).
    releasedAt: order.winthor_released_at || null,
    invoicedAt: order.winthor_invoiced_at || null,
    enteredAt: order.winthor_entered_at,
    enteredBy: order.winthor_entered_by_name || '',
    paymentPlan: order.payment_plan_label || order.payment_plan,
    paymentPlanLabel: order.payment_plan_label || '',
    total: Number(order.total),
    coupon: order.coupon_code ? { code: order.coupon_code, description: order.coupon_description, discountAmount: Number(order.coupon_discount_amount) } : null,
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
      image: productImageUrl({ ...item, id: item.product_id }),
      boxes: Number(item.boxes), units: Number(item.units), unitsPerBox: Number(item.units_per_box),
      unitPrice: Number(item.unit_price), lineTotal: Number(item.line_total),
    })),
  }))
}

function decodeBannerImage(dataUrl, allowGif = false, maxSizeMb = 5) {
  if (!dataUrl) return null
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!match) throw new Error('Imagem inválida. Use PNG, JPG ou WEBP.')
  if (match[1] === 'image/gif' && !allowGif) throw new Error('GIF animado é permitido somente no banner principal.')
  const data = Buffer.from(match[2], 'base64')
  if (!data.length || data.length > maxSizeMb * 1024 * 1024) throw new Error(`A imagem deve ter no máximo ${maxSizeMb} MB.`)
  return { mime: match[1], data }
}

function institutionalPageJson(row) {
  const version = row.updated_at ? new Date(row.updated_at).getTime() : Date.now()
  return {
    heroTitle: row.hero_title,
    heroSubtitle: row.hero_subtitle,
    historyTitle: row.history_title,
    historyText: row.history_text,
    valuesTitle: row.values_title,
    valuesText: row.values_text,
    heroImageUrl: row.hero_image_data ? `/api/site/institutional/image/hero?v=${version}` : null,
    historyImageUrl: row.history_image_data ? `/api/site/institutional/image/history?v=${version}` : null,
    updatedAt: row.updated_at,
  }
}

async function findMissingBannerDestination(database, banners) {
  const configurations = {
    sections: { column: 'section_code', label: 'seção' },
    products: { column: 'external_id', label: 'produto' },
    suppliers: { column: 'supplier_id', label: 'fornecedor' },
  }
  for (const banner of banners) {
    if (banner.destinationType === 'navigation') continue
    const codes = [...new Set(banner.destinationValues.map(Number))]
    if (banner.destinationType === 'campaigns') {
      const result = await database.query(
        'SELECT external_id AS code FROM discount_campaigns WHERE external_id = ANY($1::int[])',
        [codes],
      )
      const availableCodes = new Set(result.rows.map((row) => Number(row.code)))
      const missingCode = codes.find((code) => !availableCodes.has(code))
      if (missingCode) return { label: 'campanha', code: missingCode }
      continue
    }
    const configuration = configurations[banner.destinationType]
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
  if (banner.destinationType === 'navigation') return banner.navigationPath || '/#produtos'
  return banner.id ? `/?banner=${banner.id}#produtos` : '/#produtos'
}

function postgresIntegerArray(values) {
  return `{${values.map(Number).join(',')}}`
}

function decodeProductImage(dataUrl) {
  const match = /^data:(image\/webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''))
  if (!match) throw new Error('Imagem inválida. A foto do produto deve estar no formato WEBP.')
  const data = Buffer.from(match[2], 'base64')
  if (!data.length || data.length > 5 * 1024 * 1024) throw new Error('A foto deve ter no máximo 5 MB.')
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP') throw new Error('O arquivo não é uma imagem WEBP válida.')
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
function currentBrasiliaDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const part = (type) => parts.find((item) => item.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}
const PRICE_TABLES = [1, 2, 3, 4, 5, 6, 7]
const priceTableOf = (value) => (PRICE_TABLES.includes(Number(value)) ? Number(value) : 1)
// Coluna segura: o número é validado contra PRICE_TABLES antes de entrar no SQL.
const priceColumn = (table) => `price_${priceTableOf(table)}`

// Região de preço e planos do cliente vindos do WinThor. Sem condições sincronizadas
// (cadastro em análise ou ainda sem CODCLI), o cliente não tem região e não vê preço.
async function customerPricing(database, customer) {
  if (!customer) return null
  const result = await database.query(
    'SELECT price_region, stock_branch, is_blocked, allow_sales_multiple, payment_plans, restricted_supplier_ids FROM customer_commercial_conditions WHERE customer_id=$1',
    [customer.id],
  )
  const row = result.rows[0]
  const plans = (Array.isArray(row?.payment_plans) ? row.payment_plans : []).map((plan) => ({
    code: String(plan.code),
    label: String(plan.label),
    priceTable: priceTableOf(plan.priceTable),
  }))
  const region = row?.price_region != null ? Number(row.price_region) : null
  const restrictedSupplierIds = (Array.isArray(row?.restricted_supplier_ids) ? row.restricted_supplier_ids : [])
    .map(Number).filter((value) => Number.isSafeInteger(value) && value > 0)
  const stockBranch = [1, 3].includes(Number(row?.stock_branch)) ? Number(row.stock_branch) : null
  return { region, stockBranch, isBlocked: Boolean(row?.is_blocked), allowSalesMultiple: row?.allow_sales_multiple !== false, plans, priceTables: [...new Set(plans.map((plan) => plan.priceTable))], restrictedSupplierIds }
}

function purchaseMultiple(pricing, product) {
  return Math.max(1, Number(pricing?.allowSalesMultiple === false ? product.units_per_box : product.sales_multiple))
}

// Menor preço positivo entre as tabelas dos planos liberados para o cliente.
function lowestPlanPrice(row, priceTables) {
  const prices = priceTables.map((table) => Number(row?.[priceColumn(table)])).filter((price) => price > 0)
  return prices.length ? Math.min(...prices) : null
}

// Calcula as linhas do carrinho com o preço da região do cliente na tabela do plano escolhido.
async function priceCartItems(database, pricing, plan, items, customerExternalId = null) {
  const productIds = [...new Set(items.map((item) => item.productId))]
  const placeholders = productIds.map((_, index) => `$${index + 2}`).join(',')
  const result = await database.query(
    `SELECT p.id, p.external_id, p.supplier_id, p.section_code, p.name, p.units_per_box, p.sales_multiple, CASE WHEN rp.${priceColumn(plan.priceTable)} > 0 THEN rp.${priceColumn(plan.priceTable)} END AS price
     FROM products p
     LEFT JOIN region_prices rp ON rp.product_id = p.id AND rp.region = $1
     WHERE p.active = TRUE AND p.id IN (${placeholders})`,
    [pricing.region, ...productIds],
  )
  const productMap = new Map(result.rows.map((product) => [Number(product.id), product]))
  const customerParam = productIds.length + 2
  const campaignResult = await database.query(
    `SELECT dcp.product_id,dc.external_id,dc.description,dcp.min_quantity,dcp.max_quantity,dcp.discount_percent
     FROM discount_campaign_products dcp
     JOIN discount_campaigns dc ON dc.id=dcp.campaign_id
     LEFT JOIN discount_campaign_customers dcc
       ON dcc.campaign_id=dc.id AND dcc.customer_external_id=$${customerParam}::integer
     WHERE dc.active=TRUE AND dc.starts_on<=$1::date AND dc.ends_on>=$1::date
       AND dcp.product_id IN (${placeholders})
       AND (dc.customer_restricted=FALSE OR dcc.customer_external_id IS NOT NULL)
     ORDER BY dcp.discount_percent DESC,dc.external_id`,
    [currentBrasiliaDate(), ...productIds, customerExternalId],
  )
  const campaignRules = new Map()
  const campaignProducts = new Map()
  for (const rule of campaignResult.rows) {
    const productId = Number(rule.product_id)
    const campaignCode = Number(rule.external_id)
    campaignRules.set(productId, [...(campaignRules.get(productId) || []), rule])
    if (!campaignProducts.has(campaignCode)) campaignProducts.set(campaignCode, new Set())
    campaignProducts.get(campaignCode).add(productId)
  }
  // A quantidade mínima/máxima da campanha considera a soma de todos os
  // produtos participantes presentes no carrinho. O Set acima impede que um
  // produto seja contado novamente quando a campanha possui mais de uma faixa.
  const quantityByProduct = new Map()
  for (const item of items) {
    quantityByProduct.set(item.productId, (quantityByProduct.get(item.productId) || 0) + item.quantity)
  }
  const campaignQuantities = new Map()
  for (const [campaignCode, participatingProducts] of campaignProducts) {
    campaignQuantities.set(campaignCode, [...participatingProducts].reduce(
      (total, productId) => total + (quantityByProduct.get(productId) || 0),
      0,
    ))
  }
  const restrictedSuppliers = new Set(pricing.restrictedSupplierIds || [])
  const restrictedProduct = result.rows.find((product) => restrictedSuppliers.has(Number(product.supplier_id)))
  if (restrictedProduct) {
    throw new RequestError(`O produto ${restrictedProduct.external_id} - ${restrictedProduct.name} não está disponível para este cadastro.`)
  }
  if (productMap.size !== productIds.length) throw new RequestError('Um ou mais produtos não estão disponíveis.')
  const lines = items.map((item) => {
    const product = productMap.get(item.productId)
    if (product.price == null) {
      throw new RequestError(`O produto ${product.external_id} - ${product.name} está sem preço para o seu cadastro. Remova-o do carrinho.`)
    }
    const units = item.quantity
    const salesMultiple = purchaseMultiple(pricing, product)
    if (units < salesMultiple || units % salesMultiple !== 0) {
      throw new RequestError(`A quantidade do produto ${product.external_id} deve ser um múltiplo de ${salesMultiple} unidades.`)
    }
    const eligibleCampaign = (campaignRules.get(Number(product.id)) || []).find((rule) => (
      (campaignQuantities.get(Number(rule.external_id)) || 0) >= Number(rule.min_quantity)
      && (rule.max_quantity == null || (campaignQuantities.get(Number(rule.external_id)) || 0) <= Number(rule.max_quantity))
    ))
    const discountPercent = eligibleCampaign ? Number(eligibleCampaign.discount_percent) : 0
    const baseUnitPrice = Number(product.price)
    const unitPrice = money2(baseUnitPrice * (1 - discountPercent / 100))
    return {
      product,
      units,
      boxes: Math.max(1, Math.ceil(units / Number(product.units_per_box))),
      baseUnitPrice,
      unitPrice,
      discountPercent,
      campaignCode: eligibleCampaign ? Number(eligibleCampaign.external_id) : null,
      campaignDescription: eligibleCampaign?.description || null,
      lineTotal: money2(units * unitPrice),
    }
  })
  return { lines, total: money2(lines.reduce((sum, line) => sum + line.lineTotal, 0)) }
}

async function applyCoupon(database, couponCode, lines) {
  const code = String(couponCode || '').trim().toUpperCase()
  const subtotal = money2(lines.reduce((sum, line) => sum + line.lineTotal, 0))
  if (!code) return { subtotal, total: subtotal, coupon: null }
  const result = await database.query(
    `SELECT c.id,c.code,c.description,c.discount_type,c.discount_value,c.scope_type
     FROM coupons c
     WHERE UPPER(c.code)=UPPER($1) AND c.active=TRUE
       AND (c.starts_at IS NULL OR c.starts_at<=CURRENT_TIMESTAMP)
       AND (c.ends_at IS NULL OR c.ends_at>CURRENT_TIMESTAMP)
     LIMIT 1`,
    [code],
  )
  const coupon = result.rows[0]
  if (!coupon) throw new RequestError('Cupom inválido, inativo ou fora do período de utilização.')
  const targetResult = coupon.scope_type === 'order' ? { rows: [] } : await database.query('SELECT target_value FROM coupon_targets WHERE coupon_id=$1', [coupon.id])
  const targets = new Set(targetResult.rows.map((row) => Number(row.target_value)))
  const eligibleLines = lines.filter((line) => {
    if (coupon.scope_type === 'order') return true
    if (coupon.scope_type === 'products') return targets.has(Number(line.product.external_id))
    if (coupon.scope_type === 'suppliers') return targets.has(Number(line.product.supplier_id))
    return targets.has(Number(line.product.section_code))
  })
  const eligibleSubtotal = money2(eligibleLines.reduce((sum, line) => sum + line.lineTotal, 0))
  if (eligibleSubtotal <= 0) throw new RequestError('Este cupom não se aplica aos produtos do seu pedido.')
  const value = Number(coupon.discount_value)
  const discountAmount = money2(Math.min(eligibleSubtotal, coupon.discount_type === 'percent' ? eligibleSubtotal * value / 100 : value))
  return {
    subtotal,
    total: money2(Math.max(0, subtotal - discountAmount)),
    coupon: {
      id: Number(coupon.id), code: coupon.code, description: coupon.description,
      discountType: coupon.discount_type, discountValue: value, eligibleSubtotal, discountAmount,
    },
  }
}

// Valida o snapshot da filial e desconta pedidos do e-commerce que ainda nao
// estavam refletidos no WinThor quando esse snapshot foi produzido.
async function validateOrderStock(database, stockBranch, lines) {
  if (![1, 3].includes(Number(stockBranch))) {
    throw new RequestError('A filial de atendimento deste cadastro ainda não foi sincronizada.', 503)
  }
  const productIds = lines.map((line) => Number(line.product.id))
  const placeholders = productIds.map((_, index) => `$${index + 2}`).join(',')
  const result = await database.query(
    `SELECT ps.product_id, ps.available_units, ss.source_updated_at, p.external_id, p.name,
            COALESCE((
              SELECT SUM(oi.units)
              FROM order_items oi
              JOIN orders o ON o.id=oi.order_id
              WHERE oi.product_id=ps.product_id AND o.stock_branch=ps.branch
                AND o.status<>'cancelled'
                AND (o.winthor_order_number IS NULL OR o.winthor_entered_at IS NULL
                     OR ss.source_updated_at<=o.winthor_entered_at)
            ),0) AS local_pending_units
     FROM product_stocks ps
     JOIN stock_sync_state ss ON ss.branch=ps.branch
     JOIN products p ON p.id=ps.product_id
     WHERE ps.branch=$1 AND ps.product_id IN (${placeholders})
     FOR UPDATE OF ps`,
    [stockBranch, ...productIds],
  )
  const stockByProduct = new Map(result.rows.map((row) => [Number(row.product_id), row]))
  for (const line of lines) {
    const stock = stockByProduct.get(Number(line.product.id))
    if (!stock) {
      throw new RequestError(`O estoque do produto ${line.product.external_id} ainda não foi sincronizado. Tente novamente em alguns minutos.`, 503)
    }
    const sourceTime = new Date(stock.source_updated_at).getTime()
    if (!Number.isFinite(sourceTime) || Date.now() - sourceTime > stockMaxAgeMs) {
      throw new RequestError('O estoque está sendo atualizado. Aguarde alguns minutos antes de finalizar o pedido.', 503)
    }
    const available = Math.max(0, Number(stock.available_units) - Number(stock.local_pending_units))
    if (line.units > available) {
      throw new RequestError(`A quantidade solicitada do produto ${stock.external_id} - ${stock.name} não está disponível no momento. Ajuste o carrinho e tente novamente.`, 409)
    }
  }
}

async function activeCampaignOffers(database, productIds, customerExternalId = null) {
  const ids = [...new Set(productIds.map(Number).filter((value) => Number.isSafeInteger(value) && value > 0))]
  if (!ids.length) return new Map()
  const placeholders = ids.map((_, index) => `$${index + 2}`).join(',')
  const customerParam = ids.length + 2
  const result = await database.query(
    `SELECT dcp.product_id,dc.external_id,dc.description,dcp.min_quantity,dcp.max_quantity,
            dcp.discount_percent,dcp.discount_type
     FROM discount_campaign_products dcp
     JOIN discount_campaigns dc ON dc.id=dcp.campaign_id
     LEFT JOIN discount_campaign_customers dcc
       ON dcc.campaign_id=dc.id AND dcc.customer_external_id=$${customerParam}::integer
     WHERE dc.active=TRUE AND dc.starts_on<=$1::date AND dc.ends_on>=$1::date
       AND dcp.product_id IN (${placeholders})
       AND (dc.customer_restricted=FALSE OR dcc.customer_external_id IS NOT NULL)
     ORDER BY dcp.product_id,dcp.discount_percent DESC,dc.external_id`,
    [currentBrasiliaDate(), ...ids, customerExternalId],
  )
  const offers = new Map()
  for (const row of result.rows) {
    const productId = Number(row.product_id)
    offers.set(productId, [...(offers.get(productId) || []), {
      campaignCode: Number(row.external_id),
      campaign: row.description,
      minQuantity: Number(row.min_quantity),
      maxQuantity: row.max_quantity == null ? null : Number(row.max_quantity),
      discountPercent: Number(row.discount_percent),
      discountType: row.discount_type || '',
    }])
  }
  return offers
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
    `Este pedido já foi vinculado ao número ${current.rows[0].winthor_order_number} e não pode mais ser cancelado pelo e-commerce.`,
    409,
  )
}

// Crédito disponível = LIMCRED - títulos em aberto - pedidos não faturados no WinThor
// - pedidos do e-commerce que ainda não estavam no WinThor na última leitura.
async function customerCreditSummary(database, customerId, { lock = false } = {}) {
  const conditionsResult = await database.query(
    `SELECT credit_limit, open_titles_amount, open_orders_amount, is_blocked, payment_plans, source_updated_at, updated_at
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
    isBlocked: Boolean(row.is_blocked),
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

    // Primeiro acesso de cliente do WinThor: o cadastro é criado agora, depois que a senha
    // foi definida pelo link enviado ao e-mail oficial. Só vale se o e-mail autenticado for
    // exatamente o e-mail oficial do documento no WinThor.
    if ((!customerResult.rows.length || !customerResult.rows[0].supabase_user_id) && !profile && metadataDocument) {
      const official = await fetchWinthorCustomerByDocument(metadataDocument)
      if (official?.email && official.email.toLowerCase() === request.authUser.email) {
        const conflicting = await client.query(
          `SELECT id FROM customers
           WHERE active=TRUE AND document<>$3
             AND (external_id=$1 OR LOWER(email)=LOWER($2) OR supabase_user_id=$4)
           LIMIT 1`,
          [official.code, official.email, official.document, request.authUser.id],
        )
        if (conflicting.rows.length) {
          await client.query('ROLLBACK')
          return response.status(409).json({ message: 'Este CPF/CNPJ já está ligado a outra conta de acesso. Fale com a equipe Ômega.' })
        }
        const created = await client.query(
          `INSERT INTO customers (
             external_id, document, person_type, legal_name, trade_name, phone, email, supabase_user_id,
             postal_code, address_line, address_number, address_complement, neighborhood, city, state,
             sales_channel, registration_status, approved_at, active, source
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'approved',CURRENT_TIMESTAMP,TRUE,'erp')
           ON CONFLICT (document) DO UPDATE SET
             external_id=EXCLUDED.external_id, person_type=EXCLUDED.person_type,
             legal_name=EXCLUDED.legal_name, trade_name=EXCLUDED.trade_name, phone=EXCLUDED.phone,
             email=EXCLUDED.email, supabase_user_id=EXCLUDED.supabase_user_id, password_hash=NULL,
             postal_code=EXCLUDED.postal_code, address_line=EXCLUDED.address_line,
             address_number=EXCLUDED.address_number, address_complement=EXCLUDED.address_complement,
             neighborhood=EXCLUDED.neighborhood, city=EXCLUDED.city, state=EXCLUDED.state,
             sales_channel=EXCLUDED.sales_channel, registration_status='approved',
             approved_at=COALESCE(customers.approved_at,CURRENT_TIMESTAMP), active=TRUE, source='erp',
             updated_at=CURRENT_TIMESTAMP
           WHERE customers.supabase_user_id IS NULL OR customers.supabase_user_id=EXCLUDED.supabase_user_id
           RETURNING id, external_id, document, person_type, legal_name, trade_name, phone, email,
                     postal_code, address_line, address_number, address_complement, neighborhood,
                     city, state, sales_channel, registration_status`,
          [
            official.code, official.document, official.personType, official.name, official.tradeName,
            official.phone, official.email, request.authUser.id, official.postalCode, official.addressLine,
            official.addressNumber, official.addressComplement, official.neighborhood, official.city,
            official.state, official.salesChannel,
          ],
        )
        if (!created.rows.length) {
          await client.query('ROLLBACK')
          return response.status(409).json({ message: 'Este cliente já está vinculado a outra conta.' })
        }
        await client.query('COMMIT')
        return response.json({ accountType: 'customer', customer: customerJson(created.rows[0]) })
      }
    }

    if ((!customerResult.rows.length || !customerResult.rows[0].supabase_user_id) && !profile) {
      await client.query('ROLLBACK')
      return response.status(409).json({
        message: 'Informe seu CPF ou CNPJ para continuar.',
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
    if (error instanceof OmegaApiError) return response.status(error.status).json({ message: error.message })
    return next(error)
  } finally {
    client.release()
  }
})

app.post('/api/auth/login', async (request, response, next) => {
  try {
    if (supabaseAuthConfigured()) {
      return response.status(410).json({ message: 'Entre pela página de login da loja.' })
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
  if (request.customer.registration_status === 'approved') {
    return response.status(403).json({ message: 'Para alterar seus dados, fale com a equipe Ômega.' })
  }
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

app.get('/api/site/institutional', async (_request, response, next) => {
  try {
    const result = await pool.query('SELECT * FROM institutional_page WHERE id=1')
    if (!result.rows.length) return response.status(404).json({ message: 'Conteúdo institucional indisponível.' })
    return response.json({ content: institutionalPageJson(result.rows[0]) })
  } catch (error) {
    return next(error)
  }
})

app.get('/api/site/institutional/image/:slot', async (request, response, next) => {
  try {
    const slots = {
      hero: ['hero_image_data', 'hero_image_mime'],
      history: ['history_image_data', 'history_image_mime'],
    }
    const columns = slots[request.params.slot]
    if (!columns) return response.status(404).end()
    const result = await pool.query(`SELECT ${columns[0]} AS data, ${columns[1]} AS mime FROM institutional_page WHERE id=1`)
    if (!result.rows[0]?.data) return response.status(404).end()
    response.setHeader('Content-Type', result.rows[0].mime || 'image/webp')
    response.setHeader('Cache-Control', 'public, max-age=86400, immutable')
    return response.send(result.rows[0].data)
  } catch (error) {
    return next(error)
  }
})

app.put('/api/staff/site/institutional', requireMarketingAccess, async (request, response, next) => {
  try {
    const parsed = institutionalPageSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
    const content = parsed.data
    let heroImage = null
    let historyImage = null
    try {
      heroImage = decodeBannerImage(content.heroImageDataUrl)
      historyImage = decodeBannerImage(content.historyImageDataUrl)
    } catch (error) {
      return response.status(400).json({ message: error.message })
    }
    const result = await pool.query(
      `UPDATE institutional_page SET
         hero_title=$1, hero_subtitle=$2, history_title=$3, history_text=$4,
         values_title=$5, values_text=$6,
         hero_image_data=CASE WHEN $9 THEN NULL WHEN $7::bytea IS NOT NULL THEN $7 ELSE hero_image_data END,
         hero_image_mime=CASE WHEN $9 THEN NULL WHEN $7::bytea IS NOT NULL THEN $8 ELSE hero_image_mime END,
         history_image_data=CASE WHEN $12 THEN NULL WHEN $10::bytea IS NOT NULL THEN $10 ELSE history_image_data END,
         history_image_mime=CASE WHEN $12 THEN NULL WHEN $10::bytea IS NOT NULL THEN $11 ELSE history_image_mime END,
         updated_by=$13, updated_at=CURRENT_TIMESTAMP
       WHERE id=1 RETURNING *`,
      [
        content.heroTitle, content.heroSubtitle, content.historyTitle, content.historyText,
        content.valuesTitle, content.valuesText,
        heroImage?.data || null, heroImage?.mime || null, content.removeHeroImage,
        historyImage?.data || null, historyImage?.mime || null, content.removeHistoryImage,
        request.staff.id,
      ],
    )
    return response.json({ content: institutionalPageJson(result.rows[0]) })
  } catch (error) {
    return next(error)
  }
})

app.get('/api/banners', async (request, response, next) => {
  try {
    const placement = request.query.placement === 'catalog' ? 'catalog' : 'hero'
    const pricing = await customerPricing(pool, request.customer)
    const restrictedSupplierIds = pricing?.restrictedSupplierIds || []
    const customerExternalId = Number(request.customer?.external_id) || null
    // pg-mem não implementa referências correlacionadas dentro destes EXISTS.
    // O PostgreSQL do Railway mantém a filtragem completa; no banco temporário
    // local, os banners de demonstração são apenas filtrados por vigência e tipo.
    const destinationAvailability = process.env.DATABASE_URL ? `AND (
           b.destination_type = 'navigation'
           OR (b.destination_type IN ('sections','products','suppliers') AND EXISTS (
             SELECT 1
             FROM products bp
             WHERE bp.active = TRUE
               AND (
                 (b.destination_type = 'sections' AND bp.section_code = ANY(b.destination_values))
                 OR (b.destination_type = 'products' AND bp.external_id = ANY(b.destination_values))
                 OR (b.destination_type = 'suppliers' AND bp.supplier_id = ANY(b.destination_values))
               )
               AND ($2::integer[] = '{}'::integer[] OR NOT (bp.supplier_id = ANY($2::integer[])))
           ))
           OR (b.destination_type = 'campaigns' AND EXISTS (
             SELECT 1
             FROM discount_campaigns bdc
             JOIN discount_campaign_products bdcp ON bdcp.campaign_id=bdc.id
             JOIN products bp ON bp.id=bdcp.product_id AND bp.active=TRUE
              LEFT JOIN discount_campaign_customers bdcc
                ON bdcc.campaign_id=bdc.id AND bdcc.customer_external_id=$4::integer
             WHERE bdc.external_id=ANY(b.destination_values)
               AND bdc.active=TRUE AND bdc.starts_on<=$3::date AND bdc.ends_on>=$3::date
               AND ($2::integer[] = '{}'::integer[] OR NOT (bp.supplier_id = ANY($2::integer[])))
                AND (bdc.customer_restricted=FALSE OR bdcc.customer_external_id IS NOT NULL)
           ))
         )` : ''
    const result = await pool.query(
      `SELECT b.id, b.title, b.alt_text, b.image_path, b.image_data IS NOT NULL AS uploaded,
              b.mobile_image_path, b.mobile_image_data IS NOT NULL AS mobile_uploaded,
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
         ${destinationAvailability}
       ORDER BY b.position, b.id`,
      process.env.DATABASE_URL
        ? [placement, postgresIntegerArray(restrictedSupplierIds), currentBrasiliaDate(), customerExternalId]
        : [placement],
    )
    return response.json({ banners: result.rows.map((banner) => ({
      id: Number(banner.id),
      title: banner.title,
      altText: banner.alt_text,
      imageUrl: banner.uploaded ? `/api/banners/${banner.id}/image?v=${new Date(banner.updated_at).getTime()}` : banner.image_path,
      mobileImageUrl: banner.mobile_uploaded
        ? `/api/banners/${banner.id}/mobile-image?v=${new Date(banner.updated_at).getTime()}`
        : (banner.mobile_image_path || (banner.uploaded ? `/api/banners/${banner.id}/image?v=${new Date(banner.updated_at).getTime()}` : banner.image_path)),
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

app.get('/api/banners/:id/mobile-image', async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT COALESCE(mobile_image_data,image_data) AS image_data,
              COALESCE(mobile_image_mime,image_mime) AS image_mime
       FROM banners WHERE id=$1 LIMIT 1`,
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
        active BOOLEAN, price_date DATE, orders_last_30_days INTEGER
      )`,
    )

    const rows = uniqueProducts.map((product) => [
      'Filial', product.externalId, product.supplierId, product.brand, product.name,
      product.package, product.masterPackage, product.unitsPerBox, product.salesMultiple, product.minBoxes,
      product.retailUnitPrice, product.retailUnitPrice, product.retailUnitPrice,
      product.networkUnitPrice || product.retailUnitPrice, product.departmentCode, product.department,
      product.sectionCode, product.section, product.ean, product.manufacturerCode, product.ncm, true, product.priceDate || null,
      product.ordersLast30Days,
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
    // Pedidos dos últimos 30 dias: ordenação do catálogo. Atualizado à parte para não
    // contar como alteração cadastral do produto.
    await client.query(
      `UPDATE products p SET orders_last_30_days=s.orders_last_30_days
       FROM ecommerce_product_stage s
       WHERE p.company=s.company AND p.external_id=s.external_id
         AND p.orders_last_30_days IS DISTINCT FROM s.orders_last_30_days`,
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
       VALUES (CURRENT_TIMESTAMP,$1,$2,$3,$4,'success','Sistema comercial via API HTTPS')`,
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

app.post('/api/integrations/campaigns/sync', async (request, response, next) => {
  if (!validIntegrationToken(request)) return response.status(401).json({ message: 'Credencial de integração inválida.' })
  const parsed = campaignSyncSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
  const campaigns = [...new Map(parsed.data.campaigns.map((campaign) => [campaign.externalId, campaign])).values()]
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (process.env.DATABASE_URL) await client.query("SELECT pg_advisory_xact_lock(hashtext('omega_ecommerce_campaign_sync'))")
    const externalIds = campaigns.map((campaign) => campaign.externalId)
    const receivedIds = new Set(externalIds)
    const currentCampaigns = await client.query('SELECT id,external_id,active FROM discount_campaigns')
    const removedCampaigns = currentCampaigns.rows.filter((row) => row.active && !receivedIds.has(Number(row.external_id)))
    for (const removed of removedCampaigns) {
      await client.query('UPDATE discount_campaigns SET active=FALSE,updated_at=CURRENT_TIMESTAMP WHERE id=$1', [removed.id])
      await client.query('DELETE FROM discount_campaign_products WHERE campaign_id=$1', [removed.id])
      await client.query('DELETE FROM discount_campaign_customers WHERE campaign_id=$1', [removed.id])
    }
    const deactivatedCount = removedCampaigns.length

    let productCount = 0
    let skippedProducts = 0
    let customerRestrictionCount = 0
    for (const campaign of campaigns) {
      const campaignResult = await client.query(
        `INSERT INTO discount_campaigns
          (external_id,description,starts_on,ends_on,branch_code,uses_product_family,customer_restricted,active,source_updated_at)
         VALUES ($1,$2,$3::date,$4::date,$5,$6,COALESCE($7::boolean,FALSE),TRUE,$8::timestamptz)
         ON CONFLICT (external_id) DO UPDATE SET description=EXCLUDED.description,
           starts_on=EXCLUDED.starts_on,ends_on=EXCLUDED.ends_on,branch_code=EXCLUDED.branch_code,
           uses_product_family=EXCLUDED.uses_product_family,
           customer_restricted=COALESCE($7::boolean,discount_campaigns.customer_restricted),active=TRUE,
           source_updated_at=EXCLUDED.source_updated_at,updated_at=CURRENT_TIMESTAMP
         RETURNING id`,
        [campaign.externalId, campaign.description, campaign.startsOn, campaign.endsOn,
          campaign.branchCode, campaign.usesProductFamily,
          Array.isArray(campaign.allowedCustomerIds) ? campaign.allowedCustomerIds.length > 0 : null,
          parsed.data.sourceUpdatedAt],
      )
      const campaignId = Number(campaignResult.rows[0].id)
      await client.query('DELETE FROM discount_campaign_products WHERE campaign_id=$1', [campaignId])
      if (Array.isArray(campaign.allowedCustomerIds)) {
        await client.query('DELETE FROM discount_campaign_customers WHERE campaign_id=$1', [campaignId])
        const allowedCustomerIds = [...new Set(campaign.allowedCustomerIds)]
        for (const customerExternalId of allowedCustomerIds) {
          await client.query(
            `INSERT INTO discount_campaign_customers (campaign_id,customer_external_id)
             VALUES ($1,$2) ON CONFLICT (campaign_id,customer_external_id) DO NOTHING`,
            [campaignId, customerExternalId],
          )
          customerRestrictionCount += 1
        }
      }
      const uniqueProducts = [...new Map(campaign.products.map((product) => [
        `${product.externalId}:${product.sequence}`, product,
      ])).values()]
      for (const product of uniqueProducts) {
        const inserted = await client.query(
          `INSERT INTO discount_campaign_products
            (campaign_id,product_id,sequence,registered_product_code,product_origin,min_quantity,max_quantity,discount_percent,discount_type)
           SELECT $1::bigint,p.id,$3::integer,$4::integer,$5::varchar,$6::integer,
                  $7::integer,$8::numeric,$9::text
           FROM products p WHERE p.company='Filial' AND p.external_id=$2 AND p.active=TRUE
           ON CONFLICT (campaign_id,product_id,sequence) DO UPDATE SET
             registered_product_code=EXCLUDED.registered_product_code,product_origin=EXCLUDED.product_origin,
             min_quantity=EXCLUDED.min_quantity,max_quantity=EXCLUDED.max_quantity,
             discount_percent=EXCLUDED.discount_percent,discount_type=EXCLUDED.discount_type
           RETURNING product_id`,
          [campaignId, product.externalId, product.sequence, product.registeredProductCode,
            product.origin, product.minQuantity, product.maxQuantity ?? null,
            product.discountPercent, product.discountType],
        )
        if (inserted.rowCount) productCount += 1
        else skippedProducts += 1
      }
    }
    await client.query('COMMIT')
    return response.json({
      synchronized: true,
      campaignCount: campaigns.length,
      productCount,
      customerRestrictionCount,
      skippedProducts,
      deactivatedCount,
    })
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

// Clientes aprovados nas últimas 24h ainda sem condições comerciais: o job de estoque
// (a cada minuto) usa esta lista para liberar os preços logo após o primeiro acesso.
app.get('/api/integrations/customers/pending', async (request, response) => {
  if (!validIntegrationToken(request)) return response.status(401).json({ message: 'Credencial de integração inválida.' })
  const result = await pool.query(
    `SELECT DISTINCT c.external_id FROM customers c
     LEFT JOIN customer_commercial_conditions cc ON cc.customer_id=c.id
     WHERE c.active=TRUE AND c.registration_status='approved' AND c.external_id IS NOT NULL
       AND cc.customer_id IS NULL AND c.created_at > CURRENT_TIMESTAMP - INTERVAL '1 day'
     ORDER BY c.external_id`,
  )
  return response.json({ externalIds: result.rows.map((row) => Number(row.external_id)) })
})

app.post('/api/integrations/customers/conditions', async (request, response, next) => {
  if (!validIntegrationToken(request)) return response.status(401).json({ message: 'Credencial de integração inválida.' })
  const parsed = customerConditionsSyncSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
  const client = await pool.connect()
  const authEmailChanges = []
  try {
    await client.query('BEGIN')
    let updatedCount = 0
    for (const condition of parsed.data.customers) {
      const currentCustomer = await client.query(
        'SELECT id, document, email, supabase_user_id FROM customers WHERE external_id=$1 AND active=TRUE LIMIT 1',
        [condition.externalId],
      )
      if (!currentCustomer.rows.length) continue
      if (digits(currentCustomer.rows[0].document) !== condition.document) {
        throw new RequestError(`O CPF/CNPJ do cliente ${condition.externalId} diverge do cadastro vinculado.`, 409)
      }
      const currentProfile = currentCustomer.rows[0]
      if (condition.email && currentProfile.supabase_user_id
        && currentProfile.email.toLowerCase() !== condition.email) {
        const [staffOwner, customerOwner, authOwner] = await Promise.all([
          client.query('SELECT id FROM staff_users WHERE LOWER(email)=LOWER($1) AND active=TRUE LIMIT 1', [condition.email]),
          client.query('SELECT id FROM customers WHERE LOWER(email)=LOWER($1) AND id<>$2 AND active=TRUE LIMIT 1', [condition.email, currentProfile.id]),
          findSupabaseUserByEmail(condition.email),
        ])
        if (staffOwner.rows.length || customerOwner.rows.length
          || (authOwner && authOwner.id !== currentProfile.supabase_user_id)) {
          throw new RequestError(`O e-mail oficial do cliente ${condition.externalId} já está vinculado a outra conta.`, 409)
        }
        await updateSupabaseUser(currentProfile.supabase_user_id, {
          email: condition.email,
          metadata: { account_type: 'customer', document: condition.document, external_id: condition.externalId },
        })
        authEmailChanges.push({ id: currentProfile.supabase_user_id, email: currentProfile.email })
      }
      await client.query(
        `UPDATE customers SET person_type=$2, legal_name=$3, trade_name=$4, phone=$5,
           email=CASE WHEN $6<>'' THEN $6 ELSE email END,
           postal_code=$7, address_line=$8, address_number=$9, address_complement=$10,
           neighborhood=$11, city=$12, state=$13, sales_channel=$14, source='erp',
           updated_at=CURRENT_TIMESTAMP
         WHERE id=$1`,
        [currentCustomer.rows[0].id, condition.personType, condition.legalName, condition.tradeName,
          condition.phone, condition.email, condition.postalCode, condition.addressLine,
          condition.addressNumber, condition.addressComplement, condition.neighborhood,
          condition.city, condition.state, condition.salesChannel],
      )
      const result = await client.query(
        `INSERT INTO customer_commercial_conditions
          (customer_id, credit_limit, open_titles_amount, open_orders_amount, price_region, stock_branch, is_blocked, allow_sales_multiple, restricted_supplier_ids, payment_plans, source_updated_at)
         SELECT id,$2::numeric,$5::numeric,$6::numeric,$7::int,$9::int,$10::boolean,$11::boolean,$8::integer[],$3::jsonb,$4::timestamptz FROM customers WHERE external_id=$1 AND active=TRUE
         ON CONFLICT (customer_id) DO UPDATE SET credit_limit=EXCLUDED.credit_limit,
           open_titles_amount=EXCLUDED.open_titles_amount, open_orders_amount=EXCLUDED.open_orders_amount,
           price_region=COALESCE(EXCLUDED.price_region, customer_commercial_conditions.price_region),
           stock_branch=COALESCE(EXCLUDED.stock_branch, customer_commercial_conditions.stock_branch),
           is_blocked=EXCLUDED.is_blocked,
           allow_sales_multiple=EXCLUDED.allow_sales_multiple,
           restricted_supplier_ids=EXCLUDED.restricted_supplier_ids,
           payment_plans=EXCLUDED.payment_plans, source_updated_at=EXCLUDED.source_updated_at,
           updated_at=CURRENT_TIMESTAMP
         RETURNING customer_id`,
        [condition.externalId, condition.creditLimit, JSON.stringify(condition.paymentPlans), condition.sourceUpdatedAt || null,
          condition.openTitlesAmount, condition.openOrdersAmount, condition.priceRegion ?? null,
          postgresIntegerArray(condition.restrictedSupplierIds), condition.stockBranch ?? null, condition.isBlocked, condition.allowSalesMultiple],
      )
      updatedCount += result.rowCount
    }
    await client.query('COMMIT')
    return response.json({ updatedCount })
  } catch (error) {
    await client.query('ROLLBACK')
    for (const change of authEmailChanges.reverse()) {
      await updateSupabaseUser(change.id, { email: change.email }).catch(() => undefined)
    }
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

app.post('/api/integrations/stocks/sync', async (request, response, next) => {
  if (!validIntegrationToken(request)) return response.status(401).json({ message: 'Credencial de integração inválida.' })
  const parsed = productStocksSyncSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })

  const uniqueRows = [...new Map(parsed.data.stocks.map((row) => [`${row[1]}:${row[0]}`, row])).values()]
  const branches = [...new Set(uniqueRows.map((row) => row[1]))].sort()
  if (branches.length !== 2 || branches[0] !== 1 || branches[1] !== 3) {
    return response.status(409).json({ message: 'A sincronização de estoque precisa conter as filiais 1 e 3.' })
  }
  const minimumPerBranch = Math.max(1, Number(process.env.STOCK_SYNC_MIN_COUNT) || 100)
  for (const branch of branches) {
    const count = uniqueRows.filter((row) => row[1] === branch).length
    if (count < minimumPerBranch) {
      return response.status(409).json({ message: `Sincronização da filial ${branch} cancelada: ${count} itens, abaixo do mínimo de segurança (${minimumPerBranch}).` })
    }
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (process.env.DATABASE_URL) await client.query("SELECT pg_advisory_xact_lock(hashtext('omega_ecommerce_stock_sync'))")
    const stockStageKind = process.env.DATABASE_URL ? 'TEMP ' : ''
    await client.query(`CREATE ${stockStageKind}TABLE ecommerce_stock_stage (
      external_id INTEGER NOT NULL, branch INTEGER NOT NULL,
      total_units NUMERIC(14,2) NOT NULL, reserved_units NUMERIC(14,2) NOT NULL,
      blocked_units NUMERIC(14,2) NOT NULL, available_units NUMERIC(14,2) NOT NULL
    )`)
    for (let offset = 0; offset < uniqueRows.length; offset += 500) {
      const batch = uniqueRows.slice(offset, offset + 500)
      const params = []
      const values = batch.map(([externalId, branch, total, reserved, blocked]) => {
        const available = Math.max(0, Number(total) - Number(reserved) - Number(blocked))
        return `(${[externalId, branch, total, reserved, blocked, available].map((value) => {
          params.push(value); return `$${params.length}`
        }).join(',')})`
      })
      await client.query(`INSERT INTO ecommerce_stock_stage VALUES ${values.join(',')}`, params)
    }
    const stockDifferenceOperator = process.env.DATABASE_URL ? 'IS DISTINCT FROM' : '<>'
    const changed = await client.query(
      `INSERT INTO product_stocks
        (product_id,branch,total_units,reserved_units,blocked_units,available_units,source_updated_at)
       SELECT p.id,s.branch,s.total_units,s.reserved_units,s.blocked_units,s.available_units,$1::timestamptz
       FROM ecommerce_stock_stage s
       JOIN products p ON p.company='Filial' AND p.external_id=s.external_id AND p.active=TRUE
       ON CONFLICT (product_id,branch) DO UPDATE SET
         total_units=EXCLUDED.total_units,reserved_units=EXCLUDED.reserved_units,
         blocked_units=EXCLUDED.blocked_units,available_units=EXCLUDED.available_units,
         source_updated_at=EXCLUDED.source_updated_at,updated_at=CURRENT_TIMESTAMP
       WHERE product_stocks.total_units ${stockDifferenceOperator} EXCLUDED.total_units
          OR product_stocks.reserved_units ${stockDifferenceOperator} EXCLUDED.reserved_units
          OR product_stocks.blocked_units ${stockDifferenceOperator} EXCLUDED.blocked_units
          OR product_stocks.available_units ${stockDifferenceOperator} EXCLUDED.available_units`,
      [parsed.data.sourceUpdatedAt],
    )
    const removed = process.env.DATABASE_URL
      ? await client.query(
        `DELETE FROM product_stocks ps
         WHERE ps.branch=ANY($1::integer[])
           AND NOT EXISTS (
             SELECT 1 FROM ecommerce_stock_stage s
             JOIN products p ON p.company='Filial' AND p.external_id=s.external_id AND p.active=TRUE
             WHERE p.id=ps.product_id AND s.branch=ps.branch
           )`,
        [branches],
      )
      : { rowCount: 0 }
    for (const branch of branches) {
      const sourceCount = uniqueRows.filter((row) => row[1] === branch).length
      await client.query(
        `INSERT INTO stock_sync_state(branch,source_updated_at,source_count)
         VALUES ($1,$2::timestamptz,$3)
         ON CONFLICT (branch) DO UPDATE SET source_updated_at=EXCLUDED.source_updated_at,
           source_count=EXCLUDED.source_count,updated_at=CURRENT_TIMESTAMP`,
        [branch, parsed.data.sourceUpdatedAt, sourceCount],
      )
    }
    await client.query('DROP TABLE ecommerce_stock_stage')
    await client.query('COMMIT')
    return response.json({ sourceCount: uniqueRows.length, changedCount: changed.rowCount, removedCount: removed.rowCount, branches })
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
    if (pricing.isBlocked) {
      return response.status(403).json({ message: 'Seu cadastro está bloqueado para compras. Fale com a equipe Ômega.' })
    }
    if (pricing.region == null || !pricing.plans.length) {
      return response.status(503).json({ message: 'As condições comerciais deste cadastro ainda estão sendo atualizadas.' })
    }
    const requested = parsed.data.paymentPlan
    if (requested && !pricing.plans.some((item) => item.code === requested)) {
      return response.status(400).json({ message: 'O plano de pagamento selecionado não está liberado para este cliente.' })
    }
    const quotes = []
    for (const plan of pricing.plans) {
      try {
        const priced = await priceCartItems(pool, pricing, plan, parsed.data.items, request.customer.external_id)
        quotes.push({ plan, ...priced, ...(await applyCoupon(pool, parsed.data.couponCode, priced.lines)) })
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
      items: selected.lines.map((line) => ({
        productId: Number(line.product.id), units: line.units, baseUnitPrice: line.baseUnitPrice,
        unitPrice: line.unitPrice, lineTotal: line.lineTotal, discountPercent: line.discountPercent,
        campaignCode: line.campaignCode, campaignDescription: line.campaignDescription,
      })),
      subtotal: selected.subtotal,
      coupon: selected.coupon,
      total: selected.total,
      planTotals: quotes.map((quote) => ({ code: quote.plan.code, label: quote.plan.label, total: quote.error ? null : quote.total })),
    })
  } catch (error) {
    if (error instanceof RequestError) return response.status(error.status).json({ message: error.message })
    return next(error)
  }
})

// Checagem antecipada para alterações no carrinho. Ela não reserva unidades:
// a validação definitiva continua sendo feita dentro da transação do pedido.
app.post('/api/customer/stock-check', async (request, response, next) => {
  if (!request.customer) return response.status(401).json({ message: 'Entre na sua conta para adicionar produtos.' })
  if ((request.customer.registration_status || 'approved') !== 'approved') {
    return response.status(403).json({ message: 'Seu cadastro ainda está em análise.' })
  }
  const parsed = stockCheckSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
  try {
    const pricing = await customerPricing(pool, request.customer)
    if (pricing.isBlocked) {
      return response.status(403).json({ message: 'Seu cadastro está bloqueado para compras. Fale com a equipe Ômega.' })
    }
    const productResult = await pool.query(
      `SELECT id, external_id, supplier_id, name, units_per_box, sales_multiple
       FROM products WHERE id=$1 AND active=TRUE LIMIT 1`,
      [parsed.data.productId],
    )
    const product = productResult.rows[0]
    if (!product || pricing.restrictedSupplierIds.includes(Number(product.supplier_id))) {
      throw new RequestError('Este produto não está disponível para o seu cadastro.', 404)
    }
    const salesMultiple = purchaseMultiple(pricing, product)
    if (parsed.data.quantity < salesMultiple || parsed.data.quantity % salesMultiple !== 0) {
      throw new RequestError(`A quantidade do produto ${product.external_id} deve ser um múltiplo de ${salesMultiple} unidades.`)
    }
    await validateOrderStock(pool, pricing.stockBranch, [{ product, units: parsed.data.quantity }])
    return response.json({ available: true })
  } catch (error) {
    if (error instanceof RequestError) return response.status(error.status).json({ message: error.message })
    return next(error)
  }
})

app.get('/api/customer/cart', async (request, response, next) => {
  if (!request.customer) return response.status(401).json({ message: 'Entre na sua conta para consultar o carrinho.' })
  try {
    const pricing = await customerPricing(pool, request.customer)
    const priceTables = pricing?.region != null ? pricing.priceTables : []
    const priceColumns = priceTables.map((table) => `, rp.${priceColumn(table)}`).join('')
    const restrictedSupplierIds = pricing?.restrictedSupplierIds || []
    const result = await pool.query(
      `SELECT p.id,p.external_id,p.supplier_id,p.brand,p.name,p.package,p.master_package,
              p.units_per_box,p.sales_multiple,p.min_boxes,p.department_code,p.department,
              p.section_code,p.section,p.image_path,p.image_data IS NOT NULL AS image_uploaded,
              p.image_hidden,p.image_updated_at,p.ean,p.manufacturer_code,p.ncm_code,
              p.price_date,p.orders_last_30_days,cci.quantity,cc.updated_at AS cart_updated_at${priceColumns}
       FROM customer_cart_items cci
       JOIN customer_carts cc ON cc.customer_id=cci.customer_id
       JOIN products p ON p.id=cci.product_id AND p.active=TRUE
       LEFT JOIN region_prices rp ON rp.product_id=p.id AND rp.region=$2
       WHERE cci.customer_id=$1
         AND ($3::integer[]='{}'::integer[] OR NOT (p.supplier_id=ANY($3::integer[])))
       ORDER BY cci.created_at, p.name`,
      [request.customer.id, priceTables.length ? pricing.region : -1, postgresIntegerArray(restrictedSupplierIds)],
    )
    const campaignOffers = await activeCampaignOffers(
      pool,
      result.rows.map((row) => Number(row.id)),
      request.customer.external_id,
    )
    return response.json({
      updatedAt: result.rows[0]?.cart_updated_at || null,
      items: result.rows.map((row) => {
        const customerPrice = lowestPlanPrice(row, priceTables)
        return {
          id: Number(row.id), code: Number(row.external_id), supplierId: Number(row.supplier_id || 0),
          brand: row.brand, name: row.name, package: row.package || '', masterPackage: row.master_package || '',
          unitsPerBox: Number(row.units_per_box), salesMultiple: purchaseMultiple(pricing, row), minBoxes: Number(row.min_boxes),
          unitPrice: customerPrice, listUnitPrice: customerPrice,
          category: row.section || 'Sem seção', categories: row.section ? [row.section] : [],
          departmentCode: Number(row.department_code || 0), department: row.department || '',
          sectionCode: Number(row.section_code || 0), section: row.section || '',
          image: productImageUrl(row), priceDate: row.price_date, ordersLast30Days: Number(row.orders_last_30_days || 0),
          ean: row.ean || '', manufacturerCode: row.manufacturer_code || '', ncm: row.ncm_code || '',
          campaignOffers: campaignOffers.get(Number(row.id)) || [], quantity: Number(row.quantity),
        }
      }),
    })
  } catch (error) {
    return next(error)
  }
})

app.put('/api/customer/cart/:productId', async (request, response, next) => {
  if (!request.customer) return response.status(401).json({ message: 'Entre na sua conta para alterar o carrinho.' })
  if ((request.customer.registration_status || 'approved') !== 'approved') {
    return response.status(403).json({ message: 'Seu cadastro ainda está em análise.' })
  }
  const parsed = cartQuantitySchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
  const productId = Number(request.params.productId)
  if (!Number.isSafeInteger(productId) || productId < 1) return response.status(400).json({ message: 'Produto inválido.' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const pricing = await customerPricing(client, request.customer)
    if (!pricing || pricing.isBlocked) throw new RequestError('Seu cadastro está bloqueado para compras. Fale com a equipe Ômega.', 403)
    const productResult = await client.query(
      'SELECT id,external_id,supplier_id,name,units_per_box,sales_multiple FROM products WHERE id=$1 AND active=TRUE LIMIT 1',
      [productId],
    )
    const product = productResult.rows[0]
    if (!product || pricing.restrictedSupplierIds.includes(Number(product.supplier_id))) {
      throw new RequestError('Este produto não está disponível para o seu cadastro.', 404)
    }
    const salesMultiple = purchaseMultiple(pricing, product)
    if (parsed.data.quantity < salesMultiple || parsed.data.quantity % salesMultiple !== 0) {
      throw new RequestError(`A quantidade do produto ${product.external_id} deve ser um múltiplo de ${salesMultiple} unidades.`)
    }
    await validateOrderStock(client, pricing.stockBranch, [{ product, units: parsed.data.quantity }])
    await client.query(
      `INSERT INTO customer_carts(customer_id,reminder_sent_at,updated_at) VALUES ($1,NULL,CURRENT_TIMESTAMP)
       ON CONFLICT (customer_id) DO UPDATE SET reminder_sent_at=NULL,updated_at=CURRENT_TIMESTAMP`,
      [request.customer.id],
    )
    await client.query(
      `INSERT INTO customer_cart_items(customer_id,product_id,quantity) VALUES ($1,$2,$3)
       ON CONFLICT (customer_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity,updated_at=CURRENT_TIMESTAMP`,
      [request.customer.id, productId, parsed.data.quantity],
    )
    await client.query('COMMIT')
    return response.json({ productId, quantity: parsed.data.quantity })
  } catch (error) {
    await client.query('ROLLBACK')
    if (error instanceof RequestError) return response.status(error.status).json({ message: error.message })
    return next(error)
  } finally {
    client.release()
  }
})

app.delete('/api/customer/cart/:productId', async (request, response, next) => {
  if (!request.customer) return response.status(401).json({ message: 'Entre na sua conta para alterar o carrinho.' })
  const productId = Number(request.params.productId)
  if (!Number.isSafeInteger(productId) || productId < 1) return response.status(400).json({ message: 'Produto inválido.' })
  try {
    await pool.query('DELETE FROM customer_cart_items WHERE customer_id=$1 AND product_id=$2', [request.customer.id, productId])
    await pool.query(
      `INSERT INTO customer_carts(customer_id,reminder_sent_at,updated_at) VALUES ($1,NULL,CURRENT_TIMESTAMP)
       ON CONFLICT (customer_id) DO UPDATE SET reminder_sent_at=NULL,updated_at=CURRENT_TIMESTAMP`,
      [request.customer.id],
    )
    return response.status(204).end()
  } catch (error) {
    return next(error)
  }
})

app.delete('/api/customer/cart', async (request, response, next) => {
  if (!request.customer) return response.status(401).json({ message: 'Entre na sua conta para alterar o carrinho.' })
  try {
    await pool.query('DELETE FROM customer_cart_items WHERE customer_id=$1', [request.customer.id])
    await pool.query(
      `INSERT INTO customer_carts(customer_id,reminder_sent_at,updated_at) VALUES ($1,NULL,CURRENT_TIMESTAMP)
       ON CONFLICT (customer_id) DO UPDATE SET reminder_sent_at=NULL,updated_at=CURRENT_TIMESTAMP`,
      [request.customer.id],
    )
    return response.status(204).end()
  } catch (error) {
    return next(error)
  }
})

app.get('/api/campaigns', async (request, response, next) => {
  try {
    const pricing = await customerPricing(pool, request.customer)
    const restrictedSupplierIds = pricing?.restrictedSupplierIds || []
    const customerExternalId = Number(request.customer?.external_id) || null
    const result = await pool.query(
      `SELECT dc.external_id,dc.description,dc.starts_on,dc.ends_on,dc.uses_product_family,
              p.id AS product_id,p.external_id AS product_code,p.name,p.brand,p.supplier_id,
              p.image_path,p.image_data IS NOT NULL AS image_uploaded,p.image_hidden,p.image_updated_at,
              dcp.min_quantity,dcp.max_quantity,dcp.discount_percent,dcp.discount_type
       FROM discount_campaigns dc
       JOIN discount_campaign_products dcp ON dcp.campaign_id=dc.id
       JOIN products p ON p.id=dcp.product_id AND p.active=TRUE
       LEFT JOIN discount_campaign_customers dcc
         ON dcc.campaign_id=dc.id AND dcc.customer_external_id=$3::integer
       WHERE dc.active=TRUE AND dc.starts_on<=$1::date AND dc.ends_on>=$1::date
         AND ($2::integer[]='{}'::integer[] OR NOT (p.supplier_id=ANY($2::integer[])))
         AND (dc.customer_restricted=FALSE OR dcc.customer_external_id IS NOT NULL)
       ORDER BY dc.starts_on DESC,dc.external_id,p.orders_last_30_days DESC,p.name,dcp.discount_percent DESC`,
      [currentBrasiliaDate(), postgresIntegerArray(restrictedSupplierIds), customerExternalId],
    )
    const campaigns = new Map()
    for (const row of result.rows) {
      const code = Number(row.external_id)
      const campaign = campaigns.get(code) || {
        code, description: row.description, startsOn: row.starts_on, endsOn: row.ends_on,
        usesProductFamily: Boolean(row.uses_product_family), products: [],
      }
      let product = campaign.products.find((item) => item.id === Number(row.product_id))
      if (!product) {
        product = {
          id: Number(row.product_id), code: Number(row.product_code), name: row.name, brand: row.brand,
          supplierId: Number(row.supplier_id || 0), image: productImageUrl(row), offers: [],
        }
        campaign.products.push(product)
      }
      product.offers.push({
        minQuantity: Number(row.min_quantity), maxQuantity: row.max_quantity == null ? null : Number(row.max_quantity),
        discountPercent: Number(row.discount_percent), discountType: row.discount_type || '',
      })
      campaigns.set(code, campaign)
    }
    return response.json({ campaigns: [...campaigns.values()] })
  } catch (error) {
    return next(error)
  }
})

app.get('/api/products', async (request, response, next) => {
  try {
    const search = String(request.query.search ?? '').trim()
    const supplier = Number(request.query.supplier)
    const department = Number(request.query.department)
    const section = Number(request.query.section)
    const campaign = Number(request.query.campaign)
    const sort = request.query.sort === 'bestsellers' ? 'bestsellers' : 'featured'
    const limit = Math.min(Math.max(Number(request.query.limit) || 180, 1), 5000)
    const params = []
    const conditions = ['p.active = TRUE']
    const customerExternalId = Number(request.customer?.external_id) || null
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
    if (Number.isSafeInteger(campaign) && campaign > 0) {
      params.push(campaign, currentBrasiliaDate(), customerExternalId)
      const campaignCodeParam = params.length - 2
      const campaignDateParam = params.length - 1
      const campaignCustomerParam = params.length
      conditions.push(`p.id IN (
        SELECT dcpf.product_id FROM discount_campaign_products dcpf
        JOIN discount_campaigns dcf ON dcf.id=dcpf.campaign_id
        LEFT JOIN discount_campaign_customers dccf
          ON dccf.campaign_id=dcf.id AND dccf.customer_external_id=$${campaignCustomerParam}::integer
        WHERE dcf.external_id=$${campaignCodeParam}
          AND dcf.active=TRUE AND dcf.starts_on<=$${campaignDateParam}::date AND dcf.ends_on>=$${campaignDateParam}::date
          AND (dcf.customer_restricted=FALSE OR dccf.customer_external_id IS NOT NULL)
      )`)
    }
    const pricing = await customerPricing(pool, request.customer)
    if (pricing?.restrictedSupplierIds?.length) {
      params.push(postgresIntegerArray(pricing.restrictedSupplierIds))
      conditions.push(`NOT (p.supplier_id = ANY($${params.length}::integer[]))`)
    }
    const priceTables = pricing?.region != null ? pricing.priceTables : []
    params.push(priceTables.length ? pricing.region : -1)
    const regionParam = params.length
    const priceColumns = priceTables.map((table) => `, rp.${priceColumn(table)}`).join('')
    params.push(limit)

    const hasImage = `(p.image_hidden=FALSE AND (p.image_data IS NOT NULL OR p.image_path IS NOT NULL))`
    // Todas as listagens da loja seguem o número de pedidos dos últimos 30 dias no WinThor.
    const orderBy = `p.orders_last_30_days DESC, ${hasImage} DESC, p.name`

    const result = await pool.query(
      `SELECT p.id, p.external_id, p.supplier_id, p.brand, p.name, p.package, p.master_package,
              p.units_per_box, p.sales_multiple, p.min_boxes, p.unit_price, p.list_unit_price,
              p.retail_unit_price, p.network_unit_price,
              p.category, p.department_code, p.department, p.section_code, p.section, p.image_path,
              p.image_data IS NOT NULL AS image_uploaded, p.image_hidden, p.image_updated_at, p.ean,
              p.manufacturer_code, p.ncm_code,
              p.price_date, p.orders_last_30_days${priceColumns}
       FROM products p
       LEFT JOIN region_prices rp ON rp.product_id = p.id AND rp.region = $${regionParam}
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT $${params.length}`,
      params,
    )

    const campaignOffers = await activeCampaignOffers(
      pool,
      result.rows.map((row) => Number(row.id)),
      customerExternalId,
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
        salesMultiple: purchaseMultiple(pricing, row),
        minBoxes: Number(row.min_boxes),
        unitPrice: customerPrice,
        listUnitPrice: customerPrice,
        category: row.section || 'Sem seção',
        categories: row.section ? [row.section] : [],
        departmentCode: Number(row.department_code || 0),
        department: row.department,
        sectionCode: Number(row.section_code || 0),
        section: row.section,
        image: productImageUrl(row),
        ean: row.ean || '',
        manufacturerCode: row.manufacturer_code || '',
        ncm: row.ncm_code || '',
        priceDate: row.price_date,
        ordersLast30Days: Number(row.orders_last_30_days),
        campaignOffers: campaignOffers.get(Number(row.id)) || [],
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
async function supplierLogoMap() {
  const logos = new Map(partnerLogoBySupplier)
  const result = await pool.query('SELECT supplier_id, image_data IS NOT NULL AS uploaded, updated_at FROM supplier_logos')
  for (const row of result.rows) {
    if (row.uploaded) logos.set(Number(row.supplier_id), `/api/suppliers/${row.supplier_id}/image?v=${new Date(row.updated_at).getTime()}`)
    else logos.delete(Number(row.supplier_id))
  }
  return logos
}

app.get('/api/suppliers/:id/image', async (request, response, next) => {
  try {
    const id = Number(request.params.id)
    if (!Number.isSafeInteger(id) || id < 1) return response.status(400).end()
    const result = await pool.query('SELECT image_data FROM supplier_logos WHERE supplier_id=$1', [id])
    if (!result.rows[0]?.image_data) return response.status(404).end()
    response.set('Cache-Control', 'public, max-age=300')
    return response.type('image/webp').send(result.rows[0].image_data)
  } catch (error) { return next(error) }
})

async function changeSupplierLogo(request, response, next) {
  const id = Number(request.params.id)
  if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ message: 'Código de fornecedor inválido.' })
  try {
    const exists = await pool.query('SELECT id FROM products WHERE supplier_id=$1 AND active=TRUE LIMIT 1', [id])
    if (!exists.rows.length) return response.status(404).json({ message: 'Fornecedor não encontrado no catálogo ativo.' })
    let data = null
    if (request.method === 'PUT') {
      try { data = decodeProductImage(request.body?.imageDataUrl).data }
      catch (error) { return response.status(400).json({ message: error.message }) }
    }
    const onlyMissing = request.method === 'PUT' && request.body?.onlyMissing === true
    // Static logos count as existing unless explicitly removed by a stored override.
    if (onlyMissing) {
      const override = await pool.query('SELECT image_data IS NOT NULL AS uploaded FROM supplier_logos WHERE supplier_id=$1', [id])
      if (override.rows[0]?.uploaded || (!override.rows.length && partnerLogoBySupplier.has(id))) return response.json({ skipped: true })
    }
    const result = await pool.query(
      `INSERT INTO supplier_logos (supplier_id,image_data) VALUES ($1,$2)
       ON CONFLICT (supplier_id) DO UPDATE SET image_data=EXCLUDED.image_data,updated_at=CURRENT_TIMESTAMP
       WHERE $3=FALSE OR supplier_logos.image_data IS NULL RETURNING updated_at`,
      [id, data, onlyMissing],
    )
    if (!result.rows.length) return response.json({ skipped: true })
    return response.json({ image: data ? `/api/suppliers/${id}/image?v=${new Date(result.rows[0].updated_at).getTime()}` : null })
  } catch (error) { return next(error) }
}
app.put('/api/staff/suppliers/:id/image', requireMarketingAccess, changeSupplierLogo)
app.delete('/api/staff/suppliers/:id/image', requireMarketingAccess, changeSupplierLogo)

app.get('/api/catalog/navigation', async (request, response, next) => {
  try {
    const pricing = await customerPricing(pool, request.customer)
    const restrictedSupplierIds = pricing?.restrictedSupplierIds || []
    const taxonomyResult = await pool.query(
      `SELECT department_code, department, section_code, section, COUNT(*)::int AS product_count
       FROM products
       WHERE active=TRUE
         AND ($1::integer[] = '{}'::integer[] OR NOT (supplier_id = ANY($1::integer[])))
         AND COALESCE(department,'') <> '' AND COALESCE(section,'') <> ''
       GROUP BY department_code, department, section_code, section
       ORDER BY department, section`,
      [postgresIntegerArray(restrictedSupplierIds)],
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

    const logos = await supplierLogoMap()
    const supplierIds = [...logos.keys()].filter((id) => !restrictedSupplierIds.includes(id))
    const partnerResult = await pool.query(
      `SELECT supplier_id, MIN(brand) AS name, COUNT(*)::int AS product_count
       FROM products
       WHERE active=TRUE AND supplier_id = ANY($1::int[])
         AND ($2::integer[] = '{}'::integer[] OR NOT (supplier_id = ANY($2::integer[])))
       GROUP BY supplier_id
       ORDER BY MIN(brand)`,
      [supplierIds, postgresIntegerArray(restrictedSupplierIds)],
    )
    const partnerData = new Map(partnerResult.rows.map((row) => [Number(row.supplier_id), row]))
    const partners = supplierIds.map((supplierId) => {
      const row = partnerData.get(supplierId)
      return {
        supplierId,
        name: row?.name || `Fornecedor ${supplierId}`,
        productCount: Number(row?.product_count || 0),
        logo: logos.get(supplierId),
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
              network_unit_price, category, department_code, department, section_code, section, image_path,
              image_data IS NOT NULL AS image_uploaded, image_hidden, image_updated_at,
              ean, manufacturer_code, ncm_code, price_date
       FROM products WHERE external_id=$1 AND active=TRUE LIMIT 1`,
      [code],
    )
    if (!result.rows.length) return response.status(404).json({ message: 'Produto não encontrado ou indisponível.' })
    const row = result.rows[0]
    const pricing = await customerPricing(pool, request.customer)
    if (pricing?.restrictedSupplierIds?.includes(Number(row.supplier_id))) {
      return response.status(404).json({ message: 'Produto não encontrado ou indisponível.' })
    }
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
    let staffStocks = []
    if (request.staff) {
      const stocksResult = await pool.query(
        `SELECT b.branch,ps.total_units,ps.reserved_units,ps.blocked_units,ps.available_units,ss.source_updated_at
         FROM (VALUES (1),(3)) AS b(branch)
         LEFT JOIN product_stocks ps ON ps.branch=b.branch AND ps.product_id=$1
         LEFT JOIN stock_sync_state ss ON ss.branch=b.branch
         ORDER BY b.branch`,
        [row.id],
      )
      staffStocks = stocksResult.rows.map((stock) => ({
        branch: Number(stock.branch),
        totalUnits: stock.total_units == null ? null : Number(stock.total_units),
        reservedUnits: stock.reserved_units == null ? null : Number(stock.reserved_units),
        blockedUnits: stock.blocked_units == null ? null : Number(stock.blocked_units),
        availableUnits: stock.available_units == null ? null : Number(stock.available_units),
        updatedAt: stock.source_updated_at || null,
      }))
    }
    const campaignOffers = await activeCampaignOffers(pool, [Number(row.id)], request.customer?.external_id)
    return response.json({ product: {
      id: Number(row.id), code: Number(row.external_id), supplierId: Number(row.supplier_id || 0),
      brand: row.brand, name: row.name, package: row.package || '', masterPackage: row.master_package || '',
      unitsPerBox: Number(row.units_per_box), salesMultiple: purchaseMultiple(pricing, row), minBoxes: Number(row.min_boxes),
      unitPrice, listUnitPrice: unitPrice, planPrices,
      category: row.category || 'Sem categoria', categories: [],
      departmentCode: Number(row.department_code || 0), department: row.department || '',
      sectionCode: Number(row.section_code || 0), section: row.section || '',
      image: productImageUrl(row), priceDate: row.price_date, ordersLast30Days: Number(row.orders_last_30_days || 0),
      ean: row.ean || '', manufacturerCode: row.manufacturer_code || '', ncm: row.ncm_code || '',
      campaignOffers: campaignOffers.get(Number(row.id)) || [],
      ...(request.staff ? { stocks: staffStocks } : {}),
    } })
  } catch (error) {
    return next(error)
  }
})

app.get('/api/customer/favorites', async (request, response, next) => {
  if (!request.customer) return response.status(401).json({ message: 'Entre na sua conta para consultar seus favoritos.' })
  try {
    const pricing = await customerPricing(pool, request.customer)
    const priceTables = pricing?.region != null ? pricing.priceTables : []
    const priceColumns = priceTables.map((table) => `, rp.${priceColumn(table)}`).join('')
    const restrictedSupplierIds = pricing?.restrictedSupplierIds || []
    const result = await pool.query(
      `SELECT p.id, p.external_id, p.supplier_id, p.brand, p.name, p.package, p.master_package,
              p.units_per_box, p.sales_multiple, p.min_boxes, p.department_code, p.department,
              p.section_code, p.section, p.image_path, p.image_data IS NOT NULL AS image_uploaded,
              p.image_hidden, p.image_updated_at, p.ean, p.manufacturer_code, p.ncm_code,
              p.price_date, cf.created_at AS favorited_at${priceColumns}
       FROM customer_favorites cf
       JOIN products p ON p.id=cf.product_id AND p.active=TRUE
       LEFT JOIN region_prices rp ON rp.product_id=p.id AND rp.region=$2
       WHERE cf.customer_id=$1
         AND ($3::integer[] = '{}'::integer[] OR NOT (p.supplier_id = ANY($3::integer[])))
       ORDER BY cf.created_at DESC`,
      [request.customer.id, priceTables.length ? pricing.region : -1, postgresIntegerArray(restrictedSupplierIds)],
    )
    return response.json({ favorites: result.rows.map((row) => {
      const customerPrice = lowestPlanPrice(row, priceTables)
      return {
        id: Number(row.id), code: Number(row.external_id), supplierId: Number(row.supplier_id || 0),
        brand: row.brand, name: row.name, package: row.package || '', masterPackage: row.master_package || '',
        unitsPerBox: Number(row.units_per_box), salesMultiple: purchaseMultiple(pricing, row), minBoxes: Number(row.min_boxes),
        unitPrice: customerPrice, listUnitPrice: customerPrice,
        category: row.section || 'Sem seção', categories: row.section ? [row.section] : [],
        departmentCode: Number(row.department_code || 0), department: row.department || '',
        sectionCode: Number(row.section_code || 0), section: row.section || '',
        image: productImageUrl(row), priceDate: row.price_date, ordersLast30Days: Number(row.orders_last_30_days || 0),
        ean: row.ean || '', manufacturerCode: row.manufacturer_code || '', ncm: row.ncm_code || '',
        favoritedAt: row.favorited_at,
      }
    }) })
  } catch (error) {
    return next(error)
  }
})

app.put('/api/customer/favorites/:productId', async (request, response, next) => {
  if (!request.customer) return response.status(401).json({ message: 'Entre na sua conta para favoritar produtos.' })
  try {
    const productId = Number(request.params.productId)
    if (!Number.isSafeInteger(productId) || productId < 1) return response.status(400).json({ message: 'Produto inválido.' })
    const [productResult, pricing] = await Promise.all([
      pool.query('SELECT id, supplier_id FROM products WHERE id=$1 AND active=TRUE LIMIT 1', [productId]),
      customerPricing(pool, request.customer),
    ])
    if (!productResult.rows.length || pricing?.restrictedSupplierIds?.includes(Number(productResult.rows[0].supplier_id))) {
      return response.status(404).json({ message: 'Produto não encontrado ou indisponível.' })
    }
    await pool.query(
      `INSERT INTO customer_favorites(customer_id,product_id) VALUES ($1,$2)
       ON CONFLICT (customer_id,product_id) DO NOTHING`,
      [request.customer.id, productId],
    )
    return response.status(201).json({ productId, favorite: true })
  } catch (error) {
    return next(error)
  }
})

app.delete('/api/customer/favorites/:productId', async (request, response, next) => {
  if (!request.customer) return response.status(401).json({ message: 'Entre na sua conta para alterar seus favoritos.' })
  try {
    const productId = Number(request.params.productId)
    if (!Number.isSafeInteger(productId) || productId < 1) return response.status(400).json({ message: 'Produto inválido.' })
    await pool.query('DELETE FROM customer_favorites WHERE customer_id=$1 AND product_id=$2', [request.customer.id, productId])
    return response.status(204).end()
  } catch (error) {
    return next(error)
  }
})

app.get('/api/customer/commercial-conditions', async (request, response, next) => {
  if (!request.customer) return response.status(401).json({ message: 'Entre na sua conta para consultar as condições comerciais.' })
  try {
    const summary = await customerCreditSummary(pool, request.customer.id)
    if (!summary) {
      return response.status(503).json({ message: 'As condições comerciais deste cadastro ainda estão sendo atualizadas.' })
    }
    return response.json(summary)
  } catch (error) {
    return next(error)
  }
})

app.post('/api/customers/lookup', firstAccessLimiter, async (request, response, next) => {
  try {
    const parsed = lookupSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
    const localResult = await pool.query(
      `SELECT id, external_id, registration_status, supabase_user_id, email
       FROM customers WHERE document=$1 AND active=TRUE LIMIT 1`,
      [parsed.data.document],
    )
    const localCustomer = localResult.rows[0]
    // Um cadastro iniciado pelo site continua sob análise até que a equipe informe o CODCLI.
    if (localCustomer?.registration_status === 'pending' && localCustomer.supabase_user_id) {
      return response.json({ found: true, pending: true })
    }

    const official = await fetchWinthorCustomerByDocument(parsed.data.document)
    if (!official) return response.json({ found: false, document: parsed.data.document, personType: parsed.data.personType })
    if (!official.email) {
      return response.json({ found: true, contactRequired: true })
    }
    // O cadastro no e-commerce só é criado quando o cliente define a senha do primeiro acesso.
    if (localCustomer?.supabase_user_id) {
      return response.json({ found: true, hasAccess: true })
    }
    const staffConflict = await pool.query(
      'SELECT id FROM staff_users WHERE LOWER(email)=LOWER($1) AND active=TRUE LIMIT 1',
      [official.email],
    )
    if (staffConflict.rows.length) {
      return response.status(409).json({ message: 'Este e-mail pertence a uma conta interna. Fale com a equipe Ômega para regularizar o acesso.' })
    }
    const conflictingCustomer = await pool.query(
      `SELECT external_id=$1 AS same_code FROM customers
       WHERE active=TRUE AND (external_id=$1 OR LOWER(email)=LOWER($2)) AND document<>$3
       ORDER BY (external_id=$1) DESC
       LIMIT 1`,
      [official.code, official.email, official.document],
    )
    if (conflictingCustomer.rows.length) {
      // Cada e-mail é o login de uma única conta: o e-mail do WinThor precisa ser exclusivo.
      return response.status(409).json({
        message: conflictingCustomer.rows[0].same_code
          ? 'Este CPF/CNPJ já está ligado a outra conta de acesso. Fale com a equipe Ômega.'
          : `O e-mail cadastrado (${maskEmail(official.email)}) já é usado por outro cliente no e-commerce. Fale com a equipe Ômega para corrigir o e-mail do seu cadastro.`,
      })
    }

    // Enquanto o primeiro acesso não é concluído (sem cadastro vinculado), um novo pedido
    // invalida os convites enviados para e-mails anteriores do mesmo CPF/CNPJ — por exemplo,
    // quando o e-mail do WinThor estava errado e foi corrigido.
    for (const invite of await findCustomerInvitesByDocument(official.document)) {
      if (String(invite.email || '').toLowerCase() === official.email.toLowerCase()) continue
      const linked = await pool.query('SELECT 1 FROM customers WHERE supabase_user_id=$1 LIMIT 1', [invite.id])
      if (!linked.rows.length) await removeSupabaseUser(invite.id)
    }

    const authUser = await findSupabaseUserByEmail(official.email)
    if (authUser) {
      if (authUser.user_metadata?.account_type === 'staff') {
        return response.status(409).json({ message: 'Este e-mail pertence a uma conta interna. Fale com a equipe Ômega para regularizar o acesso.' })
      }
      const linkedCustomer = await pool.query('SELECT id FROM customers WHERE supabase_user_id=$1 LIMIT 1', [authUser.id])
      if (linkedCustomer.rows.length) {
        return response.status(409).json({ message: 'Este CPF/CNPJ já está ligado a outra conta de acesso. Fale com a equipe Ômega.' })
      }
      // Conta de autenticação sem cadastro vinculado: um primeiro acesso anterior não foi
      // concluído. O convite só pode ser reenviado para contas ainda não confirmadas.
      if (authUser.email_confirmed_at) await removeSupabaseUser(authUser.id)
    }
    await inviteSupabaseUser(official.email, {
      account_type: 'customer', document: official.document, external_id: official.code,
    })
    return response.json({ found: true, accessEmailSent: true, maskedEmail: maskEmail(official.email) })
  } catch (error) {
    if (error instanceof OmegaApiError) return response.status(error.status).json({ message: error.message })
    if (error?.status) return response.status(error.status).json({ message: error.message })
    next(error)
  }
})

app.post('/api/customers', (_request, response) => response.status(410).json({
  message: 'Faça seu cadastro pela página de login da loja.',
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

app.post('/api/staff/customers', requireCommercialAccess, (_request, response) => response.status(410).json({
  message: 'Novos acessos devem ser iniciados pelo CPF/CNPJ na área do cliente e vinculados pela equipe após o cadastro comercial.',
}))

// Exclui cliente. Sem pedidos: remove o registro. Com pedidos: desativa e libera e-mail e CPF/CNPJ,
// preservando o histórico. Em ambos os casos o acesso no Supabase é removido.
app.delete('/api/staff/customers/:id', requireAdmin, async (request, response, next) => {
  const customerId = Number(request.params.id)
  if (!Number.isSafeInteger(customerId) || customerId < 1) return response.status(400).json({ message: 'Cliente inválido.' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const current = await client.query(
      'SELECT id, legal_name, trade_name, supabase_user_id FROM customers WHERE id=$1 AND active=TRUE FOR UPDATE',
      [customerId],
    )
    if (!current.rows.length) {
      await client.query('ROLLBACK')
      return response.status(404).json({ message: 'Cliente não encontrado.' })
    }
    const customer = current.rows[0]
    if (customer.supabase_user_id) await removeSupabaseUser(customer.supabase_user_id)
    const orders = await client.query('SELECT COUNT(*)::int AS count FROM orders WHERE customer_id=$1', [customerId])
    const orderCount = Number(orders.rows[0].count)
    if (orderCount === 0) {
      await client.query('DELETE FROM customers WHERE id=$1', [customerId])
    } else {
      await client.query('DELETE FROM sessions WHERE customer_id=$1', [customerId])
      await client.query('DELETE FROM customer_commercial_conditions WHERE customer_id=$1', [customerId])
      await client.query(
        `UPDATE customers SET active=FALSE, supabase_user_id=NULL, password_hash=NULL,
           email=$2, document=$3, updated_at=CURRENT_TIMESTAMP
         WHERE id=$1`,
        [customerId, `removido-${customerId}@cliente-removido.invalid`, `REM${customerId}`.slice(0, 14)],
      )
    }
    await client.query('COMMIT')
    return response.json({ removed: true, orderCount, name: customer.trade_name || customer.legal_name })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    if (error instanceof Error && /acesso do cliente|não está configurada/.test(error.message)) {
      return response.status(502).json({ message: error.message })
    }
    return next(error)
  } finally {
    client.release()
  }
})

app.post('/api/staff/customers/:id/approve', requireCommercialAccess, async (request, response, next) => {
  try {
    const customerId = Number(request.params.id)
    if (!Number.isSafeInteger(customerId) || customerId < 1) {
      return response.status(400).json({ message: 'Cliente inválido.' })
    }
    const parsed = staffCustomerApproveSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
    const current = await pool.query(
      `SELECT id, document, email, supabase_user_id, registration_status
       FROM customers WHERE id=$1 AND active=TRUE LIMIT 1`,
      [customerId],
    )
    if (!current.rows.length) return response.status(404).json({ message: 'Cliente não encontrado.' })
    if (current.rows[0].registration_status === 'approved') {
      return response.status(409).json({ message: 'Este cadastro já foi aprovado.' })
    }
    const winthorCustomer = await fetchWinthorCustomerByCode(parsed.data.externalId)
    if (!winthorCustomer) {
      return response.status(422).json({
        message: 'Código de cliente não encontrado no cadastro comercial. O cadastro continua em análise.',
      })
    }
    if (winthorCustomer.document !== digits(current.rows[0].document)) {
      return response.status(422).json({ message: 'O CPF/CNPJ do código informado não corresponde ao cadastro pendente.' })
    }
    if (!winthorCustomer.email) {
      return response.status(422).json({ message: 'O cliente ainda não possui um e-mail válido no cadastro comercial. Cadastre o e-mail antes de aprovar.' })
    }
    const conflicts = await pool.query(
      `SELECT id FROM customers
       WHERE active=TRUE AND id<>$1 AND (external_id=$2 OR LOWER(email)=LOWER($3)) LIMIT 1`,
      [customerId, winthorCustomer.code, winthorCustomer.email],
    )
    if (conflicts.rows.length) {
      return response.status(409).json({ message: 'Este código de cliente ou e-mail oficial já está vinculado a outra conta.' })
    }
    const pendingCustomer = current.rows[0]
    if (pendingCustomer.supabase_user_id && pendingCustomer.email.toLowerCase() !== winthorCustomer.email) {
      const emailOwner = await findSupabaseUserByEmail(winthorCustomer.email)
      if (emailOwner && emailOwner.id !== pendingCustomer.supabase_user_id) {
        return response.status(409).json({ message: 'O e-mail oficial já pertence a outra conta de acesso.' })
      }
      await updateSupabaseUser(pendingCustomer.supabase_user_id, {
        email: winthorCustomer.email,
        metadata: { account_type: 'customer', document: winthorCustomer.document, external_id: winthorCustomer.code },
      })
    }
    const result = await pool.query(
      `UPDATE customers SET external_id=$2, person_type=$3, legal_name=$4, trade_name=$5,
         phone=$6, email=$7, postal_code=$8, address_line=$9, address_number=$10,
         address_complement=$11, neighborhood=$12, city=$13, state=$14, sales_channel=$15,
         registration_status='approved', approved_at=CURRENT_TIMESTAMP, approved_by_staff_user_id=$16,
         source='erp',
         updated_at=CURRENT_TIMESTAMP
       WHERE id=$1 AND registration_status='pending'
       RETURNING id, external_id, document, person_type, legal_name, trade_name, phone, email,
                 postal_code, address_line, address_number, address_complement, neighborhood,
                 city, state, sales_channel, registration_status, approved_at`,
      [
        customerId, winthorCustomer.code, winthorCustomer.personType, winthorCustomer.name,
        winthorCustomer.tradeName, winthorCustomer.phone, winthorCustomer.email,
        winthorCustomer.postalCode, winthorCustomer.addressLine, winthorCustomer.addressNumber,
        winthorCustomer.addressComplement, winthorCustomer.neighborhood, winthorCustomer.city,
        winthorCustomer.state, winthorCustomer.salesChannel, request.staff.id,
      ],
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

app.get('/api/staff/abandoned-carts', requireTelevendasAccess, async (_request, response, next) => {
  try {
    const carts = await pool.query(
      `SELECT cc.customer_id,cc.updated_at,c.external_id,c.legal_name,c.trade_name,c.document,c.email,c.phone,
              c.postal_code,c.address_line,c.address_number,c.address_complement,c.neighborhood,c.city,c.state,
              ccc.price_region,ccc.payment_plans,ccc.restricted_supplier_ids
       FROM customer_carts cc JOIN customers c ON c.id=cc.customer_id
       LEFT JOIN customer_commercial_conditions ccc ON ccc.customer_id=c.id
       WHERE cc.updated_at<=CURRENT_TIMESTAMP-INTERVAL '1 day' AND c.active=TRUE
         AND EXISTS(SELECT 1 FROM customer_cart_items ci JOIN products p ON p.id=ci.product_id AND p.active=TRUE WHERE ci.customer_id=cc.customer_id)
       ORDER BY cc.updated_at DESC LIMIT 100`,
    )
    if (!carts.rows.length) return response.json({ carts: [], minimumIdleMinutes: 1440 })
    const ids = carts.rows.map((cart) => Number(cart.customer_id))
    const items = await pool.query(
      `SELECT ci.customer_id,ci.quantity,p.id,p.external_id,p.name,p.supplier_id,p.image_path,
              p.image_data IS NOT NULL AS image_uploaded,p.image_hidden,p.image_updated_at,
              rp.price_1,rp.price_2,rp.price_3,rp.price_4,rp.price_5,rp.price_6,rp.price_7
       FROM customer_cart_items ci JOIN products p ON p.id=ci.product_id AND p.active=TRUE
       JOIN customers c ON c.id=ci.customer_id
       LEFT JOIN customer_commercial_conditions ccc ON ccc.customer_id=c.id
       LEFT JOIN region_prices rp ON rp.product_id=p.id AND rp.region=ccc.price_region
       WHERE ci.customer_id=ANY($1::bigint[]) ORDER BY ci.customer_id,ci.created_at`, [ids],
    )
    const grouped = new Map()
    for (const item of items.rows) {
      const id = Number(item.customer_id)
      if (!grouped.has(id)) grouped.set(id, [])
      grouped.get(id).push(item)
    }
    const output = carts.rows.map((cart) => {
      const plans = Array.isArray(cart.payment_plans) ? cart.payment_plans : []
      const tables = [...new Set(plans.map((plan) => priceTableOf(plan.priceTable)))]
      const restricted = new Set((cart.restricted_supplier_ids || []).map(Number))
      const visible = (grouped.get(Number(cart.customer_id)) || []).filter((item) => !restricted.has(Number(item.supplier_id)))
      let subtotal = 0
      let pricesAvailable = true
      const cartItems = visible.map((item) => {
        const unitPrice = lowestPlanPrice(item, tables)
        if (unitPrice == null) pricesAvailable = false
        else subtotal += unitPrice * Number(item.quantity)
        return { code: Number(item.external_id), name: item.name, quantity: Number(item.quantity), unitPrice,
          lineTotal: unitPrice == null ? null : money2(unitPrice * Number(item.quantity)), image: productImageUrl(item) }
      })
      return { customerId: Number(cart.customer_id), customerCode: cart.external_id == null ? null : Number(cart.external_id),
        name: cart.trade_name || cart.legal_name, legalName: cart.legal_name, document: cart.document,
        email: cart.email, phone: cart.phone, postalCode: cart.postal_code, addressLine: cart.address_line,
        addressNumber: cart.address_number, addressComplement: cart.address_complement,
        neighborhood: cart.neighborhood, city: cart.city, state: cart.state, updatedAt: cart.updated_at,
        items: cartItems, subtotal: pricesAvailable ? money2(subtotal) : null }
    }).filter((cart) => cart.items.length)
    return response.json({ carts: output, minimumIdleMinutes: 1440 })
  } catch (error) { return next(error) }
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
    if (!winthorStatus) return response.status(404).json({ message: 'Número do pedido não encontrado no sistema comercial.' })
    const linkClient = await pool.connect()
    let result
    try {
      await linkClient.query('BEGIN')
      const previous = await linkClient.query('SELECT status FROM orders WHERE id=$1 FOR UPDATE', [orderId])
      result = await linkClient.query(
      `UPDATE orders SET winthor_order_number=$2, status=$3,
         winthor_status_code=$4, winthor_status_label=$5,
         winthor_status_checked_at=CURRENT_TIMESTAMP, winthor_delivery_date=$7::date,
         winthor_released_at=$8::timestamptz, winthor_invoiced_at=$9::timestamptz,
         winthor_entered_by_staff_user_id=$6,
         winthor_entered_at=CURRENT_TIMESTAMP,
         updated_at=CURRENT_TIMESTAMP
       WHERE id=$1 AND status <> 'cancelled' RETURNING id`,
      [orderId, winthorOrderNumber, winthorStatus.status || 'analysis', winthorStatus.code, winthorStatus.label, request.staff.id,
        winthorStatus.deliveryDate, winthorStatus.releasedAt, winthorStatus.invoicedAt],
      )
      if (result.rows.length && isForwardStage(previous.rows[0]?.status, winthorStatus.status || 'analysis')) {
        await queueOrderStage(linkClient, orderId, winthorStatus.status)
      }
      await linkClient.query('COMMIT')
    } catch (error) {
      await linkClient.query('ROLLBACK')
      throw error
    } finally { linkClient.release() }
    if (!result.rows.length) {
      const exists = await pool.query('SELECT 1 FROM orders WHERE id=$1', [orderId])
      return exists.rows.length
        ? response.status(409).json({ message: 'Este pedido foi cancelado e não pode mais ser vinculado.' })
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
  response.status(410).json({ message: 'As categorias manuais foram desativadas. Use os departamentos e seções disponíveis no catálogo.' })
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
    const logos = await supplierLogoMap()
    return response.json({
      products: result.rows.map((product) => ({
        id: Number(product.id), code: Number(product.external_id), supplierId: Number(product.supplier_id),
        brand: product.brand, name: product.name, package: product.package,
        unitsPerBox: Number(product.units_per_box), image: productImageUrl(product),
      })),
      suppliers: suppliersResult.rows.map((supplier) => ({
        id: Number(supplier.supplier_id), name: supplier.name, productCount: Number(supplier.product_count),
        logo: logos.get(Number(supplier.supplier_id)) || null,
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
         AND ($4=FALSE OR image_hidden=TRUE OR (image_data IS NULL AND image_path IS NULL))
       RETURNING id,image_updated_at`,
      [image.data, image.mime, request.params.id, request.body?.onlyMissing === true],
    )
    if (!result.rows.length && request.body?.onlyMissing === true) {
      const existing = await pool.query('SELECT id FROM products WHERE id=$1 AND active=TRUE', [request.params.id])
      if (existing.rows.length) return response.json({ skipped: true })
    }
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
              b.mobile_image_path, b.mobile_image_data IS NOT NULL AS mobile_uploaded,
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
      mobileImageUrl: banner.mobile_uploaded
        ? `/api/banners/${banner.id}/mobile-image?v=${new Date(banner.updated_at).getTime()}`
        : (banner.mobile_image_path || (banner.uploaded ? `/api/banners/${banner.id}/image?v=${new Date(banner.updated_at).getTime()}` : banner.image_path)),
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

function couponJson(row) {
  return {
    id: Number(row.id), code: row.code, description: row.description,
    discountType: row.discount_type, discountValue: Number(row.discount_value),
    scopeType: row.scope_type, targetValues: (row.target_values || row.targets || []).map(Number),
    active: Boolean(row.active), startsAt: row.starts_at || null, endsAt: row.ends_at || null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

app.get('/api/staff/coupons', requireCommercialAccess, async (_request, response, next) => {
  try {
    const [result, targets] = await Promise.all([
      pool.query('SELECT * FROM coupons ORDER BY active DESC,updated_at DESC,code'),
      pool.query('SELECT coupon_id,target_value FROM coupon_targets ORDER BY target_value'),
    ])
    const targetsByCoupon = new Map()
    for (const target of targets.rows) targetsByCoupon.set(Number(target.coupon_id), [...(targetsByCoupon.get(Number(target.coupon_id)) || []), Number(target.target_value)])
    return response.json({ coupons: result.rows.map((row) => couponJson({ ...row, target_values: targetsByCoupon.get(Number(row.id)) || [] })) })
  } catch (error) { return next(error) }
})

async function saveCoupon(request, response, next) {
  const parsed = couponSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
  const content = parsed.data
  const couponId = request.params.id ? Number(request.params.id) : null
  if (couponId !== null && (!Number.isSafeInteger(couponId) || couponId < 1)) return response.status(400).json({ message: 'Cupom inválido.' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const uniqueTargets = [...new Set(content.targetValues)]
    if (content.scopeType !== 'order') {
      const column = content.scopeType === 'products' ? 'external_id' : content.scopeType === 'suppliers' ? 'supplier_id' : 'section_code'
      const validTargets = await client.query(`SELECT DISTINCT ${column} AS value FROM products WHERE active=TRUE AND ${column}=ANY($1::integer[])`, [postgresIntegerArray(uniqueTargets)])
      if (validTargets.rows.length !== uniqueTargets.length) throw new RequestError('Um ou mais itens selecionados não estão disponíveis no catálogo ativo.')
    }
    const values = [content.code, content.description, content.discountType, content.discountValue, content.scopeType, content.active, content.startsAt || null, content.endsAt || null]
    const saved = couponId === null
      ? await client.query(
        `INSERT INTO coupons (code,description,discount_type,discount_value,scope_type,active,starts_at,ends_at,created_by_staff_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [...values, request.staff.id])
      : await client.query(
        `UPDATE coupons SET code=$1,description=$2,discount_type=$3,discount_value=$4,scope_type=$5,active=$6,starts_at=$7,ends_at=$8,updated_at=CURRENT_TIMESTAMP
         WHERE id=$9 RETURNING *`, [...values, couponId])
    if (!saved.rows.length) throw new RequestError('Cupom não encontrado.', 404)
    const id = Number(saved.rows[0].id)
    await client.query('DELETE FROM coupon_targets WHERE coupon_id=$1', [id])
    if (content.scopeType !== 'order') {
      for (const target of uniqueTargets) {
        await client.query('INSERT INTO coupon_targets (coupon_id,target_value) VALUES ($1,$2)', [id, target])
      }
    }
    await client.query('COMMIT')
    return response.status(couponId === null ? 201 : 200).json({ coupon: couponJson({ ...saved.rows[0], target_values: content.scopeType === 'order' ? [] : uniqueTargets }) })
  } catch (error) {
    await client.query('ROLLBACK')
    if (error?.code === '23505') return response.status(409).json({ message: 'Já existe um cupom com este código.' })
    if (error instanceof RequestError) return response.status(error.status).json({ message: error.message })
    return next(error)
  } finally { client.release() }
}

app.post('/api/staff/coupons', requireCommercialAccess, saveCoupon)
app.put('/api/staff/coupons/:id', requireCommercialAccess, saveCoupon)
app.delete('/api/staff/coupons/:id', requireCommercialAccess, async (request, response, next) => {
  try {
    const result = await pool.query('UPDATE coupons SET active=FALSE,updated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING id', [request.params.id])
    if (!result.rows.length) return response.status(404).json({ message: 'Cupom não encontrado.' })
    return response.status(204).end()
  } catch (error) { return next(error) }
})

app.get('/api/staff/campaigns', requireMarketingAccess, async (_request, response, next) => {
  try {
    const [result, audienceResult] = await Promise.all([
      pool.query(
        `SELECT dc.external_id,dc.description,dc.starts_on,dc.ends_on,dc.branch_code,
                dc.uses_product_family,dc.active,dc.source_updated_at,
                p.external_id AS product_code,p.name,p.brand,
                dcp.min_quantity,dcp.max_quantity,dcp.discount_percent,dcp.discount_type,dcp.product_origin
         FROM discount_campaigns dc
         LEFT JOIN discount_campaign_products dcp ON dcp.campaign_id=dc.id
         LEFT JOIN products p ON p.id=dcp.product_id
         ORDER BY dc.starts_on DESC,dc.external_id,p.name,dcp.discount_percent DESC`,
      ),
      pool.query(
        `SELECT dc.external_id,dcc.customer_external_id
         FROM discount_campaign_customers dcc
         JOIN discount_campaigns dc ON dc.id=dcc.campaign_id
         ORDER BY dc.external_id,dcc.customer_external_id`,
      ),
    ])
    const audiences = new Map()
    for (const row of audienceResult.rows) {
      const code = Number(row.external_id)
      audiences.set(code, [...(audiences.get(code) || []), Number(row.customer_external_id)])
    }
    const campaigns = new Map()
    for (const row of result.rows) {
      const code = Number(row.external_id)
      const campaign = campaigns.get(code) || {
        code, description: row.description, startsOn: row.starts_on, endsOn: row.ends_on,
        branchCode: row.branch_code || '', usesProductFamily: Boolean(row.uses_product_family),
        active: Boolean(row.active), sourceUpdatedAt: row.source_updated_at,
        allowedCustomerIds: audiences.get(code) || [], products: [],
      }
      if (row.product_code != null) campaign.products.push({
        code: Number(row.product_code), name: row.name, brand: row.brand,
        minQuantity: Number(row.min_quantity), maxQuantity: row.max_quantity == null ? null : Number(row.max_quantity),
        discountPercent: Number(row.discount_percent), discountType: row.discount_type || '', origin: row.product_origin,
      })
      campaigns.set(code, campaign)
    }
    return response.json({ campaigns: [...campaigns.values()] })
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
      let mobileImage = null
      try { image = decodeBannerImage(banner.imageDataUrl, banner.placement === 'hero', 10) } catch (error) {
        await client.query('ROLLBACK')
        return response.status(400).json({ message: error.message })
      }
      try { mobileImage = decodeBannerImage(banner.mobileImageDataUrl, banner.placement === 'hero', 10) } catch (error) {
        await client.query('ROLLBACK')
        return response.status(400).json({ message: `Imagem mobile: ${error.message}` })
      }
      if (banner.id) {
        const result = await client.query(
          `UPDATE banners SET title=$1, alt_text=$2, target_url=$3, section_code=$4,
             destination_type=$5, destination_values=$6, navigation_path=$7,
             position=$8, active=$9, placement=$10,
             starts_at=$11, ends_at=$12, image_data=COALESCE($13, image_data), image_mime=COALESCE($14, image_mime),
             image_path=CASE WHEN $13::bytea IS NOT NULL THEN NULL ELSE image_path END,
             mobile_image_data=COALESCE($15, mobile_image_data), mobile_image_mime=COALESCE($16, mobile_image_mime),
             mobile_image_path=CASE WHEN $15::bytea IS NOT NULL THEN NULL ELSE mobile_image_path END,
             updated_at=CURRENT_TIMESTAMP
           WHERE id=$17 RETURNING id`,
          [banner.title, banner.altText, bannerDestinationUrl(banner),
            banner.destinationType === 'sections' ? banner.destinationValues[0] : null,
            banner.destinationType, postgresIntegerArray(banner.destinationValues), banner.navigationPath,
            banner.position, banner.active, banner.placement, banner.startsAt || null, banner.endsAt || null,
            image?.data ?? null, image?.mime ?? null, mobileImage?.data ?? null, mobileImage?.mime ?? null, banner.id],
        )
        if (!result.rows.length) throw new Error('Um dos banners editados não existe mais.')
      } else {
        if (!image || !mobileImage) {
          await client.query('ROLLBACK')
          return response.status(400).json({ message: `Selecione as imagens para desktop e mobile do banner “${banner.title}”.` })
        }
        const inserted = await client.query(
          `INSERT INTO banners (title, alt_text, image_data, image_mime, mobile_image_data, mobile_image_mime, target_url, section_code,
             destination_type, destination_values, navigation_path, position, active, placement, starts_at, ends_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
          [banner.title, banner.altText, image.data, image.mime, mobileImage.data, mobileImage.mime, bannerDestinationUrl(banner),
            banner.destinationType === 'sections' ? banner.destinationValues[0] : null,
            banner.destinationType, postgresIntegerArray(banner.destinationValues), banner.navigationPath,
            banner.position, banner.active, banner.placement, banner.startsAt || null, banner.endsAt || null],
        )
        await client.query('UPDATE banners SET target_url=$2 WHERE id=$1', [inserted.rows[0].id, bannerDestinationUrl({ ...banner, id: inserted.rows[0].id })])
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
    let mobileImage = null
    try { image = decodeBannerImage(parsed.data.imageDataUrl, parsed.data.placement === 'hero', 10) } catch (error) {
      return response.status(400).json({ message: error.message })
    }
    try { mobileImage = decodeBannerImage(parsed.data.mobileImageDataUrl, parsed.data.placement === 'hero', 10) } catch (error) {
      return response.status(400).json({ message: `Imagem mobile: ${error.message}` })
    }
    const values = [
      parsed.data.title, parsed.data.altText, bannerDestinationUrl({ ...parsed.data, id: Number(request.params.id) }),
      parsed.data.destinationType === 'sections' ? parsed.data.destinationValues[0] : null,
      parsed.data.destinationType, postgresIntegerArray(parsed.data.destinationValues), parsed.data.navigationPath,
      parsed.data.position, parsed.data.active, parsed.data.placement,
      parsed.data.startsAt || null, parsed.data.endsAt || null, image?.data ?? null, image?.mime ?? null,
      mobileImage?.data ?? null, mobileImage?.mime ?? null,
      request.params.id,
    ]
    const result = await pool.query(
      `UPDATE banners SET title=$1, alt_text=$2, target_url=$3, section_code=$4,
         destination_type=$5, destination_values=$6, navigation_path=$7,
         position=$8, active=$9, placement=$10,
         starts_at=$11, ends_at=$12,
         image_data=COALESCE($13, image_data), image_mime=COALESCE($14, image_mime),
         image_path=CASE WHEN $13::bytea IS NOT NULL THEN NULL ELSE image_path END,
         mobile_image_data=COALESCE($15, mobile_image_data), mobile_image_mime=COALESCE($16, mobile_image_mime),
         mobile_image_path=CASE WHEN $15::bytea IS NOT NULL THEN NULL ELSE mobile_image_path END,
         updated_at=CURRENT_TIMESTAMP
       WHERE id=$17 RETURNING id`,
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
    let mobileImage
    try { image = decodeBannerImage(parsed.data.imageDataUrl, parsed.data.placement === 'hero', 10) } catch (error) {
      return response.status(400).json({ message: error.message })
    }
    try { mobileImage = decodeBannerImage(parsed.data.mobileImageDataUrl, parsed.data.placement === 'hero', 10) } catch (error) {
      return response.status(400).json({ message: `Imagem mobile: ${error.message}` })
    }
    if (!image || !mobileImage) return response.status(400).json({ message: 'Selecione as imagens para desktop e mobile do novo banner.' })
    const result = await pool.query(
      `INSERT INTO banners (title, alt_text, image_data, image_mime, mobile_image_data, mobile_image_mime, target_url, section_code,
         destination_type, destination_values, navigation_path, position, active, placement, starts_at, ends_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [parsed.data.title, parsed.data.altText, image.data, image.mime, mobileImage.data, mobileImage.mime, bannerDestinationUrl(parsed.data),
        parsed.data.destinationType === 'sections' ? parsed.data.destinationValues[0] : null,
        parsed.data.destinationType, postgresIntegerArray(parsed.data.destinationValues), parsed.data.navigationPath,
        parsed.data.position, parsed.data.active, parsed.data.placement,
        parsed.data.startsAt || null, parsed.data.endsAt || null],
    )
    await pool.query('UPDATE banners SET target_url=$2 WHERE id=$1', [result.rows[0].id, bannerDestinationUrl({ ...parsed.data, id: result.rows[0].id })])
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
      return response.status(503).json({ message: 'As condições comerciais deste cadastro ainda estão sendo atualizadas.' })
    }
    if (conditions.isBlocked) {
      await client.query('ROLLBACK')
      return response.status(403).json({ message: 'Seu cadastro está bloqueado para compras. Fale com a equipe Ômega.' })
    }
    const pricing = await customerPricing(client, request.customer)
    if (pricing.region == null) {
      await client.query('ROLLBACK')
      return response.status(503).json({ message: 'As condições comerciais deste cadastro ainda estão sendo atualizadas.' })
    }
    const selectedPlan = pricing.plans.find((plan) => plan.code === parsed.data.paymentPlan)
    if (!selectedPlan) {
      await client.query('ROLLBACK')
      return response.status(400).json({ message: 'O plano de pagamento selecionado não está liberado para este cliente.' })
    }
    const priced = await priceCartItems(client, pricing, selectedPlan, parsed.data.items, request.customer.external_id)
    const { subtotal, total, coupon } = await applyCoupon(client, parsed.data.couponCode, priced.lines)
    const { lines } = priced

    if (subtotal < 200) {
      await client.query('ROLLBACK')
      return response.status(400).json({ message: `O pedido mínimo é R$ 200,00. Adicione mais R$ ${(200 - subtotal).toFixed(2).replace('.', ',')}.` })
    }
    if (total > conditions.availableCredit) {
      await client.query('ROLLBACK')
      return response.status(400).json({
        message: `O total do pedido excede o limite de crédito disponível de R$ ${conditions.availableCredit.toFixed(2).replace('.', ',')}.`,
      })
    }

    if (pricing.stockBranch == null) {
      await client.query('ROLLBACK')
      return response.status(503).json({ message: 'A filial de atendimento deste cadastro ainda está sendo atualizada.' })
    }
    // Uma trava curta por filial serializa checkouts concorrentes. Assim, o segundo
    // pedido ja enxerga a reserva local criada pelo primeiro antes de validar o saldo.
    if (process.env.DATABASE_URL) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`omega_ecommerce_checkout_stock_${pricing.stockBranch}`])
    }
    await validateOrderStock(client, pricing.stockBranch, lines)

    const orderResult = await client.query(
      "INSERT INTO orders (customer_id, status, payment_plan, payment_plan_label, stock_branch, total, notes) VALUES ($1,'analysis',$2,$3,$4,$5,$6) RETURNING id, created_at",
      [request.customer.id, parsed.data.paymentPlan, String(selectedPlan.label).slice(0, 160), pricing.stockBranch, total.toFixed(2), parsed.data.notes],
    )
    const order = orderResult.rows[0]
    for (const line of lines) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, boxes, units, units_per_box, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [order.id, line.product.id, line.boxes, line.units, line.product.units_per_box, line.unitPrice, line.lineTotal.toFixed(2)],
      )
    }
    if (coupon) {
      await client.query(
        `INSERT INTO order_coupons (order_id,coupon_id,code,description,discount_type,discount_value,eligible_subtotal,discount_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [order.id, coupon.id, coupon.code, coupon.description, coupon.discountType, coupon.discountValue, coupon.eligibleSubtotal, coupon.discountAmount],
      )
    }
    await queueOrderStage(client, order.id, 'analysis')
    await client.query('DELETE FROM customer_cart_items WHERE customer_id=$1', [request.customer.id])
    await client.query(
      `INSERT INTO customer_carts(customer_id,reminder_sent_at,updated_at) VALUES ($1,NULL,CURRENT_TIMESTAMP)
       ON CONFLICT (customer_id) DO UPDATE SET reminder_sent_at=NULL,updated_at=CURRENT_TIMESTAMP`,
      [request.customer.id],
    )
    await client.query('COMMIT')
    return response.status(201).json({
      order: {
        id: Number(order.id),
        number: 'Pedido pendente',
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
  .then(() => {
    app.listen(port, '0.0.0.0', () => console.info(`[api] disponível em http://localhost:${port}`))
    startOrderEmailWorker()
    if (omegaApiConfig()) {
      let checking = false
      const check = async () => {
        if (checking) return
        checking = true
        try {
          const result = await pool.query(
            `SELECT id,status,winthor_order_number,winthor_status_checked_at,
                    winthor_released_at,winthor_invoiced_at,cancelled_at,cancelled_by
             FROM orders WHERE winthor_order_number IS NOT NULL
               AND status IN ('analysis','released','sent')
               AND (winthor_status_checked_at IS NULL OR winthor_status_checked_at < CURRENT_TIMESTAMP - ($1::integer * INTERVAL '1 millisecond'))
             ORDER BY winthor_status_checked_at NULLS FIRST LIMIT 100`, [orderStatusCacheMs],
          )
          await refreshStaleOrderStatuses(result.rows)
        } catch (error) { console.warn('[orders] atualização automática adiada:', error.message) }
        finally { checking = false }
      }
      setInterval(check, 60000).unref()
      check()
    }
  })
  .catch((error) => {
    console.error('[api] falha ao iniciar', error)
    process.exit(1)
  })
