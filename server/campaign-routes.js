import { managedCampaignSchema } from './validation.js'
import { normalizedCity, refreshManagedCampaignProducts } from './managed-campaigns.js'

async function sourceQuery(sql, params, maxRows = 100) {
  const url = String(process.env.OMEGA_API_URL || '').trim().replace(/\/$/, '')
  const key = String(process.env.OMEGA_API_KEY || '').trim()
  if (!url || !key) throw new Error('A consulta de clientes e cidades não está disponível no momento.')
  const response = await fetch(`${url}/v1/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': key, 'X-Client-Name': 'omega-ecommerce' },
    body: JSON.stringify({ sql, params, max_rows: maxRows }), signal: AbortSignal.timeout(12000),
  })
  if (!response.ok) throw new Error('Não foi possível consultar os cadastros comerciais.')
  const data = await response.json()
  return (data.rows || []).map((values) => Object.fromEntries((data.columns || []).map((column, index) => [column, values[index]])))
}

const campaignFields = `id,external_id,name,description,rule_type,scope_type,target_values,reward_product_codes,reward_items,
 discount_value,threshold_basis,threshold_quantity,buy_quantity,free_quantity,allowed_customer_ids,
 allowed_cities,starts_on,ends_on,active,created_at,updated_at`

function campaignJson(row) {
  return {
    id: Number(row.id), code: Number(row.external_id), name: row.name || row.description,
    description: row.description, ruleType: row.rule_type, scopeType: row.scope_type,
    targetValues: (row.target_values || []).map(Number), rewardProductCodes: (row.reward_product_codes || []).map(Number),
    rewardItems: (row.reward_items || []).map((item) => ({ code: Number(item.code), quantity: Number(item.quantity) })),
    discountValue: Number(row.discount_value), thresholdBasis: row.threshold_basis,
    thresholdQuantity: Number(row.threshold_quantity), buyQuantity: Number(row.buy_quantity),
    freeQuantity: Number(row.free_quantity), allowedCustomerIds: (row.allowed_customer_ids || []).map(Number),
    allowedCities: row.allowed_cities || [], startsOn: row.starts_on instanceof Date ? row.starts_on.toISOString().slice(0, 10) : String(row.starts_on).slice(0, 10),
    endsOn: row.ends_on instanceof Date ? row.ends_on.toISOString().slice(0, 10) : String(row.ends_on).slice(0, 10), active: Boolean(row.active),
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

export function registerCampaignRoutes(app, pool, requireMarketingAccess) {
  app.get('/api/staff/campaigns', requireMarketingAccess, async (_request, response, next) => {
    try {
      const result = await pool.query(`SELECT ${campaignFields} FROM discount_campaigns WHERE origin='ecommerce' ORDER BY updated_at DESC,id DESC`)
      const campaigns = await Promise.all(result.rows.map(async (row) => {
        const productResult = await pool.query(
          `SELECT p.external_id AS code,p.name,p.brand,p.supplier_id
           FROM discount_campaign_products cp JOIN products p ON p.id=cp.product_id
           WHERE cp.campaign_id=$1 AND p.active=TRUE ORDER BY p.name`, [row.id],
        )
        return { ...campaignJson(row), products: productResult.rows.map((product) => ({
          code: Number(product.code), name: product.name, brand: product.brand, supplierId: Number(product.supplier_id),
        })) }
      }))
      return response.json({ campaigns })
    } catch (error) { return next(error) }
  })

  app.get('/api/staff/campaigns/options', requireMarketingAccess, async (request, response, next) => {
    try {
      const kind = String(request.query.kind || '')
      const q = String(request.query.q || '').trim().slice(0, 100)
      if (kind === 'clients') {
        if (q.length < 2) return response.json({ options: [] })
        const exactCode = /^\d+$/.test(q) ? Number(q) : -1
        const rows = await sourceQuery(
          `SELECT DISTINCT ON (codcli) codcli AS code, COALESCE(NULLIF(fantasia,''),cliente) AS name, cidade AS city
           FROM filial.dcliente WHERE codcli=%s OR cliente ILIKE %s OR fantasia ILIKE %s
           ORDER BY codcli,name LIMIT 100`, [exactCode, `%${q}%`, `%${q}%`], 100,
        )
        return response.json({ options: rows.map((row) => ({ code: Number(row.code), name: row.name, city: row.city })) })
      }
      if (kind === 'cities') {
        const rows = await sourceQuery(
          `SELECT DISTINCT cidade AS name FROM filial.dcliente
           WHERE cidade IS NOT NULL AND TRIM(cidade)<>'' AND cidade ILIKE %s
           ORDER BY name LIMIT 200`, [`%${q}%`], 200,
        )
        return response.json({ options: rows.map((row) => ({ name: row.name })) })
      }
      return response.status(400).json({ message: 'Tipo de seleção inválido.' })
    } catch (error) { return next(error) }
  })

  async function save(request, response, next) {
    const parsed = managedCampaignSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: parsed.error.issues[0].message })
    const item = parsed.data
    const targets = [...new Set(item.targetValues)]
    const rewardItems = item.ruleType === 'buy_get' ? item.rewardItems : []
    const rewards = rewardItems.map((reward) => reward.code)
    const customerIds = [...new Set(item.allowedCustomerIds)]
    const cities = [...new Set(item.allowedCities.map(normalizedCity))]
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const matched = await client.query(
        `SELECT COUNT(DISTINCT ${item.scopeType === 'products' ? 'external_id' : item.scopeType === 'sections' ? 'section_code' : 'supplier_id'})::int AS count
         FROM products WHERE active=TRUE AND ${item.scopeType === 'products' ? 'external_id' : item.scopeType === 'sections' ? 'section_code' : 'supplier_id'}=ANY($1::integer[])`, [targets],
      )
      if (Number(matched.rows[0].count) !== targets.length) {
        await client.query('ROLLBACK')
        return response.status(400).json({ message: 'Um ou mais produtos, seções ou fornecedores não estão disponíveis no catálogo ativo.' })
      }
      if (rewards.length) {
        const available = await client.query('SELECT external_id,sales_multiple FROM products WHERE active=TRUE AND external_id=ANY($1::integer[])', [rewards])
        if (available.rows.length !== rewards.length) {
          await client.query('ROLLBACK')
          return response.status(400).json({ message: 'Um ou mais produtos gratuitos não estão disponíveis.' })
        }
        const rewardByCode = new Map(available.rows.map((product) => [Number(product.external_id), product]))
        for (const reward of rewardItems) {
          const multiple = Math.max(1, Number(rewardByCode.get(reward.code)?.sales_multiple || 1))
          if (reward.quantity % multiple !== 0) {
            await client.query('ROLLBACK')
            return response.status(400).json({ message: `O brinde ${reward.code} deve ser informado em múltiplos de ${multiple} unidades.` })
          }
        }
      }
      if (customerIds.length) {
        for (let offset = 0; offset < customerIds.length; offset += 100) {
          const batch = customerIds.slice(offset, offset + 100)
          const rows = await sourceQuery('SELECT DISTINCT codcli AS code FROM filial.dcliente WHERE codcli=ANY(%s::int[])', [batch], 100)
          if (new Set(rows.map((row) => Number(row.code))).size !== batch.length) {
            await client.query('ROLLBACK')
            return response.status(400).json({ message: 'Um ou mais códigos de cliente não foram encontrados.' })
          }
        }
      }
      let id = Number(request.params.id || 0)
      if (id) {
        const exists = await client.query("SELECT id FROM discount_campaigns WHERE id=$1 AND origin='ecommerce' FOR UPDATE", [id])
        if (!exists.rows.length) { await client.query('ROLLBACK'); return response.status(404).json({ message: 'Campanha não encontrada.' }) }
      } else {
        if (process.env.DATABASE_URL) await client.query("SELECT pg_advisory_xact_lock(hashtext('omega_ecommerce_campaign_code'))")
        const nextCode = await client.query('SELECT GREATEST(COALESCE(MAX(external_id),0)+1,1000000) AS code FROM discount_campaigns')
        const created = await client.query("INSERT INTO discount_campaigns (external_id,name,description,starts_on,ends_on,origin) VALUES ($1,$2,$3,$4,$5,'ecommerce') RETURNING id", [nextCode.rows[0].code, item.name, item.description, item.startsOn, item.endsOn])
        id = Number(created.rows[0].id)
      }
      const saved = await client.query(
        `UPDATE discount_campaigns SET name=$2,description=$3,rule_type=$4,scope_type=$5,target_values=$6,
         reward_product_codes=$7,reward_items=$18::jsonb,discount_value=$8,threshold_basis=$9,threshold_quantity=$10,
         buy_quantity=$11,free_quantity=$12,allowed_customer_ids=$13,allowed_cities=$14,
         starts_on=$15,ends_on=$16,active=$17,updated_at=CURRENT_TIMESTAMP
         WHERE id=$1 AND origin='ecommerce' RETURNING ${campaignFields}`,
        [id,item.name,item.description,item.ruleType,item.scopeType,targets,rewards,item.discountValue,
          item.thresholdBasis,item.ruleType === 'buy_get' ? item.buyQuantity : item.thresholdQuantity,item.buyQuantity,rewardItems.reduce((sum, reward) => sum + reward.quantity, 0) || 1,customerIds,cities,
          item.startsOn,item.endsOn,item.active,JSON.stringify(rewardItems)],
      )
      await refreshManagedCampaignProducts(client, id)
      await client.query('COMMIT')
      return response.json({ campaign: campaignJson(saved.rows[0]) })
    } catch (error) { await client.query('ROLLBACK'); return next(error) }
    finally { client.release() }
  }
  app.post('/api/staff/campaigns', requireMarketingAccess, save)
  app.put('/api/staff/campaigns/:id', requireMarketingAccess, save)
  app.delete('/api/staff/campaigns/:id', requireMarketingAccess, async (request, response, next) => {
    try {
      const result = await pool.query("UPDATE discount_campaigns SET active=FALSE,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND origin='ecommerce' RETURNING id", [request.params.id])
      return result.rowCount ? response.status(204).end() : response.status(404).json({ message: 'Campanha não encontrada.' })
    } catch (error) { return next(error) }
  })
}
