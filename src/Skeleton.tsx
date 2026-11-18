type SkeletonProps = { className?: string }

export function Skeleton({ className = '' }: SkeletonProps) {
  return <span className={`skeleton ${className}`.trim()} aria-hidden="true" />
}

export function HeroSkeleton() {
  return <section className="hero hero-skeleton" aria-label="Carregando destaques" aria-busy="true"><Skeleton className="hero-skeleton-fill" /></section>
}

export function ProductGridSkeleton({ count = 10 }: { count?: number }) {
  return <div className="product-grid skeleton-product-grid" aria-label="Carregando produtos" aria-busy="true">
    {Array.from({ length: count }, (_, index) => <article className="skeleton-product-card" key={index}>
      <Skeleton className="skeleton-product-image" /><Skeleton className="skeleton-product-meta" />
      <Skeleton className="skeleton-product-title" /><Skeleton className="skeleton-product-title short" />
      <Skeleton className="skeleton-product-price" /><Skeleton className="skeleton-product-button" />
    </article>)}
  </div>
}

export function ContentSkeleton({ cards = 0 }: { cards?: number }) {
  return <div className="content-skeleton" aria-label="Carregando conteúdo" aria-busy="true">
    <Skeleton className="content-skeleton-kicker" /><Skeleton className="content-skeleton-title" />
    <Skeleton className="content-skeleton-copy" /><Skeleton className="content-skeleton-copy short" />
    {cards > 0 && <div className="content-skeleton-cards">{Array.from({ length: cards }, (_, index) => <Skeleton className="content-skeleton-card" key={index} />)}</div>}
  </div>
}

export function PageSkeleton() {
  return <main className="page-skeleton" aria-label="Carregando página" aria-busy="true">
    <div className="page-skeleton-header"><Skeleton className="page-skeleton-logo" /><Skeleton className="page-skeleton-search" /><Skeleton className="page-skeleton-account" /></div>
    <div className="page-skeleton-nav">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} />)}</div>
    <div className="page-skeleton-body"><ContentSkeleton cards={3} /></div>
  </main>
}
