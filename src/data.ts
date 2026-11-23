export const money = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
})

// Os preços de origem podem ter mais de 2 casas decimais.
export const unitMoney = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
})
import type { Product } from './types'

export function campaignQuantitiesForCart(items: Array<Product & { quantity: number }>) {
  const totals = new Map<number, number>()
  for (const item of items) {
    const campaigns = new Set((item.campaignOffers || []).map((offer) => offer.campaignCode))
    for (const campaignCode of campaigns) {
      totals.set(campaignCode, (totals.get(campaignCode) || 0) + item.quantity)
    }
  }
  return totals
}

export function productPriceForQuantity(
  product: Product,
  quantity: number,
  campaignQuantities?: ReadonlyMap<number, number>,
) {
  const basePrice = product.unitPrice
  if (basePrice == null) return { unitPrice: null, discountPercent: 0, campaignCode: null as number | null }
  const offer = [...(product.campaignOffers || [])]
    .filter((item) => {
      const qualifyingQuantity = campaignQuantities?.get(item.campaignCode) ?? quantity
      return qualifyingQuantity >= item.minQuantity && (item.maxQuantity == null || qualifyingQuantity <= item.maxQuantity)
    })
    .sort((a, b) => b.discountPercent - a.discountPercent)[0]
  if (!offer) return { unitPrice: basePrice, discountPercent: 0, campaignCode: null as number | null }
  return {
    unitPrice: Math.round(basePrice * (1 - offer.discountPercent / 100) * 100) / 100,
    discountPercent: offer.discountPercent,
    campaignCode: offer.campaignCode,
  }
}
