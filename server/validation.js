import { z } from 'zod'

export function digits(value, maxLength = 14) {
  return String(value ?? '').replace(/\D/g, '').slice(0, maxLength)
}

export function isValidCpf(value) {
  const cpf = digits(value, 11)
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false
  const calculate = (length) => {
    let sum = 0
    for (let index = 0; index < length; index += 1) sum += Number(cpf[index]) * (length + 1 - index)
    const remainder = (sum * 10) % 11
    return remainder === 10 ? 0 : remainder
  }
  return calculate(9) === Number(cpf[9]) && calculate(10) === Number(cpf[10])
}

export function isValidCnpj(value) {
  const cnpj = digits(value, 14)
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false
  const calculate = (base) => {
    let factor = base.length - 7
    let sum = 0
    for (const char of base) {
      sum += Number(char) * factor--
      if (factor < 2) factor = 9
    }
    const remainder = sum % 11
    return remainder < 2 ? 0 : 11 - remainder
  }
  const first = calculate(cnpj.slice(0, 12))
  const second = calculate(`${cnpj.slice(0, 12)}${first}`)
  return cnpj.endsWith(`${first}${second}`)
}

export function isValidDocument(value) {
  const normalized = digits(value)
  return normalized.length === 11 ? isValidCpf(normalized) : normalized.length === 14 && isValidCnpj(normalized)
}

export const customerProfileSchema = z.object({
  document: z.string().transform((value) => digits(value)).refine(isValidDocument, 'CPF ou CNPJ inválido'),
  legalName: z.string().trim().min(3, 'Informe o nome ou razão social').max(160),
  tradeName: z.string().trim().max(160).optional().default(''),
  phone: z.string().transform((value) => digits(value, 11)).refine((value) => value.length === 10 || value.length === 11, 'Telefone inválido'),
  email: z.string().trim().email('E-mail inválido').max(180),
  postalCode: z.string().transform((value) => digits(value, 8)).refine((value) => value.length === 8, 'Informe um CEP válido'),
  addressLine: z.string().trim().min(3, 'Informe o endereço').max(180),
  addressNumber: z.string().trim().min(1, 'Informe o número').max(20),
  addressComplement: z.string().trim().max(100).optional().default(''),
  neighborhood: z.string().trim().min(2, 'Informe o bairro').max(100),
  city: z.string().trim().min(2, 'Informe a cidade').max(100),
  state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Informe uma UF válida'),
})

export const customerUpdateSchema = customerProfileSchema.omit({ document: true, email: true })

// Cadastro feito pela gestão: telefone e CEP podem ficar para o cliente completar depois.
export const staffCustomerCreateSchema = customerProfileSchema.extend({
  phone: z.string().optional().default('').transform((value) => digits(value, 11))
    .refine((value) => value === '' || value.length === 10 || value.length === 11, 'Telefone inválido'),
  postalCode: z.string().optional().default('').transform((value) => digits(value, 8))
    .refine((value) => value === '' || value.length === 8, 'Informe um CEP válido'),
  email: z.string().trim().email('E-mail inválido').max(180).transform((value) => value.toLowerCase()),
  password: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres').max(72)
    .regex(/[A-Z]/, 'Inclua uma letra maiúscula na senha')
    .regex(/[a-z]/, 'Inclua uma letra minúscula na senha')
    .regex(/\d/, 'Inclua um número na senha'),
})

export const staffPasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Informe a senha atual').max(72),
  newPassword: z.string().min(8, 'A nova senha precisa ter pelo menos 8 caracteres').max(72)
    .regex(/[A-Z]/, 'Inclua uma letra maiúscula na nova senha')
    .regex(/[a-z]/, 'Inclua uma letra minúscula na nova senha')
    .regex(/\d/, 'Inclua um número na nova senha'),
})

export const loginSchema = z.object({
  email: z.string().trim().email('E-mail inválido').max(180).transform((value) => value.toLocaleLowerCase('pt-BR')),
  password: z.string().min(1, 'Informe sua senha').max(72),
})

export const emailCheckSchema = z.object({
  email: z.string().trim().email('E-mail inválido').max(180).transform((value) => value.toLowerCase()),
})

export const lookupSchema = z.object({
  document: z.string().transform((value) => digits(value)).refine(isValidDocument, 'CPF ou CNPJ inválido'),
})

export const orderSchema = z.object({
  customerId: z.coerce.number().int().positive(),
  paymentPlan: z.string().trim().min(1, 'Selecione um plano de pagamento').max(30),
  notes: z.string().trim().max(1000).optional().default(''),
  items: z.array(z.object({
    productId: z.coerce.number().int().positive(),
    quantity: z.coerce.number().int().positive().max(100000),
  })).min(1, 'O pedido precisa ter ao menos um item').max(200),
})

export const orderQuoteSchema = z.object({
  paymentPlan: z.string().trim().min(1).max(30).optional(),
  items: z.array(z.object({
    productId: z.coerce.number().int().positive(),
    quantity: z.coerce.number().int().positive().max(100000),
  })).min(1, 'O carrinho está vazio').max(200),
})

