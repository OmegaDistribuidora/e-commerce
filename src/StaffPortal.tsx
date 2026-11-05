import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Camera, CheckSquare, ClipboardCheck, ImageOff, ImagePlus, KeyRound, LayoutDashboard, LoaderCircle, LogOut, PackageCheck, Plus, Save, Search, ShieldCheck, Tag, Trash2, UserCheck, Users } from 'lucide-react'
import { authenticatedFetch } from './api'
import { money } from './data'
import { formatCatalogName } from './catalog'
import { orderStatusLabel } from './orderStatus'
import { supabase } from './supabase'
import type { Banner, CatalogCategory, CatalogDepartment, CatalogSupplier, Customer, Order, StaffCatalogProduct, StaffUser } from './types'
import { formatDocument, formatPhone, formatPostalCode } from './validation'

type Tab = 'orders' | 'customers' | 'banners' | 'photos' | 'categories' | 'users' | 'settings'

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(url, options)
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

function toBrasiliaInput(value: string | null) {
  if (!value) return ''
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(value))
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

function fromBrasiliaInput(value: string) {
  return value ? new Date(`${value}:00-03:00`).toISOString() : null
}

async function productImageAsWebp(file: File) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Selecione uma imagem PNG, JPG ou WEBP.')
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('Não foi possível abrir esta imagem.'))
      element.src = objectUrl
    })
    const maxDimension = 1600
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Seu navegador não conseguiu processar a imagem.')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/webp', .84)
    if (!dataUrl.startsWith('data:image/webp')) throw new Error('Este navegador não oferece conversão para WEBP.')
    if ((dataUrl.length * 3) / 4 > 5 * 1024 * 1024) throw new Error('A imagem continua maior que 5 MB após a otimização.')
    return dataUrl
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export default function StaffPortal() {
  const [user, setUser] = useState<StaffUser | null>(null)
  const [ready, setReady] = useState(false)
  const [tab, setTab] = useState<Tab>('orders')
  const [orders, setOrders] = useState<Order[]>([])
  const [pendingCustomers, setPendingCustomers] = useState<Customer[]>([])
  const [banners, setBanners] = useState<Banner[]>([])
  const [catalogDepartments, setCatalogDepartments] = useState<CatalogDepartment[]>([])
  const [deletedBannerIds, setDeletedBannerIds] = useState<number[]>([])
  const [users, setUsers] = useState<StaffUser[]>([])
  const [categories, setCategories] = useState<CatalogCategory[]>([])
  const [catalogProducts, setCatalogProducts] = useState<StaffCatalogProduct[]>([])
  const [suppliers, setSuppliers] = useState<CatalogSupplier[]>([])
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null)
  const [selectedProductIds, setSelectedProductIds] = useState<Set<number>>(new Set())
  const [productSearch, setProductSearch] = useState('')
  const [supplierFilter, setSupplierFilter] = useState('')
  const [photoSearch, setPhotoSearch] = useState('')
  const [photoSupplierFilter, setPhotoSupplierFilter] = useState('')
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
      api<{ customers: Customer[] }>('/api/staff/customers?status=pending').then((data) => setPendingCustomers(data.customers)),
      api<{ banners: Banner[] }>('/api/staff/banners').then((data) => setBanners(data.banners)),
      api<{ departments: CatalogDepartment[] }>('/api/catalog/navigation').then((data) => setCatalogDepartments(data.departments)),
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
  const filteredPhotoProducts = useMemo(() => {
    const search = normalizeSearch(photoSearch.trim())
    return catalogProducts.filter((product) => {
      const matchesSupplier = !photoSupplierFilter || String(product.supplierId) === photoSupplierFilter
      const text = normalizeSearch(`${product.code} ${product.name} ${product.brand}`)
      return matchesSupplier && (!search || text.includes(search))
    })
  }, [catalogProducts, photoSearch, photoSupplierFilter])

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true); setError(''); setNotice('')
    const form = new FormData(event.currentTarget)
    try {
      const email = String(form.get('email'))
      const password = String(form.get('password'))
      const supabaseResult = await supabase.auth.signInWithPassword({ email, password })
      let data: { user: StaffUser }
      if (!supabaseResult.error) {
        await api('/api/auth/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        data = await api<{ user: StaffUser }>('/api/staff/auth/me')
      } else {
        // Compatibilidade temporária para as contas internas anteriores à migração.
        data = await api<{ user: StaffUser }>('/api/staff/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
        })
      }
      setTab('orders')
      setUser(data.user)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível entrar.') }
    finally { setLoading(false) }
  }

  async function logout() {
    try {
      await Promise.all([supabase.auth.signOut(), fetch('/api/staff/auth/logout', { method: 'POST' })])
    } finally {
      setUser(null); setOrders([]); setPendingCustomers([]); setBanners([]); setCatalogDepartments([]); setUsers([]); setCategories([]); setCatalogProducts([])
      setTab('orders'); setError(''); setNotice('')
    }
  }

  function changeTab(nextTab: Tab) {
    setTab(nextTab)
    setError('')
    setNotice('')
  }

  function updateBanner(id: number, values: Partial<Banner>) {
    setBanners((current) => current.map((banner) => banner.id === id ? { ...banner, ...values } : banner))
  }

  function addBanner() {
    setBanners((current) => [...current, {
      id: -Date.now(), title: '', altText: '', imageUrl: '', targetUrl: '#produtos',
      sectionCode: null, position: current.length + 1, active: true, placement: 'hero', startsAt: null, endsAt: null,
    }])
  }

  function deleteBanner(banner: Banner) {
    if (!window.confirm(`Excluir o banner “${banner.title || 'novo banner'}”? A exclusão será efetivada ao salvar.`)) return
    setBanners((current) => current.filter((item) => item.id !== banner.id))
    if (banner.id > 0) setDeletedBannerIds((current) => [...new Set([...current, banner.id])])
  }

  async function selectBannerImage(banner: Banner, file?: File) {
    if (!file?.size) return
    if (file.size > 5 * 1024 * 1024) { setError('A imagem deve ter no máximo 5 MB.'); return }
    const imageDataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file)
    })
    updateBanner(banner.id, { imageDataUrl, imageUrl: imageDataUrl })
  }

  async function saveBanners() {
    setLoading(true); setError(''); setNotice('')
    try {
      await api('/api/staff/banners', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ banners: banners.map((banner) => ({
          ...(banner.id > 0 ? { id: banner.id } : {}), title: banner.title, altText: banner.altText,
          targetUrl: banner.targetUrl, position: banner.position, active: banner.active,
          sectionCode: banner.sectionCode,
          placement: banner.placement, imageDataUrl: banner.imageDataUrl || '',
          startsAt: banner.startsAt, endsAt: banner.endsAt,
        })), deletedIds: deletedBannerIds }),
      })
      const data = await api<{ banners: Banner[] }>('/api/staff/banners')
      setBanners(data.banners); setDeletedBannerIds([]); setNotice('Todas as alterações dos banners foram salvas.')
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Não foi possível salvar os banners.') }
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

  async function uploadProductPhoto(product: StaffCatalogProduct, file?: File) {
    if (!file) return
    setLoading(true); setError(''); setNotice('')
    try {
      const imageDataUrl = await productImageAsWebp(file)
      const data = await api<{ image: string }>(`/api/staff/products/${product.id}/image`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageDataUrl }),
      })
      setCatalogProducts((current) => current.map((item) => item.id === product.id ? { ...item, image: data.image } : item))
      setNotice(`Foto do produto ${product.code} atualizada em WEBP.`)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível atualizar a foto.')
    } finally { setLoading(false) }
  }

  async function deleteProductPhoto(product: StaffCatalogProduct) {
    if (!product.image || !window.confirm(`Excluir a foto do produto ${product.code} · ${product.name}?`)) return
    setLoading(true); setError(''); setNotice('')
    try {
      await api(`/api/staff/products/${product.id}/image`, { method: 'DELETE' })
      setCatalogProducts((current) => current.map((item) => item.id === product.id ? { ...item, image: null } : item))
      setNotice(`Foto do produto ${product.code} excluída.`)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível excluir a foto.')
    } finally { setLoading(false) }
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

  async function approveCustomer(customer: Customer) {
    if (!window.confirm(`Aprovar o cadastro de ${customer.tradeName || customer.legalName}? O CPF/CNPJ será validado no WinThor.`)) return
    setLoading(true); setError(''); setNotice('')
    try {
      const data = await api<{ customer: Customer; winthorCustomer: { code: number } }>(`/api/staff/customers/${customer.id}/approve`, { method: 'POST' })
      setPendingCustomers((current) => current.filter((item) => item.id !== customer.id))
      setNotice(`${data.customer.tradeName || data.customer.legalName} aprovado com o código WinThor ${data.winthorCustomer.code}.`)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível aprovar o cadastro.')
    } finally { setLoading(false) }
  }

  async function changeStaffPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoading(true); setError(''); setNotice('')
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const newPassword = String(form.get('newPassword'))
    if (newPassword !== String(form.get('confirmPassword'))) {
      setError('A confirmação da senha não confere.'); setLoading(false); return
    }
    if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/.test(newPassword)) {
      setError('Use ao menos 8 caracteres, com maiúscula, minúscula e número.'); setLoading(false); return
    }
    try {
      if (user?.authProvider === 'supabase') {
        const { error: updateError } = await supabase.auth.updateUser({ password: newPassword })
        if (updateError) throw updateError
      } else {
        await api('/api/staff/password', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword: form.get('currentPassword'), newPassword }),
        })
      }
      formElement.reset(); setNotice('Senha alterada com sucesso.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível alterar a senha.')
    } finally { setLoading(false) }
  }

  if (!ready) return <main className="staff-loading"><LoaderCircle className="spin" /></main>
  if (!user) return <main className="staff-login"><a href="/" className="account-back"><ArrowLeft size={18} /> Voltar para a loja</a><form onSubmit={login}><img src="/assets/omega-logo.png" alt="Ômega Distribuidora" /><span className="staff-login-icon"><ShieldCheck /></span><h1>Gestão do e-Commerce</h1><p>Acesso exclusivo para Administradores e equipe Comercial.</p><label>E-mail<input name="email" type="email" autoComplete="username" required /></label><label>Senha<input name="password" type="password" autoComplete="current-password" required /></label>{error && <span className="field-error">{error}</span>}<button className="checkout-button" disabled={loading}>{loading ? <LoaderCircle className="spin" /> : 'Entrar'}</button></form></main>

  return <div className="staff-shell">
    <aside className="staff-sidebar"><a href="/"><img src="/assets/omega-logo.png" alt="Ômega Distribuidora" /></a><div className="staff-identity"><strong>{user.name}</strong><span>{user.role === 'ADMIN' ? 'Administrador' : 'Comercial'}</span></div><nav><button className={tab === 'orders' ? 'active' : ''} onClick={() => changeTab('orders')}><PackageCheck /> Pedidos</button><button className={tab === 'customers' ? 'active' : ''} onClick={() => changeTab('customers')}><UserCheck /> Clientes pendentes{pendingCustomers.length > 0 && <b className="nav-count">{pendingCustomers.length}</b>}</button><button className={tab === 'categories' ? 'active' : ''} onClick={() => changeTab('categories')}><Tag /> Categorias</button><button className={tab === 'photos' ? 'active' : ''} onClick={() => changeTab('photos')}><Camera /> Fotos dos produtos</button><button className={tab === 'banners' ? 'active' : ''} onClick={() => changeTab('banners')}><ImagePlus /> Banners</button>{user.role === 'ADMIN' && <button className={tab === 'users' ? 'active' : ''} onClick={() => changeTab('users')}><Users /> Usuários</button>}<button className={tab === 'settings' ? 'active' : ''} onClick={() => changeTab('settings')}><KeyRound /> Configurações</button></nav><button className="staff-logout" onClick={logout}><LogOut /> Sair</button></aside>
    <main className="staff-main"><header><div><span className="eyebrow">PAINEL INTERNO</span><h1>{({ orders: 'Pedidos do e-Commerce', customers: 'Clientes pendentes', categories: 'Categorias de produtos', photos: 'Fotos dos produtos', banners: 'Banners da loja', users: 'Usuários internos', settings: 'Configurações da conta' } as Record<Tab, string>)[tab]}</h1></div><span className="staff-role"><LayoutDashboard /> {user.role}</span></header>{error && <div className="staff-alert error">{error}</div>}{notice && <div className="staff-alert success">{notice}</div>}
      {tab === 'orders' && <section className="staff-orders">{orders.length ? orders.map((order) => <StaffOrderCard key={order.id} order={order} loading={loading} onLink={linkWinthorOrder} />) : <div className="staff-empty">Nenhum pedido recebido até agora.</div>}</section>}
      {tab === 'customers' && <section className="pending-customers">{pendingCustomers.length ? pendingCustomers.map((customer) => <article key={customer.id} className="pending-customer-card"><header><div className="pending-customer-avatar">{(customer.tradeName || customer.legalName).slice(0, 1).toUpperCase()}</div><div><span className="eyebrow">AGUARDANDO VALIDAÇÃO</span><h2>{customer.tradeName || customer.legalName}</h2><p>{customer.legalName}</p></div><span className="pending-date">Cadastrado em<br /><strong>{customer.createdAt ? new Date(customer.createdAt).toLocaleString('pt-BR') : '—'}</strong></span></header><div className="pending-customer-data"><p><b>CPF/CNPJ</b>{formatDocument(customer.document)}</p><p><b>Contato</b>{customer.email}<br />{formatPhone(customer.phone)}</p><p><b>Endereço</b>{customer.addressLine}, {customer.addressNumber}{customer.addressComplement ? ` · ${customer.addressComplement}` : ''}<br />{customer.neighborhood} · {customer.city}/{customer.state}<br />CEP {formatPostalCode(customer.postalCode)}</p></div><footer><span>A aprovação consultará este documento diretamente no WinThor e salvará o CODCLI encontrado.</span><button className="primary-button" disabled={loading} onClick={() => approveCustomer(customer)}>{loading ? <LoaderCircle className="spin" /> : <><UserCheck /> Validar e aprovar</>}</button></footer></article>) : <div className="staff-empty"><UserCheck /><h2>Nenhum cadastro pendente</h2><p>Novos clientes aguardando validação aparecerão aqui.</p></div>}</section>}
      {tab === 'categories' && <section className="category-manager"><aside className="category-manager-list"><form onSubmit={createCategory}><input name="name" placeholder="Nova categoria" required minLength={2} maxLength={80} /><button disabled={loading} aria-label="Criar categoria"><Plus /></button></form><div>{categories.map((category) => <button key={category.id} className={selectedCategoryId === category.id ? 'active' : ''} onClick={() => selectCategory(category)}><span><Tag /><b>{category.name}</b><small>{category.productIds?.length || 0} produtos</small></span><i role="button" tabIndex={0} aria-label={`Excluir ${category.name}`} onClick={(event) => { event.stopPropagation(); deleteCategory(category) }} onKeyDown={(event) => { if (event.key === 'Enter') deleteCategory(category) }}><Trash2 /></i></button>)}</div></aside><div className="category-product-picker">{selectedCategory ? <><div className="category-picker-heading"><div><span className="eyebrow">EDITANDO CATEGORIA</span><h2>{selectedCategory.name}</h2><p>Pesquise e marque todos os produtos que devem aparecer nesta categoria.</p></div><strong>{selectedProductIds.size} selecionados</strong></div><div className="category-product-filters"><label><Search /><input value={productSearch} onChange={(event) => setProductSearch(event.target.value)} placeholder="Nome, EAN, marca ou códigos separados por vírgula" /></label><select value={supplierFilter} onChange={(event) => setSupplierFilter(event.target.value)}><option value="">Todos os fornecedores</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name} ({supplier.productCount})</option>)}</select><button onClick={toggleVisibleProducts}><CheckSquare /> {filteredCatalogProducts.length && filteredCatalogProducts.every((product) => selectedProductIds.has(product.id)) ? 'Desmarcar resultados' : 'Marcar resultados'}</button></div><div className="category-results-summary"><span>{filteredCatalogProducts.length} produtos encontrados</span><span>A seleção é mantida ao trocar a busca ou fornecedor.</span></div><div className="category-product-list">{filteredCatalogProducts.map((product) => <label key={product.id} className={selectedProductIds.has(product.id) ? 'selected' : ''}><input type="checkbox" checked={selectedProductIds.has(product.id)} onChange={() => toggleProduct(product.id)} />{product.image ? <img src={product.image} alt="" /> : <span className="category-no-image"><ImageOff /></span>}<span><b>{product.name}</b><small>Cód. {product.code} · {product.brand}</small><small>{product.package} · {product.unitsPerBox} un./caixa</small></span></label>)}</div><div className="category-save-bar"><span>{selectedProductIds.size} produtos nesta categoria</span><button className="primary-button" onClick={saveCategoryProducts} disabled={loading}>{loading ? <LoaderCircle className="spin" /> : <><Save /> Salvar categoria</>}</button></div></> : <div className="staff-empty">Crie uma categoria para começar a selecionar produtos.</div>}</div></section>}
      {tab === 'photos' && <section className="product-photo-manager"><div className="staff-section-heading"><div><h2>Acervo de fotos</h2><span>Envios são otimizados em WEBP e ficam armazenados com segurança no banco.</span></div><strong>{catalogProducts.filter((product) => product.image).length} de {catalogProducts.length} produtos com foto</strong></div><div className="photo-manager-filters"><label><Search /><input value={photoSearch} onChange={(event) => setPhotoSearch(event.target.value)} placeholder="Buscar por código, produto ou fornecedor" /></label><select value={photoSupplierFilter} onChange={(event) => setPhotoSupplierFilter(event.target.value)}><option value="">Todos os fornecedores</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name} ({supplier.productCount})</option>)}</select></div><div className="photo-results-summary"><span>{filteredPhotoProducts.length} produtos encontrados</span>{filteredPhotoProducts.length > 200 && <span>Exibindo os primeiros 200. Use a busca para localizar outro produto.</span>}</div><div className="product-photo-grid">{filteredPhotoProducts.slice(0, 200).map((product) => <article key={product.id}><div className="product-photo-preview">{product.image ? <img src={product.image} alt={product.name} /> : <span><ImageOff /><b>Produto sem foto</b></span>}</div><div className="product-photo-info"><small>CÓD. {product.code} · {product.brand}</small><strong>{product.name}</strong></div><div className="product-photo-actions"><label className="secondary-button"><Camera /> {product.image ? 'Substituir' : 'Adicionar'}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={loading} onChange={(event) => { void uploadProductPhoto(product, event.target.files?.[0]); event.currentTarget.value = '' }} /></label>{product.image && <button className="photo-delete" disabled={loading} onClick={() => deleteProductPhoto(product)} aria-label={`Excluir foto de ${product.name}`}><Trash2 /> Excluir</button>}</div></article>)}</div></section>}
      {tab === 'banners' && <section><div className="staff-section-heading banner-manager-heading"><div><h2>Banners cadastrados</h2><span>Edite tudo o que precisar e salve as alterações de uma só vez. Horários em Brasília.</span></div><button className="secondary-button" onClick={addBanner}><Plus /> Adicionar banner</button></div><div className="banner-admin-grid">{banners.map((banner) => <BannerEditor key={banner.id} banner={banner} departments={catalogDepartments} onChange={updateBanner} onImage={selectBannerImage} onDelete={deleteBanner} />)}</div><div className="banner-save-all"><span>{banners.length} {banners.length === 1 ? 'banner configurado' : 'banners configurados'}{deletedBannerIds.length > 0 && ` · ${deletedBannerIds.length} aguardando exclusão`}</span><button className="primary-button" onClick={saveBanners} disabled={loading}>{loading ? <LoaderCircle className="spin" /> : <><Save /> Salvar todas as alterações</>}</button></div></section>}
      {tab === 'users' && user.role === 'ADMIN' && <section className="users-admin"><form className="staff-form create-user-form" onSubmit={createUser}><h2><Plus /> Novo usuário</h2><label>Nome<input name="name" required minLength={3} /></label><label>E-mail<input name="email" type="email" required /></label><label>Senha inicial<input name="password" type="password" minLength={8} required /></label><label>Perfil<select name="role" defaultValue="COMERCIAL"><option value="COMERCIAL">Comercial</option><option value="ADMIN">Administrador</option></select></label><button className="primary-button" disabled={loading}>Criar usuário</button></form><div className="staff-user-list">{users.map((item) => <article key={item.id}><span>{item.name.slice(0, 1).toUpperCase()}</span><div><strong>{item.name}</strong><small>{item.email}</small></div><b>{item.role}</b></article>)}</div></section>}
      {tab === 'settings' && <section className="staff-settings"><form className="staff-form" onSubmit={changeStaffPassword}><h2><KeyRound /> Alterar senha</h2><p>Atualize a senha utilizada para acessar a gestão do e-Commerce.</p>{user.authProvider !== 'supabase' && <label>Senha atual<input name="currentPassword" type="password" autoComplete="current-password" required /></label>}<label>Nova senha<input name="newPassword" type="password" autoComplete="new-password" minLength={8} required /></label><label>Confirmar nova senha<input name="confirmPassword" type="password" autoComplete="new-password" minLength={8} required /></label><small>Use ao menos 8 caracteres, com maiúscula, minúscula e número.</small><button className="primary-button" disabled={loading}>{loading ? <LoaderCircle className="spin" /> : <><Save /> Salvar nova senha</>}</button></form></section>}
    </main>
  </div>
}

