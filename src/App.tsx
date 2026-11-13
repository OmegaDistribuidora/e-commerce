import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight, BadgePercent, ChevronDown, ChevronLeft, ChevronRight,
  CircleUserRound, Headphones, Heart, ImageOff, LoaderCircle, LockKeyhole,
  LogOut, MapPin, Menu, Minus, PackageCheck, Plus, Search, ShieldCheck,
  ShoppingCart, SlidersHorizontal, Store, Trash2, Truck, X,
} from 'lucide-react'
import AccountPage from './AccountPage'
import OrdersPage from './OrdersPage'
import StaffPortal from './StaffPortal'
import ProductPage from './ProductPage'
import { authenticatedFetch } from './api'
import { money, unitMoney } from './data'
import { formatCatalogName } from './catalog'
import { supabase } from './supabase'
import type { Banner, CartItem, CatalogDepartment, CommercialConditions, Customer, OrderQuote, Partner, Product, StaffUser } from './types'
import { formatDocument } from './validation'

const fallbackSlides: Banner[] = [
  { id: 1, title: 'Institucional Ômega', imageUrl: '/assets/banner-omega.png', altText: 'Tudo que o seu negócio precisa, em um só lugar', targetUrl: '/#produtos', sectionCode: null, destinationType: 'navigation', destinationValues: [], navigationPath: '/#produtos', position: 1, active: true, placement: 'hero', startsAt: null, endsAt: null },
  { id: 2, title: 'Linha Bombril', imageUrl: '/assets/banner-bombril.png', altText: 'Linha Bombril: mais limpeza para o seu dia a dia', targetUrl: '/#produtos', sectionCode: null, destinationType: 'navigation', destinationValues: [], navigationPath: '/#produtos', position: 2, active: true, placement: 'hero', startsAt: null, endsAt: null },
]

const whatsappUrl = `https://wa.me/558592020207?text=${encodeURIComponent('Olá! Venho do e-Commerce da Ômega Distribuidora e preciso de atendimento!')}`

function readStoredCart(): CartItem[] {
  try {
    const stored = JSON.parse(localStorage.getItem('omega-cart-v2') ?? '[]')
    return Array.isArray(stored) ? stored.filter((item) => Number.isFinite(item.unitPrice)) : []
  } catch { return [] }
}

function queryCodes(value: string | null) {
  return [...new Set((value || '').split(',').map(Number).filter((code) => Number.isSafeInteger(code) && code > 0))]
}

function App() {
  if (window.location.pathname === '/conta') return <AccountPage />
  if (window.location.pathname === '/pedidos') return <OrdersPage />
  if (window.location.pathname === '/gestao') return <StaffPortal />
  const productMatch = /^\/produto\/(\d+)$/.exec(window.location.pathname)
  if (productMatch) return <ProductPage code={Number(productMatch[1])} />
  const parameters = new URLSearchParams(window.location.search)
  const supplierId = Number(parameters.get('fornecedor'))
  const supplierIds = queryCodes(parameters.get('fornecedores'))
  if (Number.isFinite(supplierId) && supplierId > 0) supplierIds.push(supplierId)
  return <StorePage
    initialSupplierIds={[...new Set(supplierIds)]}
    initialSectionCodes={queryCodes(parameters.get('secoes'))}
    initialProductCodes={queryCodes(parameters.get('produtos'))}
    initialDepartment={parameters.get('departamento') || ''}
    initialSection={parameters.get('secao') || ''}
    initialQuery={parameters.get('busca') || ''}
    initialCartOpen={parameters.get('carrinho') === '1'}
    initialMode={parameters.get('modo') === 'mais-vendidos' ? 'bestsellers' : 'featured'}
  />
}

