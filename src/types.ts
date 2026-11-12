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
  stockUnits: number
  weeklySales: number
  priceDate: string
  manufacturerCode: string
  ncm: string
  ean: string
  planPrices?: Array<{ code: string; label: string; unitPrice: number }>
}

export type PricePlan = { code: string; label: string }

export type OrderQuote = {
  paymentPlan: PricePlan
  items: Array<{ productId: number; units: number; unitPrice: number; lineTotal: number }>
  total: number
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

export type CartItem = Product & { quantity: number }

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
  canOrder: boolean
  createdAt?: string
  approvedAt?: string | null
}

export type StaffUser = {
  id: number
  name: string
  email: string
  role: 'ADMIN' | 'COMERCIAL' | 'MARKETING'
  authProvider?: 'supabase' | 'legacy'
  active?: boolean
  createdAt?: string
}

export type Banner = {
  id: number
  title: string
  altText: string
  imageUrl: string
  targetUrl: string
  sectionCode: number | null
  destinationType: 'navigation' | 'sections' | 'products' | 'suppliers'
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
}

export type CommercialConditions = {
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
  image: string | null
}

export type CatalogSupplier = {
  id: number
  name: string
  productCount: number
}

export type OrderItem = {
  id: number
  productId: number
  code: number
  name: string
  boxes: number
  units: number
  unitsPerBox: number
  unitPrice: number
  lineTotal: number
}

export type Order = {
  id: number
  number: string
  status: string
  winthorOrderNumber: number | null
  winthorStatusCode: string
  winthorStatusLabel: string
  statusUpdatedAt: string | null
  enteredAt: string | null
  enteredBy: string
  paymentPlan: string
  paymentPlanLabel?: string
  total: number
  notes: string
  createdAt: string
  updatedAt: string
  cancelledAt?: string | null
  cancelledBy?: string
  canCancel?: boolean
  customer: Pick<Customer, 'id' | 'legalName' | 'tradeName' | 'document' | 'email' | 'phone'>
  items: OrderItem[]
}
