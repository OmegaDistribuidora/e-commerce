import { useEffect, useState } from 'react'
import { ArrowLeft, ChevronDown, KeyRound, LoaderCircle, MapPinHouse, PackageCheck, Save, Settings, ShoppingBag, UserRound } from 'lucide-react'
import { authenticatedFetch } from './api'
import { money } from './data'
import { orderStatusLabel } from './orderStatus'
import { supabase } from './supabase'
import type { Customer, Order } from './types'
import { formatDocument, formatPhone, formatPostalCode } from './validation'

type CustomerTab = 'orders' | 'profile' | 'security'

function paymentLabel(value: string) {
  return ({ avista: 'À vista', '7_dias': '7 dias', '14_dias': '14 dias', '28_dias': '28 dias', '4_14_dias': '4/14 dias', '14_28_dias': '14/28 dias' } as Record<string, string>)[value] || value
}

export default function OrdersPage() {
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [orders, setOrders] = useState<Order[]>([])
  const [tab, setTab] = useState<CustomerTab>('orders')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    Promise.all([authenticatedFetch('/api/auth/me'), authenticatedFetch('/api/orders')])
      .then(async ([authResponse, ordersResponse]) => {
        const auth = await authResponse.json()
        if (!authResponse.ok || auth.accountType !== 'customer') throw new Error(auth.message || 'Entre para consultar sua conta.')
        const orderData = await ordersResponse.json()
        if (!ordersResponse.ok) throw new Error(orderData.message)
        setCustomer(auth.customer); setOrders(orderData.orders)
      })
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false))
  }, [])

  function changeTab(nextTab: CustomerTab) {
    setTab(nextTab); setError(''); setNotice('')
  }

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(''); setNotice('')
    const form = new FormData(event.currentTarget)
    try {
      const response = await authenticatedFetch('/api/customer/profile', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          legalName: form.get('legalName'), tradeName: form.get('tradeName'), phone: form.get('phone'),
          postalCode: form.get('postalCode'), addressLine: form.get('addressLine'), addressNumber: form.get('addressNumber'),
          addressComplement: form.get('addressComplement'), neighborhood: form.get('neighborhood'),
          city: form.get('city'), state: form.get('state'),
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message)
      setCustomer(data.customer); setNotice('Dados atualizados com sucesso.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível atualizar os dados.')
    } finally { setSaving(false) }
  }

  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(''); setNotice('')
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const password = String(form.get('password'))
    if (password !== String(form.get('confirmPassword'))) {
      setError('A confirmação da senha não confere.'); setSaving(false); return
    }
    if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/.test(password)) {
      setError('Use ao menos 8 caracteres, com maiúscula, minúscula e número.'); setSaving(false); return
    }
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password })
      if (updateError) throw updateError
      formElement.reset(); setNotice('Senha alterada com sucesso.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível alterar a senha.')
    } finally { setSaving(false) }
  }

  return <main className="customer-orders-page">
    <header className="orders-page-header"><div className="container"><a href="/"><ArrowLeft /> Voltar para a loja</a><img src="/assets/omega-logo.png" alt="Ômega Distribuidora" /><span>{customer?.tradeName || customer?.legalName}</span></div></header>
    <section className="container customer-orders-content">
      <div className="customer-area-heading"><div><span className="eyebrow">ÁREA DO CLIENTE</span><h1>Minha conta</h1></div>{customer && <div className={`registration-chip ${customer.canOrder ? 'approved' : 'pending'}`}>{customer.canOrder ? <PackageCheck /> : <LoaderCircle />}<span><small>Status do cadastro</small><strong>{customer.canOrder ? 'Aprovado' : 'Em análise'}</strong></span></div>}</div>
      <nav className="customer-account-tabs" aria-label="Minha conta"><button className={tab === 'orders' ? 'active' : ''} onClick={() => changeTab('orders')}><ShoppingBag /> Meus pedidos</button><button className={tab === 'profile' ? 'active' : ''} onClick={() => changeTab('profile')}><Settings /> Dados e endereço</button><button className={tab === 'security' ? 'active' : ''} onClick={() => changeTab('security')}><KeyRound /> Segurança</button></nav>
      {customer && !customer.canOrder && <div className="pending-registration-notice"><LoaderCircle /><div><strong>Seu cadastro está em análise</strong><p>Você pode consultar produtos e preços, mas os pedidos serão liberados depois que a equipe Ômega validar seu CPF ou CNPJ no WinThor.</p></div></div>}
      {notice && <div className="staff-alert success">{notice}</div>}{error && <div className="staff-alert error">{error}</div>}
      {loading ? <div className="catalog-loading"><LoaderCircle className="spin" /> Carregando sua conta...</div> : customer && <>
        {tab === 'orders' && (orders.length ? <div className="customer-order-list">{orders.map((order) => <details key={order.id} className="customer-order-card"><summary><div><span>Pedido</span><strong>{order.number}</strong>{order.winthorOrderNumber && <small>WinThor {order.winthorOrderNumber}</small>}</div><div><span>Realizado em</span><strong>{new Date(order.createdAt).toLocaleString('pt-BR')}</strong></div><div><span>Total</span><strong>{money.format(order.total)}</strong></div><b className={`order-status ${order.status}`}>{orderStatusLabel(order.status)}</b><ChevronDown className="order-expand-icon" /></summary><div className="customer-order-details"><div className="customer-order-meta"><span><small>Pagamento</small><strong>{paymentLabel(order.paymentPlan)}</strong></span><span><small>Itens</small><strong>{order.items.length}</strong></span></div><div className="customer-order-lines">{order.items.map((item) => <div key={item.id}><span>{item.name}<small>Cód. {item.code} · {item.boxes} {item.boxes === 1 ? 'caixa' : 'caixas'} · {item.unitsPerBox} un./caixa</small></span><strong>{money.format(item.lineTotal)}</strong></div>)}</div>{order.notes && <p><b>Observações:</b> {order.notes}</p>}<footer><span>Total do pedido</span><strong>{money.format(order.total)}</strong></footer></div></details>)}</div> : <div className="empty-results"><PackageCheck /><h2>Você ainda não fez pedidos</h2><p>Quando seu primeiro pedido for enviado, ele aparecerá aqui.</p>{customer.canOrder && <a className="primary-button" href="/#produtos">Explorar produtos</a>}</div>)}
        {tab === 'profile' && <form className="customer-settings-card" onSubmit={saveProfile}><header><UserRound /><div><h2>Dados cadastrais e contato</h2><p>Mantenha seus dados atualizados para facilitar o atendimento e a entrega.</p></div></header><div className="settings-grid"><label>CPF ou CNPJ<input value={formatDocument(customer.document)} disabled /></label><label>E-mail de acesso<input value={customer.email} disabled /></label><label className="wide">{customer.personType === 'CNPJ' ? 'Razão social' : 'Nome completo'}<input name="legalName" defaultValue={customer.legalName} required minLength={3} /></label>{customer.personType === 'CNPJ' && <label className="wide">Nome fantasia<input name="tradeName" defaultValue={customer.tradeName} /></label>}<label>Telefone<input name="phone" inputMode="numeric" defaultValue={formatPhone(customer.phone)} onChange={(event) => { event.currentTarget.value = formatPhone(event.currentTarget.value) }} required /></label><label>Canal comercial<input value={customer.salesChannel} disabled /></label></div><header className="settings-section-title"><MapPinHouse /><div><h2>Endereço</h2><p>Endereço principal utilizado no cadastro.</p></div></header><div className="settings-grid address"><label>CEP<input name="postalCode" inputMode="numeric" defaultValue={formatPostalCode(customer.postalCode)} onChange={(event) => { event.currentTarget.value = formatPostalCode(event.currentTarget.value) }} required /></label><label className="wide">Endereço<input name="addressLine" defaultValue={customer.addressLine} required /></label><label>Número<input name="addressNumber" defaultValue={customer.addressNumber} required /></label><label>Complemento<input name="addressComplement" defaultValue={customer.addressComplement} /></label><label>Bairro<input name="neighborhood" defaultValue={customer.neighborhood} required /></label><label>Cidade<input name="city" defaultValue={customer.city} required /></label><label>UF<input name="state" defaultValue={customer.state} maxLength={2} onChange={(event) => { event.currentTarget.value = event.currentTarget.value.replace(/[^a-z]/gi, '').toUpperCase() }} required /></label></div><button className="primary-button settings-save" disabled={saving}>{saving ? <LoaderCircle className="spin" /> : <><Save /> Salvar alterações</>}</button></form>}
        {tab === 'security' && <form className="customer-settings-card security-card" onSubmit={changePassword}><header><KeyRound /><div><h2>Alterar senha</h2><p>A nova senha será atualizada no seu acesso seguro.</p></div></header><label>Nova senha<input name="password" type="password" autoComplete="new-password" minLength={8} required /></label><label>Confirmar nova senha<input name="confirmPassword" type="password" autoComplete="new-password" minLength={8} required /></label><small>Use ao menos 8 caracteres, com maiúscula, minúscula e número.</small><button className="primary-button settings-save" disabled={saving}>{saving ? <LoaderCircle className="spin" /> : <><KeyRound /> Alterar senha</>}</button></form>}
      </>}
    </section>
  </main>
}
