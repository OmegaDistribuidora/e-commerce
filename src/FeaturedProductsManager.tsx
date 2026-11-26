import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ImageOff, Plus, Save, Search, Star, Trash2 } from 'lucide-react'
import { authenticatedFetch } from './api'
import type { StaffCatalogProduct } from './types'

export default function FeaturedProductsManager({ products }: { products: StaffCatalogProduct[] }) {
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    authenticatedFetch('/api/staff/featured-products')
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.message || 'Não foi possível carregar os destaques.')
        setSelectedIds(data.productIds || [])
      })
      .catch((requestError) => setError(requestError.message))
  }, [])

  const byId = useMemo(() => new Map(products.map((product) => [product.id, product])), [products])
  const matches = useMemo(() => {
    const normalized = search.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR')
    if (!normalized) return []
    return products.filter((product) => `${product.code} ${product.name} ${product.brand}`
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').includes(normalized))
      .filter((product) => !selectedIds.includes(product.id)).slice(0, 30)
  }, [products, search, selectedIds])

  function move(id: number, direction: -1 | 1) {
    const next = [...selectedIds]
    const index = next.indexOf(id)
    const other = index + direction
    if (other < 0 || other >= next.length) return
    ;[next[index], next[other]] = [next[other], next[index]]
    setSelectedIds(next)
  }

  async function save() {
    setSaving(true)
    setMessage('')
    setError('')
    try {
      const response = await authenticatedFetch('/api/staff/featured-products', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: selectedIds }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message || 'Não foi possível salvar os destaques.')
      setMessage('Destaques salvos. A vitrine da página inicial já usa esta seleção.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Não foi possível salvar os destaques.')
    } finally { setSaving(false) }
  }

  return <section className="featured-manager">
    <p>Escolha até cinco produtos para aparecer logo abaixo do banner principal. Ajuste a ordem com as setas. Produtos indisponíveis para um cliente ficam ocultos para ele.</p>
    {error && <div className="staff-alert error">{error}</div>}
    {message && <div className="staff-alert success">{message}</div>}
    <div className="featured-manager-selected">
      {selectedIds.length === 0 && <div className="staff-empty">Nenhum produto em destaque.</div>}
      {selectedIds.map((id, index) => {
        const product = byId.get(id)
        if (!product) return null
        return <article key={id} className="featured-manager-item">
          <span className="featured-manager-position">{index + 1}</span>
          {product.image ? <img src={product.image} alt="" /> : <ImageOff />}
          <div><strong>{product.name}</strong><small>Cód. {product.code} · {product.brand}</small></div>
          <button type="button" onClick={() => move(id, -1)} disabled={index === 0} aria-label={`Subir ${product.name}`}><ArrowUp size={18} /></button>
          <button type="button" onClick={() => move(id, 1)} disabled={index === selectedIds.length - 1} aria-label={`Descer ${product.name}`}><ArrowDown size={18} /></button>
          <button type="button" onClick={() => setSelectedIds((current) => current.filter((value) => value !== id))} aria-label={`Remover ${product.name}`}><Trash2 size={18} /></button>
        </article>
      })}
    </div>
    <label className="featured-manager-search"><Search size={20} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar produto por nome ou código" aria-label="Buscar produto para destacar" /></label>
    {search.trim() && <div className="featured-manager-results">{matches.length ? matches.map((product) => <button type="button" key={product.id} disabled={selectedIds.length >= 5} onClick={() => setSelectedIds((current) => [...current, product.id])}>
      {product.image ? <img src={product.image} alt="" /> : <ImageOff />}
      <span><strong>{product.name}</strong><small>Cód. {product.code} · {product.brand}</small></span><Plus size={19} />
    </button>) : <p>Nenhum produto encontrado.</p>}</div>}
    <div className="featured-manager-actions"><span><Star size={18} /> {selectedIds.length} de 5 produtos</span><button type="button" className="primary-button" onClick={save} disabled={saving}><Save size={19} /> {saving ? 'Salvando...' : 'Salvar destaques'}</button></div>
  </section>
}
