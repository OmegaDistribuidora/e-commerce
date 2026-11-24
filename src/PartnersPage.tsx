import { useEffect, useState } from 'react'
import { ArrowRight, Handshake } from 'lucide-react'
import PublicSiteHeader from './PublicSiteHeader'
import PublicSiteFooter from './PublicSiteFooter'
import { ContentSkeleton } from './Skeleton'
import type { Partner } from './types'

export default function PartnersPage() {
  const [partners, setPartners] = useState<Partner[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/catalog/navigation').then((response) => response.json()).then((data) => {
      setPartners((Array.isArray(data.partners) ? data.partners : []).filter((partner: Partner) => partner.productCount > 0))
    }).catch(() => setPartners([])).finally(() => setLoading(false))
  }, [])

  return <div className="app-shell content-page">
    <PublicSiteHeader active="partners" />
    <main className="container partners-page-main"><header><span className="eyebrow">MARCAS</span><h1>Nossos parceiros</h1><p>Escolha uma marca para ver os produtos dela no catálogo.</p></header>
      {loading ? <ContentSkeleton cards={4} /> : partners.length ? <div className="partners-page-grid">{partners.map((partner) => <a href={`/?fornecedor=${partner.supplierId}#produtos`} key={partner.supplierId}><img src={partner.logo} alt={`Logo ${partner.name}`} /><span><strong>{partner.name}</strong><small>Conhecer produtos <ArrowRight /></small></span></a>)}</div> : <div className="content-page-state"><Handshake /><h2>Nenhum parceiro disponível agora</h2></div>}
    </main>
    <PublicSiteFooter />
  </div>
}
