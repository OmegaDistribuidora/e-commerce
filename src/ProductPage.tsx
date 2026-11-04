import { useEffect, useState } from 'react'
import { ArrowLeft, ImageOff, LoaderCircle, LockKeyhole, Minus, Plus, ShoppingCart, X, ZoomIn } from 'lucide-react'
import { authenticatedFetch } from './api'
import { money } from './data'
import type { CartItem, Customer, Product } from './types'

function readCart(): CartItem[] {
  try {
    const value = JSON.parse(localStorage.getItem('omega-cart-v2') || '[]')
    return Array.isArray(value) ? value : []
  } catch { return [] }
}

export default function ProductPage({ code }: { code: number }) {
  const [product, setProduct] = useState<Product | null>(null)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [zoomed, setZoomed] = useState(false)
  const [quantity, setQuantity] = useState(0)

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
      setProduct(loadedProduct)
      setQuantity(readCart().find((item) => item.id === loadedProduct.id)?.quantity || 0)
    }).catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'NÃ£o foi possÃ­vel carregar o produto.'))
      .finally(() => setLoading(false))
  }, [code])

  function updateCart(nextQuantity: number) {
    if (!product) return
    const cart = readCart().filter((item) => item.id !== product.id)
    if (nextQuantity > 0) cart.push({ ...product, quantity: nextQuantity })
    localStorage.setItem('omega-cart-v2', JSON.stringify(cart))
    setQuantity(nextQuantity)
  }

  if (loading) return <main className="product-page-state"><LoaderCircle className="spin" /><span>Carregando produto...</span></main>
  if (!product || error) return <main className="product-page-state"><ImageOff /><h1>Produto indisponÃ­vel</h1><p>{error}</p><a href="/"><ArrowLeft /> Voltar para a loja</a></main>

  return <div className="product-page">
    <header><a href="/"><img src="/assets/omega-logo.png" alt="Ã”mega Distribuidora" /></a><a href="/#produtos"><ArrowLeft /> Voltar ao catÃ¡logo</a></header>
    <main>
      <section className="product-detail-image">
        {product.image ? <button onClick={() => setZoomed(true)} aria-label="Ampliar foto do produto"><img src={product.image} alt={product.name} /><span><ZoomIn /> Clique para ampliar</span></button> : <div className="product-detail-no-image"><ImageOff /><span>Produto sem foto</span></div>}
      </section>
      <section className="product-detail-content">
        <span className="eyebrow">CÃ“DIGO {product.code}</span>
        <h1>{product.name}</h1>
        <p className="product-detail-brand">{product.brand}</p>
        {customer && product.unitPrice !== null ? <div className="product-detail-price"><strong>{money.format(product.unitPrice)}</strong><span>por unidade</span></div> : <a className="product-detail-login" href="/conta"><LockKeyhole /> Entrar para ver preÃ§o</a>}
        {customer?.canOrder && product.unitPrice !== null && (quantity > 0 ? <div className="product-detail-quantity"><button onClick={() => updateCart(Math.max(0, quantity - product.salesMultiple))}><Minus /></button><span><strong>{quantity}</strong> unidades no carrinho</span><button onClick={() => updateCart(quantity + product.salesMultiple)}><Plus /></button></div> : <button className="product-detail-add" onClick={() => updateCart(product.salesMultiple)}><ShoppingCart /> Adicionar {product.salesMultiple} {product.salesMultiple === 1 ? 'unidade' : 'unidades'}</button>)}
        <div className="product-specifications">
          <h2>Detalhes do produto</h2>
          <dl>
            <div><dt>CÃ³digo do Fabricante</dt><dd>{product.manufacturerCode || 'NÃ£o informado'}</dd></div>
            <div><dt>CÃ³digo</dt><dd>{product.code}</dd></div>
            <div><dt>CÃ³digo NCM</dt><dd>{product.ncm || 'NÃ£o informado'}</dd></div>
            <div><dt>CÃ³digo de Barras do Produto</dt><dd>{product.ean || 'NÃ£o informado'}</dd></div>
            <div><dt>MÃºltiplo</dt><dd>{product.salesMultiple} unidades</dd></div>
            <div><dt>Embalagem Master</dt><dd>{product.unitsPerBox} unidades</dd></div>
            <div><dt>Fabricante</dt><dd>{product.brand}</dd></div>
          </dl>
        </div>
      </section>
    </main>
    {zoomed && product.image && <div className="product-zoom" onMouseDown={() => setZoomed(false)} role="dialog" aria-modal="true"><button onClick={() => setZoomed(false)} aria-label="Fechar"><X /></button><img src={product.image} alt={product.name} onMouseDown={(event) => event.stopPropagation()} /></div>}
  </div>
}
