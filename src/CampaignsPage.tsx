import { useEffect, useState } from 'react'
import { ArrowRight, CalendarDays, CircleUserRound, LogOut, MapPin, Menu, Percent, Search, ShoppingCart } from 'lucide-react'
import { authenticatedFetch } from './api'
import DepartmentDrawer from './DepartmentDrawer'
import { formatCatalogName } from './catalog'
import { supabase } from './supabase'
import type { CatalogDepartment, Customer, DiscountCampaign, Partner, StaffUser } from './types'

const whatsappUrl = `https://wa.me/558592020207?text=${encodeURIComponent('Olá! Venho do e-Commerce da Ômega Distribuidora e preciso de atendimento!')}`

function formatDate(value: string) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(new Date(`${String(value).slice(0, 10)}T12:00:00Z`))
}

export default function CampaignsPage() {
  const [departmentsOpen, setDepartmentsOpen] = useState(false)
  const [campaigns, setCampaigns] = useState<DiscountCampaign[]>([])
  const [departments, setDepartments] = useState<CatalogDepartment[]>([])
  const [partners, setPartners] = useState<Partner[]>([])
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [staffUser, setStaffUser] = useState<StaffUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [cartCount, setCartCount] = useState(0)

  useEffect(() => {
    Promise.all([
      authenticatedFetch('/api/auth/me').then(async (response) => response.ok ? response.json() : null),
      authenticatedFetch('/api/campaigns').then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.message); return data.campaigns }),
      fetch('/api/catalog/navigation').then((response) => response.json()),
    ]).then(async ([account, availableCampaigns, navigation]) => {
      setCustomer(account?.accountType === 'customer' ? account.customer : null)
      setStaffUser(account?.accountType === 'staff' ? account.user : null)
      setCampaigns(Array.isArray(availableCampaigns) ? availableCampaigns : [])
      setDepartments(Array.isArray(navigation.departments) ? navigation.departments : [])
      setPartners(Array.isArray(navigation.partners) ? navigation.partners : [])
      if (account?.accountType === 'customer' && account.customer?.canOrder) {
        const response = await authenticatedFetch('/api/customer/cart')
        const data = await response.json().catch(() => ({ items: [] }))
        setCartCount(response.ok && Array.isArray(data.items) ? data.items.length : 0)
      }
    }).catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Não foi possível carregar as campanhas.'))
      .finally(() => setLoading(false))
  }, [])

  async function logout() {
    await Promise.all([
      supabase.auth.signOut(),
      fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined),
      fetch('/api/staff/auth/logout', { method: 'POST' }).catch(() => undefined),
    ])
    window.location.reload()
  }

  function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = String(new FormData(event.currentTarget).get('search') || '').trim()
    window.location.href = value ? `/?busca=${encodeURIComponent(value)}#produtos` : '/#produtos'
  }

  return <div className="app-shell campaigns-page">
    <div className="topbar"><div className="container topbar-inner"><p aria-busy={loading}>{loading ? <>&nbsp;</> : customer ? <>Bem-vindo(a), <strong>{customer.tradeName || customer.legalName}</strong></> : staffUser ? <>Sessão de gestão: <strong>{staffUser.name}</strong></> : <>Tudo o que você precisa, <strong>sempre por perto.</strong></>}</p><div className="topbar-links"><span><MapPin size={15} /> Entregamos em todo o Ceará</span><a href={whatsappUrl} target="_blank" rel="noreferrer">Central de ajuda</a></div></div></div>
    <header className="site-header"><div className="container header-main"><a className="mobile-menu-btn icon-btn" href="/#produtos"><Menu /></a><a className="logo" href="/"><img src="/assets/omega-logo.png" alt="Ômega Distribuidora" /></a><form className="search-box" onSubmit={submitSearch}><Search size={21} /><input name="search" placeholder="Busque produtos, marcas ou código" /><button><Search size={18} /></button></form><a className="account-button" href={staffUser ? '/gestao' : customer ? '/pedidos' : '/conta'}><CircleUserRound /><span><small>{staffUser ? 'Painel interno' : customer ? 'Meus pedidos' : 'Área do cliente'}</small><strong>{staffUser ? `${staffUser.name} · ${staffUser.role}` : customer ? `Bem-vindo(a), ${customer.tradeName || customer.legalName}` : 'Entrar ou cadastrar'}</strong></span></a>{(customer || staffUser) && <button className="logout-button" onClick={logout}><LogOut size={19} /><span>Sair</span></button>}<a className="cart-button" href="/?carrinho=1"><span className="cart-icon"><ShoppingCart />{cartCount > 0 && <b>{cartCount}</b>}</span><span><small>Meu carrinho</small><strong>{cartCount ? `${cartCount} ${cartCount === 1 ? 'item' : 'itens'}` : 'Está vazio'}</strong></span></a></div>
      <nav className="main-nav"><div className="container nav-inner department-nav"><button className="categories-button" onClick={() => setDepartmentsOpen(true)}><Menu size={19} /> Departamentos</button>{[...departments].sort((a, b) => b.productCount - a.productCount).slice(0, 6).map((department) => <div className="department-nav-item" key={department.code || department.name}><a className="product-department-link" href={`/?departamento=${encodeURIComponent(department.name)}#produtos`}>{formatCatalogName(department.name)}</a><div className="department-dropdown"><a className="department-all" href={`/?departamento=${encodeURIComponent(department.name)}#produtos`}>Ver todos em {formatCatalogName(department.name)}</a><div>{department.sections.map((section) => <a key={section.code} href={`/?departamento=${encodeURIComponent(department.name)}&secao=${encodeURIComponent(section.name)}#produtos`}>{formatCatalogName(section.name)}<small>{section.productCount}</small></a>)}</div></div></div>)}<a className="nav-campaigns active" href="/campanhas">Campanhas</a><div className="partners-nav-item"><a href="/parceiros">Parceiros</a>{partners.length > 0 && <div className="partners-dropdown">{partners.map((partner) => <a key={partner.supplierId} href={`/?fornecedor=${partner.supplierId}#produtos`}><img src={partner.logo} alt="" /><span>{partner.name}</span></a>)}</div>}</div><a className="nav-support" href={whatsappUrl} target="_blank" rel="noreferrer">Atendimento</a></div></nav>
      {departmentsOpen && <DepartmentDrawer departments={departments} onClose={() => setDepartmentsOpen(false)} />}
    </header>
    <main className="container campaigns-main"><header><h1>Campanhas de desconto</h1><p>Confira as campanhas disponíveis hoje. Os descontos são aplicados automaticamente quando a quantidade atende às regras.</p></header>
      {loading ? <div className="catalog-loading"><span>Carregando campanhas...</span></div> : error ? <div className="empty-results"><h2>Campanhas indisponíveis</h2><p>{error}</p></div> : campaigns.length === 0 ? <div className="empty-results"><Percent /><h2>Nenhuma campanha disponível hoje</h2><p>Volte em breve para conferir novas condições.</p></div> : <div className="campaign-grid">{campaigns.map((campaign) => {
        const rule = campaign.ruleType === 'buy_get'
          ? `Compre ${campaign.buyQuantity} e ganhe ${(campaign.rewardItems || []).reduce((sum, reward) => sum + reward.quantity, 0)} unidade(s)`
          : campaign.ruleType === 'fixed'
            ? `R$ ${Number(campaign.discountValue || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} de desconto`
            : `${Number(campaign.discountValue || 0).toLocaleString('pt-BR')}% de desconto`
        return <article className="campaign-card" key={campaign.code}>
          <header><span><Percent /> {rule}</span><small>Campanha #{campaign.code}</small></header>
          <h2>{campaign.name || campaign.description}</h2>
          <p>{campaign.description}</p>
          <p className="campaign-period"><CalendarDays /> {formatDate(campaign.startsOn)} até {formatDate(campaign.endsOn)}</p>
          <div className="campaign-products-preview">{campaign.products.slice(0, 5).map((product) => <span key={product.code} title={product.name}>{product.image ? <img src={product.image} alt="" /> : <b>{product.name.slice(0, 1)}</b>}</span>)}</div>
          <p><strong>{campaign.products.length} {campaign.products.length === 1 ? 'produto participante' : 'produtos participantes'}</strong></p>
          <div className="campaign-rule-preview"><span>{campaign.ruleType === 'buy_get'
            ? `${rule} ${campaign.thresholdBasis === 'boxes' ? 'caixas completas' : 'unidades'} dos produtos participantes.`
            : `${rule} a partir de ${campaign.thresholdQuantity} ${campaign.thresholdBasis === 'boxes' ? 'caixas completas' : 'unidades somadas'} dos produtos participantes.`}</span></div>
          {campaign.ruleType === 'buy_get' && Boolean(campaign.rewards?.length) && <p className="campaign-rewards"><strong>Produtos grátis:</strong> {campaign.rewards?.map((product) => `${campaign.rewardItems?.find((item) => item.code === product.code)?.quantity || 0} un. ${product.name}`).join(', ')}</p>}
          <a className="campaign-open" href={`/?campanha=${campaign.code}#produtos`}>Ver produtos da campanha <ArrowRight /></a>
        </article>      })}</div>}
    </main>
  </div>
}
