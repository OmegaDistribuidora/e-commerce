export function onlyDigits(value: string, maxLength = 14) {
  return value.replace(/\D/g, '').slice(0, maxLength)
}

export function formatDocument(value: string) {
  const normalized = onlyDigits(value)
  if (normalized.length <= 11) {
    return normalized
      .replace(/^(\d{3})(\d)/, '$1.$2')
      .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d)/, '.$1-$2')
  }
  return normalized
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\/\d{4})(\d)/, '$1-$2')
}

export function formatPhone(value: string) {
  const normalized = onlyDigits(value, 11)
  if (normalized.length <= 10) {
    return normalized
      .replace(/^(\d{2})(\d)/, '($1) $2')
      .replace(/(\d{4})(\d)/, '$1-$2')
  }
  return normalized
    .replace(/^(\d{2})(\d)/, '($1) $2')
    .replace(/(\d{5})(\d)/, '$1-$2')
}

export function formatPostalCode(value: string) {
  return onlyDigits(value, 8).replace(/^(\d{5})(\d)/, '$1-$2')
}

export function isValidCpf(value: string) {
  const cpf = onlyDigits(value, 11)
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false
  const calculate = (length: number) => {
    let sum = 0
    for (let index = 0; index < length; index += 1) sum += Number(cpf[index]) * (length + 1 - index)
    const remainder = (sum * 10) % 11
    return remainder === 10 ? 0 : remainder
  }
  return calculate(9) === Number(cpf[9]) && calculate(10) === Number(cpf[10])
}

export function isValidCnpj(value: string) {
  const cnpj = onlyDigits(value)
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false
  const calculate = (base: string) => {
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

export function isValidDocument(value: string) {
  const normalized = onlyDigits(value)
  return normalized.length === 11 ? isValidCpf(normalized) : normalized.length === 14 && isValidCnpj(normalized)
}
