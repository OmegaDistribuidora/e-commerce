import { useEffect, useMemo, useState } from 'react'
import { BadgePercent, LoaderCircle, Pencil, Plus, Save, Search, Trash2, X } from 'lucide-react'
import { authenticatedFetch } from './api'
import { formatCatalogName } from './catalog'
import type { CatalogDepartment, CatalogSupplier, Coupon, StaffCatalogProduct } from './types'

type Props = { products: StaffCatalogProduct[]; suppliers: CatalogSupplier[]; departments: CatalogDepartment[] }
const emptyCoupon = (): Coupon => ({ id: 0, code: '', description: '', discountType: 'fixed', discountValue: 0, scopeType: 'order', targetValues: [], maxUses: null, maxUsesPerCustomer: 1, active: true, startsAt: null, endsAt: null })
const localValue = (value: string | null) => value ? new Date(value).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).replace(' ', 'T').slice(0, 16) : ''
const isoValue = (value: string) => value ? new Date(`${value}:00-03:00`).toISOString() : null
const decimalDisplay = (value: number) => value ? value.toFixed(2).replace('.', ',') : ''

export default function CouponManager({ products, suppliers, departments }: Props) {
  const [coupons, setCoupons] = useState<Coupon[]>([])
  const [editing, setEditing] = useState<Coupon | null>(null)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function load() {
    setLoading(true)
    try {
      const response = await authenticatedFetch('/api/staff/coupons')
      const data = await response.json()
      if (!response.ok) throw new Error(data.message)
      setCoupons(data.coupons)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Não foi possível carregar os cupons.') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const options = useMemo(() => {
    if (!editing || editing.scopeType === 'order') return []
    const term = search.trim().toLocaleLowerCase('pt-BR')
    const items = editing.scopeType === 'products'
      ? products.filter((item) => !term || `${item.code} ${item.name} ${item.brand}`.toLocaleLowerCase('pt-BR').includes(term)).map((item) => ({ value: item.code, label: item.name, detail: `Cód. ${item.code} · ${item.brand}` }))
      : editing.scopeType === 'suppliers'
        ? suppliers.filter((item) => !term || `${item.id} ${item.name}`.toLocaleLowerCase('pt-BR').includes(term)).map((item) => ({ value: item.id, label: item.name, detail: `Cód. ${item.id}` }))
        : departments.flatMap((department) => department.sections.map((section) => ({ value: section.code, label: formatCatalogName(section.name), detail: `${formatCatalogName(department.name)} · cód. ${section.code}` }))).filter((item) => !term || `${item.value} ${item.label} ${item.detail}`.toLocaleLowerCase('pt-BR').includes(term))
    const selected = new Set(editing.targetValues)
    return items.sort((a, b) => Number(selected.has(b.value)) - Number(selected.has(a.value)))
  }, [editing, products, suppliers, departments, search])

  function toggle(value: number) {
    if (!editing) return
    setEditing({ ...editing, targetValues: editing.targetValues.includes(value) ? editing.targetValues.filter((item) => item !== value) : [...editing.targetValues, value] })
  }
  function changeDiscount(raw: string) {
    if (!editing) return
    const value = Number(raw.replace(/\D/g, '')) / 100
    if (value <= (editing.discountType === 'percent' ? 100 : 999999999)) setEditing({ ...editing, discountValue: value })
  }
  function toggleFilteredOptions() {
    if (!editing) return
    const visible = new Set(options.map((option) => option.value))
    const selected = new Set(editing.targetValues)
    const allSelected = options.length > 0 && options.every((option) => selected.has(option.value))
    onClearSelection(allSelected ? new Set([...selected].filter((value) => !visible.has(value))) : new Set([...selected, ...visible]))
  }
  function onClearSelection(values: Set<number>) {
    if (editing) setEditing({ ...editing, targetValues: [...values] })
  }
  const allFilteredSelected = options.length > 0 && options.every((option) => editing?.targetValues.includes(option.value))
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!editing) return
    setLoading(true); setError(''); setNotice('')
    try {
      const payload = { ...editing, startsAt: isoValue(localValue(editing.startsAt)), endsAt: isoValue(localValue(editing.endsAt)) }
      const response = await authenticatedFetch(editing.id ? `/api/staff/coupons/${editing.id}` : '/api/staff/coupons', { method: editing.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message)
      setEditing(null); setNotice('Cupom salvo com sucesso.'); await load()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Não foi possível salvar o cupom.') }
    finally { setLoading(false) }
  }
  async function remove(coupon: Coupon) {
    if (!confirm(`Desativar o cupom ${coupon.code}?`)) return
    setLoading(true); setError('')
    try {
      const response = await authenticatedFetch(`/api/staff/coupons/${coupon.id}`, { method: 'DELETE' })
      if (!response.ok) throw new Error((await response.json()).message)
      setEditing(null); setNotice('Cupom desativado.'); await load()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Não foi possível desativar o cupom.') }
    finally { setLoading(false) }
  }

  return <section className="coupon-manager">
    <div className="staff-section-heading"><div><h2>Cupons de desconto</h2><span>Crie descontos seguros para o pedido inteiro ou para produtos, fornecedores e seções selecionados.</span></div><button className="primary-button" onClick={() => { setEditing(emptyCoupon()); setSearch(''); setError(''); setNotice('') }}><Plus /> Novo cupom</button></div>
    {error && <div className="staff-alert error">{error}</div>}{notice && <div className="staff-alert success">{notice}</div>}
    {loading && !coupons.length ? <div className="staff-empty"><LoaderCircle className="spin" /> Carregando cupons...</div> : <div className="coupon-grid">{coupons.map((coupon) => <article key={coupon.id} className={!coupon.active ? 'inactive' : ''}><BadgePercent /><div><strong>{coupon.code}</strong><span>{coupon.description}</span><small>{coupon.discountType === 'percent' ? `${decimalDisplay(coupon.discountValue)}%` : `R$ ${decimalDisplay(coupon.discountValue)}`} · {coupon.scopeType === 'order' ? 'pedido inteiro' : `${coupon.targetValues.length} itens selecionados`}</small></div><button className="icon-btn" onClick={() => { setEditing({ ...coupon }); setSearch(''); setError(''); setNotice('') }} aria-label="Editar cupom"><Pencil /></button></article>)}</div>}
    {editing && <div className="banner-modal-backdrop" onMouseDown={() => setEditing(null)}><form className="banner-modal coupon-modal" onSubmit={save} onMouseDown={(event) => event.stopPropagation()}><header className="banner-modal-header"><div><span className="eyebrow">GESTÃO DE CUPONS</span><h2>{editing.id ? 'Editar cupom' : 'Novo cupom'}</h2></div><button type="button" className="icon-btn" onClick={() => setEditing(null)}><X /></button></header><div className="coupon-form">
      <div className="form-row"><label>Código<input value={editing.code} onChange={(event) => setEditing({ ...editing, code: event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '') })} placeholder="EX: PRIMEIRACOMPRA" required /></label><label>Descrição<input value={editing.description} onChange={(event) => setEditing({ ...editing, description: event.target.value })} required /></label></div>
      <div className="form-row"><label>Tipo de desconto<select value={editing.discountType} onChange={(event) => setEditing({ ...editing, discountType: event.target.value as Coupon['discountType'], discountValue: 0 })}><option value="fixed">Valor fixo</option><option value="percent">Percentual</option></select></label><label>Valor<span className="coupon-value-input">{editing.discountType === 'fixed' && <span aria-hidden="true">R$</span>}<input type="text" inputMode="numeric" autoComplete="off" value={decimalDisplay(editing.discountValue)} onChange={(event) => changeDiscount(event.target.value)} placeholder="0,00" aria-label={editing.discountType === 'percent' ? 'Percentual de desconto' : 'Valor do desconto em reais'} required />{editing.discountType === 'percent' && <span aria-hidden="true">%</span>}</span></label></div>
      <label>Aplicação<select value={editing.scopeType} onChange={(event) => setEditing({ ...editing, scopeType: event.target.value as Coupon['scopeType'], targetValues: [] })}><option value="order">Pedido inteiro</option><option value="products">Produtos</option><option value="suppliers">Fornecedores</option><option value="sections">Seções</option></select></label>
      {editing.scopeType !== 'order' && <fieldset className="coupon-targets"><legend>Itens válidos <small>{editing.targetValues.length} selecionados</small></legend><label className="coupon-search"><Search /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por nome ou código" /></label><button type="button" className="picker-select-all" onClick={toggleFilteredOptions} disabled={!options.length}>{allFilteredSelected ? 'Desmarcar resultados' : 'Selecionar todos os resultados'} <small>({options.length})</small></button><div>{options.map((option) => <label key={option.value}><input type="checkbox" checked={editing.targetValues.includes(option.value)} onChange={() => toggle(option.value)} /><span><b>{option.label}</b><small>{option.detail}</small></span></label>)}</div></fieldset>}
      <div className="form-row coupon-use-limits">
        <div><label className="checkbox-line"><input type="checkbox" checked={editing.maxUses !== null} onChange={(event) => setEditing({ ...editing, maxUses: event.target.checked ? 200 : null })} /> Limitar usos no total</label>{editing.maxUses !== null && <label>Máximo de pedidos<input type="number" min="1" max="100000000" value={editing.maxUses} onChange={(event) => setEditing({ ...editing, maxUses: Number(event.target.value) || 1 })} required /></label>}</div>
        <div><label className="checkbox-line"><input type="checkbox" checked={editing.maxUsesPerCustomer !== null} onChange={(event) => setEditing({ ...editing, maxUsesPerCustomer: event.target.checked ? 1 : null })} /> Limitar usos por cliente</label>{editing.maxUsesPerCustomer !== null && <label>Máximo por cliente<input type="number" min="1" max="100000000" value={editing.maxUsesPerCustomer} onChange={(event) => setEditing({ ...editing, maxUsesPerCustomer: Number(event.target.value) || 1 })} required /></label>}</div>
      </div>
      <div className="form-row"><label>Início opcional<input type="datetime-local" value={localValue(editing.startsAt)} onChange={(event) => setEditing({ ...editing, startsAt: isoValue(event.target.value) })} /></label><label>Encerramento opcional<input type="datetime-local" value={localValue(editing.endsAt)} onChange={(event) => setEditing({ ...editing, endsAt: isoValue(event.target.value) })} /></label></div>
      <label className="checkbox-line"><input type="checkbox" checked={editing.active} onChange={(event) => setEditing({ ...editing, active: event.target.checked })} /> Cupom ativo</label>
      {error && <div className="staff-alert error">{error}</div>}
    </div><footer className="banner-modal-actions coupon-modal-actions">{editing.id ? <button type="button" className="banner-delete-button" onClick={() => remove(editing)}><Trash2 /> Desativar</button> : <span />}<button type="button" className="secondary-button" onClick={() => setEditing(null)}>Cancelar</button><button className="primary-button" disabled={loading}>{loading ? <LoaderCircle className="spin" /> : <><Save /> Salvar cupom</>}</button></footer></form></div>}
  </section>
}
