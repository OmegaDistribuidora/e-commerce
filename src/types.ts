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
