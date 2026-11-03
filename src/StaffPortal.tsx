import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, CheckSquare, ClipboardCheck, ImageOff, ImagePlus, LayoutDashboard, LoaderCircle, LogOut, PackageCheck, Plus, Save, Search, ShieldCheck, Tag, Trash2, Users } from 'lucide-react'
import { money } from './data'
import { orderStatusLabel } from './orderStatus'
import type { Banner, CatalogCategory, CatalogSupplier, Order, StaffCatalogProduct, StaffUser } from './types'
import { formatDocument, formatPhone } from './validation'

type Tab = 'orders' | 'banners' | 'categories' | 'users'

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

function normalizeSearch(value: string) {
  return value.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

export default function StaffPortal() {
  const [user, setUser] = useState<StaffUser | null>(null)
  const [ready, setReady] = useState(false)
  const [tab, setTab] = useState<Tab>('orders')
  const [orders, setOrders] = useState<Order[]>([])
  const [banners, setBanners] = useState<Banner[]>([])
  const [users, setUsers] = useState<StaffUser[]>([])
  const [categories, setCategories] = useState<CatalogCategory[]>([])
  const [catalogProducts, setCatalogProducts] = useState<StaffCatalogProduct[]>([])
  const [suppliers, setSuppliers] = useState<CatalogSupplier[]>([])
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null)
  const [selectedProductIds, setSelectedProductIds] = useState<Set<number>>(new Set())
  const [productSearch, setProductSearch] = useState('')
  const [supplierFilter, setSupplierFilter] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!notice) return undefined
    const timeout = window.setTimeout(() => setNotice(''), 5000)
    return () => window.clearTimeout(timeout)
  }, [notice])

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
      api<{ categories: CatalogCategory[] }>('/api/staff/categories').then((data) => {
        setCategories(data.categories)
        if (data.categories.length) {
          setSelectedCategoryId((current) => current ?? data.categories[0].id)
          setSelectedProductIds((current) => current.size ? current : new Set(data.categories[0].productIds || []))
        }
      }),
      api<{ products: StaffCatalogProduct[]; suppliers: CatalogSupplier[] }>('/api/staff/catalog-products').then((data) => {
        setCatalogProducts(data.products); setSuppliers(data.suppliers)
      }),
      user.role === 'ADMIN' ? api<{ users: StaffUser[] }>('/api/staff/users').then((data) => setUsers(data.users)) : Promise.resolve(),
    ]).catch((requestError) => setError(requestError.message))
  }, [user])

  const filteredCatalogProducts = useMemo(() => {
    const search = normalizeSearch(productSearch.trim())
    const tokens = search.split(/[\s,;]+/).filter(Boolean)
    const multipleCodes = tokens.length > 1 && tokens.every((token) => /^\d+$/.test(token))
    return catalogProducts.filter((product) => {
      const matchesSupplier = !supplierFilter || String(product.supplierId) === supplierFilter
      const text = normalizeSearch(`${product.code} ${product.name} ${product.brand} ${product.package}`)
      const matchesSearch = !tokens.length || (multipleCodes ? tokens.some((token) => String(product.code).includes(token)) : tokens.every((token) => text.includes(token)))
      return matchesSupplier && matchesSearch
    })
  }, [catalogProducts, productSearch, supplierFilter])

  const selectedCategory = categories.find((category) => category.id === selectedCategoryId)

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true); setError(''); setNotice('')
    const form = new FormData(event.currentTarget)
    try {
      const data = await api<{ user: StaffUser }>('/api/staff/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
      })
      setTab('orders')
      setUser(data.user)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível entrar.') }
    finally { setLoading(false) }
  }

  async function logout() {
    try {
      await fetch('/api/staff/auth/logout', { method: 'POST' })
    } finally {
      setUser(null); setOrders([]); setBanners([]); setUsers([]); setCategories([]); setCatalogProducts([])
      setTab('orders'); setError(''); setNotice('')
    }
  }

  function changeTab(nextTab: Tab) {
    setTab(nextTab)
    setError('')
    setNotice('')
  }

  async function saveBanner(event: React.FormEvent<HTMLFormElement>, banner?: Banner) {
    event.preventDefault()
    setLoading(true); setError(''); setNotice('')
    const formElement = event.currentTarget
    const form = new FormData(formElement)
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
      if (!banner) formElement.reset()
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível salvar o banner.') }
    finally { setLoading(false) }
  }

  async function createUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true); setError(''); setNotice('')
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    try {
      await api('/api/staff/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.get('name'), email: form.get('email'), password: form.get('password'), role: form.get('role') }),
      })
      const data = await api<{ users: StaffUser[] }>('/api/staff/users')
      setUsers(data.users); setNotice('Usuário criado com sucesso.'); formElement.reset()
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível criar o usuário.') }
    finally { setLoading(false) }
  }

  function selectCategory(category: CatalogCategory) {
    setSelectedCategoryId(category.id)
    setSelectedProductIds(new Set(category.productIds || []))
    setProductSearch('')
    setSupplierFilter('')
    setError(''); setNotice('')
  }

  async function refreshCategories(preferredId?: number) {
    const data = await api<{ categories: CatalogCategory[] }>('/api/staff/categories')
    setCategories(data.categories)
    const next = data.categories.find((category) => category.id === (preferredId ?? selectedCategoryId)) || data.categories[0]
    if (next) {
      setSelectedCategoryId(next.id)
      setSelectedProductIds(new Set(next.productIds || []))
    } else {
      setSelectedCategoryId(null); setSelectedProductIds(new Set())
    }
  }

  async function createCategory(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoading(true); setError(''); setNotice('')
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    try {
      const data = await api<{ category: CatalogCategory }>('/api/staff/categories', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.get('name') }),
      })
      await refreshCategories(data.category.id)
      setNotice(`Categoria “${data.category.name}” criada.`); formElement.reset()
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível criar a categoria.') }
    finally { setLoading(false) }
  }

  async function deleteCategory(category: CatalogCategory) {
    if (!window.confirm(`Excluir a categoria “${category.name}”? Os produtos não serão excluídos.`)) return
    setLoading(true); setError(''); setNotice('')
    try {
      await api(`/api/staff/categories/${category.id}`, { method: 'DELETE' })
      await refreshCategories()
      setNotice('Categoria excluída. Os produtos continuam no catálogo.')
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível excluir a categoria.') }
    finally { setLoading(false) }
  }

  function toggleProduct(productId: number) {
    setSelectedProductIds((current) => {
      const next = new Set(current)
      if (next.has(productId)) next.delete(productId); else next.add(productId)
      return next
    })
  }

  function toggleVisibleProducts() {
    const visibleIds = filteredCatalogProducts.map((product) => product.id)
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedProductIds.has(id))
    setSelectedProductIds((current) => {
      const next = new Set(current)
      for (const id of visibleIds) allSelected ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function saveCategoryProducts() {
    if (!selectedCategoryId) return
    setLoading(true); setError(''); setNotice('')
    try {
      await api(`/api/staff/categories/${selectedCategoryId}/products`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: [...selectedProductIds] }),
      })
      await refreshCategories(selectedCategoryId)
      setNotice(`${selectedProductIds.size} produtos salvos em “${selectedCategory?.name}”.`)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível salvar a categoria.') }
    finally { setLoading(false) }
  }

  async function linkWinthorOrder(event: React.FormEvent<HTMLFormElement>, order: Order) {
    event.preventDefault(); setLoading(true); setError(''); setNotice('')
    const form = new FormData(event.currentTarget)
    try {
      const data = await api<{ order: Order }>(`/api/staff/orders/${order.id}/winthor`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ winthorOrderNumber: form.get('winthorOrderNumber') }),
      })
      setOrders((current) => current.map((item) => item.id === order.id ? data.order : item))
      setNotice(`${order.number} liberado e vinculado ao NUMPED ${data.order.winthorOrderNumber}.`)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível vincular o pedido ao WinThor.') }
    finally { setLoading(false) }
  }

  if (!ready) return <main className="staff-loading"><LoaderCircle className="spin" /></main>
  if (!user) return <main className="staff-login"><a href="/" className="account-back"><ArrowLeft size={18} /> Voltar para a loja</a><form onSubmit={login}><img src="/assets/omega-logo.png" alt="Ômega Distribuidora" /><span className="staff-login-icon"><ShieldCheck /></span><h1>Gestão do e-Commerce</h1><p>Acesso exclusivo para Administradores e equipe Comercial.</p><label>E-mail<input name="email" type="email" autoComplete="username" required /></label><label>Senha<input name="password" type="password" autoComplete="current-password" required /></label>{error && <span className="field-error">{error}</span>}<button className="checkout-button" disabled={loading}>{loading ? <LoaderCircle className="spin" /> : 'Entrar'}</button></form></main>

  return <div className="staff-shell">
    <aside className="staff-sidebar"><a href="/"><img src="/assets/omega-logo.png" alt="Ômega Distribuidora" /></a><div className="staff-identity"><strong>{user.name}</strong><span>{user.role === 'ADMIN' ? 'Administrador' : 'Comercial'}</span></div><nav><button className={tab === 'orders' ? 'active' : ''} onClick={() => changeTab('orders')}><PackageCheck /> Pedidos</button><button className={tab === 'categories' ? 'active' : ''} onClick={() => changeTab('categories')}><Tag /> Categorias</button><button className={tab === 'banners' ? 'active' : ''} onClick={() => changeTab('banners')}><ImagePlus /> Banners</button>{user.role === 'ADMIN' && <button className={tab === 'users' ? 'active' : ''} onClick={() => changeTab('users')}><Users /> Usuários</button>}</nav><button className="staff-logout" onClick={logout}><LogOut /> Sair</button></aside>
    <main className="staff-main"><header><div><span className="eyebrow">PAINEL INTERNO</span><h1>{tab === 'orders' ? 'Pedidos do e-Commerce' : tab === 'categories' ? 'Categorias de produtos' : tab === 'banners' ? 'Banners da loja' : 'Usuários internos'}</h1></div><span className="staff-role"><LayoutDashboard /> {user.role}</span></header>{error && <div className="staff-alert error">{error}</div>}{notice && <div className="staff-alert success">{notice}</div>}
      {tab === 'orders' && <section className="staff-orders">{orders.length ? orders.map((order) => <StaffOrderCard key={order.id} order={order} loading={loading} onLink={linkWinthorOrder} />) : <div className="staff-empty">Nenhum pedido recebido até agora.</div>}</section>}
      {tab === 'categories' && <section className="category-manager"><aside className="category-manager-list"><form onSubmit={createCategory}><input name="name" placeholder="Nova categoria" required minLength={2} maxLength={80} /><button disabled={loading} aria-label="Criar categoria"><Plus /></button></form><div>{categories.map((category) => <button key={category.id} className={selectedCategoryId === category.id ? 'active' : ''} onClick={() => selectCategory(category)}><span><Tag /><b>{category.name}</b><small>{category.productIds?.length || 0} produtos</small></span><i role="button" tabIndex={0} aria-label={`Excluir ${category.name}`} onClick={(event) => { event.stopPropagation(); deleteCategory(category) }} onKeyDown={(event) => { if (event.key === 'Enter') deleteCategory(category) }}><Trash2 /></i></button>)}</div></aside><div className="category-product-picker">{selectedCategory ? <><div className="category-picker-heading"><div><span className="eyebrow">EDITANDO CATEGORIA</span><h2>{selectedCategory.name}</h2><p>Pesquise e marque todos os produtos que devem aparecer nesta categoria.</p></div><strong>{selectedProductIds.size} selecionados</strong></div><div className="category-product-filters"><label><Search /><input value={productSearch} onChange={(event) => setProductSearch(event.target.value)} placeholder="Nome, EAN, marca ou códigos separados por vírgula" /></label><select value={supplierFilter} onChange={(event) => setSupplierFilter(event.target.value)}><option value="">Todos os fornecedores</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name} ({supplier.productCount})</option>)}</select><button onClick={toggleVisibleProducts}><CheckSquare /> {filteredCatalogProducts.length && filteredCatalogProducts.every((product) => selectedProductIds.has(product.id)) ? 'Desmarcar resultados' : 'Marcar resultados'}</button></div><div className="category-results-summary"><span>{filteredCatalogProducts.length} produtos encontrados</span><span>A seleção é mantida ao trocar a busca ou fornecedor.</span></div><div className="category-product-list">{filteredCatalogProducts.map((product) => <label key={product.id} className={selectedProductIds.has(product.id) ? 'selected' : ''}><input type="checkbox" checked={selectedProductIds.has(product.id)} onChange={() => toggleProduct(product.id)} />{product.image ? <img src={product.image} alt="" /> : <span className="category-no-image"><ImageOff /></span>}<span><b>{product.name}</b><small>Cód. {product.code} · {product.brand}</small><small>{product.package} · {product.unitsPerBox} un./caixa</small></span></label>)}</div><div className="category-save-bar"><span>{selectedProductIds.size} produtos nesta categoria</span><button className="primary-button" onClick={saveCategoryProducts} disabled={loading}>{loading ? <LoaderCircle className="spin" /> : <><Save /> Salvar categoria</>}</button></div></> : <div className="staff-empty">Crie uma categoria para começar a selecionar produtos.</div>}</div></section>}
      {tab === 'banners' && <section><div className="staff-section-heading"><h2>Banners cadastrados</h2><span>PNG, JPG ou WEBP · máximo 5 MB</span></div><div className="banner-admin-grid">{banners.map((banner) => <BannerForm key={banner.id} banner={banner} onSave={saveBanner} loading={loading} />)}<BannerForm onSave={saveBanner} loading={loading} /></div></section>}
      {tab === 'users' && user.role === 'ADMIN' && <section className="users-admin"><form className="staff-form create-user-form" onSubmit={createUser}><h2><Plus /> Novo usuário</h2><label>Nome<input name="name" required minLength={3} /></label><label>E-mail<input name="email" type="email" required /></label><label>Senha inicial<input name="password" type="password" minLength={8} required /></label><label>Perfil<select name="role" defaultValue="COMERCIAL"><option value="COMERCIAL">Comercial</option><option value="ADMIN">Administrador</option></select></label><button className="primary-button" disabled={loading}>Criar usuário</button></form><div className="staff-user-list">{users.map((item) => <article key={item.id}><span>{item.name.slice(0, 1).toUpperCase()}</span><div><strong>{item.name}</strong><small>{item.email}</small></div><b>{item.role}</b></article>)}</div></section>}
    </main>
  </div>
}

