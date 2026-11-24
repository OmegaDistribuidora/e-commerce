import { useEffect, useState } from 'react'
import { Building2, Handshake, ImageOff } from 'lucide-react'
import PublicSiteHeader from './PublicSiteHeader'
import PublicSiteFooter from './PublicSiteFooter'
import { ContentSkeleton } from './Skeleton'
import type { InstitutionalContent } from './types'

export default function AboutPage() {
  const [content, setContent] = useState<InstitutionalContent | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/site/institutional').then(async (response) => {
      const data = await response.json()
      if (!response.ok) throw new Error(data.message)
      setContent(data.content)
    }).catch(() => setError('Não foi possível carregar nossa história agora.'))
  }, [])

  return <div className="app-shell content-page">
    <PublicSiteHeader active="about" />
    <main>
      {!content ? error ? <div className="content-page-state"><ImageOff /><h1>Conteúdo indisponível</h1><p>{error}</p></div> : <ContentSkeleton cards={2} /> : <>
        <section className="about-hero"><div className="container"><div><span className="eyebrow">ÔMEGA DISTRIBUIDORA</span><h1>{content.heroTitle}</h1><p>{content.heroSubtitle}</p></div>{content.heroImageUrl ? <img src={content.heroImageUrl} alt="Ômega Distribuidora" /> : <span className="about-image-placeholder"><Building2 /></span>}</div></section>
        <section className="container about-story"><div className="about-story-image">{content.historyImageUrl ? <img src={content.historyImageUrl} alt="Nossa história" /> : <Building2 />}</div><div><span className="eyebrow">NOSSA TRAJETÓRIA</span><h2>{content.historyTitle}</h2>{content.historyText.split(/\n+/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div></section>
        <section className="about-values"><div className="container"><Handshake /><div><span className="eyebrow">NOSSOS VALORES</span><h2>{content.valuesTitle}</h2>{content.valuesText.split(/\n+/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div></div></section>
      </>}
    </main>
    <PublicSiteFooter />
  </div>
}
