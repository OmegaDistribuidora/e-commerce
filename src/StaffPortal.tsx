import { useEffect, useState } from 'react'
import { ArrowLeft, ImagePlus, LayoutDashboard, LoaderCircle, LogOut, PackageCheck, Plus, Save, ShieldCheck, Users } from 'lucide-react'
import { money } from './data'
import type { Banner, Order, StaffUser } from './types'
import { formatDocument, formatPhone } from './validation'

type Tab = 'orders' | 'banners' | 'users'

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options)
  const body = await response.text()
  const data = body ? JSON.parse(body) : {}
  if (!response.ok) throw new Error(data.message || 'Não foi possível concluir a operação.')
  return data
}

function paymentLabel(value: string) {
  return ({ avista: 'À vista', '7_dias': '7 dias', '14_dias': '14 dias', '28_dias': '28 dias', '4_14_dias': '4/14 dias', '14_28_dias': '14/28 dias' } as Record<string, string>)[value] || value
}

export default function StaffPortal() {
  const [user, setUser] = useState<StaffUser | null>(null)
  const [ready, setReady] = useState(false)
  const [tab, setTab] = useState<Tab>('orders')
  const [orders, setOrders] = useState<Order[]>([])
  const [banners, setBanners] = useState<Banner[]>([])
  const [users, setUsers] = useState<StaffUser[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    api<{ user: StaffUser }>('/api/staff/auth/me')
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setReady(true))
  }, [])

  useEffect(() => {
    if (!user) return
    Promise.all([
      api<{ orders: Order[] }>('/api/staff/orders').then((data) => setOrders(data.orders)),
      api<{ banners: Banner[] }>('/api/staff/banners').then((data) => setBanners(data.banners)),
      user.role === 'ADMIN' ? api<{ users: StaffUser[] }>('/api/staff/users').then((data) => setUsers(data.users)) : Promise.resolve(),
    ]).catch((requestError) => setError(requestError.message))
  }, [user])

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true); setError('')
    const form = new FormData(event.currentTarget)
    try {
      const data = await api<{ user: StaffUser }>('/api/staff/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
      })
      setUser(data.user)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível entrar.') }
    finally { setLoading(false) }
  }

  async function logout() {
    await fetch('/api/staff/auth/logout', { method: 'POST' })
    setUser(null); setOrders([]); setBanners([]); setUsers([])
  }

  async function saveBanner(event: React.FormEvent<HTMLFormElement>, banner?: Banner) {
    event.preventDefault()
    setLoading(true); setError(''); setNotice('')
    const form = new FormData(event.currentTarget)
    const file = form.get('image') as File
    let imageDataUrl = ''
    if (file?.size) imageDataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file)
    })
    try {
      await api(banner ? `/api/staff/banners/${banner.id}` : '/api/staff/banners', {
        method: banner ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.get('title'), altText: form.get('altText'), targetUrl: form.get('targetUrl'),
          position: Number(form.get('position')), active: form.get('active') === 'on', imageDataUrl,
        }),
      })
      const data = await api<{ banners: Banner[] }>('/api/staff/banners')
      setBanners(data.banners); setNotice('Banner salvo com sucesso.')
      if (!banner) event.currentTarget.reset()
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível salvar o banner.') }
    finally { setLoading(false) }
  }

  async function createUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true); setError(''); setNotice('')
    const form = new FormData(event.currentTarget)
    try {
      await api('/api/staff/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.get('name'), email: form.get('email'), password: form.get('password'), role: form.get('role') }),
      })
      const data = await api<{ users: StaffUser[] }>('/api/staff/users')
      setUsers(data.users); setNotice('Usuário criado com sucesso.'); event.currentTarget.reset()
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível criar o usuário.') }
    finally { setLoading(false) }
  }

  if (!ready) return <main className="staff-loading"><LoaderCircle className="spin" /></main>
  if (!user) return <main className="staff-login"><a href="/" className="account-back"><ArrowLeft size={18} /> Voltar para a loja</a><form onSubmit={login}><img src="/assets/omega-logo.png" alt="Ômega Distribuidora" /><span className="staff-login-icon"><ShieldCheck /></span><h1>Gestão do e-Commerce</h1><p>Acesso exclusivo para Administradores e equipe Comercial.</p><label>E-mail<input name="email" type="email" autoComplete="username" required /></label><label>Senha<input name="password" type="password" autoComplete="current-password" required /></label>{error && <span className="field-error">{error}</span>}<button className="checkout-button" disabled={loading}>{loading ? <LoaderCircle className="spin" /> : 'Entrar'}</button></form></main>

  return <div className="staff-shell">
    <aside className="staff-sidebar"><a href="/"><img src="/assets/omega-logo.png" alt="Ômega Distribuidora" /></a><div className="staff-identity"><strong>{user.name}</strong><span>{user.role === 'ADMIN' ? 'Administrador' : 'Comercial'}</span></div><nav><button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}><PackageCheck /> Pedidos</button><button className={tab === 'banners' ? 'active' : ''} onClick={() => setTab('banners')}><ImagePlus /> Banners</button>{user.role === 'ADMIN' && <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}><Users /> Usuários</button>}</nav><button className="staff-logout" onClick={logout}><LogOut /> Sair</button></aside>
    <main className="staff-main"><header><div><span className="eyebrow">PAINEL INTERNO</span><h1>{tab === 'orders' ? 'Pedidos do e-Commerce' : tab === 'banners' ? 'Banners da loja' : 'Usuários internos'}</h1></div><span className="staff-role"><LayoutDashboard /> {user.role}</span></header>{error && <div className="staff-alert error">{error}</div>}{notice && <div className="staff-alert success">{notice}</div>}
      {tab === 'orders' && <section className="staff-orders">{orders.length ? orders.map((order) => <details className="staff-order" key={order.id}><summary><div><strong>{order.number}</strong><span>{order.customer.tradeName || order.customer.legalName}</span></div><div><span>{new Date(order.createdAt).toLocaleString('pt-BR')}</span><strong>{money.format(order.total)}</strong></div></summary><div className="order-detail-grid"><p><b>Cliente</b>{formatDocument(order.customer.document)}<br />{order.customer.email}<br />{formatPhone(order.customer.phone)}</p><p><b>Pagamento</b>{paymentLabel(order.paymentPlan)}<br /><b>Status</b>{order.status}</p>{order.notes && <p><b>Observações</b>{order.notes}</p>}</div><div className="order-lines">{order.items.map((item) => <div key={item.id}><span>{item.code} · {item.name}</span><span>{item.boxes} cx. · {item.unitsPerBox} un./cx.</span><strong>{money.format(item.lineTotal)}</strong></div>)}</div></details>) : <div className="staff-empty">Nenhum pedido recebido até agora.</div>}</section>}
      {tab === 'banners' && <section><div className="staff-section-heading"><h2>Banners cadastrados</h2><span>PNG, JPG ou WEBP · máximo 5 MB</span></div><div className="banner-admin-grid">{banners.map((banner) => <BannerForm key={banner.id} banner={banner} onSave={saveBanner} loading={loading} />)}<BannerForm onSave={saveBanner} loading={loading} /></div></section>}
      {tab === 'users' && user.role === 'ADMIN' && <section className="users-admin"><form className="staff-form create-user-form" onSubmit={createUser}><h2><Plus /> Novo usuário</h2><label>Nome<input name="name" required minLength={3} /></label><label>E-mail<input name="email" type="email" required /></label><label>Senha inicial<input name="password" type="password" minLength={8} required /></label><label>Perfil<select name="role" defaultValue="COMERCIAL"><option value="COMERCIAL">Comercial</option><option value="ADMIN">Administrador</option></select></label><button className="primary-button" disabled={loading}>Criar usuário</button></form><div className="staff-user-list">{users.map((item) => <article key={item.id}><span>{item.name.slice(0, 1).toUpperCase()}</span><div><strong>{item.name}</strong><small>{item.email}</small></div><b>{item.role}</b></article>)}</div></section>}
    </main>
  </div>
}

