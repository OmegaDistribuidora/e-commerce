export type Category = string

export type Product = {
  id: number
  code: number
  supplierId: number
  name: string
  brand: string
  category: Exclude<Category, 'Todos'>
  categories: string[]
  package: string
  masterPackage: string
  unitsPerBox: number
  salesMultiple: number
  minBoxes: number
  unitPrice: number | null
  listUnitPrice: number | null
  image: string | null
  departmentCode: number
  department: string
  sectionCode: number
  section: string
  ordersLast30Days: number
  priceDate: string
  manufacturerCode: string
  ncm: string
  ean: string
  planPrices?: Array<{ code: string; label: string; unitPrice: number }>
  campaignOffers?: CampaignOffer[]
  stocks?: Array<{
    branch: 1 | 3
    totalUnits: number | null
    reservedUnits: number | null
    blockedUnits: number | null
    availableUnits: number | null
    updatedAt: string | null
  }>
}

export type PricePlan = { code: string; label: string }

export type OrderQuote = {
  paymentPlan: PricePlan
  items: Array<{ productId: number; units: number; baseUnitPrice: number; unitPrice: number; lineTotal: number; discountPercent: number; campaignCode: number | null; campaignDescription: string | null; isGift?: boolean }>
  total: number
  subtotal: number
  coupon: null | { code: string; description: string; discountType: 'fixed' | 'percent'; discountValue: number; eligibleSubtotal: number; discountAmount: number }
  planTotals: Array<{ code: string; label: string; total: number | null }>
}

export type Coupon = {
  id: number
  code: string
  description: string
  discountType: 'fixed' | 'percent'
  discountValue: number
  scopeType: 'order' | 'products' | 'suppliers' | 'sections'
  targetValues: number[]
  active: boolean
  startsAt: string | null
  endsAt: string | null
  createdAt?: string
  updatedAt?: string
}

export type CampaignOffer = {
  campaignCode: number
  campaign: string
  minQuantity: number
  maxQuantity: number | null
  discountPercent: number
  discountType: string
}

export type DiscountCampaign = {
  id?: number
  code: number
  name?: string
  description: string
  startsOn: string
  endsOn: string
  usesProductFamily?: boolean
  ruleType?: 'percent' | 'fixed' | 'buy_get'
  scopeType?: 'products' | 'sections' | 'suppliers'
  targetValues?: number[]
  rewardProductCodes?: number[]
  rewardItems?: Array<{ code: number; quantity: number }>
  discountValue?: number
  thresholdBasis?: 'units' | 'boxes'
  thresholdQuantity?: number
  buyQuantity?: number
  freeQuantity?: number
  allowedCities?: string[]
  branchCode?: string
  active?: boolean
  sourceUpdatedAt?: string | null
  allowedCustomerIds?: number[]
  products: Array<{
    id?: number
    code: number
    name: string
    brand: string
    supplierId?: number
    image?: string | null
    offers?: Array<{ minQuantity: number; maxQuantity: number | null; discountPercent: number; discountType: string }>
    minQuantity?: number
    maxQuantity?: number | null
    discountPercent?: number
    discountType?: string
    origin?: string
  }>
  rewards?: Array<{ id: number; code: number; name: string; brand: string; supplierId: number; image?: string | null }>
}

export type CatalogSection = {
  code: number
  name: string
  productCount: number
}

export type CatalogDepartment = {
  code: number
  name: string
  productCount: number
  sections: CatalogSection[]
}

export type Partner = {
  supplierId: number
  name: string
  logo: string
  productCount: number
}

export type InstitutionalContent = {
  heroTitle: string
  heroSubtitle: string
  historyTitle: string
  historyText: string
  valuesTitle: string
  valuesText: string
  heroImageUrl: string | null
  historyImageUrl: string | null
  updatedAt?: string
}

export type CartItem = Product & { quantity: number; isGift?: boolean; giftCampaignCode?: number; giftCampaignName?: string }

export type Customer = {
  id: number
  externalId: number | null
  document: string
  personType: 'CPF' | 'CNPJ'
  legalName: string
  tradeName?: string
  phone: string
  email: string
  postalCode: string
  addressLine: string
  addressNumber: string
  addressComplement: string
  neighborhood: string
  city?: string
  state?: string
  salesChannel: 'Varejo' | 'Redes'
  registrationStatus: 'pending' | 'approved'
  commercialBlocked?: boolean
  pricesPending?: boolean
  canOrder: boolean
  createdAt?: string
  approvedAt?: string | null
}

export type StaffUser = {
  id: number
  name: string
  email: string
  role: 'ADMIN' | 'COMERCIAL' | 'MARKETING' | 'TELEVENDAS'
  authProvider?: 'supabase' | 'legacy'
  active?: boolean
  createdAt?: string
}

export type Banner = {
  id: number
  title: string
  altText: string
  imageUrl: string
  mobileImageUrl: string
  targetUrl: string
  sectionCode: number | null
  destinationType: 'navigation' | 'sections' | 'products' | 'suppliers' | 'campaigns'
  destinationValues: number[]
  navigationPath: string
  sectionName?: string
  departmentCode?: number | null
  departmentName?: string
  position: number
  active: boolean
  placement: 'hero' | 'catalog'
  startsAt: string | null
  endsAt: string | null
  imageDataUrl?: string
  mobileImageDataUrl?: string
}

export type CommercialConditions = {
  isBlocked?: boolean
  creditLimit: number
  openTitlesAmount: number
  openOrdersAmount: number
  pendingOrdersAmount: number
  availableCredit: number
  paymentPlans: Array<{ code: string; label: string; priceTable?: number }>
  updatedAt: string | null
}

export type CatalogCategory = {
  id: number
  name: string
  position: number
  active?: boolean
  productCount?: number
  productIds?: number[]
}

export type StaffCatalogProduct = {
  id: number
  code: number
  supplierId: number
  brand: string
  name: string
  package: string
  unitsPerBox: number
  salesMultiple: number
  image: string | null
}

export type CatalogSupplier = {
  id: number
  name: string
  productCount: number
  logo?: string | null
}

export type OrderItem = {
  id: number
  productId: number
  code: number
  name: string
  image: string | null
  boxes: number
  units: number
  unitsPerBox: number
  unitPrice: number
  lineTotal: number
  isGift?: boolean
  campaignCode?: number | null
}

export type Order = {
  id: number
  number: string
  status: string
  winthorOrderNumber: number | null
  winthorStatusCode: string
  winthorStatusLabel: string
  statusUpdatedAt: string | null
  deliveryDate?: string | null
  releasedAt?: string | null
  invoicedAt?: string | null
  enteredAt: string | null
  enteredBy: string
  paymentPlan: string
  paymentPlanLabel?: string
  total: number
  coupon?: null | { code: string; description: string; discountAmount: number }
  notes: string
  createdAt: string
  updatedAt: string
  cancelledAt?: string | null
  cancelledBy?: string
  canCancel?: boolean
  customer: Pick<Customer, 'id' | 'legalName' | 'tradeName' | 'document' | 'email' | 'phone'>
  items: OrderItem[]
}
