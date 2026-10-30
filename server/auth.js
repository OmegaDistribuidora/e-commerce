import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const SESSION_DAYS = 7

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `scrypt:${salt}:${hash}`
}

export function verifyPassword(password, storedHash) {
  if (!storedHash) return false
  const [algorithm, salt, expectedHex] = storedHash.split(':')
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false
  const actual = scryptSync(password, salt, 64)
  const expected = Buffer.from(expectedHex, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function createSession() {
  const token = randomBytes(32).toString('hex')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)
  return { token, tokenHash, expiresAt }
}

export function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

export function getCookie(request, name) {
  const cookies = String(request.headers.cookie ?? '').split(';')
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=')
    if (separator < 0) continue
    if (cookie.slice(0, separator).trim() === name) return decodeURIComponent(cookie.slice(separator + 1).trim())
  }
  return ''
}

export function sessionCookie(token, expiresAt) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `omega_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secure}`
}

export function clearSessionCookie() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `omega_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`
}
