import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, CircleUserRound, KeyRound, LoaderCircle, LockKeyhole, Mail, RefreshCw, Search, ShieldCheck } from 'lucide-react'
import { authenticatedFetch, responseJson } from './api'
import { supabase, supabaseConfigured } from './supabase'
import type { Customer } from './types'
import { formatDocument, formatPhone, formatPostalCode, isValidDocument, onlyDigits } from './validation'

type Step = 'login' | 'lookup' | 'register' | 'confirm' | 'forgot' | 'reset' | 'found'
type Profile = Record<string, string>
type LinkResponse = { accountType: 'customer'; customer: Customer } | { accountType: 'staff'; user: { name: string } }

const pendingKey = 'omega-pending-registration'

function authMessage(message: string) {
  const normalized = message.toLowerCase()
  if (normalized.includes('invalid login credentials')) return 'E-mail ou senha incorretos.'
  if (normalized.includes('email not confirmed')) return 'Confirme seu e-mail com o código enviado antes de entrar.'
  if (normalized.includes('user already registered')) return 'Este e-mail já possui uma conta. Entre ou recupere sua senha.'
  if (normalized.includes('expired')) return 'O código expirou. Solicite um novo código.'
  if (normalized.includes('invalid') && normalized.includes('token')) return 'Código inválido. Confira os 6 dígitos e tente novamente.'
  if (normalized.includes('rate limit') || normalized.includes('security purposes')) return 'Muitas tentativas. Aguarde um pouco antes de tentar novamente.'
  if (normalized.includes('weak password') || normalized.includes('password should')) return 'Use ao menos 8 caracteres, com maiúscula, minúscula e número.'
  return message || 'Não foi possível concluir a autenticação.'
}

function readPendingProfile(): Profile | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey) || 'null')
    return value && typeof value === 'object' ? value : null
  } catch { return null }
}

