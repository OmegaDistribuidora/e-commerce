import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, BadgePercent, Check, LoaderCircle, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import { authenticatedFetch } from './api'
import { formatCatalogName } from './catalog'
import type { CatalogDepartment, CatalogSupplier, DiscountCampaign, StaffCatalogProduct } from './types'

type Props = {
  campaigns: DiscountCampaign[]
  onChange: (campaigns: DiscountCampaign[]) => void
  products: StaffCatalogProduct[]
  suppliers: CatalogSupplier[]
  departments: CatalogDepartment[]
}
type Option = { value: string; label: string; detail?: string }
type Stage = 'details' | 'scope' | 'rewards' | 'clients' | 'cities' | 'review'

function brasiliaDate(offset = 0) {
  const date = new Date(Date.now() + offset * 86400000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}
function emptyCampaign(): DiscountCampaign {
  return {
    id: 0, code: 0, name: '', description: '', startsOn: brasiliaDate(), endsOn: brasiliaDate(30),
    ruleType: 'percent', scopeType: 'products', targetValues: [], rewardProductCodes: [], rewardItems: [], allowRepeat: false,
    discountValue: 0, thresholdBasis: 'units', thresholdQuantity: 1, buyQuantity: 1,
    freeQuantity: 1, allowedCustomerIds: [], allowedCities: [], active: true, products: [],
  }
}
const labelForRule = (item: DiscountCampaign) => item.ruleType === 'buy_get'
  ? `Compre ${item.buyQuantity} e ganhe ${(item.rewardItems || []).reduce((sum, reward) => sum + reward.quantity, 0)} unidade(s)`
  : item.ruleType === 'fixed' ? `R$ ${Number(item.discountValue || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} de desconto`
    : `${Number(item.discountValue || 0).toLocaleString('pt-BR')}% de desconto`

export default function CampaignManager({ campaigns, onChange, products, suppliers, departments }: Props) {
  const [editing, setEditing] = useState<DiscountCampaign | null>(null)
  const [stageIndex, setStageIndex] = useState(0)
  const [search, setSearch] = useState('')
  const [remoteOptions, setRemoteOptions] = useState<Option[]>([])
  const [selectedNames, setSelectedNames] = useState<Record<string, string>>({})
  const [restrictClients, setRestrictClients] = useState(false)
  const [restrictCities, setRestrictCities] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const optionsRef = useRef<HTMLDivElement>(null)

  const stages = useMemo<Stage[]>(() => {
    if (!editing) return []
    return ['details', 'scope', ...(editing.ruleType === 'buy_get' ? ['rewards'] : []),
      ...(restrictClients ? ['clients'] : []), ...(restrictCities ? ['cities'] : []), 'review'] as Stage[]
  }, [editing?.ruleType, restrictClients, restrictCities])
  const stage = stages[stageIndex] || 'details'
  const values = stage === 'scope' ? editing?.targetValues || [] : stage === 'rewards'
    ? (editing?.rewardItems || []).map((item) => item.code) : stage === 'clients' ? editing?.allowedCustomerIds || [] : editing?.allowedCities || []
  const selected = new Set(values.map(String))
  const localOptions = useMemo<Option[]>(() => {
    if (!editing) return []
    if (stage === 'scope' && editing.scopeType === 'suppliers') return suppliers.map((item) => ({ value: String(item.id), label: item.name, detail: `Cód. ${item.id}` }))
    if (stage === 'scope' && editing.scopeType === 'sections') return departments.flatMap((department) => department.sections.map((section) => ({ value: String(section.code), label: formatCatalogName(section.name), detail: `${formatCatalogName(department.name)} · cód. ${section.code}` })))
    if (stage === 'scope' || stage === 'rewards') return products.map((item) => ({ value: String(item.code), label: item.name, detail: `${item.brand} · cód. ${item.code}` }))
    return []
  }, [editing?.scopeType, stage, products, suppliers, departments])
  const options = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('pt-BR')
    const source = stage === 'clients' || stage === 'cities' ? remoteOptions : localOptions
    return source.filter((option) => !term || `${option.value} ${option.label} ${option.detail || ''}`.toLocaleLowerCase('pt-BR').includes(term))
      .sort((a, b) => Number(selected.has(b.value)) - Number(selected.has(a.value)) || a.label.localeCompare(b.label, 'pt-BR'))
  }, [stage, search, remoteOptions, localOptions, values.join(',')])

  useEffect(() => { if (optionsRef.current) optionsRef.current.scrollTop = 0 }, [stage, search])

  useEffect(() => {
    if (stage !== 'clients' && stage !== 'cities') return
    if (stage === 'clients' && search.trim().length < 2) { setRemoteOptions([]); return }
    let active = true
    const timer = window.setTimeout(async () => {
      try {
        const response = await authenticatedFetch(`/api/staff/campaigns/options?kind=${stage}&q=${encodeURIComponent(search.trim())}`)
        const data = await response.json()
        if (!response.ok) throw new Error(data.message)
        if (active) setRemoteOptions((data.options || []).map((option: { code?: number; name: string; city?: string }) => ({
          value: String(option.code ?? option.name), label: option.name,
          detail: option.code ? `Cód. ${option.code}${option.city ? ` · ${option.city}` : ''}` : undefined,
        })))
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : 'Não foi possível buscar opções.') }
    }, 250)
    return () => { active = false; window.clearTimeout(timer) }
  }, [stage, search])

  function open(item: DiscountCampaign) {
    setEditing({ ...item, targetValues: [...(item.targetValues || [])], rewardItems: [...(item.rewardItems || [])], rewardProductCodes: [...(item.rewardProductCodes || [])], allowedCustomerIds: [...(item.allowedCustomerIds || [])], allowedCities: [...(item.allowedCities || [])] })
    setRestrictClients(Boolean(item.allowedCustomerIds?.length)); setRestrictCities(Boolean(item.allowedCities?.length))
    setStageIndex(0); setSearch(''); setError(''); setNotice(''); setSelectedNames({})
  }
  function update(values: Partial<DiscountCampaign>) { setEditing((current) => current ? { ...current, ...values } : current) }
  function setSelection(next: Set<string>) {
    if (stage === 'scope') update({ targetValues: [...next].map(Number) })
    else if (stage === 'rewards') update({ rewardItems: [...next].map((code) => editing?.rewardItems?.find((item) => item.code === Number(code)) || { code: Number(code), quantity: 1 }) })
    else if (stage === 'clients') update({ allowedCustomerIds: [...next].map(Number) })
    else update({ allowedCities: [...next] })
  }
  function toggle(option: Option) {
    const next = new Set(selected)
    if (next.has(option.value)) next.delete(option.value); else next.add(option.value)
    setSelectedNames((current) => ({ ...current, [option.value]: option.label }))
    setSelection(next)
  }
  function selectFiltered() {
    const next = new Set(selected)
    const all = options.length > 0 && options.every((option) => next.has(option.value))
    for (const option of options) { if (all) next.delete(option.value); else next.add(option.value) }
    setSelectedNames((current) => Object.assign({ ...current }, Object.fromEntries(options.map((option) => [option.value, option.label]))))
    setSelection(next)
  }
  function nextStage() {
    if (!editing) return
    if (stage === 'details' && (!editing.name?.trim() || !editing.description.trim() || !editing.startsOn || !editing.endsOn || editing.endsOn < editing.startsOn || (editing.ruleType !== 'buy_get' && (!editing.discountValue || editing.discountValue > (editing.ruleType === 'percent' ? 100 : 99999999))))) {
      setError('Preencha nome, descrição, período e desconto válidos.'); return
    }
    if (stage === 'details' && editing.ruleType === 'buy_get' && (!Number.isSafeInteger(editing.buyQuantity) || Number(editing.buyQuantity) < 1)) {
      setError('Informe a quantidade mínima para ativar os brindes.'); return
    }
    if ((stage === 'scope' || stage === 'rewards' || stage === 'clients' || stage === 'cities') && !values.length) {
      setError('Selecione pelo menos uma opção para avançar.'); return
    }
    if (stage === 'rewards' && editing.rewardItems?.some((item) => !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 100000)) {
      setError('Informe uma quantidade válida para cada produto gratuito.'); return
    }
    setError(''); setSearch(''); setStageIndex((index) => Math.min(stages.length - 1, index + 1))
  }
  async function save() {
    if (!editing) return
    setLoading(true); setError('')
    try {
      const payload = { ...editing, allowedCustomerIds: restrictClients ? editing.allowedCustomerIds : [], allowedCities: restrictCities ? editing.allowedCities : [] }
      const response = await authenticatedFetch(editing.id ? `/api/staff/campaigns/${editing.id}` : '/api/staff/campaigns', {
        method: editing.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message)
      const refreshed = await authenticatedFetch('/api/staff/campaigns')
      if (!refreshed.ok) throw new Error('A campanha foi salva, mas a lista não pôde ser atualizada.')
      onChange((await refreshed.json()).campaigns)
      setEditing(null); setNotice('Campanha salva com sucesso.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Não foi possível salvar a campanha.') }
    finally { setLoading(false) }
  }
  async function deactivate() {
    if (!editing?.id || !window.confirm(`Desativar a campanha ${editing.name}?`)) return
    setLoading(true); setError('')
    try {
      const response = await authenticatedFetch(`/api/staff/campaigns/${editing.id}`, { method: 'DELETE' })
      if (!response.ok) throw new Error((await response.json()).message)
      onChange(campaigns.map((campaign) => campaign.id === editing.id ? { ...campaign, active: false } : campaign))
      setEditing(null); setNotice('Campanha desativada.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Não foi possível desativar.') }
    finally { setLoading(false) }
  }

  return <section className="campaign-manager">
    <div className="staff-section-heading"><div><h2>Clube de Ofertas</h2><span>Crie condições para produtos, seções ou fornecedores e defina o público participante.</span></div><button className="primary-button" onClick={() => open(emptyCampaign())}><Plus /> Nova campanha</button></div>
    {notice && <div className="staff-alert success">{notice}</div>}
    <div className="campaign-manager-grid">{campaigns.map((campaign) => <article key={campaign.code} className={!campaign.active ? 'inactive' : ''}><BadgePercent /><div><strong>{campaign.name || campaign.description}</strong><span>{campaign.description}</span><small>{labelForRule(campaign)} · {campaign.products.length} produtos · {campaign.active ? 'Ativa' : 'Inativa'}</small></div><button className="icon-btn" onClick={() => open(campaign)} aria-label={`Editar ${campaign.name}`}><Pencil /></button></article>)}</div>
    {!campaigns.length && <div className="staff-empty">Nenhuma campanha cadastrada.</div>}
    {editing && <div className="banner-modal-backdrop" onMouseDown={() => setEditing(null)}><div className="banner-modal campaign-modal" role="dialog" aria-modal="true" aria-label="Editar campanha" onMouseDown={(event) => event.stopPropagation()}>
      <header className="banner-modal-header"><div><span className="eyebrow">GESTÃO DE CAMPANHAS</span><h2>{editing.id ? 'Editar campanha' : 'Nova campanha'}</h2><small>Etapa {stageIndex + 1} de {stages.length}</small></div><button className="icon-btn" onClick={() => setEditing(null)} aria-label="Fechar"><X /></button></header>
      <div className="campaign-form">
        {stage === 'details' && <>
          <div className="form-row"><label>Nome da campanha<input value={editing.name || ''} onChange={(event) => update({ name: event.target.value })} maxLength={160} /></label><label>Tipo de campanha<select value={editing.ruleType} onChange={(event) => update({ ruleType: event.target.value as DiscountCampaign['ruleType'] })}><option value="percent">Percentual</option><option value="fixed">Valor fixo</option><option value="buy_get">Compre X, leve Y</option></select></label></div>
          <label>Descrição<textarea value={editing.description} onChange={(event) => update({ description: event.target.value })} rows={3} maxLength={1000} /></label>
          <div className="form-row"><label>Produtos participantes<select value={editing.scopeType} onChange={(event) => update({ scopeType: event.target.value as DiscountCampaign['scopeType'], targetValues: [] })}><option value="products">Produtos específicos</option><option value="sections">Seções</option><option value="suppliers">Fornecedores</option></select></label><label>Contar a partir de<select value={editing.thresholdBasis} onChange={(event) => update({ thresholdBasis: event.target.value as DiscountCampaign['thresholdBasis'] })}><option value="units">Unidades somadas</option><option value="boxes">Caixas completas somadas</option></select></label></div>
          {editing.ruleType === 'buy_get' ? <><label>Compre X {editing.thresholdBasis === 'boxes' ? 'caixas' : 'unidades'} dos produtos participantes<input type="number" min="1" value={editing.buyQuantity} onChange={(event) => update({ buyQuantity: Number(event.target.value) })} /></label><label className="campaign-repeat-toggle"><input type="checkbox" checked={!editing.allowRepeat} onChange={(event) => update({ allowRepeat: !event.target.checked })} /><span><strong>Brinde uma vez por pedido</strong><small>Mesmo comprando duas vezes a quantidade mínima, o cliente recebe cada brinde apenas uma vez.</small></span></label></> : <div className="form-row"><label>{editing.ruleType === 'percent' ? 'Desconto (%)' : 'Desconto (R$)'}<input type="number" min="0.01" max={editing.ruleType === 'percent' ? 100 : undefined} step="0.01" value={editing.discountValue || ''} onChange={(event) => update({ discountValue: Number(event.target.value) })} /></label><label>A partir de quantas {editing.thresholdBasis === 'boxes' ? 'caixas' : 'unidades'}?<input type="number" min="1" value={editing.thresholdQuantity} onChange={(event) => update({ thresholdQuantity: Number(event.target.value) })} /></label></div>}
          <div className="form-row"><label>Início<input type="date" value={String(editing.startsOn).slice(0, 10)} onChange={(event) => update({ startsOn: event.target.value })} /></label><label>Fim<input type="date" value={String(editing.endsOn).slice(0, 10)} onChange={(event) => update({ endsOn: event.target.value })} /></label></div>
          <div className="campaign-audience-toggles"><label><input type="checkbox" checked={restrictClients} onChange={(event) => { setRestrictClients(event.target.checked); update({ allowedCustomerIds: [] }) }} /> Restringir por cliente</label><label><input type="checkbox" checked={restrictCities} onChange={(event) => { setRestrictCities(event.target.checked); update({ allowedCities: [] }) }} /> Restringir por cidade</label><label><input type="checkbox" checked={editing.active} onChange={(event) => update({ active: event.target.checked })} /> Campanha ativa</label></div>
        </>}
        {['scope', 'rewards', 'clients', 'cities'].includes(stage) && <><h3>{stage === 'scope' ? `Selecione ${editing.scopeType === 'products' ? 'os produtos' : editing.scopeType === 'sections' ? 'as seções' : 'os fornecedores'}` : stage === 'rewards' ? 'Selecione os produtos gratuitos' : stage === 'clients' ? 'Selecione os clientes' : 'Selecione as cidades'}</h3><p className="campaign-picker-intro">{stage === 'clients' ? 'Pesquise pelo código ou nome. A busca inclui clientes sem acesso à loja.' : 'Você pode buscar e selecionar todos os resultados de uma vez.'}</p><div className="campaign-picker-toolbar"><label className="coupon-search"><Search /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={stage === 'clients' ? 'Buscar cliente por código ou nome' : 'Buscar por nome ou código'} /></label><button className="picker-select-all" onClick={selectFiltered} disabled={!options.length}>{options.length && options.every((option) => selected.has(option.value)) ? 'Desmarcar resultados' : 'Selecionar todos os resultados'} <small>({options.length})</small></button></div><div className="campaign-selected">{[...selected].map((value) => <button key={value} onClick={() => toggle({ value, label: selectedNames[value] || value })}>{selectedNames[value] || value} <X size={13} /></button>)}</div><div className="campaign-options" ref={optionsRef}>{options.map((option) => <label key={option.value}><input type="checkbox" checked={selected.has(option.value)} onChange={() => toggle(option)} /><span><b>{option.label}</b><small>{option.detail}</small></span>{selected.has(option.value) && <Check size={16} />}</label>)}</div></>}
        {stage === 'rewards' && Boolean(editing.rewardItems?.length) && <div className="campaign-reward-quantities"><h4>Quantidade gratuita de cada produto</h4>{editing.rewardItems?.map((reward) => <label key={reward.code}><span>{selectedNames[String(reward.code)] || products.find((item) => item.code === reward.code)?.name || `Produto ${reward.code}`}</span><input type="number" min="1" max="100000" step="1" value={reward.quantity} onChange={(event) => update({ rewardItems: editing.rewardItems?.map((item) => item.code === reward.code ? { ...item, quantity: Number(event.target.value) } : item) })} /><small>unidades grátis</small></label>)}</div>}
        {stage === 'review' && <div className="campaign-review"><h3>Confira a campanha</h3><dl><div><dt>Campanha</dt><dd>{editing.name}</dd></div><div><dt>Regra</dt><dd>{labelForRule(editing)}</dd></div><div><dt>Participantes</dt><dd>{editing.targetValues?.length} {editing.scopeType === 'products' ? 'produtos' : editing.scopeType === 'sections' ? 'seções' : 'fornecedores'}</dd></div><div><dt>Mínimo</dt><dd>{editing.ruleType === 'buy_get' ? editing.buyQuantity : editing.thresholdQuantity} {editing.thresholdBasis === 'boxes' ? 'caixas completas' : 'unidades somadas'}</dd></div>{editing.ruleType === 'buy_get' && <><div><dt>Brindes</dt><dd>{editing.rewardItems?.map((item) => `${item.quantity} un. do produto ${item.code}`).join(', ')}</dd></div><div><dt>Repetição</dt><dd>{editing.allowRepeat ? 'A cada X produtos comprados' : 'Uma vez por pedido'}</dd></div></>}<div><dt>Clientes</dt><dd>{restrictClients ? editing.allowedCustomerIds?.length : 'Todos'}</dd></div><div><dt>Cidades</dt><dd>{restrictCities ? editing.allowedCities?.length : 'Todas'}</dd></div><div><dt>Período</dt><dd>{editing.startsOn} a {editing.endsOn}</dd></div></dl></div>}
        {error && <div className="staff-alert error">{error}</div>}
      </div><footer className="banner-modal-actions">{editing.id ? <button className="banner-delete-button" onClick={deactivate} disabled={loading}><Trash2 /> Desativar</button> : <span />}{stageIndex > 0 && <button className="secondary-button" onClick={() => { setError(''); setSearch(''); setStageIndex(stageIndex - 1) }}><ArrowLeft /> Voltar</button>}{stage === 'review' ? <button className="primary-button" onClick={save} disabled={loading}>{loading ? <LoaderCircle className="spin" /> : <Check />} Salvar campanha</button> : <button className="primary-button" onClick={nextStage}>Avançar <ArrowRight /></button>}</footer>
    </div></div>}
  </section>
}
