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

export const customerSchema = z.object({
  document: z.string().transform((value) => digits(value)).refine(isValidDocument, 'CPF ou CNPJ inválido'),
  legalName: z.string().trim().min(3, 'Informe o nome ou razão social').max(160),
  tradeName: z.string().trim().max(160).optional().default(''),
  phone: z.string().transform((value) => digits(value, 11)).refine((value) => value.length === 10 || value.length === 11, 'Telefone inválido'),
  email: z.string().trim().email('E-mail inválido').max(180),
  password: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres').max(72).regex(/[A-Z]/, 'Inclua uma letra maiúscula na senha').regex(/[a-z]/, 'Inclua uma letra minúscula na senha').regex(/\d/, 'Inclua um número na senha'),
  postalCode: z.string().transform((value) => digits(value, 8)).refine((value) => !value || value.length === 8, 'CEP inválido').optional().default(''),
  addressLine: z.string().trim().max(180).optional().default(''),
  addressNumber: z.string().trim().max(20).optional().default(''),
  addressComplement: z.string().trim().max(100).optional().default(''),
  neighborhood: z.string().trim().max(100).optional().default(''),
  city: z.string().trim().max(100).optional().default(''),
  state: z.string().trim().toUpperCase().regex(/^$|^[A-Z]{2}$/, 'UF inválida').optional().default(''),
})

export const loginSchema = z.object({
  email: z.string().trim().email('E-mail inválido').max(180).transform((value) => value.toLocaleLowerCase('pt-BR')),
  password: z.string().min(1, 'Informe sua senha').max(72),
})

export const lookupSchema = z.object({
  document: z.string().transform((value) => digits(value)).refine(isValidDocument, 'CPF ou CNPJ inválido'),
})

export const orderSchema = z.object({
  customerId: z.coerce.number().int().positive(),
  paymentPlan: z.enum(['avista', '7_dias', '14_dias', '28_dias', '4_14_dias', '14_28_dias']),
  notes: z.string().trim().max(1000).optional().default(''),
  items: z.array(z.object({
    productId: z.coerce.number().int().positive(),
    quantity: z.coerce.number().int().positive().max(999),
  })).min(1, 'O pedido precisa ter ao menos um item').max(200),
})

export const staffUserSchema = z.object({
  name: z.string().trim().min(3, 'Informe o nome do usuário').max(120),
  email: z.string().trim().email('E-mail inválido').max(180).transform((value) => value.toLowerCase()),
  password: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres').max(72)
    .regex(/[A-Z]/, 'Inclua uma letra maiúscula na senha')
    .regex(/[a-z]/, 'Inclua uma letra minúscula na senha')
    .regex(/\d/, 'Inclua um número na senha'),
  role: z.enum(['ADMIN', 'COMERCIAL']),
})

export const bannerSchema = z.object({
  title: z.string().trim().min(2, 'Informe o título').max(160),
  altText: z.string().trim().min(3, 'Informe o texto alternativo').max(240),
  targetUrl: z.string().trim().max(500).default('#produtos'),
  position: z.coerce.number().int().min(0).max(1000),
  active: z.boolean(),
  imageDataUrl: z.string().optional().default(''),
})

export const categorySchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome da categoria').max(80),
  position: z.coerce.number().int().min(0).max(1000).optional().default(0),
})

export const categoryProductsSchema = z.object({
  productIds: z.array(z.coerce.number().int().positive()).max(20000),
})

const syncProductSchema = z.object({
  externalId: z.coerce.number().int().positive(),
  supplierId: z.coerce.number().int().nonnegative().default(0),
  brand: z.string().trim().max(200).default(''),
  name: z.string().trim().min(1).max(300),
  package: z.string().trim().max(100).default(''),
  masterPackage: z.string().trim().max(100).default(''),
  unitsPerBox: z.coerce.number().int().positive().max(100000).default(1),
  minBoxes: z.coerce.number().int().positive().max(10000).default(1),
  retailUnitPrice: z.coerce.number().nonnegative().max(999999999),
  networkUnitPrice: z.coerce.number().nonnegative().max(999999999),
  department: z.string().trim().max(200).default(''),
  section: z.string().trim().max(200).default(''),
  ean: z.string().trim().max(40).default(''),
  priceDate: z.string().trim().max(30).nullable().optional(),
})

export const productSyncSchema = z.object({
  source: z.literal('WinThor'),
  products: z.array(syncProductSchema).min(1).max(20000),
})