function StaffOrderCard({ order, loading, onLink }: { order: Order; loading: boolean; onLink: (event: React.FormEvent<HTMLFormElement>, order: Order) => void }) {
  return <details className="staff-order"><summary><div><strong>{order.number}</strong><span>{order.customer.tradeName || order.customer.legalName}</span></div><div><span>{new Date(order.createdAt).toLocaleString('pt-BR')}</span><strong>{money.format(order.total)}</strong><b className={`order-status ${order.status}`}>{orderStatusLabel(order.status)}</b></div></summary><div className="order-detail-grid"><p><b>Cliente</b>{formatDocument(order.customer.document)}<br />{order.customer.email}<br />{formatPhone(order.customer.phone)}</p><p><b>Pagamento</b>{paymentLabel(order.paymentPlan)}<br /><b>Status para o cliente</b>{orderStatusLabel(order.status)}{order.winthorStatusLabel && <><b>Status real no WinThor</b>{order.winthorStatusLabel}{order.winthorStatusCode && ` (${order.winthorStatusCode})`}</>}{order.statusUpdatedAt && <small>Consultado em {new Date(order.statusUpdatedAt).toLocaleString('pt-BR')}</small>}</p><div className="winthor-order-box"><b>Liberação do pedido</b><form onSubmit={(event) => onLink(event, order)}><input name="winthorOrderNumber" inputMode="numeric" pattern="[0-9]+" defaultValue={order.winthorOrderNumber ?? ''} placeholder="Informe o NUMPED" required /><button disabled={loading}>{loading ? <LoaderCircle className="spin" /> : <><ClipboardCheck /> {order.winthorOrderNumber ? 'Atualizar NUMPED' : 'Liberar pedido'}</>}</button></form>{order.winthorOrderNumber && <small>NUMPED {order.winthorOrderNumber}{order.enteredBy ? ` · por ${order.enteredBy}` : ''}{order.enteredAt ? ` em ${new Date(order.enteredAt).toLocaleString('pt-BR')}` : ''}</small>}</div>{order.notes && <p><b>Observações</b>{order.notes}</p>}</div><div className="order-lines">{order.items.map((item) => <div key={item.id}><span>{item.code} · {item.name}</span><span>{item.units} {item.units === 1 ? 'unidade' : 'unidades'}</span><strong>{money.format(item.lineTotal)}</strong></div>)}</div></details>
}

