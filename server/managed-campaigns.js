export function normalizedCity(value) {
  return String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR')
}

export function campaignAllowed(campaign, customerCode, city) {
  const customers = campaign.allowed_customer_ids || []
  const cities = campaign.allowed_cities || []
  return (!customers.length || (Boolean(customerCode) && customers.map(Number).includes(Number(customerCode))))
    && (!cities.length || (Boolean(city) && cities.includes(normalizedCity(city))))
}

// Product links are a materialized view of the campaign selection. Refreshing inside
// the product sync transaction also includes newly activated products automatically.
export async function refreshManagedCampaignProducts(database, campaignId = null) {
  if (!process.env.DATABASE_URL) {
    const campaigns = await database.query(`SELECT id,scope_type,target_values,rule_type,discount_value,threshold_quantity
      FROM discount_campaigns WHERE origin='ecommerce'${campaignId == null ? '' : ' AND id=$1'}`, campaignId == null ? [] : [campaignId])
    const products = await database.query('SELECT id,external_id,supplier_id,section_code FROM products WHERE active=TRUE')
    for (const campaign of campaigns.rows) {
      await database.query('DELETE FROM discount_campaign_products WHERE campaign_id=$1', [campaign.id])
      const targets = new Set((campaign.target_values || []).map(Number))
      for (const product of products.rows) {
        const value = campaign.scope_type === 'products' ? product.external_id : campaign.scope_type === 'sections' ? product.section_code : product.supplier_id
        if (!targets.has(Number(value))) continue
        await database.query(`INSERT INTO discount_campaign_products
          (campaign_id,product_id,sequence,registered_product_code,product_origin,min_quantity,max_quantity,discount_percent,discount_type)
          VALUES ($1,$2,0,$3,'CADASTRADO',$4,NULL,$5,$6)`, [campaign.id,product.id,product.external_id,campaign.threshold_quantity,
          campaign.rule_type === 'percent' ? campaign.discount_value : 0,campaign.rule_type])
      }
    }
    return
  }
  const params = campaignId == null ? [] : [campaignId]
  const clause = campaignId == null ? '' : ' AND dc.id=$1'
  await database.query(
    `INSERT INTO discount_campaign_products
       (campaign_id,product_id,sequence,registered_product_code,product_origin,min_quantity,max_quantity,discount_percent,discount_type)
     SELECT dc.id,p.id,0,p.external_id,'CADASTRADO',dc.threshold_quantity,NULL,
            CASE WHEN dc.rule_type='percent' THEN dc.discount_value ELSE 0 END,dc.rule_type
     FROM discount_campaigns dc
     JOIN products p ON p.active=TRUE AND (
       (dc.scope_type='products' AND p.external_id=ANY(dc.target_values)) OR
       (dc.scope_type='sections' AND p.section_code=ANY(dc.target_values)) OR
       (dc.scope_type='suppliers' AND p.supplier_id=ANY(dc.target_values)))
     WHERE dc.origin='ecommerce'${clause}
     ON CONFLICT (campaign_id,product_id,sequence) DO UPDATE SET
       min_quantity=EXCLUDED.min_quantity,discount_percent=EXCLUDED.discount_percent,
       discount_type=EXCLUDED.discount_type
     WHERE discount_campaign_products.min_quantity IS DISTINCT FROM EXCLUDED.min_quantity
        OR discount_campaign_products.discount_percent IS DISTINCT FROM EXCLUDED.discount_percent
        OR discount_campaign_products.discount_type IS DISTINCT FROM EXCLUDED.discount_type`,
    params,
  )
  await database.query(
    `DELETE FROM discount_campaign_products dcp
     WHERE EXISTS (SELECT 1 FROM discount_campaigns dc WHERE dc.id=dcp.campaign_id AND dc.origin='ecommerce'${clause})
       AND NOT EXISTS (
         SELECT 1 FROM discount_campaigns dc JOIN products p ON p.id=dcp.product_id
         WHERE dc.id=dcp.campaign_id AND p.active=TRUE AND (
           (dc.scope_type='products' AND p.external_id=ANY(dc.target_values)) OR
           (dc.scope_type='sections' AND p.section_code=ANY(dc.target_values)) OR
           (dc.scope_type='suppliers' AND p.supplier_id=ANY(dc.target_values))))`,
    params,
  )
}

export function campaignDiscounts(campaigns, lines) {
  const candidates = new Map()
  for (const campaign of campaigns) {
    if (campaign.rule_type === 'buy_get') continue
    const eligible = lines.filter((line) => campaign.productIds.has(Number(line.product.id)))
    if (!eligible.length) continue
    const quantity = eligible.reduce((sum, line) => sum + (campaign.threshold_basis === 'boxes'
      ? Math.floor(line.units / Number(line.product.units_per_box || 1)) : line.units), 0)
    if (quantity < Number(campaign.threshold_quantity)) continue
    const amounts = new Map()
    if (campaign.rule_type === 'percent') {
      for (const line of eligible) amounts.set(Number(line.product.id), Math.round(line.units * line.baseUnitPrice * Number(campaign.discount_value)))
    } else if (campaign.rule_type === 'fixed') {
      const subtotal = eligible.reduce((sum, line) => sum + line.units * line.baseUnitPrice, 0)
      const appliedTotal = Math.min(Math.round(Number(campaign.discount_value) * 100), Math.round(subtotal * 100))
      let remaining = appliedTotal
      for (const [index, line] of eligible.entries()) {
        const lineMax = Math.round(line.units * line.baseUnitPrice * 100)
        const amount = index === eligible.length - 1 ? Math.min(remaining, lineMax)
          : Math.min(remaining, lineMax, Math.round(appliedTotal * (line.units * line.baseUnitPrice / subtotal)))
        amounts.set(Number(line.product.id), amount)
        remaining -= amount
      }
    }
    for (const [productId, cents] of amounts) {
      const existing = candidates.get(productId)
      if (cents > (existing?.cents || 0)) candidates.set(productId, { cents, campaign })
    }
  }
  return candidates
}

// Gifts are derived from paid lines, never from gifts already in the cart.
export function campaignGiftQuantities(campaigns, paidLines) {
  const gifts = []
  for (const campaign of campaigns) {
    if (campaign.rule_type !== 'buy_get') continue
    const buy = Number(campaign.buy_quantity)
    if (!Number.isSafeInteger(buy) || buy < 1) continue
    const qualified = paidLines.filter((line) => campaign.productIds.has(Number(line.product.id)))
    const count = qualified.reduce((sum, line) => sum + (campaign.threshold_basis === 'boxes'
      ? Math.floor(Number(line.units) / Math.max(1, Number(line.product.units_per_box))) : Number(line.units)), 0)
    const groups = campaign.allow_repeat ? Math.floor(count / buy) : Number(count >= buy)
    if (!groups) continue
    for (const reward of campaign.reward_items || []) {
      const code = Number(reward.code)
      const quantity = groups * Number(reward.quantity)
      if (Number.isSafeInteger(code) && Number.isSafeInteger(quantity) && quantity > 0 && quantity <= 100000) {
        gifts.push({ code, quantity, campaignCode: Number(campaign.external_id), campaignName: campaign.name })
      }
    }
  }
  return gifts
}
