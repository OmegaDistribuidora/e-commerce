import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight, BadgePercent, Box, ChevronDown, ChevronLeft, ChevronRight,
  CircleUserRound, Headphones, Heart, ImageOff, LoaderCircle, LockKeyhole,
  LogOut, MapPin, Menu, Minus, PackageCheck, Plus, Search, ShieldCheck,
  ShoppingCart, SlidersHorizontal, Sparkles, Store, Tag, Trash2, Truck,
  UtensilsCrossed, X,
} from 'lucide-react'
import AccountPage from './AccountPage'
import OrdersPage from './OrdersPage'
import StaffPortal from './StaffPortal'
import ProductPage from './ProductPage'
import { authenticatedFetch } from './api'
import { money } from './data'
import { supabase } from './supabase'
import type { Banner, CartItem, Category, CommercialConditions, Customer, Product, StaffUser } from './types'
import { formatDocument } from './validation'

const defaultCategories: Category[] = ['Limpeza', 'Higiene', 'Utilidades', 'Alimentos']

function categoryIcon(name: string) {
  if (name === 'Todos') return Store
  if (name === 'Limpeza') return Sparkles
  if (name === 'Higiene') return ShieldCheck
  if (name === 'Utilidades') return Box
  if (name === 'Alimentos') return UtensilsCrossed
  return Tag
}

const fallbackSlides: Banner[] = [
  { id: 1, title: 'Institucional Ômega', imageUrl: '/assets/banner-omega.png', altText: 'Tudo que o seu negócio precisa, em um só lugar', targetUrl: '#produtos', position: 1, active: true, placement: 'hero', startsAt: null, endsAt: null },
  { id: 2, title: 'Linha Bombril', imageUrl: '/assets/banner-bombril.png', altText: 'Linha Bombril: mais limpeza para o seu dia a dia', targetUrl: '#produtos', position: 2, active: true, placement: 'hero', startsAt: null, endsAt: null },
]

const partners = [
  { supplierId: 117, name: 'Bombril', logo: '/assets/brands/bombril-117.webp' },
  { supplierId: 967, name: 'Maratá', logo: '/assets/brands/marata-967.webp' },
  { supplierId: 3609, name: 'Mili', logo: '/assets/brands/mili-3609.jpg' },
  { supplierId: 1481, name: 'Realeza', logo: '/assets/brands/realeza-1481.png' },
  { supplierId: 5569, name: 'Gallo', logo: '/assets/brands/gallo-5569.webp' },
  { supplierId: 1968, name: 'JDE / Café Puro', logo: '/assets/brands/jde-1968.webp' },
]

const whatsappUrl = `https://wa.me/558592020207?text=${encodeURIComponent('Olá! Venho do e-Commerce da Ômega Distribuidora e preciso de atendimento!')}`

function readStoredCart(): CartItem[] {
  try {
    const stored = JSON.parse(localStorage.getItem('omega-cart-v2') ?? '[]')
    return Array.isArray(stored) ? stored.filter((item) => Number.isFinite(item.unitPrice)) : []
  } catch { return [] }
}

function App() {
  if (window.location.pathname === '/conta') return <AccountPage />
  if (window.location.pathname === '/pedidos') return <OrdersPage />
  if (window.location.pathname === '/gestao') return <StaffPortal />
  const productMatch = /^\/produto\/(\d+)$/.exec(window.location.pathname)
  if (productMatch) return <ProductPage code={Number(productMatch[1])} />
  const supplierId = Number(new URLSearchParams(window.location.search).get('fornecedor'))
  return <StorePage initialSupplierId={Number.isFinite(supplierId) && supplierId > 0 ? supplierId : null} />
}

