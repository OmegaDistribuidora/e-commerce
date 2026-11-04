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
