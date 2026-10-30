export type Category = 'Todos' | 'Limpeza' | 'Higiene' | 'Utilidades' | 'Alimentos'

export type Product = {
  id: number
  code: number
  supplierId: number
  name: string
  brand: string
  category: Exclude<Category, 'Todos'>
  package: string
  masterPackage: string
  unitsPerBox: number
  minBoxes: number
  unitPrice: number | null
  listUnitPrice: number | null
  priceChannel: 'Varejo' | 'Redes' | null
  image: string | null
  department: string
  section: string
  stockUnits: number
  weeklySales: number
  priceDate: string
}

export type CartItem = Product & { quantity: number }

export type Customer = {
  id: number
  document: string
  personType: 'CPF' | 'CNPJ'
  legalName: string
  tradeName?: string
  phone: string
  email: string
  city?: string
  state?: string
  salesChannel: 'Varejo' | 'Redes'
}

export type StaffUser = {
  id: number
  name: string
  email: string
  role: 'ADMIN' | 'COMERCIAL'
  active?: boolean
  createdAt?: string
}

export type Banner = {
  id: number
  title: string
  altText: string
  imageUrl: string
  targetUrl: string
  position: number
  active: boolean
}

export type OrderItem = {
  id: number
  productId: number
  code: number
  name: string
  boxes: number
  unitsPerBox: number
  unitPrice: number
  lineTotal: number
}

export type Order = {
  id: number
  number: string
  status: string
  paymentPlan: string
  total: number
  notes: string
  createdAt: string
  updatedAt: string
  customer: Pick<Customer, 'id' | 'legalName' | 'tradeName' | 'document' | 'email' | 'phone'>
  items: OrderItem[]
}
