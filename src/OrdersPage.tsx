import { useEffect, useState } from 'react'
import { ArrowLeft, LoaderCircle, PackageCheck, ShoppingBag } from 'lucide-react'
import { money } from './data'
import type { Customer, Order } from './types'

function paymentLabel(value: string) {
  return ({ avista: 'À vista', '7_dias': '7 dias', '14_dias': '14 dias', '28_dias': '28 dias', '4_14_dias': '4/14 dias', '14_28_dias': '14/28 dias' } as Record<string, string>)[value] || value
}

export default function OrdersPage() {
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([fetch('/api/auth/me'), fetch('/api/orders')])
      .then(async ([authResponse, ordersResponse]) => {
        if (!authResponse.ok) { window.location.href = '/conta'; return }
        const auth = await authResponse.json()
        const orderData = await ordersResponse.json()
        if (!ordersResponse.ok) throw new Error(orderData.message)
        setCustomer(auth.customer); setOrders(orderData.orders)
      })
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Não foi possível carregar seus pedidos.'))
      .finally(() => setLoading(false))
  }, [])

  return <main className="customer-orders-page"><header className="orders-page-header"><div className="container"><a href="/"><ArrowLeft /> Voltar para a loja</a><img src="/assets/omega-logo.png" alt="Ômega Distribuidora" /><span>{customer?.tradeName || customer?.legalName}</span></div></header><section className="container customer-orders-content"><div className="section-heading"><div><span className="eyebrow">ÁREA DO CLIENTE</span><h1>Meus pedidos</h1></div></div>{loading ? <div className="catalog-loading"><LoaderCircle className="spin" /> Carregando seus pedidos...</div> : error ? <div className="empty-results"><ShoppingBag /><h2>Pedidos indisponíveis</h2><p>{error}</p></div> : orders.length ? <div className="customer-order-list">{orders.map((order) => <article key={order.id} className="customer-order-card"><header><div><span>Pedido</span><strong>{order.number}</strong></div><div><span>Realizado em</span><strong>{new Date(order.createdAt).toLocaleString('pt-BR')}</strong></div><div><span>Pagamento</span><strong>{paymentLabel(order.paymentPlan)}</strong></div><b>{order.status === 'received' ? 'Recebido' : order.status}</b></header><div className="customer-order-lines">{order.items.map((item) => <div key={item.id}><span>{item.name}<small>Cód. {item.code} · {item.boxes} {item.boxes === 1 ? 'caixa' : 'caixas'} · {item.unitsPerBox} un./caixa</small></span><strong>{money.format(item.lineTotal)}</strong></div>)}</div>{order.notes && <p><b>Observações:</b> {order.notes}</p>}<footer><span>Total do pedido</span><strong>{money.format(order.total)}</strong></footer></article>)}</div> : <div className="empty-results"><PackageCheck /><h2>Você ainda não fez pedidos</h2><p>Quando seu primeiro pedido for enviado, ele aparecerá aqui.</p><a className="primary-button" href="/#produtos">Explorar produtos</a></div>}</section></main>
}