const priceValue = z.coerce.number().nonnegative().max(99999999).nullable()

// Linhas compactas: [região, CODPROD, PTABELA1..PTABELA7].
export const regionPricesSyncSchema = z.object({
  regions: z.array(z.coerce.number().int().nonnegative()).min(1).max(500),
  prices: z.array(z.tuple([
    z.coerce.number().int().nonnegative(), z.coerce.number().int().positive(),
    priceValue, priceValue, priceValue, priceValue, priceValue, priceValue, priceValue,
  ])).max(500000),
})

export const staffOrderLinkSchema = z.object({
  winthorOrderNumber: z.coerce.number().int('Informe um NUMPED válido').positive('Informe um NUMPED válido').max(999999999999),
})

export const staffUserSchema = z.object({
  name: z.string().trim().min(3, 'Informe o nome do usuário').max(120),
  email: z.string().trim().email('E-mail inválido').max(180).transform((value) => value.toLowerCase()),
  password: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres').max(72)
    .regex(/[A-Z]/, 'Inclua uma letra maiúscula na senha')
    .regex(/[a-z]/, 'Inclua uma letra minúscula na senha')
    .regex(/\d/, 'Inclua um número na senha'),
  role: z.enum(['ADMIN', 'COMERCIAL', 'MARKETING']),
})

export const bannerSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  title: z.string().trim().min(2, 'Informe o título').max(160),
  altText: z.string().trim().min(3, 'Informe o texto alternativo').max(240),
  targetUrl: z.string().trim().max(500).default('#produtos'),
  sectionCode: z.coerce.number().int().positive().nullable().optional().default(null),
  destinationType: z.enum(['navigation', 'sections', 'products', 'suppliers']).default('navigation'),
  destinationValues: z.array(z.coerce.number().int().positive()).max(100).default([]),
  navigationPath: z.enum(['/', '/#produtos', '/?modo=mais-vendidos#produtos', '/#parceiros', '/pedidos', '/conta']).default('/#produtos'),
  position: z.coerce.number().int().min(0).max(1000),
  active: z.boolean(),
  placement: z.enum(['hero', 'catalog']).default('hero'),
  imageDataUrl: z.string().optional().default(''),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
}).refine((value) => !value.startsAt || !value.endsAt || new Date(value.endsAt) > new Date(value.startsAt), {
  message: 'O encerramento deve ser posterior ao início.', path: ['endsAt'],
}).refine((value) => value.destinationType === 'navigation' || value.destinationValues.length > 0, {
  message: 'Selecione pelo menos um destino para o banner.', path: ['destinationValues'],
})

export const bannersBulkSchema = z.object({
  banners: z.array(bannerSchema).max(100),
  deletedIds: z.array(z.coerce.number().int().positive()).max(100).default([]),
})

const syncProductSchema = z.object({
  externalId: z.coerce.number().int().positive(),
  supplierId: z.coerce.number().int().nonnegative().default(0),
  brand: z.string().trim().max(200).default(''),
  name: z.string().trim().min(1).max(300),
  package: z.string().trim().max(100).default(''),
  masterPackage: z.string().trim().max(100).default(''),
  unitsPerBox: z.coerce.number().int().positive().max(100000).default(1),
  salesMultiple: z.coerce.number().int().positive().max(100000).default(1),
  minBoxes: z.coerce.number().int().positive().max(10000).default(1),
  retailUnitPrice: z.coerce.number().nonnegative().max(999999999),
  networkUnitPrice: z.coerce.number().nonnegative().max(999999999),
  departmentCode: z.coerce.number().int().nonnegative().default(0),
  department: z.string().trim().max(200).default(''),
  sectionCode: z.coerce.number().int().nonnegative().default(0),
  section: z.string().trim().max(200).default(''),
  ean: z.string().trim().max(40).default(''),
  manufacturerCode: z.string().trim().max(100).default(''),
  ncm: z.string().trim().max(40).default(''),
  priceDate: z.string().trim().max(30).nullable().optional(),
})

export const productSyncSchema = z.object({
  source: z.literal('WinThor'),
  products: z.array(syncProductSchema).min(1).max(20000),
})

const paymentPlanSyncSchema = z.object({
  code: z.coerce.string().trim().min(1).max(30),
  label: z.string().trim().min(1).max(160),
  priceTable: z.coerce.number().int().min(1).max(7).optional(),
})

export const customerConditionsSyncSchema = z.object({
  customers: z.array(z.object({
    externalId: z.coerce.number().int().positive(),
    creditLimit: z.coerce.number().nonnegative().max(999999999999),
    openTitlesAmount: z.coerce.number().nonnegative().max(999999999999).default(0),
    openOrdersAmount: z.coerce.number().nonnegative().max(999999999999).default(0),
    priceRegion: z.coerce.number().int().nonnegative().nullable().optional(),
    paymentPlans: z.array(paymentPlanSyncSchema).max(100),
    sourceUpdatedAt: z.string().datetime({ offset: true }).nullable().optional(),
  })).max(50000),
})
