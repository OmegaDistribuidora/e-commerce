import { useEffect, useMemo, useRef, useState } from 'react'
import { Camera, ImageOff, Search, Trash2, Upload } from 'lucide-react'
import { authenticatedFetch } from './api'
import { productImageAsWebp } from './photoUpload'
import type { CatalogSupplier, StaffCatalogProduct } from './types'

type Kind = 'products' | 'suppliers'
type Item = { id: number; code: number; name: string; image: string | null; supplierId?: number }
type Entry = { file: File; item?: Item; issue: string; result?: string; failed?: boolean }
type Props = {
  products: StaffCatalogProduct[]; suppliers: CatalogSupplier[]
  onProductImage: (id: number, image: string | null) => void
  onSupplierImage: (id: number, image: string | null) => void
}

export function photoFileCode(name: string): number | null {
  const match = /^(\d+)(?:_A)?\.(?:webp|png|jpe?g)$/i.exec(name)
    || /^.+-(\d+)(?:_A)?\.(?:webp|png|jpe?g)$/i.exec(name)
  const code = Number(match?.[1])
  return Number.isSafeInteger(code) && code > 0 ? code : null
}

async function imageRequest(kind: Kind, id: number, method: string, body?: object) {
  const response = await authenticatedFetch(`/api/staff/${kind}/${id}/image`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  })
  const data = await response.json().catch(() => ({})) as { image?: string | null; skipped?: boolean; message?: string }
  if (!response.ok) throw new Error(data.message || 'Não foi possível salvar a imagem. Tente novamente.')
  return data
}

