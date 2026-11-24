import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft, CircleUserRound, ImageOff, LoaderCircle, LockKeyhole, LogOut,
  MapPin, Menu, Minus, Plus, Search, ShoppingCart, Warehouse, X, ZoomIn,
} from 'lucide-react'
import { authenticatedFetch } from './api'
import DepartmentDrawer from './DepartmentDrawer'
import { campaignQuantitiesForCart, productPriceForQuantity, unitMoney } from './data'
import { formatCatalogName } from './catalog'
import { supabase } from './supabase'
import { PageSkeleton } from './Skeleton'
import type { CartItem, CatalogDepartment, Customer, Partner, Product, StaffUser } from './types'

const whatsappUrl = `https://wa.me/558592020207?text=${encodeURIComponent('Olá! Venho do e-Commerce da Ômega Distribuidora e preciso de atendimento!')}`

export default function ProductPage({ code }: { code: number }) {
  const [departmentsOpen, setDepartmentsOpen] = useState(false)
  const [product, setProduct] = useState<Product | null>(null)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [staffUser, setStaffUser] = useState<StaffUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [zoomed, setZoomed] = useState(false)
  const [quantity, setQuantity] = useState(0)
  const [quantityDraft, setQuantityDraft] = useState('0')
  const [checkingStock, setCheckingStock] = useState(false)
  const [quantityError, setQuantityError] = useState('')
  const stockCheckRef = useRef(false)
  const [search, setSearch] = useState('')
  const [departments, setDepartments] = useState<CatalogDepartment[]>([])
  const [partners, setPartners] = useState<Partner[]>([])
  const [cart, setCart] = useState<CartItem[]>([])

  useEffect(() => {
    Promise.all([
      authenticatedFetch('/api/auth/me').then(async (response) => response.ok ? response.json() : null),
      authenticatedFetch(`/api/products/${code}`).then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.message)
        return data.product as Product
      }),
    ]).then(async ([account, loadedProduct]) => {
      setCustomer(account?.accountType === 'customer' ? account.customer : null)
      setStaffUser(account?.accountType === 'staff' ? account.user : null)
      setProduct(loadedProduct)
      let onlineCart: CartItem[] = []
      if (account?.accountType === 'customer' && account.customer?.canOrder) {
        const cartResponse = await authenticatedFetch('/api/customer/cart')
        const cartData = await cartResponse.json().catch(() => ({ items: [] }))
        if (cartResponse.ok && Array.isArray(cartData.items)) onlineCart = cartData.items
      }
      setCart(onlineCart)
      const storedQuantity = onlineCart.find((item) => item.id === loadedProduct.id)?.quantity || 0
      setQuantity(storedQuantity)
      setQuantityDraft(String(storedQuantity))
    }).catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Não foi possível carregar o produto.'))
      .finally(() => setLoading(false))
  }, [code])

  useEffect(() => {
    fetch('/api/catalog/navigation').then((response) => response.json()).then((data) => {
      if (Array.isArray(data.departments)) setDepartments(data.departments)
      if (Array.isArray(data.partners)) setPartners(data.partners)
    }).catch(() => undefined)
  }, [])

  async function updateCart(nextQuantity: number) {
    if (!product || stockCheckRef.current) return false
    const multiple = Math.max(1, product.salesMultiple)
    if (nextQuantity > 0 && (!Number.isSafeInteger(nextQuantity) || nextQuantity < multiple || nextQuantity > 100000 || nextQuantity % multiple !== 0)) {
      setQuantityDraft(String(quantity))
      setQuantityError(`Digite uma quantidade entre ${multiple} e 100.000, em múltiplos de ${multiple}.`)
      return false
    }
    setQuantityError('')
    stockCheckRef.current = true
    setCheckingStock(true)
    try {
      const response = await authenticatedFetch(`/api/customer/cart/${product.id}`, nextQuantity > 0 ? {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantity: nextQuantity }),
      } : { method: 'DELETE' })
      const data = response.status === 204 ? null : await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.message || 'Não foi possível atualizar o carrinho agora.')
      setCart((current) => {
        const next = current.filter((item) => item.id !== product.id)
        if (nextQuantity > 0) next.push({ ...product, quantity: nextQuantity })
        return next
      })
      setQuantity(nextQuantity)
      setQuantityDraft(String(nextQuantity))
      return true
    } catch (requestError) {
      setQuantityDraft(String(quantity))
      setQuantityError(requestError instanceof Error ? requestError.message : 'Não foi possível atualizar o carrinho agora.')
      return false
    } finally {
      stockCheckRef.current = false
      setCheckingStock(false)
    }
  }

  async function commitQuantity() {
    const nextQuantity = Number(quantityDraft)
    if (!Number.isSafeInteger(nextQuantity) || nextQuantity <= 0) {
      setQuantityDraft(String(quantity))
      setQuantityError(`Digite uma quantidade válida em múltiplos de ${Math.max(1, product?.salesMultiple || 1)}.`)
      return
    }
    if (!(await updateCart(nextQuantity))) setQuantityDraft(String(quantity))
  }

  function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    window.location.href = `/?busca=${encodeURIComponent(search.trim())}#produtos`
  }

  async function logout() {
    await Promise.all([
      supabase.auth.signOut(),
      fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined),
      fetch('/api/staff/auth/logout', { method: 'POST' }).catch(() => undefined),
    ])
    window.location.reload()
  }

  if (loading) return <PageSkeleton />
  if (!product || error) return <main className="product-page-state"><ImageOff /><h1>Produto indisponível</h1><p>{error}</p><a href="/"><ArrowLeft /> Voltar para a loja</a></main>

  const cartCount = cart.length
  const campaignQuantities = campaignQuantitiesForCart(cart)
  const campaignPrice = productPriceForQuantity(product, quantity, campaignQuantities)
  const nextOffer = [...(product.campaignOffers || [])].sort((a, b) => b.discountPercent - a.discountPercent)[0]

  return <div className="app-shell product-page">
    <div className="topbar"><div className="container topbar-inner"><p>{customer ? <>Bem-vindo(a), <strong>{customer.tradeName || customer.legalName}</strong></> : staffUser ? <>Sessão de gestão: <strong>{staffUser.name}</strong></> : <>Tudo o que você precisa, <strong>sempre por perto.</strong></>}</p><div className="topbar-links"><span><MapPin size={15} /> Entregamos em todo o Ceará</span><a href={whatsappUrl} target="_blank" rel="noreferrer">Central de ajuda</a></div></div></div>
    <header className="site-header">
      <div className="container header-main">
        <a className="mobile-menu-btn icon-btn" href="/#produtos" aria-label="Voltar ao catálogo"><Menu /></a>
        <a className="logo" href="/" aria-label="Ômega Distribuidora — início"><img src="/assets/omega-logo.png" alt="Ômega Distribuidora" /></a>
        <form className="search-box" onSubmit={submitSearch}><Search size={21} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Busque produtos, marcas ou código" aria-label="Buscar produtos" /><button aria-label="Buscar"><Search size={18} /></button></form>
        <a className="account-button" href={staffUser ? '/gestao' : customer ? '/pedidos' : '/conta'}><CircleUserRound /><span><small>{staffUser ? 'Painel interno' : customer ? 'Meus pedidos' : 'Área do cliente'}</small><strong>{staffUser ? `${staffUser.name} · ${staffUser.role}` : customer ? `Bem-vindo(a), ${customer.tradeName || customer.legalName}` : 'Entrar ou cadastrar'}</strong></span></a>
        {(customer || staffUser) && <button className="logout-button" onClick={logout} aria-label="Sair da conta"><LogOut size={19} /><span>Sair</span></button>}
        <a className="cart-button" href="/?carrinho=1" aria-label={`Abrir carrinho com ${cartCount} ${cartCount === 1 ? 'item' : 'itens'}`}><span className="cart-icon"><ShoppingCart />{cartCount > 0 && <b>{cartCount}</b>}</span><span><small>Meu carrinho</small><strong>{cartCount ? `${cartCount} ${cartCount === 1 ? 'item' : 'itens'}` : 'Está vazio'}</strong></span></a>
      </div>
      <nav className="main-nav" aria-label="Departamentos e seções"><div className="container nav-inner department-nav"><button className="categories-button" onClick={() => setDepartmentsOpen(true)}><Menu size={19} /> Departamentos</button>{[...departments].sort((a, b) => b.productCount - a.productCount).slice(0, 6).map((department) => <div className="department-nav-item" key={department.code || department.name}><a className="product-department-link" href={`/?departamento=${encodeURIComponent(department.name)}#produtos`}>{formatCatalogName(department.name)}</a><div className="department-dropdown"><a className="department-all" href={`/?departamento=${encodeURIComponent(department.name)}#produtos`}>Ver todos em {formatCatalogName(department.name)}</a><div>{department.sections.map((section) => <a key={`${department.name}-${section.code || section.name}`} href={`/?departamento=${encodeURIComponent(department.name)}&secao=${encodeURIComponent(section.name)}#produtos`}>{formatCatalogName(section.name)}<small>{section.productCount}</small></a>)}</div></div></div>)}<a className="nav-campaigns" href="/campanhas">Campanhas</a><div className="partners-nav-item"><a href="/#parceiros">Parceiros</a>{partners.length > 0 && <div className="partners-dropdown">{partners.map((partner) => <a key={partner.supplierId} href={`/?fornecedor=${partner.supplierId}#produtos`}><img src={partner.logo} alt="" /><span>{partner.name}</span></a>)}</div>}</div><a className="nav-support" href={whatsappUrl} target="_blank" rel="noreferrer">Atendimento</a></div></nav>
      {departmentsOpen && <DepartmentDrawer departments={departments} onClose={() => setDepartmentsOpen(false)} />}
    </header>

    <main className="product-page-main">
      <a className="product-back-link" href="/#produtos"><ArrowLeft /> Voltar ao catálogo</a>
      <div className="product-detail-layout">
        <section className="product-detail-image">
          {product.image ? <ProductImageMagnifier src={product.image} alt={product.name} onOpen={() => setZoomed(true)} /> : <div className="product-detail-no-image"><ImageOff /><span>Produto sem foto</span></div>}
        </section>
        <section className="product-detail-content">
          <span className="eyebrow">CÓDIGO {product.code}</span>
          <h1>{product.name}</h1>
          <p className="product-detail-brand">{product.brand}</p>
          {nextOffer && <div className="product-detail-campaign"><strong>{nextOffer.discountPercent.toLocaleString('pt-BR')}% de desconto</strong><span>A partir de {nextOffer.minQuantity} unidades{nextOffer.maxQuantity ? ` até ${nextOffer.maxQuantity}` : ''} · campanha #{nextOffer.campaignCode}</span></div>}
          {customer && product.unitPrice !== null ? <div className="product-detail-price">{campaignPrice.discountPercent > 0 && <del>{unitMoney.format(product.unitPrice)}</del>}<strong>{unitMoney.format(campaignPrice.unitPrice ?? product.unitPrice)}</strong><span>por unidade{product.planPrices?.[0] ? ` · ${product.planPrices[0].label}` : ''}</span></div> : customer ? <p className="product-detail-unavailable">Preço indisponível para o seu cadastro. Fale com a equipe Ômega.</p> : <a className="product-detail-login" href="/conta"><LockKeyhole /> Entrar para ver preço</a>}{customer && product.planPrices && product.planPrices.length > 1 && <ul className="product-plan-prices">{product.planPrices.map((plan) => <li key={plan.code}><span>{plan.label}</span><strong>{unitMoney.format(plan.unitPrice)}</strong></li>)}</ul>}
          {customer?.canOrder && product.unitPrice !== null && (quantity > 0 ? <><div className="product-detail-quantity"><button disabled={checkingStock} onClick={() => updateCart(Math.max(0, quantity - product.salesMultiple))}><Minus /></button><label aria-label={`Quantidade de ${product.name}`}><input type="text" inputMode="numeric" disabled={checkingStock} value={quantityDraft} onChange={(event) => setQuantityDraft(event.target.value.replace(/\D/g, '').slice(0, 6))} onBlur={commitQuantity} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /><span>unidades</span></label><button disabled={checkingStock} onClick={() => updateCart(quantity + product.salesMultiple)}><Plus /></button></div>{quantityError && <span className="field-error product-quantity-error">{quantityError}</span>}</> : <><button className="product-detail-add" disabled={checkingStock} onClick={() => updateCart(product.salesMultiple)}>{checkingStock ? <><LoaderCircle className="spin" /> Validando estoque</> : <><ShoppingCart /> Adicionar {product.salesMultiple} {product.salesMultiple === 1 ? 'unidade' : 'unidades'}</>}</button>{quantityError && <span className="field-error product-quantity-error">{quantityError}</span>}</>)}
          {staffUser && <section className="staff-product-stock"><header><Warehouse /><div><h2>Estoque por filial</h2><span>Informação exclusiva da gestão</span></div></header><div>{product.stocks?.map((stock) => <article key={stock.branch}><div><strong>Filial {stock.branch}</strong><small>{stock.branch === 1 ? 'Capital e região metropolitana' : 'Barbalha / Cariri'}</small></div>{stock.availableUnits == null ? <b className="stock-unavailable">Não sincronizado</b> : <><b>{stock.availableUnits.toLocaleString('pt-BR')} disponíveis</b><dl><span>Total <strong>{stock.totalUnits?.toLocaleString('pt-BR')}</strong></span><span>Reservado <strong>{stock.reservedUnits?.toLocaleString('pt-BR')}</strong></span><span>Bloqueado <strong>{stock.blockedUnits?.toLocaleString('pt-BR')}</strong></span></dl></>}<time>{stock.updatedAt ? `Atualizado em ${new Date(stock.updatedAt).toLocaleString('pt-BR')}` : 'Aguardando primeira sincronização'}</time></article>)}{!product.stocks?.length && <article><b className="stock-unavailable">Aguardando sincronização do estoque</b></article>}</div></section>}
          <div className="product-specifications">
            <h2>Detalhes do produto</h2>
            <dl>
              <div><dt>Código do Fabricante</dt><dd>{product.manufacturerCode || 'Não informado'}</dd></div>
              <div><dt>Código</dt><dd>{product.code}</dd></div>
              <div><dt>Código NCM</dt><dd>{product.ncm || 'Não informado'}</dd></div>
              <div><dt>Código de Barras do Produto</dt><dd>{product.ean || 'Não informado'}</dd></div>
              <div><dt>Múltiplo</dt><dd>{product.salesMultiple} unidades</dd></div>
              <div><dt>Embalagem Master</dt><dd>{product.unitsPerBox} unidades</dd></div>
              <div><dt>Fabricante</dt><dd>{product.brand}</dd></div>
            </dl>
          </div>
        </section>
      </div>
    </main>
    {zoomed && product.image && <div className="product-zoom" onMouseDown={() => setZoomed(false)} role="dialog" aria-modal="true"><button onClick={() => setZoomed(false)} aria-label="Fechar"><X /></button><img src={product.image} alt={product.name} onMouseDown={(event) => event.stopPropagation()} /></div>}
  </div>
}

