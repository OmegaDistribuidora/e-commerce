import assert from 'node:assert/strict'
import test from 'node:test'
import { campaignAllowed, campaignDiscounts } from './managed-campaigns.js'

const line = (id, units, price = 10, box = 6) => ({
  product: { id, external_id: id, units_per_box: box }, units, baseUnitPrice: price,
})
const campaign = (overrides = {}) => ({
  external_id: 1, rule_type: 'percent', discount_value: 10, threshold_basis: 'units',
  threshold_quantity: 1, buy_quantity: 3, free_quantity: 1,
  reward_product_codes: [], productIds: new Set([1, 2]), ...overrides,
})

test('percentual usa a soma de unidades dos produtos participantes', () => {
  const result = campaignDiscounts([campaign({ threshold_quantity: 5 })], [line(1, 2), line(2, 3)])
  assert.equal(result.get(1).cents, 200)
  assert.equal(result.get(2).cents, 300)
  assert.equal(campaignDiscounts([campaign({ threshold_quantity: 6 })], [line(1, 2), line(2, 3)]).size, 0)
})

test('valor fixo entra uma vez, dividido entre produtos elegíveis', () => {
  const result = campaignDiscounts([campaign({ rule_type: 'fixed', discount_value: 15 })], [line(1, 2), line(2, 3)])
  assert.equal([...result.values()].reduce((sum, item) => sum + item.cents, 0), 1500)
  const capped = campaignDiscounts([campaign({ rule_type: 'fixed', discount_value: 100 })], [line(1, 1), line(2, 1)])
  assert.equal(capped.get(1).cents, 1000)
  assert.equal(capped.get(2).cents, 1000)
})

test('caixas completas são somadas sem contar caixas parciais', () => {
  const result = campaignDiscounts([campaign({ threshold_basis: 'boxes', threshold_quantity: 2 })], [line(1, 8), line(2, 6)])
  assert.equal(result.size, 2)
  assert.equal(campaignDiscounts([campaign({ threshold_basis: 'boxes', threshold_quantity: 3 })], [line(1, 8), line(2, 6)]).size, 0)
})

test('compre X leve Y preserva unidades pagas quando o prêmio também qualifica', () => {
  const offer = campaign({ rule_type: 'buy_get', buy_quantity: 3, free_quantity: 1, reward_product_codes: [1], productIds: new Set([1]) })
  assert.equal(campaignDiscounts([offer], [line(1, 3)]).size, 0)
  assert.equal(campaignDiscounts([offer], [line(1, 4)]).get(1).cents, 1000)
  assert.equal(campaignDiscounts([offer], [line(1, 6)]).get(1).cents, 1000)
  assert.equal(campaignDiscounts([offer], [line(1, 8)]).get(1).cents, 2000)
})

test('compre X leve Y permite produto de prêmio separado', () => {
  const offer = campaign({ rule_type: 'buy_get', buy_quantity: 3, free_quantity: 1, reward_product_codes: [3] })
  assert.equal(campaignDiscounts([offer], [line(1, 2), line(2, 1), line(3, 1, 7)]).get(3).cents, 700)
  const boxes = campaign({ rule_type: 'buy_get', threshold_basis: 'boxes', buy_quantity: 2,
    free_quantity: 1, reward_product_codes: [3] })
  assert.equal(campaignDiscounts([boxes], [line(1, 6), line(2, 6), line(3, 6, 7)]).get(3).cents, 4200)
})

test('público exige cliente e cidade quando ambos estão definidos', () => {
  const offer = { allowed_customer_ids: [66151], allowed_cities: ['fortaleza'] }
  assert.equal(campaignAllowed(offer, 66151, 'Fortaleza'), true)
  assert.equal(campaignAllowed(offer, 66151, 'Barbalha'), false)
  assert.equal(campaignAllowed(offer, 2, 'Fortaleza'), false)
  assert.equal(campaignAllowed(offer, null, 'Fortaleza'), false)
})