function BannerEditor({ banner, departments, onChange, onImage, onDelete }: { banner: Banner; departments: CatalogDepartment[]; onChange: (id: number, values: Partial<Banner>) => void; onImage: (banner: Banner, file?: File) => void; onDelete: (banner: Banner) => void }) {
  return <article className={`staff-form banner-form ${banner.placement === 'catalog' ? 'catalog-format' : ''}`}>
    {banner.imageUrl ? <img src={banner.imageUrl} alt={banner.altText} /> : <div className="new-banner-placeholder"><ImagePlus /><span>Selecione a imagem</span></div>}
    <div className="banner-editor-title"><h3>{banner.title || 'Novo banner'}</h3><button type="button" onClick={() => onDelete(banner)} aria-label="Excluir banner"><Trash2 /> Excluir</button></div>
    <label>Tipo<select value={banner.placement} onChange={(event) => onChange(banner.id, { placement: event.target.value as Banner['placement'] })}><option value="hero">Banner principal</option><option value="catalog">Banner entre produtos</option></select></label>
    <label>Seção associada <small>{banner.placement === 'hero' ? 'Ao clicar, abre os produtos da seção' : 'A próxima linha mostrará produtos desta seção'}</small><select value={banner.sectionCode ?? ''} onChange={(event) => onChange(banner.id, { sectionCode: event.target.value ? Number(event.target.value) : null })}><option value="">Nenhuma seção associada</option>{departments.map((department) => <optgroup key={department.code || department.name} label={formatCatalogName(department.name)}>{department.sections.filter((section) => section.code > 0).map((section) => <option key={`${department.code}-${section.code}`} value={section.code}>{formatCatalogName(section.name)} · cód. {section.code}</option>)}</optgroup>)}</select></label>
    <label>Título<input value={banner.title} onChange={(event) => onChange(banner.id, { title: event.target.value })} required /></label>
    <label>Texto alternativo<input value={banner.altText} onChange={(event) => onChange(banner.id, { altText: event.target.value })} required /></label>
    <div className="staff-form-row"><label>Posição<input type="number" min="0" value={banner.position} onChange={(event) => onChange(banner.id, { position: Number(event.target.value) })} /></label><label>Destino<input value={banner.targetUrl} onChange={(event) => onChange(banner.id, { targetUrl: event.target.value })} /></label></div>
    <div className="staff-form-row banner-schedule"><label>Início opcional <small>Data e hora de Brasília</small><input type="datetime-local" value={toBrasiliaInput(banner.startsAt)} onChange={(event) => onChange(banner.id, { startsAt: fromBrasiliaInput(event.target.value) })} /></label><label>Encerramento opcional <small>Sem data, não expira</small><input type="datetime-local" value={toBrasiliaInput(banner.endsAt)} onChange={(event) => onChange(banner.id, { endsAt: fromBrasiliaInput(event.target.value) })} /></label></div>
    <label>Imagem <small>{banner.id > 0 ? 'Selecione apenas se quiser substituir a atual' : 'PNG, JPG ou WEBP · máximo 5 MB'}</small><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => onImage(banner, event.target.files?.[0])} /></label>
    <label className="staff-check"><input type="checkbox" checked={banner.active} onChange={(event) => onChange(banner.id, { active: event.target.checked })} /> Exibir na loja</label>
  </article>
}