function BannerForm({ banner, onSave, loading }: { banner?: Banner; onSave: (event: React.FormEvent<HTMLFormElement>, banner?: Banner) => void; loading: boolean }) {
  return <form className="staff-form banner-form" onSubmit={(event) => onSave(event, banner)}>{banner ? <img src={banner.imageUrl} alt={banner.altText} /> : <div className="new-banner-placeholder"><ImagePlus /><span>Novo banner</span></div>}<h3>{banner ? banner.title : 'Adicionar banner'}</h3><label>Título<input name="title" defaultValue={banner?.title} required /></label><label>Texto alternativo<input name="altText" defaultValue={banner?.altText} required /></label><div className="staff-form-row"><label>Posição<input name="position" type="number" min="0" defaultValue={banner?.position ?? 10} required /></label><label>Destino<input name="targetUrl" defaultValue={banner?.targetUrl ?? '#produtos'} required /></label></div><label>Imagem{banner && <small>Deixe vazio para manter a atual</small>}<input name="image" type="file" accept="image/png,image/jpeg,image/webp" required={!banner} /></label><label className="staff-check"><input name="active" type="checkbox" defaultChecked={banner?.active ?? true} /> Exibir na loja</label><button className="secondary-button" disabled={loading}><Save /> Salvar banner</button></form>
}
