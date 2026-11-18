import { useEffect, useState } from 'react'
import { CircleUserRound, LogOut, MapPin, Menu, Search, ShoppingCart } from 'lucide-react'
import { authenticatedFetch } from './api'
import { supabase } from './supabase'
import type { Customer, StaffUser } from './types'

const whatsappUrl = `https://wa.me/558592020207?text=${encodeURIComponent('Olá! Venho do e-Commerce da Ômega Distribuidora e preciso de atendimento!')}`

function storedCartCount() {
  try {
    const cart = JSON.parse(localStorage.getItem('omega-cart-v2') || '[]')
    return Array.isArray(cart) ? cart.length : 0
  } catch { return 0 }
}

export default function PublicSiteHeader({ active }: { active?: 'about' | 'partners' }) {
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [staffUser, setStaffUser] = useState<StaffUser | null>(null)
  const [ready, setReady] = useState(false)
  const cartCount = storedCartCount()

  useEffect(() => {
    authenticatedFetch('/api/auth/me').then(async (response) => response.ok ? response.json() : null).then((account) => {
      setCustomer(account?.accountType === 'customer' ? account.customer : null)
      setStaffUser(account?.accountType === 'staff' ? account.user : null)
    }).catch(() => undefined).finally(() => setReady(true))
  }, [])

  async function logout() {
    await Promise.all([
      supabase.auth.signOut(),
      fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined),
      fetch('/api/staff/auth/logout', { method: 'POST' }).catch(() => undefined),
    ])
    localStorage.removeItem('omega-cart-v2')
    window.location.reload()
  }

  function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = String(new FormData(event.currentTarget).get('search') || '').trim()
    window.location.href = value ? `/?busca=${encodeURIComponent(value)}#produtos` : '/#produtos'
  }

  return <>
    <div className="topbar"><div className="container topbar-inner"><p aria-busy={!ready}>{!ready ? <>&nbsp;</> : customer ? <>Bem-vindo(a), <strong>{customer.tradeName || customer.legalName}</strong></> : staffUser ? <>Sessão de gestão: <strong>{staffUser.name}</strong></> : <>Tudo o que você precisa, <strong>sempre por perto.</strong></>}</p><div className="topbar-links"><span><MapPin size={15} /> Entregamos em todo o Ceará</span><a href={whatsappUrl} target="_blank" rel="noreferrer">Central de ajuda</a></div></div></div>
    <header className="site-header">
      <div className="container header-main">
        <a className="mobile-menu-btn icon-btn" href="/#produtos"><Menu /></a>
        <a className="logo" href="/"><img src="/assets/omega-logo.png" alt="Ômega Distribuidora" /></a>
        <form className="search-box" onSubmit={submitSearch}><Search size={21} /><input name="search" placeholder="Busque produtos, marcas ou código" /><button aria-label="Buscar"><Search size={18} /></button></form>
        <a className="account-button" href={staffUser ? '/gestao' : customer ? '/pedidos' : '/conta'}><CircleUserRound /><span><small>{staffUser ? 'Painel interno' : customer ? 'Meus pedidos' : 'Área do cliente'}</small><strong>{staffUser ? `${staffUser.name} · ${staffUser.role}` : customer ? `Bem-vindo(a), ${customer.tradeName || customer.legalName}` : 'Entrar ou cadastrar'}</strong></span></a>
        {(customer || staffUser) && <button className="logout-button" onClick={logout}><LogOut size={19} /><span>Sair</span></button>}
        <a className="cart-button" href="/?carrinho=1"><span className="cart-icon"><ShoppingCart />{cartCount > 0 && <b>{cartCount}</b>}</span><span><small>Meu carrinho</small><strong>{cartCount ? `${cartCount} ${cartCount === 1 ? 'item' : 'itens'}` : 'Está vazio'}</strong></span></a>
      </div>
      <nav className="main-nav"><div className="container nav-inner content-page-nav"><a className="categories-button" href="/#produtos"><Menu size={19} /> Departamentos</a><a href="/#produtos">Produtos</a><a className="nav-campaigns" href="/campanhas">Campanhas</a><a className={active === 'partners' ? 'active' : ''} href="/parceiros">Parceiros</a><a className={active === 'about' ? 'active' : ''} href="/sobre">Sobre a Ômega</a><a className="nav-support" href={whatsappUrl} target="_blank" rel="noreferrer">Atendimento</a></div></nav>
    </header>
  </>
}
