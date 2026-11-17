// Isolated regression test: never loads .env or connects to production.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chromium } from 'playwright-core'

process.env.DOTENV_CONFIG_PATH = '.env.photos-test-does-not-exist'
for (const key of ['DATABASE_URL', 'SOURCE_DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) process.env[key] = ''
process.env.PORT = '3197'
process.env.ADMIN_EMAIL = 'photo-test@example.invalid'
process.env.ADMIN_PASSWORD = randomBytes(24).toString('hex')
process.env.NODE_ENV = 'test'
await import('../server/index.js')
const { pool } = await import('../server/db.js')
const { createSession } = await import('../server/auth.js')
const base = 'http://localhost:3197'
let browser
try {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${base}/api/staff/auth/me`); break } catch { await new Promise(r => setTimeout(r, 200)) }
  }
  const staff = await pool.query("INSERT INTO staff_users (name,email,role,password_hash) VALUES ('Photo Test','marketing-test@example.invalid','MARKETING','disabled-test-login') RETURNING id")
  const session = createSession()
  await pool.query('INSERT INTO staff_sessions (token_hash,staff_user_id,expires_at) VALUES ($1,$2,$3)', [session.tokenHash, staff.rows[0].id, session.expiresAt])
  const cookie = `omega_staff=${session.token}`
  const api = async (path, method = 'GET', body, authenticated = true) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return { status: response.status, data: await response.json().catch(() => null) }
  }
  const catalog = await api('/api/staff/catalog-products')
  assert.equal(catalog.status, 200)
  const product = catalog.data.products[0]
  const supplier = catalog.data.suppliers.find(s => s.id === 117) || catalog.data.suppliers[0]
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext()
  await context.addCookies([{ name: 'omega_staff', value: session.token, url: base }])
  const page = await context.newPage()
  const imageDataUrl = await page.evaluate(() => { const c = document.createElement('canvas'); c.width=64; c.height=64; c.getContext('2d').fillRect(0,0,64,64); return c.toDataURL('image/webp') })
  const body = { imageDataUrl }
  for (const path of [`/api/staff/products/${product.id}/image`, `/api/staff/suppliers/${supplier.id}/image`]) {
    assert.equal((await api(path, 'PUT', body, false)).status, 401)
    assert.equal((await api(path, 'PUT', { imageDataUrl: 'data:image/webp;base64,YmFk' })).status, 400)
    assert.equal((await api(path, 'PUT', body)).status, 200)
    const skipped = await api(path, 'PUT', { ...body, onlyMissing: true })
    assert.equal(skipped.data.skipped, true, `${path}: ${JSON.stringify(skipped)}`)
    assert.equal((await api(path, 'DELETE')).status, 200)
    const uploaded = await api(path, 'PUT', { ...body, onlyMissing: true })
    assert.equal(uploaded.status, 200)
    assert.ok(uploaded.data.image)
    assert.equal((await fetch(base + uploaded.data.image)).status, 200)
  }
  assert.equal((await api('/api/staff/suppliers/999999999/image', 'PUT', body)).status, 404)
  const navigation = await api('/api/catalog/navigation')
  assert.equal(navigation.status, 200)
  assert.ok(navigation.data.partners.find(p => p.supplierId === supplier.id)?.logo.startsWith('/api/suppliers/'))
  // Real browser conversion, batch preview, duplicate guard, supplier tab and mobile layout.
  await page.goto(`${base}/gestao`)
  await page.getByRole('heading', { name: 'Fotos dos produtos', exact: true }).waitFor()
  const payload = (name) => ({ name, mimeType: 'image/webp', buffer: Buffer.from(imageDataUrl.split(',')[1], 'base64') })
  await page.locator('input[multiple]').setInputFiles([payload(`${product.code}.webp`), payload(`${product.code}_A.webp`), payload('999999999.webp')])
  assert.equal(await page.getByText('Código duplicado no lote.', { exact: false }).count(), 2)
  assert.equal(await page.getByText('Código não encontrado no catálogo ativo.', { exact: true }).count(), 1)
  await page.locator('input[multiple]').setInputFiles([payload(`${product.code}_A.webp`)])
  await page.getByRole('button', { name: 'Importar / continuar lote' }).click()
  await page.getByText('Ignorado: já possui imagem.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Fornecedores', exact: true }).click()
  await page.locator('input[multiple]').setInputFiles([payload(`${supplier.id}.webp`)])
  await page.locator('.photo-batch select').selectOption('replace')
  await page.getByRole('button', { name: 'Importar / continuar lote' }).click()
  await page.getByText('Salvo em WEBP.', { exact: true }).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.locator('.photo-batch').isVisible())
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile page must not overflow horizontally')
  console.log('PASS: permissions, invalid files, product/supplier upload-delete, missing-only preservation, public images, unknown supplier, duplicate/unknown codes, batch upload and mobile UI.')
  await browser.close()
  process.exit(0)
} catch (error) {
  console.error(error)
  if (browser) await browser.close()
  process.exit(1)
}
