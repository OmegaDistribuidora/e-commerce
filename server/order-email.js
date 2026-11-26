import { pool } from './db.js'

const stages = ['analysis', 'released', 'sent', 'delivered', 'cancelled']
const stageContent = {
  analysis: ['Pedido recebido', 'Recebemos seu pedido e nossa equipe já está analisando os detalhes.'],
  released: ['Pedido liberado', 'Seu pedido foi liberado e está seguindo para preparação.'],
  sent: ['Pedido enviado', 'Seu pedido foi enviado e está a caminho.'],
  delivered: ['Pedido entregue', 'Seu pedido foi entregue. Agradecemos por comprar com a Ômega Distribuidora!'],
  cancelled: ['Pedido cancelado', 'Seu pedido foi cancelado. Se precisar de ajuda, nossa equipe está à disposição.'],
}
const currency = (value) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0))
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])

export function isForwardStage(previous, next) {
  return next !== 'cancelled' && stages.includes(previous) && stages.indexOf(next) > stages.indexOf(previous)
}

export async function queueOrderStage(database, orderId, stage) {
  if (!stages.includes(stage)) return
  const order = await database.query(
    `SELECT o.id,o.total,o.created_at,o.payment_plan_label,o.payment_plan,o.winthor_order_number,
            c.email,c.legal_name,c.trade_name
     FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=$1`, [orderId],
  )
  if (!order.rows.length || !order.rows[0].email) return
  const items = await database.query(
    `SELECT p.name,oi.units,oi.unit_price,oi.line_total
     FROM order_items oi JOIN products p ON p.id=oi.product_id
     WHERE oi.order_id=$1 ORDER BY oi.id`, [orderId],
  )
  const row = order.rows[0]
  await database.query(
    `INSERT INTO order_email_outbox(order_id,stage,recipient,payload)
     VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (order_id,stage) DO NOTHING`,
    [orderId, stage, row.email, JSON.stringify({
      customerName: row.trade_name || row.legal_name,
      orderNumber: row.winthor_order_number ? String(row.winthor_order_number) : null,
      total: row.total,
      createdAt: row.created_at,
      paymentPlan: row.payment_plan_label || row.payment_plan,
      items: items.rows.map((item) => ({ name: item.name, units: item.units, unitPrice: item.unit_price, lineTotal: item.line_total })),
    })],
  )
}

