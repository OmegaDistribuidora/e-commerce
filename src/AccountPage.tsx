import { useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, CircleUserRound, KeyRound, LoaderCircle, LockKeyhole, Mail, Search, ShieldCheck } from 'lucide-react'
import type { Customer } from './types'
import { formatDocument, formatPhone, formatPostalCode, isValidDocument, onlyDigits } from './validation'

type Step = 'login' | 'lookup' | 'register' | 'found'

async function responseData(response: Response) {
  const body = await response.text()
  if (!body) {
    throw new Error(response.ok
      ? 'O servidor respondeu sem os dados esperados. Tente novamente.'
      : 'Não foi possível acessar o servidor. Confirme se a API está em execução.')
  }
  try {
    return JSON.parse(body)
  } catch {
    throw new Error('O servidor enviou uma resposta inválida. Tente novamente.')
  }
}

export default function AccountPage() {
  const [step, setStep] = useState<Step>('login')
  const [document, setDocument] = useState('')
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const documentType = useMemo(() => onlyDigits(document).length > 11 ? 'CNPJ' : 'CPF', [document])

  async function authenticate(email: string, password: string) {
    const response = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    })
    const data = await responseData(response)
    if (!response.ok) throw new Error(data.message)
    return data.customer as Customer
  }

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setLoading(true)
    const form = new FormData(event.currentTarget)
    try {
      const authenticatedCustomer = await authenticate(String(form.get('email')), String(form.get('password')))
      setCustomer(authenticatedCustomer)
      setStep('found')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível entrar.')
    } finally {
      setLoading(false)
    }
  }

  async function lookup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setNotice('')
    if (!isValidDocument(document)) {
      setError('Digite um CPF ou CNPJ válido para continuar.')
      return
    }
    setLoading(true)
    try {
      const response = await fetch('/api/customers/lookup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document }),
      })
      const data = await responseData(response)
      if (!response.ok) throw new Error(data.message)
      if (data.found && data.hasAccess) {
        setStep('login')
        setNotice('Este cliente já possui acesso. Entre com o e-mail e a senha cadastrados.')
      } else {
        setCustomer(data.customer ?? null)
        setStep('register')
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível consultar o cadastro.')
    } finally {
      setLoading(false)
    }
  }

  async function register(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const form = new FormData(event.currentTarget)
    if (form.get('password') !== form.get('confirmPassword')) {
      setError('A confirmação da senha não confere.')
      return
    }
    const payload = Object.fromEntries(form.entries())
    delete payload.confirmPassword
    setLoading(true)
    try {
      const response = await fetch('/api/customers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      const data = await responseData(response)
      if (!response.ok) throw new Error(data.message)
      const authenticatedCustomer = await authenticate(String(payload.email), String(payload.password))
      setCustomer(authenticatedCustomer)
      setStep('found')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível concluir o cadastro.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="account-page">
      <header className="account-header container">
        <a href="/" className="account-back"><ArrowLeft size={18} /> Voltar para a loja</a>
        <a href="/" aria-label="Página inicial"><img src="/assets/omega-logo.png" alt="Ômega Distribuidora" /></a>
        <span className="secure-label"><LockKeyhole size={16} /> Ambiente seguro</span>
      </header>
      <section className="account-layout container">
        <div className="account-aside">
          <span className="eyebrow">ÁREA DO CLIENTE</span>
          <h1>Seu negócio,<br />mais perto da Ômega.</h1>
          <div className="account-benefits"><span><ShieldCheck /> Sessão protegida</span></div>
        </div>

        <div className="account-card">
          {step === 'login' && <>
            <span className="account-card-icon"><CircleUserRound /></span>
            <h2>Entrar na sua conta</h2>
            <p>Use o e-mail e a senha cadastrados para consultar preços e fazer pedidos.</p>
            {notice && <div className="form-notice">{notice}</div>}
            <form onSubmit={login} noValidate>
              <label>E-mail<div className="login-field"><Mail size={18} /><input name="email" type="email" autoComplete="email" placeholder="voce@empresa.com.br" required /></div></label>
              <label>Senha<div className="login-field"><KeyRound size={18} /><input name="password" type="password" autoComplete="current-password" placeholder="Sua senha" required /></div></label>
              {error && <span className="field-error">{error}</span>}
              {import.meta.env.DEV && <small className="test-hint">Teste local: ecommerce@omegadistribuidora.com.br · senha Omega@2026</small>}
              <button className="checkout-button" disabled={loading}>{loading ? <LoaderCircle className="spin" /> : <>Entrar <ArrowRight size={19} /></>}</button>
              <button type="button" className="account-link-button" onClick={() => { setStep('lookup'); setError(''); setNotice('') }}>Primeiro acesso ou novo cadastro</button>
            </form>
          </>}

          {step === 'lookup' && <>
            <span className="account-card-icon"><Search /></span>
            <h2>Identifique o cliente</h2>
            <p>Digite seu CPF ou CNPJ para localizar o cadastro antes de criar o acesso.</p>
            <form onSubmit={lookup} noValidate>
              <label>CPF ou CNPJ<div className={`document-field ${error ? 'invalid' : ''}`}><Search size={19} /><input autoFocus inputMode="numeric" value={document} onChange={(event) => { setDocument(formatDocument(event.target.value)); setError('') }} placeholder="000.000.000-00" /></div></label>
              {error && <span className="field-error">{error}</span>}
              <button className="checkout-button" disabled={loading}>{loading ? <LoaderCircle className="spin" /> : <>Continuar <ArrowRight size={19} /></>}</button>
              <button type="button" className="account-link-button" onClick={() => { setStep('login'); setError('') }}>Já tenho acesso</button>
            </form>
          </>}

          {step === 'register' && <>
            <span className="eyebrow">CRIAR ACESSO · {documentType}</span>
            <h2>Complete seus dados</h2>
            <p>{customer ? `Localizamos ${customer.tradeName || customer.legalName}. Crie seu acesso ao e-Commerce.` : `Não localizamos ${formatDocument(document)}. Complete o cadastro.`}</p>
            <form className="registration-form" onSubmit={register}>
              <input type="hidden" name="document" value={onlyDigits(document)} />
              <label>{documentType === 'CNPJ' ? 'Razão social' : 'Nome completo'}<input name="legalName" minLength={3} defaultValue={customer?.legalName} required /></label>
              {documentType === 'CNPJ' && <label>Nome fantasia<input name="tradeName" defaultValue={customer?.tradeName} /></label>}
              <div className="form-row"><label>Telefone<input name="phone" inputMode="numeric" placeholder="(85) 99999-9999" defaultValue={customer?.phone ? formatPhone(customer.phone) : ''} onChange={(event) => { event.currentTarget.value = formatPhone(event.currentTarget.value) }} required /></label><label>E-mail<input name="email" type="email" autoComplete="email" placeholder="compras@empresa.com.br" defaultValue={customer?.email} required /></label></div>
              <div className="form-row"><label>Senha<input name="password" type="password" autoComplete="new-password" minLength={8} placeholder="Mínimo de 8 caracteres" required /></label><label>Confirmar senha<input name="confirmPassword" type="password" autoComplete="new-password" minLength={8} required /></label></div>
              <div className="form-row address-row"><label>CEP<input name="postalCode" inputMode="numeric" placeholder="00000-000" onChange={(event) => { event.currentTarget.value = formatPostalCode(event.currentTarget.value) }} /></label><label>Endereço<input name="addressLine" /></label><label>Número<input name="addressNumber" /></label></div>
              <div className="form-row"><label>Bairro<input name="neighborhood" /></label><label>Cidade<input name="city" defaultValue={customer?.city} /></label><label>UF<input name="state" maxLength={2} defaultValue={customer?.state} onChange={(event) => { event.currentTarget.value = event.currentTarget.value.replace(/[^a-z]/gi, '').toUpperCase() }} /></label></div>
              <label>Complemento<input name="addressComplement" /></label>
              {error && <span className="field-error">{error}</span>}
              <div className="registration-actions"><button type="button" className="secondary-button" onClick={() => { setStep('lookup'); setError('') }}>Voltar</button><button className="checkout-button" disabled={loading}>{loading ? <LoaderCircle className="spin" /> : <>Criar acesso <ArrowRight size={19} /></>}</button></div>
            </form>
          </>}

          {step === 'found' && customer && <div className="account-success"><span><Check /></span><h2>Acesso confirmado!</h2><p>Bem-vindo(a), <strong>{customer.tradeName || customer.legalName}</strong>.</p><div className="customer-summary"><span>{customer.email}</span>{customer.city && <span>{customer.city}{customer.state ? ` · ${customer.state}` : ''}</span>}</div><a className="checkout-button" href="/">Ir para a loja <ArrowRight size={19} /></a></div>}
        </div>
      </section>
    </main>
  )
}
