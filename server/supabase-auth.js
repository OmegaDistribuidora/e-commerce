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

// Percorre as contas de autenticação (até 20 mil) e devolve as que atendem ao filtro.
async function filterSupabaseUsers(predicate, { first = false } = {}) {
  const config = authConfig()
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  if (!config || !serviceRoleKey) return []

  const matches = []
  for (let page = 1; page <= 20; page += 1) {
    const response = await fetch(`${config.url}/auth/v1/admin/users?page=${page}&per_page=1000`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) throw new Error('Não foi possível consultar as contas de autenticação.')
    const payload = await response.json()
    const users = Array.isArray(payload.users) ? payload.users : []
    for (const user of users) {
      if (!predicate(user)) continue
      matches.push(user)
      if (first) return matches
    }
    if (users.length < 1000) return matches
  }
  throw new Error('A consulta de contas excedeu o limite seguro.')
}

export async function findSupabaseUserByEmail(email) {
  const normalized = email.toLowerCase()
  const [user] = await filterSupabaseUsers((item) => String(item.email || '').toLowerCase() === normalized, { first: true })
  return user || null
}

// Convites de primeiro acesso de um CPF/CNPJ (contas de cliente criadas pelo convite).
export async function findCustomerInvitesByDocument(document) {
  return filterSupabaseUsers((item) => item.user_metadata?.account_type === 'customer'
    && String(item.user_metadata?.document || '').replace(/\D/g, '') === document)
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

export async function updateSupabaseUser(id, { email, metadata } = {}) {
  const headers = adminHeaders()
  if (!headers) throw new Error('A autenticação de clientes não está configurada no servidor.')
  const body = {}
  if (email) {
    body.email = email
    body.email_confirm = true
  }
  if (metadata) body.user_metadata = metadata
  const response = await fetch(`${authConfig().url}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
    method: 'PUT', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = String(payload.msg || payload.message || payload.error_description || '')
    const error = new Error(/already|registered|exists/i.test(message)
      ? 'O e-mail oficial já está vinculado a outra conta de acesso.'
      : 'Não foi possível atualizar o acesso do cliente.')
    error.status = /already|registered|exists/i.test(message) ? 409 : 502
    throw error
  }
  return payload
}

// Envia o convite de primeiro acesso (modelo "Invite user" do Supabase). A conta só é
// confirmada quando o cliente abre o link e cria a própria senha.
export async function inviteSupabaseUser(email, metadata = {}) {
  const headers = adminHeaders()
  if (!headers) throw new Error('O envio de e-mails de acesso não está configurado no servidor.')
  const response = await fetch(`${authConfig().url}/auth/v1/invite`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, data: metadata }),
    signal: AbortSignal.timeout(15_000),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = String(payload.msg || payload.message || payload.error_description || '')
    // Registra a causa real (SMTP, remetente, limite) sem expor detalhes ao cliente.
    console.error(`Supabase /invite falhou: HTTP ${response.status} ${payload.error_code || payload.code || ''} ${message}`.trim())
    const rateLimited = response.status === 429 || /rate|security purposes/i.test(message)
    const error = new Error(rateLimited
      ? 'Muitas solicitações de acesso. Aguarde alguns minutos e tente novamente.'
      : 'Não foi possível enviar o e-mail de primeiro acesso agora.')
    error.status = rateLimited ? 429 : 502
    throw error
  }
  return payload
}

// Remove o acesso e informa se deu certo (404 = acesso já não existia).
export async function removeSupabaseUser(id) {
  const headers = adminHeaders()
  if (!headers) throw new Error('A autenticação de clientes não está configurada no servidor.')
  const response = await fetch(`${authConfig().url}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers,
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok && response.status !== 404) throw new Error('Não foi possível remover o acesso do cliente.')
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
