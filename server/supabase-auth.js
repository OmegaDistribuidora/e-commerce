import { createRemoteJWKSet, jwtVerify } from 'jose'

let cachedConfig
let cachedJwks

function authConfig() {
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '')
  if (!url) return null
  if (cachedConfig?.url === url) return cachedConfig
  cachedConfig = {
    url,
    issuer: `${url}/auth/v1`,
    audience: String(process.env.SUPABASE_JWT_AUDIENCE || 'authenticated').trim(),
  }
  cachedJwks = createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`), {
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
    timeoutDuration: 5_000,
  })
  return cachedConfig
}

export function supabaseAuthConfigured() {
  return Boolean(authConfig())
}

export async function findSupabaseUserByEmail(email) {
  const config = authConfig()
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  if (!config || !serviceRoleKey) return null

  for (let page = 1; page <= 20; page += 1) {
    const response = await fetch(`${config.url}/auth/v1/admin/users?page=${page}&per_page=1000`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) throw new Error('Não foi possível consultar as contas de autenticação.')
    const payload = await response.json()
    const users = Array.isArray(payload.users) ? payload.users : []
    const user = users.find((item) => String(item.email || '').toLowerCase() === email.toLowerCase())
    if (user) return user
    if (users.length < 1000) return null
  }
  throw new Error('A consulta de contas excedeu o limite seguro.')
}

export async function verifySupabaseAccessToken(request) {
  const config = authConfig()
  if (!config) return null
  const match = /^Bearer\s+(.+)$/i.exec(String(request.headers.authorization || ''))
  if (!match) return null

  const { payload } = await jwtVerify(match[1], cachedJwks, {
    issuer: config.issuer,
    audience: config.audience,
    algorithms: ['ES256', 'RS256'],
  })
  if (!payload.sub || typeof payload.email !== 'string') throw new Error('Token de autenticação incompleto.')
  return {
    id: payload.sub,
    email: payload.email.trim().toLowerCase(),
    role: payload.role,
    userMetadata: payload.user_metadata && typeof payload.user_metadata === 'object' ? payload.user_metadata : {},
  }
}

function adminHeaders() {
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  if (!authConfig() || !serviceRoleKey) return null
  return { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' }
}

// Cria um acesso já confirmado (usado pela gestão enquanto o envio de e-mails não está ativo).
export async function createConfirmedSupabaseUser({ email, password, metadata = {} }) {
  const headers = adminHeaders()
  if (!headers) throw new Error('A autenticação de clientes não está configurada no servidor.')
  const response = await fetch(`${authConfig().url}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: metadata }),
    signal: AbortSignal.timeout(10_000),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = String(payload.msg || payload.message || payload.error_description || '')
    const error = new Error(/already|registered|exists/i.test(message)
      ? 'Este e-mail já possui uma conta de acesso.'
      : 'Não foi possível criar o acesso do cliente.')
    error.status = /already|registered|exists/i.test(message) ? 409 : 502
    throw error
  }
  return payload
}

export async function deleteSupabaseUser(id) {
  const headers = adminHeaders()
  if (!headers || !id) return
  await fetch(`${authConfig().url}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
}
