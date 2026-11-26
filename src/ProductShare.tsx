import { useEffect, useState } from 'react'
import { Check, Link2, Mail } from 'lucide-react'

type ProductShareProps = {
  code: number
  name: string
}

function SocialIcon({ network }: { network: 'whatsapp' | 'instagram' | 'x' | 'linkedin' | 'facebook' }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {network === 'whatsapp' && <><path d="M20.3 11.7a8.3 8.3 0 0 1-11.9 7.5L4 20l.9-4.2A8.3 8.3 0 1 1 20.3 11.7Z" /><path d="M8.6 8.3c-.3.4-.5.9-.4 1.5.4 2.2 2.2 4.3 4.4 5.3.7.3 1.4.4 1.9.1l1-.8-1.9-1.4-.9.8c-1.1-.6-2.1-1.6-2.7-2.7l.8-.8-1.4-2Z" /></>}
    {network === 'instagram' && <><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r=".7" fill="currentColor" stroke="none" /></>}
    {network === 'x' && <><path d="M4 3h3.7L20 21h-3.7L4 3Z" /><path d="M20 3 4 21" /></>}
    {network === 'linkedin' && <><rect x="2.5" y="2.5" width="19" height="19" rx="3" /><path d="M7.4 10.5v6.4m0-9.6v.2m4.2 9.4v-6.4m0 2.8a2.7 2.7 0 0 1 5.4 0v3.6" /></>}
    {network === 'facebook' && <><circle cx="12" cy="12" r="9.5" /><path d="M13.8 7.2h-1.4c-1.2 0-1.8.8-1.8 1.8v8m-2-5h5.2" /></>}
  </svg>
}

export default function ProductShare({ code, name }: ProductShareProps) {
  const [feedback, setFeedback] = useState('')
  const url = `${window.location.origin}/produto/${code}`
  const message = `Confira este produto na Ômega Distribuidora: ${name}: ${url}`
  const encodedUrl = encodeURIComponent(url)

  useEffect(() => {
    if (!feedback) return
    const timeout = window.setTimeout(() => setFeedback(''), 4000)
    return () => window.clearTimeout(timeout)
  }, [feedback])

  async function copy(value: string, successMessage: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
      } else {
        const input = document.createElement('textarea')
        input.value = value
        input.style.position = 'fixed'
        input.style.opacity = '0'
        document.body.appendChild(input)
        input.select()
        const copied = document.execCommand('copy')
        input.remove()
        if (!copied) throw new Error('Cópia indisponível')
      }
      setFeedback(successMessage)
    } catch {
      setFeedback('Não foi possível copiar. Tente novamente.')
    }
  }

  async function shareOnInstagram() {
    if (navigator.share) {
      try {
        await navigator.share({ title: name, text: message })
        return
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
      }
    }
    window.open('https://www.instagram.com/', '_blank', 'noopener,noreferrer')
    await copy(message, 'Mensagem copiada. Cole no Instagram para compartilhar.')
  }

  return <div className="product-share">
    <span className="product-share-label">Compartilhar produto</span>
    <div className="product-share-actions">
      <a href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener noreferrer" aria-label="Compartilhar no WhatsApp" title="WhatsApp"><SocialIcon network="whatsapp" /></a>
      <button type="button" onClick={shareOnInstagram} aria-label="Compartilhar no Instagram" title="Instagram"><SocialIcon network="instagram" /></button>
      <a href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener noreferrer" aria-label="Compartilhar no X" title="X"><SocialIcon network="x" /></a>
      <a href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`} target="_blank" rel="noopener noreferrer" onClick={() => { void copy(message, 'Mensagem copiada. Cole no LinkedIn se desejar adicionar o texto.') }} aria-label="Compartilhar no LinkedIn" title="LinkedIn"><SocialIcon network="linkedin" /></a>
      <a href={`https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`} target="_blank" rel="noopener noreferrer" onClick={() => { void copy(message, 'Mensagem copiada. Cole no Facebook se desejar adicionar o texto.') }} aria-label="Compartilhar no Facebook" title="Facebook"><SocialIcon network="facebook" /></a>
      <a href={`mailto:?subject=${encodeURIComponent(`Produto na Ômega Distribuidora: ${name}`)}&body=${encodeURIComponent(message)}`} aria-label="Compartilhar por e-mail" title="E-mail"><Mail aria-hidden="true" /></a>
      <button type="button" onClick={() => { void copy(url, 'Link do produto copiado.') }} aria-label="Copiar link do produto" title="Copiar link"><Link2 aria-hidden="true" /></button>
    </div>
    <span className="product-share-feedback" role="status" aria-live="polite">{feedback && <><Check size={14} aria-hidden="true" /> {feedback}</>}</span>
  </div>
}
