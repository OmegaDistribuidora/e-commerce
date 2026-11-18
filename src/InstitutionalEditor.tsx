import { Building2, ImagePlus, LoaderCircle, Save, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { authenticatedFetch } from './api'
import type { InstitutionalContent } from './types'

type Draft = InstitutionalContent & {
  heroImageDataUrl: string
  historyImageDataUrl: string
  removeHeroImage: boolean
  removeHistoryImage: boolean
}

function toDraft(content: InstitutionalContent): Draft {
  return {
    ...content,
    heroImageDataUrl: '',
    historyImageDataUrl: '',
    removeHeroImage: false,
    removeHistoryImage: false,
  }
}

async function readImage(file: File) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('Use uma imagem PNG, JPG ou WEBP.')
  }
  if (file.size > 5 * 1024 * 1024) throw new Error('A imagem deve ter no máximo 5 MB.')
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('Não foi possível ler a imagem.'))
    reader.readAsDataURL(file)
  })
}

export default function InstitutionalEditor() {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    fetch('/api/site/institutional').then(async (response) => {
      const data = await response.json()
      if (!response.ok) throw new Error(data.message)
      setDraft(toDraft(data.content))
    }).catch((reason) => setError(reason.message || 'Não foi possível carregar o conteúdo.')).finally(() => setLoading(false))
  }, [])

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current)
    setError('')
    setNotice('')
  }

  async function selectImage(slot: 'hero' | 'history', file?: File) {
    if (!file) return
    try {
      const dataUrl = await readImage(file)
      setDraft((current) => {
        if (!current) return current
        return slot === 'hero'
          ? { ...current, heroImageDataUrl: dataUrl, heroImageUrl: dataUrl, removeHeroImage: false }
          : { ...current, historyImageDataUrl: dataUrl, historyImageUrl: dataUrl, removeHistoryImage: false }
      })
      setError('')
      setNotice('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Imagem inválida.')
    }
  }

  function removeImage(slot: 'hero' | 'history') {
    setDraft((current) => {
      if (!current) return current
      return slot === 'hero'
        ? { ...current, heroImageUrl: null, heroImageDataUrl: '', removeHeroImage: true }
        : { ...current, historyImageUrl: null, historyImageDataUrl: '', removeHistoryImage: true }
    })
    setNotice('')
  }

  async function save() {
    if (!draft) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await authenticatedFetch('/api/staff/site/institutional', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message || 'Não foi possível salvar o conteúdo.')
      setDraft(toDraft(data.content))
      setNotice('Página institucional atualizada com sucesso.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível salvar o conteúdo.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="content-page-state"><LoaderCircle className="spin" /><span>Carregando conteúdo...</span></div>
  if (!draft) return <div className="staff-alert error">{error || 'Conteúdo indisponível.'}</div>

  return <section className="institutional-editor">
    <div className="staff-section-heading"><div><h2>Sobre a Ômega</h2><span>Edite os textos e imagens exibidos na página institucional da loja.</span></div><a className="secondary-button" href="/sobre" target="_blank" rel="noreferrer">Ver página</a></div>
    {error && <div className="staff-alert error">{error}</div>}
    {notice && <div className="staff-alert success">{notice}</div>}

    <article>
      <header><Building2 /><div><h3>Apresentação</h3><span>Primeiro bloco da página</span></div></header>
      <div className="institutional-editor-grid">
        <div className="institutional-fields">
          <label>Título<input value={draft.heroTitle} onChange={(event) => update('heroTitle', event.target.value)} /></label>
          <label>Texto de apresentação<textarea rows={6} value={draft.heroSubtitle} onChange={(event) => update('heroSubtitle', event.target.value)} /></label>
        </div>
        <ImageField image={draft.heroImageUrl} label="Imagem de apresentação" onSelect={(file) => selectImage('hero', file)} onRemove={() => removeImage('hero')} />
      </div>
    </article>

    <article>
      <header><Building2 /><div><h3>Nossa história</h3><span>Conte a trajetória da empresa</span></div></header>
      <div className="institutional-editor-grid">
        <div className="institutional-fields">
          <label>Título<input value={draft.historyTitle} onChange={(event) => update('historyTitle', event.target.value)} /></label>
          <label>História<textarea rows={10} value={draft.historyText} onChange={(event) => update('historyText', event.target.value)} /></label>
        </div>
        <ImageField image={draft.historyImageUrl} label="Imagem da história" onSelect={(file) => selectImage('history', file)} onRemove={() => removeImage('history')} />
      </div>
    </article>

    <article>
      <header><Building2 /><div><h3>Compromisso e valores</h3><span>Bloco final da página</span></div></header>
      <div className="institutional-fields">
        <label>Título<input value={draft.valuesTitle} onChange={(event) => update('valuesTitle', event.target.value)} /></label>
        <label>Texto<textarea rows={8} value={draft.valuesText} onChange={(event) => update('valuesText', event.target.value)} /></label>
      </div>
    </article>

    <footer><button className="primary-button" disabled={saving} onClick={save}>{saving ? <LoaderCircle className="spin" /> : <Save />} {saving ? 'Salvando...' : 'Salvar conteúdo institucional'}</button></footer>
  </section>
}

function ImageField({ image, label, onSelect, onRemove }: { image: string | null; label: string; onSelect: (file?: File) => void; onRemove: () => void }) {
  return <div className="institutional-image-field">
    <strong>{label}</strong>
    <div>{image ? <img src={image} alt="Prévia" /> : <span><ImagePlus /><small>Nenhuma imagem</small></span>}</div>
    <label className="secondary-button"><ImagePlus /> Escolher imagem<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => onSelect(event.target.files?.[0])} /></label>
    {image && <button className="institutional-remove-image" type="button" onClick={onRemove}><Trash2 /> Remover imagem</button>}
    <small>PNG, JPG ou WEBP, até 5 MB.</small>
  </div>
}
