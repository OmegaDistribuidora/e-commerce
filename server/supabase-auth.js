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