export function renderOrderEmail(stage, payload) {
  const [title, message] = stageContent[stage]
  const base = (process.env.PUBLIC_URL || 'https://e-commerce-production-ce2d.up.railway.app').replace(/\/$/, '')
  const orderLabel = payload.orderNumber ? `Pedido ${escapeHtml(payload.orderNumber)}` : 'Seu pedido'
  const rows = payload.items.map((item) => `<tr><td style="padding:12px 8px;border-bottom:1px solid #e5ecf5">${escapeHtml(item.name)}<br><small>${currency(item.unitPrice)} por unidade</small></td><td style="padding:12px 8px;border-bottom:1px solid #e5ecf5;text-align:center">${Number(item.units)} un.</td><td style="padding:12px 8px;border-bottom:1px solid #e5ecf5;text-align:right">${currency(item.lineTotal)}</td></tr>`).join('')
  const itemSum = payload.items.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0)
  const discount = Math.max(0, itemSum - Number(payload.total || 0))
  const discountHtml = discount >= 0.01 ? `<p style="text-align:right;color:#397145">Descontos: -${currency(discount)}</p>` : ''
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f1f5fb;font-family:Arial,sans-serif;color:#09265e"><table role="presentation" style="width:100%;border-collapse:collapse"><tr><td align="center" style="padding:28px 12px"><table role="presentation" style="width:100%;max-width:620px;background:#fff;border-radius:16px;overflow:hidden;border-collapse:collapse"><tr><td style="background:#010066;padding:22px 30px"><img src="${base}/assets/omega-logo.png" alt="Ômega Distribuidora" width="180" style="display:block;background:#fff;border-radius:8px;padding:6px"></td></tr><tr><td style="padding:32px 30px"><div style="font-size:13px;color:#FC6800;font-weight:bold;letter-spacing:1px;text-transform:uppercase">Atualização do seu pedido</div><h1 style="font-size:28px;line-height:1.2;margin:12px 0;color:#010066">${title}</h1><p style="font-size:16px;line-height:1.6">Olá, ${escapeHtml(payload.customerName)}!</p><p style="font-size:16px;line-height:1.6">${message}</p><div style="background:#f1f5fb;border-left:4px solid #FCC71C;border-radius:8px;padding:16px;margin:24px 0"><strong>${orderLabel}</strong><br><span>Realizado em ${new Intl.DateTimeFormat('pt-BR', { timeZone:'America/Sao_Paulo', dateStyle:'short', timeStyle:'short' }).format(new Date(payload.createdAt))}</span><br><span>Condição de pagamento: ${escapeHtml(payload.paymentPlan)}</span></div><h2 style="font-size:19px;color:#010066">Itens do pedido</h2><table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr style="background:#f1f5fb"><th style="padding:10px 8px;text-align:left">Produto</th><th style="padding:10px 8px;text-align:center">Quantidade</th><th style="padding:10px 8px;text-align:right">Valor</th></tr></thead><tbody>${rows}</tbody></table>${discountHtml}<p style="font-size:19px;font-weight:bold;text-align:right;margin:20px 0">Total: ${currency(payload.total)}</p><a href="${base}/conta" style="display:inline-block;background:#FC6800;color:#fff;text-decoration:none;font-weight:bold;border-radius:8px;padding:14px 22px">Acompanhar meu pedido</a><p style="font-size:13px;color:#5e7092;margin-top:30px">Em caso de dúvidas, fale com nossa equipe pelo atendimento da loja.</p></td></tr><tr><td style="background:#010066;color:#fff;padding:18px 30px;font-size:12px">Ômega Distribuidora · Tudo o que você precisa, sempre por perto.</td></tr></table></td></tr></table></body></html>`
  return { subject: `Ômega Distribuidora | ${title}`, html }
}

async function processOne() {
  if (!process.env.RESEND_API_KEY) return false
  const database = await pool.connect()
  let row
  try {
    await database.query('BEGIN')
    const found = await database.query(
      `SELECT id,order_id,stage,recipient,payload,attempts FROM order_email_outbox
       WHERE sent_at IS NULL AND next_attempt_at<=CURRENT_TIMESTAMP
       ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
    )
    row = found.rows[0]
    if (!row) { await database.query('COMMIT'); return false }
    const email = renderOrderEmail(row.stage, row.payload)
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `omega-order-${row.order_id}-${row.stage}` },
      body: JSON.stringify({ from: process.env.ORDER_EMAIL_FROM || 'Ômega Distribuidora <contato@omegadistribuidora.com.br>', to: [row.recipient], subject: email.subject, html: email.html }),
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error(`Resend HTTP ${response.status}`)
    await database.query('UPDATE order_email_outbox SET sent_at=CURRENT_TIMESTAMP,attempts=attempts+1 WHERE id=$1', [row.id])
    await database.query('COMMIT')
    return true
  } catch (error) {
    await database.query('ROLLBACK')
    // A mesma chave de idempotência protege o reenvio após falha de rede ou reinício.
    if (row) await database.query("UPDATE order_email_outbox SET attempts=attempts+1,next_attempt_at=CURRENT_TIMESTAMP + (LEAST(60,POWER(2,LEAST(attempts,6)))::integer * INTERVAL '1 minute') WHERE id=$1", [row.id])
    console.warn(`[email] envio adiado: ${error instanceof Error ? error.message : 'falha desconhecida'}`)
    return false
  } finally { database.release() }
}

export function startOrderEmailWorker() {
  if (!process.env.RESEND_API_KEY) { console.warn('[email] RESEND_API_KEY ausente; notificações aguardam configuração.'); return }
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try { for (let i = 0; i < 20 && await processOne(); i += 1) {} }
    finally { running = false }
  }
  setInterval(() => tick().catch((error) => console.warn('[email] trabalhador indisponível:', error.message)), 30000).unref()
  tick().catch((error) => console.warn('[email] trabalhador indisponível:', error.message))
}