export default function PhotoManager({ products, suppliers, onProductImage, onSupplierImage }: Props) {
  const [kind, setKind] = useState<Kind>('products')
  const [search, setSearch] = useState('')
  const [supplier, setSupplier] = useState('')
  const [limit, setLimit] = useState(100)
  const [entries, setEntries] = useState<Entry[]>([])
  const [onlyMissing, setOnlyMissing] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const stop = useRef(false)
  useEffect(() => () => { stop.current = true }, [])
  useEffect(() => { setLimit(100) }, [search, supplier, kind])
  useEffect(() => {
    if (!busy) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [busy])
  const items: Item[] = useMemo(() => kind === 'products'
    ? products.map(p => ({ id: p.id, code: p.code, name: p.name, image: p.image, supplierId: p.supplierId }))
    : suppliers.map(s => ({ id: s.id, code: s.id, name: s.name, image: s.logo || null })), [kind, products, suppliers])
  const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const visible = items.filter(item => (!supplier || String(item.supplierId) === supplier)
    && normalize(`${item.code} ${item.name}`).includes(normalize(search.trim())))
  const update = (id: number, image: string | null) => (kind === 'products' ? onProductImage : onSupplierImage)(id, image)

  function preview(files: FileList | null) {
    if (!files) return
    setMessage('')
    if (files.length > 500) { setMessage('Selecione até 500 imagens por lote.'); return }
    const selected = Array.from(files)
    const codes = selected.map(file => photoFileCode(file.name))
    const counts = new Map<number | null, number>()
    codes.forEach(code => counts.set(code, (counts.get(code) || 0) + 1))
    const byCode = new Map(items.map(item => [item.code, item]))
    setEntries(selected.map((file, index) => {
      const code = codes[index]
      const item = code ? byCode.get(code) : undefined
      const issue = !code ? 'Nome inválido: use o código no nome do arquivo.'
        : (counts.get(code) || 0) > 1 ? 'Código duplicado no lote. Selecione apenas uma imagem por código.'
        : !item ? 'Código não encontrado no catálogo ativo.'
        : file.size > 20 * 1024 * 1024 ? 'Arquivo maior que 20 MB.' : ''
      return { file, item, issue }
    }))
  }

  async function uploadOne(item: Item, file?: File) {
    if (!file || busy) return
    setBusy(true); setMessage('')
    try {
      const imageDataUrl = await productImageAsWebp(file)
      const data = await imageRequest(kind, item.id, 'PUT', { imageDataUrl })
      update(item.id, data.image || null)
      setMessage(`Imagem de ${item.name} salva.`)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Falha ao enviar imagem.') }
    finally { setBusy(false) }
  }

  async function remove(item: Item) {
    if (busy || !window.confirm(`Excluir a imagem de ${item.name}?`)) return
    setBusy(true); setMessage('')
    try { await imageRequest(kind, item.id, 'DELETE'); update(item.id, null); setMessage('Imagem excluída.') }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Falha ao excluir imagem.') }
    finally { setBusy(false) }
  }

  async function importBatch() {
    if (busy) return
    stop.current = false
    setBusy(true); setMessage('Importação em andamento. Mantenha esta aba aberta.')
    for (let index = 0; index < entries.length; index++) {
      if (stop.current) break
      const entry = entries[index]
      if (entry.issue || !entry.item || (entry.result && !entry.failed)) continue
      let result: string
      let failed = false
      try {
        const imageDataUrl = await productImageAsWebp(entry.file)
        if (stop.current) break
        const data = await imageRequest(kind, entry.item.id, 'PUT', { imageDataUrl, onlyMissing })
        result = data.skipped ? 'Ignorado: já possui imagem.' : 'Salvo em WEBP.'
        if (!data.skipped) update(entry.item.id, data.image || null)
      } catch (error) {
        failed = true
        result = error instanceof Error ? error.message : 'Falha ao enviar imagem.'
      }
      setEntries(current => current.map((e, i) => i === index ? { ...e, result, failed } : e))
    }
    setBusy(false)
    setMessage(stop.current ? 'Importação interrompida. As imagens já salvas foram mantidas.' : 'Lote processado. Confira o resultado de cada arquivo abaixo.')
  }

  const pending = entries.filter(e => !e.issue && (!e.result || e.failed)).length
  const completed = entries.filter(e => e.result && !e.failed).length
  return <section className="product-photo-manager">
    <div className="photo-tabs" role="group" aria-label="Tipo de imagem">
      <button className={kind === 'products' ? 'active' : ''} disabled={busy} onClick={() => { setKind('products'); setEntries([]); setSearch(''); setSupplier(''); setMessage('') }}>Produtos</button>
      <button className={kind === 'suppliers' ? 'active' : ''} disabled={busy} onClick={() => { setKind('suppliers'); setEntries([]); setSearch(''); setSupplier(''); setMessage('') }}>Fornecedores</button>
    </div>
    <div className="staff-section-heading"><div><h2>{kind === 'products' ? 'Fotos dos produtos' : 'Logos dos fornecedores'}</h2><span>PNG, JPG e WEBP. As imagens são otimizadas em WEBP, sem cortes.</span></div><strong>{items.filter(i => i.image).length} de {items.length} com imagem</strong></div>
    <div className="photo-batch">
      <h3>Importar imagens em lote</h3>
      <p>Use o código {kind === 'products' ? 'do produto' : 'do fornecedor'}: <b>16449.webp</b>, <b>16449_A.png</b> ou <b>nome-16449.webp</b>. Até 500 arquivos por lote e 20 MB por arquivo.</p>
      <div className="photo-batch-controls">
        <label className="secondary-button"><Upload /> Selecionar imagens<input type="file" multiple accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e => { preview(e.target.files); e.currentTarget.value = '' }} /></label>
        <label>Tratamento das fotos existentes<select disabled={busy || completed > 0} value={onlyMissing ? 'missing' : 'replace'} onChange={e => setOnlyMissing(e.target.value === 'missing')}><option value="missing">Preencher somente as ausentes</option><option value="replace">Substituir as imagens existentes</option></select></label>
      </div>
      {entries.length > 0 && <>
        <p>{entries.length} arquivos · {entries.filter(e => e.issue).length} com impedimento · {completed} concluídos · {entries.filter(e => e.failed).length} falhas</p>
        <div className="photo-batch-preview"><table><thead><tr><th>Arquivo</th><th>Cadastro identificado</th><th>Resultado / previsão</th></tr></thead><tbody>{entries.map((e, i) => <tr key={i}><td>{e.file.name}</td><td>{e.item ? `${e.item.code} · ${e.item.name}` : '—'}</td><td className={e.issue || e.failed ? 'photo-batch-error' : ''}>{e.issue || e.result || (onlyMissing && e.item?.image ? 'Já possui imagem: será preservada' : 'Pronto para enviar')}</td></tr>)}</tbody></table></div>
        <progress aria-label="Progresso da importação" value={entries.filter(e => e.result || e.issue).length} max={entries.length} />
        <div className="photo-batch-controls"><button className="primary-button" disabled={busy || !pending} onClick={() => void importBatch()}>{busy ? 'Enviando…' : 'Importar / continuar lote'}</button>{busy && <button className="secondary-button" onClick={() => { stop.current = true }}>Parar após o arquivo atual</button>}<button className="secondary-button" disabled={busy} onClick={() => setEntries([])}>Limpar lote</button></div>
      </>}
      {message && <p role="status" aria-live="polite">{message}</p>}
    </div>
    <div className="photo-manager-filters"><label><Search /><input aria-label="Buscar imagens" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por código ou nome" /></label>{kind === 'products' && <select aria-label="Fornecedor" value={supplier} onChange={e => setSupplier(e.target.value)}><option value="">Todos os fornecedores</option>{suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</div>
    <div className="photo-results-summary">{visible.length} encontrados</div>
    <div className="product-photo-grid">{visible.slice(0, limit).map(item => <article key={item.id}>
      <div className="product-photo-preview">{item.image ? <img loading="lazy" src={item.image} alt={item.name} /> : <span><ImageOff /><b>Sem imagem</b></span>}</div>
      <div className="product-photo-info"><small>CÓD. {item.code}</small><strong>{item.name}</strong></div>
      <div className="product-photo-actions"><label className="secondary-button"><Camera />{item.image ? 'Substituir' : 'Adicionar'}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e => { void uploadOne(item, e.target.files?.[0]); e.currentTarget.value = '' }} /></label>{item.image && <button className="photo-delete" disabled={busy} onClick={() => void remove(item)}><Trash2 /> Excluir</button>}</div>
    </article>)}</div>
    {visible.length > limit && <button className="secondary-button" onClick={() => setLimit(n => n + 100)}>Mostrar mais</button>}
  </section>
}