function StorePage({ initialSupplierIds, initialSectionCodes, initialProductCodes, initialDepartment, initialSection, initialQuery, initialCartOpen, initialMode }: { initialSupplierIds: number[]; initialSectionCodes: number[]; initialProductCodes: number[]; initialDepartment: string; initialSection: string; initialQuery: string; initialCartOpen: boolean; initialMode: 'featured' | 'bestsellers' }) {
  const [products, setProducts] = useState<Product[]>([])
  const [loadingProducts, setLoadingProducts] = useState(true)
  const [productsError, setProductsError] = useState('')
  const [query, setQuery] = useState(initialQuery)
  const [supplierFilter, setSupplierFilter] = useState(initialSupplierIds.length === 1 ? String(initialSupplierIds[0]) : '')
  const [destinationSupplierIds, setDestinationSupplierIds] = useState(initialSupplierIds)
  const [destinationSectionCodes, setDestinationSectionCodes] = useState(initialSectionCodes)
  const [destinationProductCodes, setDestinationProductCodes] = useState(initialProductCodes)
  const [departmentFilter, setDepartmentFilter] = useState(initialDepartment)
  const [sectionFilter, setSectionFilter] = useState(initialSection)
  const [departments, setDepartments] = useState<CatalogDepartment[]>([])
  const [partnerLogos, setPartnerLogos] = useState<Partner[]>([])
  const [expandedDepartment, setExpandedDepartment] = useState(initialDepartment)
  const [catalogMode, setCatalogMode] = useState<'featured' | 'bestsellers'>(initialMode)
  const [visibleCount, setVisibleCount] = useState(25)
  const [cart, setCart] = useState<CartItem[]>([])
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [staffUser, setStaffUser] = useState<StaffUser | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [cartOpen, setCartOpen] = useState(initialCartOpen)
  const [menuOpen, setMenuOpen] = useState(false)
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [sendingOrder, setSendingOrder] = useState(false)
  const [orderError, setOrderError] = useState('')
  const [commercialConditions, setCommercialConditions] = useState<CommercialConditions | null>(null)
  const [quote, setQuote] = useState<OrderQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [loadingConditions, setLoadingConditions] = useState(false)
  const [orderNumber, setOrderNumber] = useState('')
  const [slides, setSlides] = useState<Banner[]>(fallbackSlides)
  const [catalogBanners, setCatalogBanners] = useState<Banner[]>([])
  const [slide, setSlide] = useState(0)
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
    authenticatedFetch(`/api/products?limit=5000&sort=${catalogMode}`, { signal: controller.signal })
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
    if (!products.length) return
    const current = new Map(products.map((product) => [product.id, product]))
    setCart((items) => {
      const refreshed = items.flatMap((item) => {
        const product = current.get(item.id)
        return product && product.unitPrice !== null ? [{ ...product, quantity: item.quantity }] : []
      })
      if (refreshed.length < items.length) setToast('Itens sem preço ou indisponíveis foram removidos do carrinho.')
      return refreshed
    })
  }, [products])
  useEffect(() => {
    if (authReady && !customer) setCart([])
  }, [authReady, customer])
  useEffect(() => {
    if (!authReady) return
    authenticatedFetch('/api/banners').then((response) => response.json()).then((data) => {
      if (Array.isArray(data.banners)) setSlides(data.banners.length ? data.banners : fallbackSlides)
    }).catch(() => undefined)
    authenticatedFetch('/api/banners?placement=catalog').then((response) => response.json()).then((data) => {
      if (Array.isArray(data.banners)) setCatalogBanners(data.banners)
    }).catch(() => undefined)
    authenticatedFetch('/api/catalog/navigation').then((response) => response.json()).then((data) => {
      if (Array.isArray(data.departments)) setDepartments(data.departments)
      if (Array.isArray(data.partners)) setPartnerLogos(data.partners)
    }).catch(() => undefined)
  }, [authReady, customer?.id])
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
      const matchesSupplier = !supplierFilter || String(product.supplierId) === supplierFilter
      const matchesDestinationSupplier = !destinationSupplierIds.length || destinationSupplierIds.includes(product.supplierId)
      const matchesDepartment = !departmentFilter || product.department === departmentFilter
      const matchesSection = !sectionFilter || product.section === sectionFilter
      const matchesDestinationSection = !destinationSectionCodes.length || destinationSectionCodes.includes(product.sectionCode)
      const matchesDestinationProduct = !destinationProductCodes.length || destinationProductCodes.includes(product.code)
      const matchesQuery = !normalized || `${product.name} ${product.brand} ${product.category} ${product.code}`.toLocaleLowerCase('pt-BR').includes(normalized)
      return matchesSupplier && matchesDestinationSupplier && matchesDepartment && matchesSection && matchesDestinationSection && matchesDestinationProduct && matchesQuery
    })
  }, [departmentFilter, destinationProductCodes, destinationSectionCodes, destinationSupplierIds, products, query, sectionFilter, supplierFilter])

  const supplierOptions = useMemo(() => [...new Map(products.map((product) => [product.supplierId, product.brand])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR')), [products])
  const selectedSupplierName = supplierOptions.find(([id]) => String(id) === supplierFilter)?.[1]
  const selectedDepartment = departments.find((department) => department.name === departmentFilter)
  const selectedSection = selectedDepartment?.sections.find((section) => section.name === sectionFilter)
  const headerDepartments = useMemo(() => [...departments].sort((a, b) => b.productCount - a.productCount || a.name.localeCompare(b.name, 'pt-BR')).slice(0, 6), [departments])

  const catalogRows = useMemo(() => {
    const remaining = [...filteredProducts]
    const rows: Array<{ products: Product[]; bannerAfter: Banner | null }> = []
    let displayed = 0
    const takeMatching = (predicate: (product: Product) => boolean, limit: number) => {
      const selected: Product[] = []
      for (let index = 0; index < remaining.length && selected.length < limit;) {
        if (predicate(remaining[index])) selected.push(...remaining.splice(index, 1))
        else index += 1
      }
      return selected
    }
    const productsPerPage = 25
    const bannersPerPage = 2
    for (let pageIndex = 0; remaining.length > 0 && displayed < visibleCount; pageIndex += 1) {
      const pageProductLimit = Math.min(visibleCount, (pageIndex + 1) * productsPerPage)
      const pageBanners = catalogBanners.slice(pageIndex * bannersPerPage, (pageIndex + 1) * bannersPerPage)
      let pageBannerIndex = 0
      let precedingBanner: Banner | null = null
      const nextAvailableBanner = () => {
        while (pageBannerIndex < pageBanners.length) {
          const candidate = pageBanners[pageBannerIndex]
          pageBannerIndex += 1
          const sectionCodes = candidate.destinationType === 'sections' ? candidate.destinationValues : []
          if (!sectionCodes.length || remaining.some((product) => sectionCodes.includes(product.sectionCode))) return candidate
        }
        return null
      }
      while (remaining.length > 0 && displayed < pageProductLimit) {
        const limit = Math.min(5, pageProductLimit - displayed)
        const requiredSections = precedingBanner?.destinationType === 'sections' ? precedingBanner.destinationValues : []
        const upcomingBanner = pageBanners.slice(pageBannerIndex).find((banner) => (
          banner.destinationType !== 'sections' || !banner.destinationValues.length || remaining.some((product) => banner.destinationValues.includes(product.sectionCode))
        )) ?? null
        const reservedSections = requiredSections.length || upcomingBanner?.destinationType !== 'sections' ? [] : upcomingBanner.destinationValues
        const canReserve = Boolean(reservedSections.length && remaining.some((product) => !reservedSections.includes(product.sectionCode)))
        const rowProducts = requiredSections.length
          ? takeMatching((product) => requiredSections.includes(product.sectionCode), limit)
          : canReserve
            ? takeMatching((product) => !reservedSections.includes(product.sectionCode), limit)
            : remaining.splice(0, limit)
        if (!rowProducts.length) {
          precedingBanner = null
          continue
        }
        displayed += rowProducts.length
        const bannerAfter = displayed < pageProductLimit && remaining.length ? nextAvailableBanner() : null
        rows.push({ products: rowProducts, bannerAfter })
        precedingBanner = bannerAfter
      }
    }
    return rows
  }, [catalogBanners, filteredProducts, visibleCount])
  const cartCount = cart.length
  const cartTotal = cart.reduce((sum, item) => sum + (item.unitPrice ?? 0) * item.quantity, 0)
  const minimumOrder = 200
  const checkoutTotal = quote?.total ?? cartTotal
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
    setSupplierFilter('')
    setDepartmentFilter('')
    setSectionFilter('')
    setDestinationSupplierIds([])
    setDestinationSectionCodes([])
    setDestinationProductCodes([])
    setCatalogMode('featured')
    if (window.location.search) window.history.replaceState({}, '', '/')
  }

  function clearDestinationFilters() {
    setDestinationSupplierIds([])
    setDestinationSectionCodes([])
    setDestinationProductCodes([])
  }

  function selectSearch(value: string) {
    setQuery(value)
    setSupplierFilter('')
    setDepartmentFilter('')
    setSectionFilter('')
    setExpandedDepartment('')
    clearDestinationFilters()
    setCatalogMode('featured')
    setVisibleCount(25)
    window.history.replaceState({}, '', value ? `/?busca=${encodeURIComponent(value)}#produtos` : '/')
  }

  function selectSupplier(value: string) {
    if (!value) {
      clearFilters()
      return
    }
    setQuery('')
    setSupplierFilter(value)
    setDepartmentFilter('')
    setSectionFilter('')
    setExpandedDepartment('')
    clearDestinationFilters()
    setCatalogMode('featured')
    setVisibleCount(25)
    window.history.replaceState({}, '', `/?fornecedor=${value}#produtos`)
  }

  function selectDepartment(name: string) {
    setQuery('')
    setSupplierFilter('')
    clearDestinationFilters()
    setCatalogMode('featured')
    setDepartmentFilter(name)
    setSectionFilter('')
    setExpandedDepartment(name)
    setVisibleCount(25)
    setMenuOpen(false)
    window.history.replaceState({}, '', `/?departamento=${encodeURIComponent(name)}#produtos`)
    window.setTimeout(() => productsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  function selectSection(departmentName: string, sectionName: string) {
    setQuery('')
    setSupplierFilter('')
    clearDestinationFilters()
    setCatalogMode('featured')
    setDepartmentFilter(departmentName)
    setSectionFilter(sectionName)
    setVisibleCount(25)
    setMenuOpen(false)
    window.history.replaceState({}, '', `/?departamento=${encodeURIComponent(departmentName)}&secao=${encodeURIComponent(sectionName)}#produtos`)
    window.setTimeout(() => productsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  function selectPartner(partner: Partner) {
    selectSupplier(String(partner.supplierId))
    window.setTimeout(() => productsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  function bannerTarget(banner: Banner) {
    const codes = banner.destinationValues.join(',')
    if (banner.destinationType === 'sections') return `/?secoes=${codes}#produtos`
    if (banner.destinationType === 'products') return `/?produtos=${codes}#produtos`
    if (banner.destinationType === 'suppliers') return `/?fornecedores=${codes}#produtos`
    return banner.navigationPath || '/#produtos'
  }

  function changeQuantity(id: number, delta: number) {
    setCart((current) => current.flatMap((item) => {
      if (item.id !== id) return [item]
      const nextQuantity = item.quantity + delta
      return nextQuantity > 0 ? [{ ...item, quantity: nextQuantity }] : []
    }))
  }

  function setQuantity(id: number, quantity: number) {
    setCart((current) => current.map((item) => item.id === id ? { ...item, quantity } : item))
  }

  function removeFromCart(id: number) {
    setCart((current) => current.filter((item) => item.id !== id))
  }

  function showBestSellers() {
    setCatalogMode('bestsellers')
    setMenuOpen(false)
    window.setTimeout(() => productsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  // Sem plano informado, a API escolhe o plano de menor total para o cliente.
  async function requestQuote(paymentPlan?: string) {
    if (!cart.length) return
    setQuoting(true)
    setOrderError('')
    try {
      const response = await authenticatedFetch('/api/customer/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentPlan, items: cart.map((item) => ({ productId: item.id, quantity: item.quantity })) }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message)
      setQuote(data)
    } catch (error) {
      setQuote(null)
      setOrderError(error instanceof Error ? error.message : 'Não foi possível calcular o pedido.')
    } finally { setQuoting(false) }
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
      setQuote(null)
      setCartOpen(false)
      setCheckoutOpen(true)
      void requestQuote()
    } catch (error) {
      setOrderError(error instanceof Error ? error.message : 'Não foi possível consultar suas condições comerciais.')
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
          <a className="logo" href="/" aria-label="Ômega Distribuidora — início sem filtros"><img src="/assets/omega-logo.png" alt="Ômega Distribuidora" /></a>
          <label className="search-box"><Search size={21} /><input value={query} onChange={(event) => selectSearch(event.target.value)} onFocus={() => productsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} placeholder="Busque produtos, marcas ou código" aria-label="Buscar produtos" />{query && <button onClick={() => selectSearch('')} aria-label="Limpar busca"><X size={18} /></button>}</label>
          <a className="account-button" href={staffUser ? '/gestao' : customer ? '/pedidos' : '/conta'}><CircleUserRound /><span><small>{staffUser ? 'Painel interno' : customer ? 'Meus pedidos' : 'Área do cliente'}</small><strong>{staffUser ? `${staffUser.name} · ${staffUser.role}` : customer ? `Bem-vindo(a), ${customer.tradeName || customer.legalName}` : 'Entrar ou cadastrar'}</strong></span></a>
          {(customer || staffUser) && <button className="logout-button" onClick={logout} aria-label="Sair da conta" title="Sair da conta"><LogOut size={19} /><span>Sair</span></button>}
          <button className="cart-button" onClick={() => setCartOpen(true)} aria-label={`Abrir carrinho com ${cartCount} ${cartCount === 1 ? 'item' : 'itens'}`}><span className="cart-icon"><ShoppingCart />{cartCount > 0 && <b>{cartCount}</b>}</span><span><small>Meu carrinho</small><strong>{cartCount ? `${cartCount} ${cartCount === 1 ? 'item' : 'itens'}` : 'Está vazio'}</strong></span></button>
        </div>
        <nav className="main-nav" aria-label="Departamentos e seções">
          <div className="container nav-inner department-nav">
            <button className="categories-button" onClick={() => setMenuOpen(true)}><Menu size={19} /> Departamentos <ChevronDown size={17} /></button>
            {headerDepartments.map((department) => <div className="department-nav-item" key={department.code || department.name}>
              <button className={departmentFilter === department.name ? 'active' : ''} onClick={() => selectDepartment(department.name)}>{formatCatalogName(department.name)}<ChevronDown size={14} /></button>
              <div className="department-dropdown">
                <button className="department-all" onClick={() => selectDepartment(department.name)}>Ver todos em {formatCatalogName(department.name)}</button>
                <div>{department.sections.map((section) => <button key={`${department.name}-${section.code || section.name}`} onClick={() => selectSection(department.name, section.name)}>{formatCatalogName(section.name)}<small>{section.productCount}</small></button>)}</div>
              </div>
            </div>)}
            <div className="partners-nav-item"><a href="#parceiros">Parceiros</a>{partnerLogos.length > 0 && <div className="partners-dropdown">{partnerLogos.map((partner) => <button key={partner.supplierId} onClick={() => selectPartner(partner)}><img src={partner.logo} alt="" /><span>{partner.name}</span></button>)}</div>}</div>
            <a className="nav-support" href={whatsappUrl} target="_blank" rel="noreferrer">Atendimento</a>
          </div>
        </nav>
      </header>

      {customer && !customer.canOrder && <div className="store-pending-banner"><LoaderCircle /><div><strong>Cadastro em análise</strong><span>Você já pode consultar o catálogo e os preços. A compra será liberada após a validação do seu cadastro.</span></div><a href="/pedidos">Ver meu cadastro</a></div>}

      <main id="top">
        <section className="hero" aria-label="Destaques"><div className="hero-track" style={{ transform: `translate3d(-${slide * 100}%, 0, 0)` }}>{slides.map((item) => <a key={item.id} className="hero-slide" href={bannerTarget(item)}><img src={item.imageUrl} alt={item.altText} /></a>)}</div>{slides.length > 1 && <><button className="slider-arrow prev" aria-label="Banner anterior" onClick={() => setSlide((slide - 1 + slides.length) % slides.length)}><ChevronLeft /></button><button className="slider-arrow next" aria-label="Próximo banner" onClick={() => setSlide((slide + 1) % slides.length)}><ChevronRight /></button><div className="slider-dots">{slides.map((item, index) => <button key={item.id} className={index === slide ? 'active' : ''} onClick={() => setSlide(index)} aria-label={`Ir para banner ${index + 1}`} />)}</div></>}</section>

        <section className={`container products-section ${selectedDepartment ? 'has-taxonomy' : 'catalog-home'}`} id="produtos" ref={productsRef}>
          {selectedDepartment && <aside className="taxonomy-sidebar" aria-label="Departamentos e seções">
            <div className="taxonomy-sidebar-title"><SlidersHorizontal size={18} /><div><strong>Departamentos</strong><span>Escolha uma seção</span></div></div>
            <button className={!departmentFilter ? 'active taxonomy-all' : 'taxonomy-all'} onClick={clearFilters}>Todos os produtos</button>
            <div className="taxonomy-list">{departments.map((department) => {
              const open = expandedDepartment === department.name || departmentFilter === department.name
              return <div className={`taxonomy-department ${open ? 'open' : ''}`} key={department.code || department.name}>
                <button className={departmentFilter === department.name && !sectionFilter ? 'active' : ''} onClick={() => selectDepartment(department.name)}><span>{formatCatalogName(department.name)}<small>{department.productCount} produtos</small></span><ChevronDown size={17} /></button>
                {open && <div className="taxonomy-sections">{department.sections.map((section) => <button className={sectionFilter === section.name ? 'active' : ''} key={`${department.name}-${section.code || section.name}`} onClick={() => selectSection(department.name, section.name)}><span>{formatCatalogName(section.name)}</span><small>{section.productCount}</small></button>)}</div>}
              </div>
            })}</div>
          </aside>}
          <div className="section-heading"><div><span className="eyebrow">DEPARTAMENTO → SEÇÃO → PRODUTOS</span><h1>{selectedSupplierName ? `Produtos ${selectedSupplierName}` : query ? `Resultados para “${query}”` : selectedSection ? formatCatalogName(selectedSection.name) : selectedDepartment ? formatCatalogName(selectedDepartment.name) : catalogMode === 'bestsellers' ? 'Mais vendidos nos últimos 7 dias' : 'Todos os produtos'}</h1>{selectedDepartment && <p className="taxonomy-breadcrumb">{formatCatalogName(selectedDepartment.name)}{selectedSection ? ` → ${formatCatalogName(selectedSection.name)}` : ''}</p>}</div><span className="result-count">{filteredProducts.length} {filteredProducts.length === 1 ? 'produto' : 'produtos'}</span></div>
          <div className="catalog-filters"><span className="filter-title"><SlidersHorizontal size={18} /> Refinar catálogo</span><label>Fornecedor<select value={supplierFilter} onChange={(event) => selectSupplier(event.target.value)}><option value="">Todos os fornecedores</option>{supplierOptions.map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label><label>Departamento<select value={departmentFilter} onChange={(event) => event.target.value ? selectDepartment(event.target.value) : clearFilters()}><option value="">Todos os departamentos</option>{departments.map((department) => <option value={department.name} key={department.code || department.name}>{formatCatalogName(department.name)}</option>)}</select></label><label>Seção<select value={sectionFilter} onChange={(event) => event.target.value ? selectSection(departmentFilter, event.target.value) : selectDepartment(departmentFilter)} disabled={!selectedDepartment}><option value="">Todas as seções</option>{selectedDepartment?.sections.map((section) => <option value={section.name} key={section.code || section.name}>{formatCatalogName(section.name)}</option>)}</select></label><button onClick={clearFilters}>Limpar filtros</button></div>
          {loadingProducts ? <div className="catalog-loading"><LoaderCircle className="spin" /><span>Carregando produtos...</span></div> : productsError ? <div className="empty-results"><ImageOff size={36} /><h2>Catálogo indisponível</h2><p>{productsError}</p><button className="primary-button" onClick={() => window.location.reload()}>Tentar novamente</button></div> : catalogRows.length > 0 ? <><div className="catalog-flow">{catalogRows.map((row, rowIndex) => <div className="catalog-row-group" key={`row-${rowIndex}`}><div className="product-grid">{row.products.map((product, productIndex) => <ProductCard key={product.id} product={product} rank={catalogMode === 'bestsellers' ? rowIndex * 5 + productIndex + 1 : undefined} addToCart={addToCart} changeQuantity={changeQuantity} quantity={cart.find((item) => item.id === product.id)?.quantity ?? 0} authenticated={Boolean(customer)} canOrder={Boolean(customer?.canOrder)} />)}</div>{row.bannerAfter && <a className="catalog-banner" href={bannerTarget(row.bannerAfter)}><img src={row.bannerAfter.imageUrl} alt={row.bannerAfter.altText} /></a>}</div>)}</div>{visibleCount < filteredProducts.length && <button className="load-more" onClick={() => setVisibleCount((count) => count + 25)}>Ver mais produtos <ArrowRight size={18} /></button>}</> : <div className="empty-results"><Search size={36} /><h2>Nenhum produto encontrado</h2><p>Tente combinar outros filtros ou explore todo o catálogo.</p><button className="primary-button" onClick={clearFilters}>Limpar filtros</button></div>}
        </section>

        <section className="container benefits" id="atendimento"><article><span><Truck /></span><div><strong>Entrega programada</strong><p>Agilidade e segurança no seu abastecimento</p></div></article><article><span><ShieldCheck /></span><div><strong>Compra segura</strong><p>Seus dados e seu pedido protegidos</p></div></article><article><span><PackageCheck /></span><div><strong>Quantidade sob medida</strong><p>Compre respeitando o múltiplo de cada produto</p></div></article><a className="benefit-card" href={whatsappUrl} target="_blank" rel="noreferrer" aria-label="Falar com o atendimento da Ômega pelo WhatsApp"><span><Headphones /></span><div><strong>Atendimento próximo</strong><p>Fale agora com nossa equipe pelo WhatsApp</p></div></a></section>

        <section className="brands-section" id="parceiros"><div className="container"><div className="section-heading"><div><span className="eyebrow">BONS NEGÓCIOS COMEÇAM COM BOAS PARCERIAS</span><h2>Nossos parceiros</h2><p>Selecione uma marca para ver todos os produtos desse fornecedor.</p></div></div><div className="brands-grid">{partnerLogos.map((partner) => <button className="brand-card" onClick={() => selectPartner(partner)} key={partner.supplierId} aria-label={`Filtrar produtos de ${partner.name}`}><img src={partner.logo} alt={`Logo ${partner.name}`} loading="lazy" /><span>{partner.productCount} produtos</span></button>)}</div></div></section>
      </main>

      <footer><div className="container footer-grid"><div className="footer-brand"><img src="/assets/omega-logo.png" alt="Ômega Distribuidora" /><p>Distribuindo mais do que produtos: parcerias de sucesso.</p></div><div><strong>Institucional</strong><a href="#top">Sobre a Ômega</a><a href="#parceiros">Nossos parceiros</a><a href={whatsappUrl} target="_blank" rel="noreferrer">Fale conosco</a></div><div><strong>Atendimento</strong><span>Segunda a sexta, 8h às 17h</span><a href={whatsappUrl} target="_blank" rel="noreferrer">WhatsApp: (85) 9202-0207</a></div><div><strong>Compra protegida</strong><p className="security-copy"><LockKeyhole size={19} /> Ambiente seguro para seus pedidos.</p></div></div><div className="container footer-bottom"><span>© 2026 Ômega Distribuidora. Todos os direitos reservados.</span><span>Preços unitários sujeitos à confirmação comercial.</span></div></footer>

      {customer?.canOrder && <button className={`minimum-order-widget ${minimumRemaining === 0 ? 'complete' : ''}`} onClick={() => setCartOpen(true)} aria-label={`Carrinho em ${money.format(cartTotal)} de um pedido mínimo de ${money.format(minimumOrder)}`}><span><ShoppingCart size={18} /> Pedido mínimo</span><strong>{money.format(cartTotal)} <small>/ {money.format(minimumOrder)}</small></strong><i><b style={{ width: `${minimumProgress}%` }} /></i><em>{minimumRemaining > 0 ? `Faltam ${money.format(minimumRemaining)}` : 'Mínimo atingido'}</em></button>}

      {menuOpen && <div className="overlay" onMouseDown={() => setMenuOpen(false)}><aside className="side-panel menu-panel department-drawer" onMouseDown={(event) => event.stopPropagation()}><div className="drawer-heading"><div><span className="eyebrow">CATÁLOGO</span><h2>Departamentos</h2></div><button className="icon-btn" onClick={() => setMenuOpen(false)}><X /></button></div><button className={!departmentFilter ? 'active drawer-all-products' : 'drawer-all-products'} onClick={() => { clearFilters(); setMenuOpen(false); window.setTimeout(() => productsRef.current?.scrollIntoView({ behavior: 'smooth' }), 50) }}><Store size={20} />Todos os produtos<ChevronRight size={18} /></button><div className="drawer-taxonomy">{departments.map((department) => { const open = expandedDepartment === department.name || departmentFilter === department.name; return <div className="drawer-department" key={department.code || department.name}><button className={departmentFilter === department.name && !sectionFilter ? 'active' : ''} onClick={() => setExpandedDepartment(open ? '' : department.name)}><span>{formatCatalogName(department.name)}<small>{department.productCount} produtos</small></span><ChevronDown className={open ? 'rotated' : ''} size={18} /></button>{open && <div>{<button className="drawer-department-all" onClick={() => selectDepartment(department.name)}>Todos em {formatCatalogName(department.name)}</button>}{department.sections.map((section) => <button className={sectionFilter === section.name ? 'active' : ''} key={`${department.name}-${section.code || section.name}`} onClick={() => selectSection(department.name, section.name)}>{formatCatalogName(section.name)}<small>{section.productCount}</small></button>)}</div>}</div> })}</div><a className="drawer-partners" href="#parceiros" onClick={() => setMenuOpen(false)}>Parceiros<ChevronRight size={18} /></a>{(customer || staffUser) && <button className="menu-logout" onClick={logout}><LogOut size={20} />Sair da conta</button>}</aside></div>}

      {cartOpen && <div className="overlay" onMouseDown={() => setCartOpen(false)}><aside className="side-panel cart-panel" onMouseDown={(event) => event.stopPropagation()}><div className="drawer-heading"><div><span className="eyebrow">SEU PEDIDO</span><h2>Meu carrinho</h2></div><button className="icon-btn" onClick={() => setCartOpen(false)}><X /></button></div>{cart.length === 0 ? <div className="empty-cart"><span><ShoppingCart /></span><h3>Seu carrinho está vazio</h3><p>Explore o catálogo e adicione os produtos que seu negócio precisa.</p><button className="primary-button" onClick={() => setCartOpen(false)}>Explorar produtos</button></div> : <><div className="cart-items">{cart.map((item) => <div className="cart-item" key={item.id}><div className="cart-product-image">{item.image ? <img src={item.image} alt="" /> : <ImageOff />}</div><div className="cart-product-info"><strong>{item.name}</strong><small>Vendido em múltiplos de {item.salesMultiple} unidades</small><span>{unitMoney.format(item.unitPrice ?? 0)} / unidade</span><div className="quantity-control"><button onClick={() => changeQuantity(item.id, -item.salesMultiple)} aria-label={`Remover ${item.salesMultiple} unidades`}><Minus size={15} /></button><CartQuantityField item={item} onChange={setQuantity} onInvalid={(message) => setToast(message)} /><button onClick={() => changeQuantity(item.id, item.salesMultiple)} aria-label={`Adicionar ${item.salesMultiple} unidades`}><Plus size={15} /></button><button className="remove-item" onClick={() => removeFromCart(item.id)} aria-label="Remover item"><Trash2 size={16} /></button></div></div></div>)}</div><div className="cart-summary"><div><span>Subtotal estimado</span><strong>{money.format(cartTotal)}</strong></div><div className={`cart-minimum ${minimumRemaining === 0 ? 'complete' : ''}`}><span>{minimumRemaining > 0 ? `Adicione mais ${money.format(minimumRemaining)} para atingir o mínimo.` : 'Pedido mínimo atingido.'}</span><i><b style={{ width: `${minimumProgress}%` }} /></i></div><p>Pedido para {customer?.tradeName || customer?.legalName}. Os preços exibidos são os menores entre os seus planos de pagamento; o total é recalculado conforme o plano escolhido na finalização. Frete confirmado pela equipe.</p><button className="checkout-button" onClick={beginCheckout} disabled={minimumRemaining > 0 || loadingConditions}>{loadingConditions ? <LoaderCircle className="spin" /> : minimumRemaining > 0 ? `Mínimo de ${money.format(minimumOrder)}` : 'Finalizar pedido'} {!loadingConditions && <ArrowRight size={19} />}</button>{orderError && <span className="field-error cart-condition-error">{orderError}</span>}<button className="keep-shopping" onClick={() => setCartOpen(false)}>Continuar comprando</button></div></>}</aside></div>}

      {checkoutOpen && customer && commercialConditions && <div className="overlay modal-overlay" onMouseDown={() => setCheckoutOpen(false)}><div className="checkout-modal" onMouseDown={(event) => event.stopPropagation()}><div className="drawer-heading"><div><span className="eyebrow">CONFIRMAR PEDIDO</span><h2>Identificação do cliente</h2></div><button className="icon-btn" onClick={() => setCheckoutOpen(false)}><X /></button></div><form onSubmit={submitOrder}><div className="checkout-customer"><CircleUserRound /><div><strong>{customer.tradeName || customer.legalName}</strong><span>{formatDocument(customer.document)} · {customer.email}</span></div><a href="/conta">Alterar</a></div><label>Plano de pagamento<select name="paymentPlan" value={quote?.paymentPlan.code ?? ''} onChange={(event) => requestQuote(event.target.value)} disabled={quoting} required>{!quote && <option value="" disabled>Calculando...</option>}{(quote?.planTotals ?? commercialConditions.paymentPlans.map((plan) => ({ ...plan, total: null }))).map((plan) => <option key={plan.code} value={plan.code} disabled={quote !== null && plan.total === null}>{plan.label}{plan.total !== null ? ` · ${money.format(plan.total)}` : quote ? ' · indisponível' : ''}</option>)}</select></label><div className={`checkout-credit ${checkoutTotal > commercialConditions.availableCredit ? 'exceeded' : ''}`}><span>Crédito disponível</span><strong>{money.format(commercialConditions.availableCredit)}</strong>{commercialConditions.availableCredit < commercialConditions.creditLimit && <small>Limite de {money.format(commercialConditions.creditLimit)}, com {money.format(commercialConditions.creditLimit - commercialConditions.availableCredit)} comprometidos em títulos e pedidos em aberto.</small>}<small>{checkoutTotal > commercialConditions.availableCredit ? `Reduza o pedido em ${money.format(checkoutTotal - commercialConditions.availableCredit)}.` : `Após este pedido: ${money.format(commercialConditions.availableCredit - checkoutTotal)}`}</small></div><label>Observações<textarea name="notes" placeholder="Informe preferências de entrega, contato ou condições." rows={3} /></label>{orderError && <span className="field-error">{orderError}</span>}<div className="checkout-total"><span>Total no plano escolhido</span><strong>{quoting ? <LoaderCircle className="spin" /> : money.format(checkoutTotal)}</strong></div><button className="checkout-button" type="submit" disabled={sendingOrder || quoting || !quote || checkoutTotal < minimumOrder || checkoutTotal > commercialConditions.availableCredit || commercialConditions.paymentPlans.length === 0}>{sendingOrder ? <LoaderCircle className="spin" /> : <>Enviar pedido <ArrowRight size={19} /></>}</button></form></div></div>}

      {orderNumber && <div className="overlay modal-overlay"><div className="success-modal"><span><PackageCheck /></span><h2>Pedido recebido!</h2><p>Sua solicitação foi registrada como <strong>{orderNumber}</strong>. Nossa equipe comercial fará a análise e associará o número do pedido no WinThor.</p><a className="primary-button" href="/pedidos">Ver meus pedidos</a><button className="secondary-button" onClick={() => setOrderNumber('')}>Continuar comprando</button></div></div>}
      {toast && <div className="toast"><PackageCheck size={19} />{toast}</div>}
    </div>
  )
}

function CartQuantityField({ item, onChange, onInvalid }: {
  item: CartItem
  onChange: (id: number, quantity: number) => void
  onInvalid: (message: string) => void
}) {
  const [draft, setDraft] = useState(String(item.quantity))
  useEffect(() => setDraft(String(item.quantity)), [item.quantity])

  function commit() {
    const quantity = Number(draft)
    const multiple = Math.max(1, item.salesMultiple)
    if (!Number.isSafeInteger(quantity) || quantity < multiple || quantity > 100000 || quantity % multiple !== 0) {
      setDraft(String(item.quantity))
      onInvalid(`Digite uma quantidade entre ${multiple} e 100.000, em múltiplos de ${multiple}.`)
      return
    }
    setDraft(String(quantity))
    onChange(item.id, quantity)
  }

  return <label className="cart-quantity-field" aria-label={`Quantidade de ${item.name}`}>
    <input
      type="text"
      inputMode="numeric"
      value={draft}
      onChange={(event) => setDraft(event.target.value.replace(/\D/g, '').slice(0, 6))}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
    />
    <span>un.</span>
  </label>
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
        {authenticated && product.unitPrice !== null && <div className="price-row unit-price-row"><div><strong>{unitMoney.format(product.unitPrice)}</strong><small>por unidade</small></div></div>}
        {authenticated && product.unitPrice === null ? <button className="buy-button login-to-buy" disabled>Preço indisponível</button> : quantity > 0 && authenticated && canOrder ? <div className="product-quantity-control"><button onClick={() => changeQuantity(product.id, -product.salesMultiple)} aria-label={`Remover ${product.salesMultiple} unidades`}><Minus size={18} /></button><span><strong>{quantity}</strong><small>unidades</small></span><button onClick={() => changeQuantity(product.id, product.salesMultiple)} aria-label={`Adicionar ${product.salesMultiple} unidades`}><Plus size={18} /></button></div> : <button className={`buy-button ${!authenticated || !canOrder ? 'login-to-buy' : ''}`} onClick={() => addToCart(product)}>{!authenticated ? <><LockKeyhole size={17} />Entrar para ver preço</> : !canOrder ? <><LoaderCircle size={17} />Cadastro em análise</> : <><ShoppingCart size={18} />Adicionar {product.salesMultiple} {product.salesMultiple === 1 ? 'unidade' : 'unidades'}</>}</button>}
      </div>
    </article>
  )
}

export default App