function StorePage({ initialSupplierId }: { initialSupplierId: number | null }) {
  const [products, setProducts] = useState<Product[]>([])
  const [catalogCategories, setCatalogCategories] = useState<Category[]>(defaultCategories)
  const [loadingProducts, setLoadingProducts] = useState(true)
  const [productsError, setProductsError] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category>('Todos')
  const [supplierFilter, setSupplierFilter] = useState(initialSupplierId ? String(initialSupplierId) : '')
  const [departmentFilter, setDepartmentFilter] = useState('')
  const [catalogMode, setCatalogMode] = useState<'featured' | 'bestsellers'>('featured')
  const [visibleCount, setVisibleCount] = useState(25)
  const [cart, setCart] = useState<CartItem[]>([])
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [staffUser, setStaffUser] = useState<StaffUser | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [cartOpen, setCartOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [sendingOrder, setSendingOrder] = useState(false)
  const [orderError, setOrderError] = useState('')
  const [commercialConditions, setCommercialConditions] = useState<CommercialConditions | null>(null)
  const [loadingConditions, setLoadingConditions] = useState(false)
  const [orderNumber, setOrderNumber] = useState('')
  const [slides, setSlides] = useState<Banner[]>(fallbackSlides)
  const [catalogBanners, setCatalogBanners] = useState<Banner[]>([])
  const [slide, setSlide] = useState(0)
  const [slideRatios, setSlideRatios] = useState<Record<number, number>>({})
  const [toast, setToast] = useState('')
  const productsRef = useRef<HTMLElement>(null)

  useEffect(() => {
    authenticatedFetch('/api/auth/me')
      .then(async (response) => response.ok ? response.json() : null)
      .then((data) => {
        const authenticatedCustomer = data?.accountType === 'customer' ? data.customer : null
        const authenticatedStaff = data?.accountType === 'staff' ? data.user : null
        setCustomer(authenticatedCustomer)
        setStaffUser(authenticatedStaff)
        setCart(authenticatedCustomer?.canOrder ? readStoredCart() : [])
      })
      .catch(() => { setCustomer(null); setStaffUser(null) })
      .finally(() => setAuthReady(true))
  }, [])

  useEffect(() => {
    if (!authReady) return
    const controller = new AbortController()
    setLoadingProducts(true)
    authenticatedFetch(`/api/products?limit=180&sort=${catalogMode}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.message)
        setProducts(data.products)
        setProductsError('')
        setVisibleCount(25)
      })
      .catch((error) => { if (error.name !== 'AbortError') setProductsError('Não foi possível carregar o catálogo agora.') })
      .finally(() => setLoadingProducts(false))
    return () => controller.abort()
  }, [authReady, catalogMode, customer?.id])

  useEffect(() => { if (authReady) localStorage.setItem('omega-cart-v2', JSON.stringify(cart)) }, [authReady, cart])
  useEffect(() => {
    if (authReady && !customer) setCart([])
  }, [authReady, customer])
  useEffect(() => {
    fetch('/api/banners').then((response) => response.json()).then((data) => {
      if (Array.isArray(data.banners) && data.banners.length) setSlides(data.banners)
    }).catch(() => undefined)
    fetch('/api/banners?placement=catalog').then((response) => response.json()).then((data) => {
      if (Array.isArray(data.banners)) setCatalogBanners(data.banners)
    }).catch(() => undefined)
    fetch('/api/categories').then((response) => response.json()).then((data) => {
      if (Array.isArray(data.categories)) setCatalogCategories(data.categories.map((item: { name: string }) => item.name))
    }).catch(() => undefined)
  }, [])
  useEffect(() => {
    const timer = window.setInterval(() => setSlide((current) => (current + 1) % slides.length), 6500)
    return () => window.clearInterval(timer)
  }, [slides.length])
  useEffect(() => { if (slide >= slides.length) setSlide(0) }, [slide, slides.length])
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2400)
    return () => window.clearTimeout(timer)
  }, [toast])

  const filteredProducts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('pt-BR')
    return products.filter((product) => {
      const matchesCategory = category === 'Todos' || product.categories?.includes(category) || product.category === category
      const matchesSupplier = !supplierFilter || String(product.supplierId) === supplierFilter
      const matchesDepartment = !departmentFilter || product.department === departmentFilter
      const matchesQuery = !normalized || `${product.name} ${product.brand} ${product.category} ${product.code}`.toLocaleLowerCase('pt-BR').includes(normalized)
      return matchesCategory && matchesSupplier && matchesDepartment && matchesQuery
    })
  }, [category, departmentFilter, products, query, supplierFilter])

  const supplierOptions = useMemo(() => [...new Map(products.map((product) => [product.supplierId, product.brand])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR')), [products])
  const departmentOptions = useMemo(() => [...new Set(products.map((product) => product.department).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR')), [products])
  const selectedSupplierName = supplierOptions.find(([id]) => String(id) === supplierFilter)?.[1]

  const visibleProducts = filteredProducts.slice(0, visibleCount)
  const productRows = Array.from({ length: Math.ceil(visibleProducts.length / 5) }, (_, index) => visibleProducts.slice(index * 5, index * 5 + 5))
  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0)
  const cartTotal = cart.reduce((sum, item) => sum + (item.unitPrice ?? 0) * item.quantity, 0)
  const minimumOrder = 200
  const minimumRemaining = Math.max(0, minimumOrder - cartTotal)
  const minimumProgress = Math.min(100, (cartTotal / minimumOrder) * 100)

  function addToCart(product: Product) {
    if (!customer || product.unitPrice === null) {
      window.location.href = '/conta'
      return
    }
    if (!customer.canOrder) {
      setToast('Seu cadastro está em análise. Você poderá comprar após a aprovação da equipe Ômega.')
      return
    }
    setCart((current) => {
      const existing = current.find((item) => item.id === product.id)
      return existing
        ? current.map((item) => item.id === product.id ? { ...item, quantity: item.quantity + product.salesMultiple } : item)
        : [...current, { ...product, quantity: product.salesMultiple }]
    })
    setToast(`${product.name} adicionado ao carrinho`)
  }

  async function logout() {
    await Promise.all([
      supabase.auth.signOut(),
      fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined),
      fetch('/api/staff/auth/logout', { method: 'POST' }).catch(() => undefined),
    ])
    localStorage.removeItem('omega-cart-v2')
    setCart([])
    setCustomer(null)
    setStaffUser(null)
    setMenuOpen(false)
    setToast('Você saiu da sua conta')
  }

  function clearFilters() {
    setQuery('')
    setCategory('Todos')
    setSupplierFilter('')
    setDepartmentFilter('')
    setCatalogMode('featured')
    if (window.location.search) window.history.replaceState({}, '', '/')
  }

  function changeQuantity(id: number, delta: number) {
    setCart((current) => current.flatMap((item) => {
      if (item.id !== id) return [item]
      const nextQuantity = item.quantity + delta
      return nextQuantity > 0 ? [{ ...item, quantity: nextQuantity }] : []
    }))
  }

  function removeFromCart(id: number) {
    setCart((current) => current.filter((item) => item.id !== id))
  }

  function selectCategory(next: Category) {
    setCategory(next)
    setMenuOpen(false)
    setVisibleCount(25)
    window.setTimeout(() => productsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  function showBestSellers() {
    setCatalogMode('bestsellers')
    setCategory('Todos')
    setMenuOpen(false)
    window.setTimeout(() => productsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  async function beginCheckout() {
    if (!customer) {
      window.location.href = '/conta?return=checkout'
      return
    }
    if (!customer.canOrder) {
      setCartOpen(false)
      setToast('Seu cadastro ainda está em análise e não pode enviar pedidos.')
      return
    }
    setLoadingConditions(true)
    setOrderError('')
    try {
      const response = await authenticatedFetch('/api/customer/commercial-conditions')
      const data = await response.json()
      if (!response.ok) throw new Error(data.message)
      setCommercialConditions(data)
      setCartOpen(false)
      setCheckoutOpen(true)
    } catch (error) {
      setOrderError(error instanceof Error ? error.message : 'NÃ£o foi possÃ­vel consultar suas condiÃ§Ãµes comerciais.')
    } finally { setLoadingConditions(false) }
  }

  async function submitOrder(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!customer) return
    setSendingOrder(true)
    setOrderError('')
    const form = new FormData(event.currentTarget)
    try {
      const response = await authenticatedFetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: customer.id, paymentPlan: form.get('paymentPlan'), notes: form.get('notes'), items: cart.map((item) => ({ productId: item.id, quantity: item.quantity })) }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message)
      setOrderNumber(data.order.number)
      setCart([])
      setCheckoutOpen(false)
    } catch (error) {
      setOrderError(error instanceof Error ? error.message : 'Não foi possível enviar o pedido.')
    } finally {
      setSendingOrder(false)
    }
  }

  return (
    <div className="app-shell">
      <div className="topbar"><div className="container topbar-inner"><p>{customer ? <>Bem-vindo(a), <strong>{customer.tradeName || customer.legalName}</strong></> : staffUser ? <>Sessão de gestão: <strong>{staffUser.name}</strong></> : <>Tudo o que você precisa, <strong>sempre por perto.</strong></>}</p><div className="topbar-links"><span><MapPin size={15} /> Entregamos em todo o Ceará</span><a href={whatsappUrl} target="_blank" rel="noreferrer">Central de ajuda</a></div></div></div>
      <header className="site-header">
        <div className="container header-main">
          <button className="mobile-menu-btn icon-btn" aria-label="Abrir menu" onClick={() => setMenuOpen(true)}><Menu /></button>
          <a className="logo" href="#top" aria-label="Ômega Distribuidora — início"><img src="/assets/omega-logo.png" alt="Ômega Distribuidora" /></a>
          <label className="search-box"><Search size={21} /><input value={query} onChange={(event) => { setQuery(event.target.value); setVisibleCount(25) }} onFocus={() => productsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} placeholder="Busque produtos, marcas ou código" aria-label="Buscar produtos" />{query && <button onClick={() => setQuery('')} aria-label="Limpar busca"><X size={18} /></button>}</label>
          <a className="account-button" href={staffUser ? '/gestao' : customer ? '/pedidos' : '/conta'}><CircleUserRound /><span><small>{staffUser ? 'Painel interno' : customer ? 'Meus pedidos' : 'Área do cliente'}</small><strong>{staffUser ? `${staffUser.name} · ${staffUser.role}` : customer ? `Bem-vindo(a), ${customer.tradeName || customer.legalName}` : 'Entrar ou cadastrar'}</strong></span></a>
          {(customer || staffUser) && <button className="logout-button" onClick={logout} aria-label="Sair da conta" title="Sair da conta"><LogOut size={19} /><span>Sair</span></button>}
          <button className="cart-button" onClick={() => setCartOpen(true)} aria-label={`Abrir carrinho com ${cartCount} unidades`}><span className="cart-icon"><ShoppingCart />{cartCount > 0 && <b>{cartCount}</b>}</span><span><small>Meu carrinho</small><strong>{cartCount ? `${cartCount} ${cartCount === 1 ? 'unidade' : 'unidades'}` : 'Está vazio'}</strong></span></button>
        </div>
        <nav className="main-nav" aria-label="Navegação principal"><div className="container nav-inner"><button className="categories-button" onClick={() => setMenuOpen(true)}><Menu size={19} /> Todas as categorias <ChevronDown size={17} /></button><a href="#produtos" onClick={() => setCatalogMode('featured')}>Destaques</a><a href="#produtos" onClick={showBestSellers}>Mais vendidos</a><a href="#produtos">Ofertas</a><a href="#marcas">Marcas</a><a href={whatsappUrl} target="_blank" rel="noreferrer">Atendimento</a></div></nav>
      </header>

      {customer && !customer.canOrder && <div className="store-pending-banner"><LoaderCircle /><div><strong>Cadastro em análise</strong><span>Você já pode consultar o catálogo e os preços. A compra será liberada após a validação do seu cadastro.</span></div><a href="/pedidos">Ver meu cadastro</a></div>}

      <main id="top">
        <section className="hero" aria-label="Destaques" style={{ aspectRatio: slideRatios[slide] || 2.5 }}><div className="hero-track" style={{ transform: `translate3d(-${slide * 100}%, 0, 0)` }}>{slides.map((item, index) => <a key={item.id} className="hero-slide" href={item.targetUrl || '#produtos'}><img src={item.imageUrl} alt={item.altText} onLoad={(event) => { const image = event.currentTarget; if (image.naturalWidth && image.naturalHeight) setSlideRatios((current) => ({ ...current, [index]: image.naturalWidth / image.naturalHeight })) }} /></a>)}</div>{slides.length > 1 && <><button className="slider-arrow prev" aria-label="Banner anterior" onClick={() => setSlide((slide - 1 + slides.length) % slides.length)}><ChevronLeft /></button><button className="slider-arrow next" aria-label="Próximo banner" onClick={() => setSlide((slide + 1) % slides.length)}><ChevronRight /></button><div className="slider-dots">{slides.map((item, index) => <button key={item.id} className={index === slide ? 'active' : ''} onClick={() => setSlide(index)} aria-label={`Ir para banner ${index + 1}`} />)}</div></>}</section>

        <section className="container category-strip" aria-label="Categorias">{['Todos', ...catalogCategories].map((name) => { const Icon = categoryIcon(name); return <button key={name} className={category === name && catalogMode === 'featured' ? 'active' : ''} onClick={() => { setCatalogMode('featured'); selectCategory(name) }}><span><Icon size={24} /></span>{name}</button> })}<button className={catalogMode === 'bestsellers' ? 'active' : ''} onClick={showBestSellers}><span><BadgePercent size={24} /></span>Mais vendidos</button></section>

        <section className="container products-section" id="produtos" ref={productsRef}>
          <div className="section-heading"><div><span className="eyebrow">CATÁLOGO REAL · PRODUTOS ATIVOS</span><h1>{selectedSupplierName ? `Produtos ${selectedSupplierName}` : query ? `Resultados para “${query}”` : catalogMode === 'bestsellers' ? 'Mais vendidos nos últimos 7 dias' : category === 'Todos' ? 'Produtos em destaque' : category}</h1></div><span className="result-count">{filteredProducts.length} {filteredProducts.length === 1 ? 'produto' : 'produtos'}</span></div>
          <div className="catalog-filters"><span className="filter-title"><SlidersHorizontal size={18} /> Filtrar catálogo</span><label>Fornecedor<select value={supplierFilter} onChange={(event) => { setSupplierFilter(event.target.value); setVisibleCount(25) }}><option value="">Todos os fornecedores</option>{supplierOptions.map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label><label>Categoria<select value={category} onChange={(event) => { setCategory(event.target.value as Category); setVisibleCount(25) }}><option value="Todos">Todos</option>{catalogCategories.map((name) => <option value={name} key={name}>{name}</option>)}</select></label><label>Departamento<select value={departmentFilter} onChange={(event) => { setDepartmentFilter(event.target.value); setVisibleCount(25) }}><option value="">Todos os departamentos</option>{departmentOptions.map((department) => <option value={department} key={department}>{department}</option>)}</select></label><button onClick={clearFilters}>Limpar filtros</button></div>
          {loadingProducts ? <div className="catalog-loading"><LoaderCircle className="spin" /><span>Carregando produtos...</span></div> : productsError ? <div className="empty-results"><ImageOff size={36} /><h2>Catálogo indisponível</h2><p>{productsError}</p><button className="primary-button" onClick={() => window.location.reload()}>Tentar novamente</button></div> : visibleProducts.length > 0 ? <><div className="catalog-flow">{productRows.map((row, rowIndex) => <div className="catalog-row-group" key={`row-${rowIndex}`}><div className="product-grid">{row.map((product, productIndex) => <ProductCard key={product.id} product={product} rank={catalogMode === 'bestsellers' ? rowIndex * 5 + productIndex + 1 : undefined} addToCart={addToCart} changeQuantity={changeQuantity} quantity={cart.find((item) => item.id === product.id)?.quantity ?? 0} authenticated={Boolean(customer)} canOrder={Boolean(customer?.canOrder)} />)}</div>{catalogBanners.length > 0 && rowIndex < productRows.length - 1 && <a className="catalog-banner" href={catalogBanners[rowIndex % catalogBanners.length].targetUrl || '#produtos'}><img src={catalogBanners[rowIndex % catalogBanners.length].imageUrl} alt={catalogBanners[rowIndex % catalogBanners.length].altText} /></a>}</div>)}</div>{visibleCount < filteredProducts.length && <button className="load-more" onClick={() => setVisibleCount((count) => count + 25)}>Ver mais produtos <ArrowRight size={18} /></button>}</> : <div className="empty-results"><Search size={36} /><h2>Nenhum produto encontrado</h2><p>Tente combinar outros filtros ou explore todo o catálogo.</p><button className="primary-button" onClick={clearFilters}>Limpar filtros</button></div>}
        </section>

        <section className="container benefits" id="atendimento"><article><span><Truck /></span><div><strong>Entrega programada</strong><p>Agilidade e segurança no seu abastecimento</p></div></article><article><span><ShieldCheck /></span><div><strong>Compra segura</strong><p>Seus dados e seu pedido protegidos</p></div></article><article><span><PackageCheck /></span><div><strong>Quantidade sob medida</strong><p>Compre respeitando o múltiplo de cada produto</p></div></article><a className="benefit-card" href={whatsappUrl} target="_blank" rel="noreferrer" aria-label="Falar com o atendimento da Ômega pelo WhatsApp"><span><Headphones /></span><div><strong>Atendimento próximo</strong><p>Fale agora com nossa equipe pelo WhatsApp</p></div></a></section>

        <section className="brands-section" id="marcas"><div className="container"><div className="section-heading"><div><span className="eyebrow">BONS NEGÓCIOS COMEÇAM COM BOAS MARCAS</span><h2>Nossos parceiros</h2></div></div><div className="brands-grid">{partners.map((partner) => <a className="brand-card" href={`/?fornecedor=${partner.supplierId}#produtos`} key={partner.supplierId} aria-label={`Filtrar produtos de ${partner.name}`}><img src={partner.logo} alt={`Logo ${partner.name}`} loading="lazy" /></a>)}</div></div></section>
      </main>

      <footer><div className="container footer-grid"><div className="footer-brand"><img src="/assets/omega-logo.png" alt="Ômega Distribuidora" /><p>Distribuindo mais do que produtos: parcerias de sucesso.</p></div><div><strong>Institucional</strong><a href="#top">Sobre a Ômega</a><a href="#marcas">Nossas marcas</a><a href={whatsappUrl} target="_blank" rel="noreferrer">Fale conosco</a></div><div><strong>Atendimento</strong><span>Segunda a sexta, 8h às 17h</span><a href={whatsappUrl} target="_blank" rel="noreferrer">WhatsApp: (85) 9202-0207</a></div><div><strong>Compra protegida</strong><p className="security-copy"><LockKeyhole size={19} /> Ambiente seguro para seus pedidos.</p></div></div><div className="container footer-bottom"><span>© 2026 Ômega Distribuidora. Todos os direitos reservados.</span><span>Preços unitários sujeitos à confirmação comercial.</span></div></footer>

      {customer?.canOrder && <button className={`minimum-order-widget ${minimumRemaining === 0 ? 'complete' : ''}`} onClick={() => setCartOpen(true)} aria-label={`Carrinho em ${money.format(cartTotal)} de um pedido mínimo de ${money.format(minimumOrder)}`}><span><ShoppingCart size={18} /> Pedido mínimo</span><strong>{money.format(cartTotal)} <small>/ {money.format(minimumOrder)}</small></strong><i><b style={{ width: `${minimumProgress}%` }} /></i><em>{minimumRemaining > 0 ? `Faltam ${money.format(minimumRemaining)}` : 'Mínimo atingido'}</em></button>}

      {menuOpen && <div className="overlay" onMouseDown={() => setMenuOpen(false)}><aside className="side-panel menu-panel" onMouseDown={(event) => event.stopPropagation()}><div className="drawer-heading"><h2>Categorias</h2><button className="icon-btn" onClick={() => setMenuOpen(false)}><X /></button></div>{['Todos', ...catalogCategories].map((name) => { const Icon = categoryIcon(name); return <button key={name} className={category === name ? 'active' : ''} onClick={() => selectCategory(name)}><Icon size={21} />{name}<ChevronRight size={18} /></button> })}{(customer || staffUser) && <button className="menu-logout" onClick={logout}><LogOut size={20} />Sair da conta</button>}</aside></div>}

      {cartOpen && <div className="overlay" onMouseDown={() => setCartOpen(false)}><aside className="side-panel cart-panel" onMouseDown={(event) => event.stopPropagation()}><div className="drawer-heading"><div><span className="eyebrow">SEU PEDIDO</span><h2>Meu carrinho</h2></div><button className="icon-btn" onClick={() => setCartOpen(false)}><X /></button></div>{cart.length === 0 ? <div className="empty-cart"><span><ShoppingCart /></span><h3>Seu carrinho está vazio</h3><p>Explore o catálogo e adicione os produtos que seu negócio precisa.</p><button className="primary-button" onClick={() => setCartOpen(false)}>Explorar produtos</button></div> : <><div className="cart-items">{cart.map((item) => <div className="cart-item" key={item.id}><div className="cart-product-image">{item.image ? <img src={item.image} alt="" /> : <ImageOff />}</div><div className="cart-product-info"><strong>{item.name}</strong><small>Vendido em múltiplos de {item.salesMultiple} unidades</small><span>{money.format(item.unitPrice ?? 0)} / unidade</span><div className="quantity-control"><button onClick={() => changeQuantity(item.id, -item.salesMultiple)} aria-label={`Remover ${item.salesMultiple} unidades`}><Minus size={15} /></button><b>{item.quantity} un.</b><button onClick={() => changeQuantity(item.id, item.salesMultiple)} aria-label={`Adicionar ${item.salesMultiple} unidades`}><Plus size={15} /></button><button className="remove-item" onClick={() => removeFromCart(item.id)} aria-label="Remover item"><Trash2 size={16} /></button></div></div></div>)}</div><div className="cart-summary"><div><span>Subtotal estimado</span><strong>{money.format(cartTotal)}</strong></div><div className={`cart-minimum ${minimumRemaining === 0 ? 'complete' : ''}`}><span>{minimumRemaining > 0 ? `Adicione mais ${money.format(minimumRemaining)} para atingir o mínimo.` : 'Pedido mínimo atingido.'}</span><i><b style={{ width: `${minimumProgress}%` }} /></i></div><p>Pedido para {customer?.tradeName || customer?.legalName}. Frete e condições comerciais serão confirmados pela equipe.</p><button className="checkout-button" onClick={beginCheckout} disabled={minimumRemaining > 0 || loadingConditions}>{loadingConditions ? <LoaderCircle className="spin" /> : minimumRemaining > 0 ? `Mínimo de ${money.format(minimumOrder)}` : 'Finalizar pedido'} {!loadingConditions && <ArrowRight size={19} />}</button>{orderError && <span className="field-error cart-condition-error">{orderError}</span>}<button className="keep-shopping" onClick={() => setCartOpen(false)}>Continuar comprando</button></div></>}</aside></div>}

      {checkoutOpen && customer && commercialConditions && <div className="overlay modal-overlay" onMouseDown={() => setCheckoutOpen(false)}><div className="checkout-modal" onMouseDown={(event) => event.stopPropagation()}><div className="drawer-heading"><div><span className="eyebrow">CONFIRMAR PEDIDO</span><h2>Identificação do cliente</h2></div><button className="icon-btn" onClick={() => setCheckoutOpen(false)}><X /></button></div><form onSubmit={submitOrder}><div className="checkout-customer"><CircleUserRound /><div><strong>{customer.tradeName || customer.legalName}</strong><span>{formatDocument(customer.document)} · {customer.email}</span></div><a href="/conta">Alterar</a></div><label>Plano de pagamento<select name="paymentPlan" defaultValue={commercialConditions.paymentPlans[0]?.code} required>{commercialConditions.paymentPlans.map((plan) => <option key={plan.code} value={plan.code}>{plan.label}</option>)}</select></label><div className={`checkout-credit ${cartTotal > commercialConditions.creditLimit ? 'exceeded' : ''}`}><span>Limite de crédito</span><strong>{money.format(commercialConditions.creditLimit)}</strong><small>{cartTotal > commercialConditions.creditLimit ? `Reduza o pedido em ${money.format(cartTotal - commercialConditions.creditLimit)}.` : `Após este pedido: ${money.format(commercialConditions.creditLimit - cartTotal)}`}</small></div><label>Observações<textarea name="notes" placeholder="Informe preferências de entrega, contato ou condições." rows={3} /></label>{orderError && <span className="field-error">{orderError}</span>}<div className="checkout-total"><span>Total estimado</span><strong>{money.format(cartTotal)}</strong></div><button className="checkout-button" type="submit" disabled={sendingOrder || cartTotal > commercialConditions.creditLimit || commercialConditions.paymentPlans.length === 0}>{sendingOrder ? <LoaderCircle className="spin" /> : <>Enviar pedido <ArrowRight size={19} /></>}</button></form></div></div>}

      {orderNumber && <div className="overlay modal-overlay"><div className="success-modal"><span><PackageCheck /></span><h2>Pedido recebido!</h2><p>Sua solicitação <strong>{orderNumber}</strong> foi registrada. Nossa equipe comercial entrará em contato para confirmar valores, frete e prazo.</p><a className="primary-button" href="/pedidos">Ver meus pedidos</a><button className="secondary-button" onClick={() => setOrderNumber('')}>Continuar comprando</button></div></div>}
      {toast && <div className="toast"><PackageCheck size={19} />{toast}</div>}
    </div>
  )
}

function ProductCard({ product, rank, addToCart, changeQuantity, quantity, authenticated, canOrder }: { product: Product; rank?: number; addToCart: (product: Product) => void; changeQuantity: (id: number, delta: number) => void; quantity: number; authenticated: boolean; canOrder: boolean }) {
  return (
    <article className="product-card">
      <div className="product-image-wrap">
        {rank && rank <= 10 && <span className="product-badge">#{rank} em vendas</span>}
        <button className="favorite" aria-label="Favoritar"><Heart size={19} /></button>
        <a className="product-image-link" href={`/produto/${product.code}`} aria-label={`Ver detalhes de ${product.name}`}>{product.image ? <img src={product.image} alt={product.name} /> : <div className="no-product-image"><ImageOff /><span>Produto sem foto</span></div>}</a>
      </div>
      <div className="product-content">
        <span className="product-brand">{product.brand} · cód. {product.code}</span>
        <h3><a href={`/produto/${product.code}`}>{product.name}</a></h3>
        {authenticated && product.unitPrice !== null && <div className="price-row unit-price-row"><div><strong>{money.format(product.unitPrice)}</strong><small>por unidade</small></div></div>}
        {quantity > 0 && authenticated && canOrder ? <div className="product-quantity-control"><button onClick={() => changeQuantity(product.id, -product.salesMultiple)} aria-label={`Remover ${product.salesMultiple} unidades`}><Minus size={18} /></button><span><strong>{quantity}</strong><small>unidades</small></span><button onClick={() => changeQuantity(product.id, product.salesMultiple)} aria-label={`Adicionar ${product.salesMultiple} unidades`}><Plus size={18} /></button></div> : <button className={`buy-button ${!authenticated || !canOrder ? 'login-to-buy' : ''}`} onClick={() => addToCart(product)}>{!authenticated ? <><LockKeyhole size={17} />Entrar para ver preço</> : !canOrder ? <><LoaderCircle size={17} />Cadastro em análise</> : <><ShoppingCart size={18} />Adicionar {product.salesMultiple} {product.salesMultiple === 1 ? 'unidade' : 'unidades'}</>}</button>}
      </div>
    </article>
  )
}

export default App