type MagnifierState = {
  lensLeft: number
  lensTop: number
  lensWidth: number
  lensHeight: number
  paneLeft: number
  paneWidth: number
  paneHeight: number
  backgroundWidth: number
  backgroundHeight: number
  backgroundX: number
  backgroundY: number
}

// Lupa da foto (somente desktop com mouse): um bloco suave acompanha o cursor sobre a
// foto e a área destacada aparece ampliada sobre a coluna de informações, à direita.
const magnifierQuery = '(hover: hover) and (pointer: fine) and (min-width: 1024px)'

function ProductImageMagnifier({ src, alt, onOpen }: { src: string; alt: string; onOpen: () => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const [magnifier, setMagnifier] = useState<MagnifierState | null>(null)

  function track(event: React.MouseEvent<HTMLButtonElement>) {
    const button = buttonRef.current
    const image = imageRef.current
    const section = button?.parentElement
    const content = section?.nextElementSibling
    if (!button || !image || !section || !content || !image.naturalWidth || !window.matchMedia(magnifierQuery).matches) {
      setMagnifier(null)
      return
    }
    const sectionBox = section.getBoundingClientRect()
    const contentBox = content.getBoundingClientRect()
    const imageBox = image.getBoundingClientRect()
    // A foto usa object-fit: contain; calcula a área realmente desenhada.
    const ratio = Math.min(imageBox.width / image.naturalWidth, imageBox.height / image.naturalHeight)
    const drawnWidth = image.naturalWidth * ratio
    const drawnHeight = image.naturalHeight * ratio
    const drawnLeft = imageBox.left + (imageBox.width - drawnWidth) / 2
    const drawnTop = imageBox.top + (imageBox.height - drawnHeight) / 2
    const pointerX = event.clientX - drawnLeft
    const pointerY = event.clientY - drawnTop
    if (pointerX < 0 || pointerY < 0 || pointerX > drawnWidth || pointerY > drawnHeight) {
      setMagnifier(null)
      return
    }
    // Amplia até a resolução original da foto (entre 2x e 3x) para não perder nitidez.
    const scale = Math.min(3, Math.max(2, image.naturalWidth / drawnWidth))
    const paneWidth = contentBox.width
    const paneHeight = sectionBox.height
    const lensWidth = Math.min(drawnWidth, paneWidth / scale)
    const lensHeight = Math.min(drawnHeight, paneHeight / scale)
    const lensX = Math.min(Math.max(pointerX - lensWidth / 2, 0), drawnWidth - lensWidth)
    const lensY = Math.min(Math.max(pointerY - lensHeight / 2, 0), drawnHeight - lensHeight)
    setMagnifier({
      lensLeft: drawnLeft - sectionBox.left + lensX,
      lensTop: drawnTop - sectionBox.top + lensY,
      lensWidth,
      lensHeight,
      paneLeft: contentBox.left - sectionBox.left,
      paneWidth,
      paneHeight,
      backgroundWidth: drawnWidth * scale,
      backgroundHeight: drawnHeight * scale,
      backgroundX: -lensX * scale,
      backgroundY: -lensY * scale,
    })
  }

  return <>
    <button
      ref={buttonRef}
      className={magnifier ? 'magnifying' : ''}
      onClick={onOpen}
      onMouseMove={track}
      onMouseLeave={() => setMagnifier(null)}
      aria-label="Ampliar foto do produto"
    >
      <img ref={imageRef} src={src} alt={alt} />
      <span><ZoomIn /><em className="magnifier-hint">Passe o mouse para ver detalhes ou clique para ampliar</em><em className="magnifier-hint-touch">Clique para ampliar</em></span>
    </button>
    {magnifier && <>
      <span
        className="product-magnifier-lens"
        aria-hidden="true"
        style={{ left: magnifier.lensLeft, top: magnifier.lensTop, width: magnifier.lensWidth, height: magnifier.lensHeight }}
      />
      <div
        className="product-magnifier-pane"
        aria-hidden="true"
        style={{
          left: magnifier.paneLeft,
          width: magnifier.paneWidth,
          height: magnifier.paneHeight,
          backgroundImage: `url("${src}")`,
          backgroundSize: `${magnifier.backgroundWidth}px ${magnifier.backgroundHeight}px`,
          backgroundPosition: `${magnifier.backgroundX}px ${magnifier.backgroundY}px`,
        }}
      />
    </>}
  </>
}