export default function AccountPage() {
  const [step, setStep] = useState<Step>(new URLSearchParams(window.location.search).get('mode') === 'reset' ? 'reset' : 'login')
  const [document, setDocument] = useState('')
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [locatedCustomer, setLocatedCustomer] = useState<Customer | null>(null)
  const [confirmationEmail, setConfirmationEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [resendSeconds, setResendSeconds] = useState(0)
  const documentType = useMemo(() => onlyDigits(document).length > 11 ? 'CNPJ' : 'CPF', [document])

  useEffect(() => {
    if (resendSeconds <= 0) return
    const timer = window.setInterval(() => setResendSeconds((value) => Math.max(0, value - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [resendSeconds])

  useEffect(() => {
    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setStep('reset')
    })
    if (step !== 'reset') {
      supabase.auth.getSession().then(({ data }) => { if (data.session) void finishLink() })
    }
    return () => listener.subscription.unsubscribe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function finishLink(profile?: Profile) {
    const response = await authenticatedFetch('/api/auth/link', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile ? { profile } : {}),
    })
    const data = await responseJson<LinkResponse & { message?: string; code?: string }>(response)
    if (!response.ok) {
      if (data.code === 'PROFILE_REQUIRED') {
        setStep('lookup'); setNotice('Confirme seu CPF ou CNPJ para concluir a vinculação desta conta.'); return null
      }
      throw new Error(data.message || 'Não foi possível vincular sua conta ao cadastro da Ômega.')
    }
    sessionStorage.removeItem(pendingKey)
    if (data.accountType === 'staff') { window.location.href = '/gestao'; return null }
    setCustomer(data.customer); setStep('found'); return data.customer
  }

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setNotice(''); setLoading(true)
    const form = new FormData(event.currentTarget)
    try {
      if (!supabaseConfigured) throw new Error('A autenticação ainda não está configurada neste ambiente.')
      const { error: signInError } = await supabase.auth.signInWithPassword({ email: String(form.get('email')).trim(), password: String(form.get('password')) })
      if (signInError) throw signInError
      await finishLink()
    } catch (requestError) { setError(authMessage(requestError instanceof Error ? requestError.message : 'Não foi possível entrar.')) }
    finally { setLoading(false) }
  }

  async function lookup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setNotice('')
    if (!isValidDocument(document)) { setError('Digite um CPF ou CNPJ válido para continuar.'); return }
    setLoading(true)
    try {
      const response = await fetch('/api/customers/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document }) })
      const data = await responseJson<{ found: boolean; hasAccess?: boolean; customer?: Customer; message?: string }>(response)
      if (!response.ok) throw new Error(data.message)
      if (data.found && data.hasAccess) { setStep('login'); setNotice('Este cliente já possui acesso. Entre com o e-mail e a senha cadastrados.') }
      else { setLocatedCustomer(data.customer ?? null); setStep('register') }
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível consultar o cadastro.') }
    finally { setLoading(false) }
  }

  async function register(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setNotice('')
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password'))
    if (password !== form.get('confirmPassword')) { setError('A confirmação da senha não confere.'); return }
    if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/.test(password)) { setError('Use ao menos 8 caracteres, com maiúscula, minúscula e número.'); return }
    const profile = Object.fromEntries([...form.entries()].filter(([key]) => !['password', 'confirmPassword'].includes(key)).map(([key, value]) => [key, String(value)]))
    const email = String(form.get('email')).trim().toLowerCase()
    sessionStorage.setItem(pendingKey, JSON.stringify(profile)); setLoading(true)
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      if (sessionData.session) { await finishLink(profile); return }
      const { data, error: signUpError } = await supabase.auth.signUp({ email, password, options: { data: { document: onlyDigits(document) } } })
      if (signUpError) throw signUpError
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) throw new Error('Este e-mail já possui uma conta. Entre ou recupere sua senha.')
      setConfirmationEmail(email); setResendSeconds(60)
      if (data.session) await finishLink(profile); else setStep('confirm')
    } catch (requestError) { setError(authMessage(requestError instanceof Error ? requestError.message : 'Não foi possível concluir o cadastro.')) }
    finally { setLoading(false) }
  }

  async function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setLoading(true)
    const token = onlyDigits(String(new FormData(event.currentTarget).get('token') || '')).slice(0, 6)
    try {
      if (token.length !== 6) throw new Error('Digite os 6 dígitos enviados ao seu e-mail.')
      const { error: verifyError } = await supabase.auth.verifyOtp({ email: confirmationEmail, token, type: 'signup' })
      if (verifyError) throw verifyError
      await finishLink(readPendingProfile() ?? undefined)
    } catch (requestError) { setError(authMessage(requestError instanceof Error ? requestError.message : 'Código inválido.')) }
    finally { setLoading(false) }
  }

  async function resendCode() {
    if (resendSeconds > 0 || !confirmationEmail) return
    setError(''); setLoading(true)
    try {
      const { error: resendError } = await supabase.auth.resend({ type: 'signup', email: confirmationEmail })
      if (resendError) throw resendError
      setResendSeconds(60); setNotice('Enviamos um novo código. Verifique sua caixa de entrada e o spam.')
    } catch (requestError) { setError(authMessage(requestError instanceof Error ? requestError.message : 'Não foi possível reenviar o código.')) }
    finally { setLoading(false) }
  }

  async function requestRecovery(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setNotice(''); setLoading(true)
    const email = String(new FormData(event.currentTarget).get('email')).trim()
    try {
      const { error: recoveryError } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/conta?mode=reset` })
      if (recoveryError) throw recoveryError
      setNotice('Se o e-mail estiver cadastrado, você receberá as instruções para redefinir a senha.')
    } catch (requestError) { setError(authMessage(requestError instanceof Error ? requestError.message : 'Não foi possível solicitar a recuperação.')) }
    finally { setLoading(false) }
  }

  async function resetPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setLoading(true)
    const form = new FormData(event.currentTarget); const password = String(form.get('password'))
    if (password !== form.get('confirmPassword')) { setError('A confirmação da senha não confere.'); setLoading(false); return }
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password })
      if (updateError) throw updateError
      setNotice('Senha redefinida com sucesso.'); await finishLink()
    } catch (requestError) { setError(authMessage(requestError instanceof Error ? requestError.message : 'Não foi possível redefinir a senha.')) }
    finally { setLoading(false) }
  }

  return <main className="account-page">
    <header className="account-header container"><a href="/" className="account-back"><ArrowLeft size={18} /> Voltar para a loja</a><a href="/" aria-label="Página inicial"><img src="/assets/omega-logo.png" alt="Ômega Distribuidora" /></a><span className="secure-label"><LockKeyhole size={16} /> Ambiente seguro</span></header>
    <section className="account-layout container">
      <div className="account-aside"><span className="eyebrow">ÁREA DO CLIENTE</span><h1>Seu negócio,<br />mais perto da Ômega.</h1><div className="account-benefits"><span><ShieldCheck /> Autenticação protegida</span><span><Mail /> Confirmação por e-mail</span></div></div>
      <div className="account-card">
        {step === 'login' && <><span className="account-card-icon"><CircleUserRound /></span><h2>Entrar na sua conta</h2><p>Use seu e-mail e sua senha para consultar preços e fazer pedidos.</p>{notice && <div className="form-notice">{notice}</div>}<form onSubmit={login}><label>E-mail<div className="login-field"><Mail size={18} /><input name="email" type="email" autoComplete="email" required /></div></label><label>Senha<div className="login-field"><KeyRound size={18} /><input name="password" type="password" autoComplete="current-password" required /></div></label>{error && <span className="field-error">{error}</span>}<button type="button" className="account-link-button account-forgot" onClick={() => { setStep('forgot'); setError(''); setNotice('') }}>Esqueci minha senha</button><button className="checkout-button" disabled={loading}>{loading ? <LoaderCircle className="spin" /> : <>Entrar <ArrowRight size={19} /></>}</button><button type="button" className="account-link-button" onClick={() => { setStep('lookup'); setError(''); setNotice('') }}>Primeiro acesso ou novo cadastro</button></form></>}
        {step === 'lookup' && <><span className="account-card-icon"><Search /></span><h2>Identifique o cliente</h2><p>Digite seu CPF ou CNPJ para localizar o cadastro antes de criar o acesso.</p>{notice && <div className="form-notice">{notice}</div>}<form onSubmit={lookup}><label>CPF ou CNPJ<div className={`document-field ${error ? 'invalid' : ''}`}><Search size={19} /><input autoFocus inputMode="numeric" value={document} onChange={(event) => { setDocument(formatDocument(event.target.value)); setError('') }} placeholder="000.000.000-00" /></div></label>{error && <span className="field-error">{error}</span>}<button className="checkout-button" disabled={loading}>{loading ? <LoaderCircle className="spin" /> : <>Continuar <ArrowRight size={19} /></>}</button><button type="button" className="account-link-button" onClick={() => setStep('login')}>Já tenho acesso</button></form></>}
        {step === 'register' && <><span className="eyebrow">CRIAR ACESSO · {documentType}</span><h2>Complete seus dados</h2><p>{locatedCustomer ? `Localizamos ${locatedCustomer.tradeName || locatedCustomer.legalName}. Confirme os dados e crie seu acesso.` : `Não localizamos ${formatDocument(document)}. Complete o cadastro.`}</p><form className="registration-form" onSubmit={register}><input type="hidden" name="document" value={onlyDigits(document)} /><label>{documentType === 'CNPJ' ? 'Razão social' : 'Nome completo'}<input name="legalName" minLength={3} defaultValue={locatedCustomer?.legalName} required /></label>{documentType === 'CNPJ' && <label>Nome fantasia<input name="tradeName" defaultValue={locatedCustomer?.tradeName} /></label>}<div className="form-row"><label>Telefone<input name="phone" inputMode="numeric" placeholder="(85) 99999-9999" defaultValue={locatedCustomer?.phone ? formatPhone(locatedCustomer.phone) : ''} onChange={(event) => { event.currentTarget.value = formatPhone(event.currentTarget.value) }} required /></label><label>E-mail<input name="email" type="email" autoComplete="email" defaultValue={locatedCustomer?.email} required /></label></div><div className="form-row"><label>Senha<input name="password" type="password" autoComplete="new-password" minLength={8} required /></label><label>Confirmar senha<input name="confirmPassword" type="password" autoComplete="new-password" minLength={8} required /></label></div><small className="password-help">Mínimo de 8 caracteres, com maiúscula, minúscula e número.</small><div className="form-row address-row"><label>CEP<input name="postalCode" inputMode="numeric" onChange={(event) => { event.currentTarget.value = formatPostalCode(event.currentTarget.value) }} /></label><label>Endereço<input name="addressLine" /></label><label>Número<input name="addressNumber" /></label></div><div className="form-row"><label>Bairro<input name="neighborhood" /></label><label>Cidade<input name="city" defaultValue={locatedCustomer?.city} /></label><label>UF<input name="state" maxLength={2} defaultValue={locatedCustomer?.state} onChange={(event) => { event.currentTarget.value = event.currentTarget.value.replace(/[^a-z]/gi, '').toUpperCase() }} /></label></div><label>Complemento<input name="addressComplement" /></label>{error && <span className="field-error">{error}</span>}<div className="registration-actions"><button type="button" className="secondary-button" onClick={() => setStep('lookup')}>Voltar</button><button className="checkout-button" disabled={loading}>{loading ? <LoaderCircle className="spin" /> : <>Enviar código <ArrowRight size={19} /></>}</button></div></form></>}
        {step === 'confirm' && <><span className="account-card-icon otp-icon"><Mail /></span><h2>Confirme seu e-mail</h2><p>Digite o código de 6 dígitos enviado para <strong>{confirmationEmail}</strong>.</p>{notice && <div className="form-notice">{notice}</div>}<form onSubmit={confirm}><label>Código de confirmação<input className="otp-input" name="token" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" autoFocus required onInput={(event) => { event.currentTarget.value = onlyDigits(event.currentTarget.value).slice(0, 6) }} /></label>{error && <span className="field-error">{error}</span>}<button className="checkout-button" disabled={loading}>{loading ? <LoaderCircle className="spin" /> : <>Confirmar e-mail <Check size={19} /></>}</button><button type="button" className="account-link-button otp-resend" disabled={loading || resendSeconds > 0} onClick={resendCode}><RefreshCw size={16} /> {resendSeconds > 0 ? `Reenviar em ${resendSeconds}s` : 'Reenviar código'}</button></form></>}
        {step === 'forgot' && <><span className="account-card-icon"><KeyRound /></span><h2>Recuperar senha</h2><p>Enviaremos um link seguro para você criar uma nova senha.</p>{notice && <div className="form-notice">{notice}</div>}<form onSubmit={requestRecovery}><label>E-mail<div className="login-field"><Mail size={18} /><input name="email" type="email" autoComplete="email" required /></div></label>{error && <span className="field-error">{error}</span>}<button className="checkout-button" disabled={loading}>{loading ? <LoaderCircle className="spin" /> : 'Enviar instruções'}</button><button type="button" className="account-link-button" onClick={() => { setStep('login'); setError(''); setNotice('') }}>Voltar para o login</button></form></>}
        {step === 'reset' && <><span className="account-card-icon"><KeyRound /></span><h2>Crie uma nova senha</h2><p>Use ao menos 8 caracteres, com maiúscula, minúscula e número.</p>{notice && <div className="form-notice">{notice}</div>}<form onSubmit={resetPassword}><label>Nova senha<input name="password" type="password" autoComplete="new-password" minLength={8} required /></label><label>Confirmar nova senha<input name="confirmPassword" type="password" autoComplete="new-password" minLength={8} required /></label>{error && <span className="field-error">{error}</span>}<button className="checkout-button" disabled={loading}>{loading ? <LoaderCircle className="spin" /> : 'Salvar nova senha'}</button></form></>}
        {step === 'found' && customer && <div className="account-success"><span><Check /></span><h2>Acesso confirmado!</h2><p>Bem-vindo(a), <strong>{customer.tradeName || customer.legalName}</strong>.</p><div className="customer-summary"><span>{customer.email}</span>{customer.city && <span>{customer.city}{customer.state ? ` · ${customer.state}` : ''}</span>}</div><a className="checkout-button" href="/">Ir para a loja <ArrowRight size={19} /></a></div>}
      </div>
    </section>
  </main>
}