function StaffOrderCard({ order, loading, onLink }: { order: Order; loading: boolean; onLink: (event: React.FormEvent<HTMLFormElement>, order: Order) => void }) {
  return <details className="staff-order"><summary><div><strong>{order.number}</strong><span>{order.customer.tradeName || order.customer.legalName}</span></div><div><span>{new Date(order.createdAt).toLocaleString('pt-BR')}</span><strong>{money.format(order.total)}</strong><b className={`order-status ${order.status}`}>{orderStatusLabel(order.status)}</b></div></summary><div className="order-detail-grid"><p><b>Cliente</b>{formatDocument(order.customer.document)}<br />{order.customer.email}<br />{formatPhone(order.customer.phone)}</p><p><b>Pagamento</b>{paymentLabel(order.paymentPlan)}<br /><b>Status para o cliente</b>{orderStatusLabel(order.status)}{order.winthorStatusLabel && <><b>Status real no WinThor</b>{order.winthorStatusLabel}{order.winthorStatusCode && ` (${order.winthorStatusCode})`}</>}{order.statusUpdatedAt && <small>Consultado em {new Date(order.statusUpdatedAt).toLocaleString('pt-BR')}</small>}</p><div className="winthor-order-box"><b>Liberação do pedido</b><form onSubmit={(event) => onLink(event, order)}><input name="winthorOrderNumber" inputMode="numeric" pattern="[0-9]+" defaultValue={order.winthorOrderNumber ?? ''} placeholder="Informe o NUMPED" required /><button disabled={loading}>{loading ? <LoaderCircle className="spin" /> : <><ClipboardCheck /> {order.winthorOrderNumber ? 'Atualizar NUMPED' : 'Liberar pedido'}</>}</button></form>{order.winthorOrderNumber && <small>NUMPED {order.winthorOrderNumber}{order.enteredBy ? ` · por ${order.enteredBy}` : ''}{order.enteredAt ? ` em ${new Date(order.enteredAt).toLocaleString('pt-BR')}` : ''}</small>}</div>{order.notes && <p><b>Observações</b>{order.notes}</p>}</div><div className="order-lines">{order.items.map((item) => <div key={item.id}><span>{item.code} · {item.name}</span><span>{item.boxes} cx. · {item.unitsPerBox} un./cx.</span><strong>{money.format(item.lineTotal)}</strong></div>)}</div></details>
}

