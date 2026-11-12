import { useEffect, useState } from 'react'
import {
  ArrowLeft, CircleUserRound, ImageOff, LoaderCircle, LockKeyhole, LogOut,
  MapPin, Menu, Minus, Plus, Search, ShoppingCart, X, ZoomIn,
} from 'lucide-react'
import { authenticatedFetch } from './api'
import { money } from './data'
import { formatCatalogName } from './catalog'
import { supabase } from './supabase'
import type { CartItem, CatalogDepartment, Customer, Partner, Product, StaffUser } from './types'

const whatsappUrl = `https://wa.me/558592020207?text=${encodeURIComponent('Olá! Venho do e-Commerce da Ômega Distribuidora e preciso de atendimento!')}`

function readCart(): CartItem[] {
  try {
    const value = JSON.parse(localStorage.getItem('omega-cart-v2') || '[]')
    return Array.isArray(value) ? value : []
  } catch { return [] }
}

export default function ProductPage({ code }: { code: number }) {
  const [product, setProduct] = useState<Product | null>(null)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [staffUser, setStaffUser] = useState<StaffUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [zoomed, setZoomed] = useState(false)
  const [quantity, setQuantity] = useState(0)
  const [search, setSearch] = useState('')
  const [departments, setDepartments] = useState<CatalogDepartment[]>([])
  const [partners, setPartners] = useState<Partner[]>([])

  useEffect(() => {
    Promise.all([
      authenticatedFetch('/api/auth/me').then(async (response) => response.ok ? response.json() : null),
      authenticatedFetch(`/api/products/${code}`).then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.message)
        return data.product as Product
      }),
    ]).then(([account, loadedProduct]) => {
      setCustomer(account?.accountType === 'customer' ? account.customer : null)
      setStaffUser(account?.accountType === 'staff' ? account.user : null)
      setProduct(loadedProduct)
      setQuantity(readCart().find((item) => item.id === loadedProduct.id)?.quantity || 0)
    }).catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Não foi possível carregar o produto.'))
      .finally(() => setLoading(false))
  }, [code])

  useEffect(() => {
    fetch('/api/catalog/navigation').then((response) => response.json()).then((data) => {
      if (Array.isArray(data.departments)) setDepartments(data.departments)
      if (Array.isArray(data.partners)) setPartners(data.partners)
    }).catch(() => undefined)
  }, [])

  function updateCart(nextQuantity: number) {
    if (!product) return
    const cart = readCart().filter((item) => item.id !== product.id)
    if (nextQuantity > 0) cart.push({ ...product, quantity: nextQuantity })
    localStorage.setItem('omega-cart-v2', JSON.stringify(cart))
    setQuantity(nextQuantity)
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
    localStorage.removeItem('omega-cart-v2')
    window.location.href = '/'
  }

  if (loading) return <main className="product-page-state"><LoaderCircle className="spin" /><span>Carregando produto...</span></main>
  if (!product || error) return <main className="product-page-state"><ImageOff /><h1>Produto indisponível</h1><p>{error}</p><a href="/"><ArrowLeft /> Voltar para a loja</a></main>

  const cartCount = readCart().length

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
      <nav className="main-nav" aria-label="Departamentos e seções"><div className="container nav-inner department-nav"><a className="categories-button" href="/#produtos"><Menu size={19} /> Departamentos</a>{[...departments].sort((a, b) => b.productCount - a.productCount).slice(0, 6).map((department) => <div className="department-nav-item" key={department.code || department.name}><a className="product-department-link" href={`/?departamento=${encodeURIComponent(department.name)}#produtos`}>{formatCatalogName(department.name)}</a><div className="department-dropdown"><a className="department-all" href={`/?departamento=${encodeURIComponent(department.name)}#produtos`}>Ver todos em {formatCatalogName(department.name)}</a><div>{department.sections.map((section) => <a key={`${department.name}-${section.code || section.name}`} href={`/?departamento=${encodeURIComponent(department.name)}&secao=${encodeURIComponent(section.name)}#produtos`}>{formatCatalogName(section.name)}<small>{section.productCount}</small></a>)}</div></div></div>)}<div className="partners-nav-item"><a href="/#parceiros">Parceiros</a>{partners.length > 0 && <div className="partners-dropdown">{partners.map((partner) => <a key={partner.supplierId} href={`/?fornecedor=${partner.supplierId}#produtos`}><img src={partner.logo} alt="" /><span>{partner.name}</span></a>)}</div>}</div><a className="nav-support" href={whatsappUrl} target="_blank" rel="noreferrer">Atendimento</a></div></nav>
    </header>

    <main className="product-page-main">
      <a className="product-back-link" href="/#produtos"><ArrowLeft /> Voltar ao catálogo</a>
      <div className="product-detail-layout">
        <section className="product-detail-image">
          {product.image ? <button onClick={() => setZoomed(true)} aria-label="Ampliar foto do produto"><img src={product.image} alt={product.name} /><span><ZoomIn /> Clique para ampliar</span></button> : <div className="product-detail-no-image"><ImageOff /><span>Produto sem foto</span></div>}
        </section>
        <section className="product-detail-content">
          <span className="eyebrow">CÓDIGO {product.code}</span>
          <h1>{product.name}</h1>
          <p className="product-detail-brand">{product.brand}</p>
          {customer && product.unitPrice !== null ? <div className="product-detail-price"><strong>{money.format(product.unitPrice)}</strong><span>por unidade</span></div> : <a className="product-detail-login" href="/conta"><LockKeyhole /> Entrar para ver preço</a>}
          {customer?.canOrder && product.unitPrice !== null && (quantity > 0 ? <div className="product-detail-quantity"><button onClick={() => updateCart(Math.max(0, quantity - product.salesMultiple))}><Minus /></button><span><strong>{quantity}</strong> unidades no carrinho</span><button onClick={() => updateCart(quantity + product.salesMultiple)}><Plus /></button></div> : <button className="product-detail-add" onClick={() => updateCart(product.salesMultiple)}><ShoppingCart /> Adicionar {product.salesMultiple} {product.salesMultiple === 1 ? 'unidade' : 'unidades'}</button>)}
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
