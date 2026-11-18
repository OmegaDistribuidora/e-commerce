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


export function productPriceForQuantity(product: Product, quantity: number) {
  const basePrice = product.unitPrice
  if (basePrice == null) return { unitPrice: null, discountPercent: 0, campaignCode: null as number | null }
  const offer = [...(product.campaignOffers || [])]
    .filter((item) => quantity >= item.minQuantity && (item.maxQuantity == null || quantity <= item.maxQuantity))
    .sort((a, b) => b.discountPercent - a.discountPercent)[0]
  if (!offer) return { unitPrice: basePrice, discountPercent: 0, campaignCode: null as number | null }
  return {
    unitPrice: Math.round(basePrice * (1 - offer.discountPercent / 100) * 100) / 100,
    discountPercent: offer.discountPercent,
    campaignCode: offer.campaignCode,
  }
}