function BannerForm({ banner, onSave, loading }: { banner?: Banner; onSave: (event: React.FormEvent<HTMLFormElement>, banner?: Banner) => void; loading: boolean }) {
  return <form className="staff-form banner-form" onSubmit={(event) => onSave(event, banner)}>{banner ? <img src={banner.imageUrl} alt={banner.altText} /> : <div className="new-banner-placeholder"><ImagePlus /><span>Novo banner</span></div>}<h3>{banner ? banner.title : 'Adicionar banner'}</h3><label>Título<input name="title" defaultValue={banner?.title} required /></label><label>Texto alternativo<input name="altText" defaultValue={banner?.altText} required /></label><div className="staff-form-row"><label>Posição<input name="position" type="number" min="0" defaultValue={banner?.position ?? 10} required /></label><label>Destino<input name="targetUrl" defaultValue={banner?.targetUrl ?? '#produtos'} required /></label></div><label>Imagem{banner && <small>Deixe vazio para manter a atual</small>}<input name="image" type="file" accept="image/png,image/jpeg,image/webp" required={!banner} /></label><label className="staff-check"><input name="active" type="checkbox" defaultChecked={banner?.active ?? true} /> Exibir na loja</label><button className="secondary-button" disabled={loading}><Save /> Salvar banner</button></form>
}
