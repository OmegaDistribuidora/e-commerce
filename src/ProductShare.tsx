import { useEffect, useState } from 'react'
import { Check, Link2, Mail } from 'lucide-react'

type ProductShareProps = {
  code: number
  name: string
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
      <a href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener noreferrer" aria-label="Compartilhar no WhatsApp" title="WhatsApp"><img src="/assets/social/whatsapp.png" alt="" /></a>
      <button type="button" onClick={shareOnInstagram} aria-label="Compartilhar no Instagram" title="Instagram"><img src="/assets/social/instagram.jpg" alt="" /></button>
      <a href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener noreferrer" aria-label="Compartilhar no X" title="X"><img src="/assets/social/x.webp" alt="" /></a>
      <a href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`} target="_blank" rel="noopener noreferrer" onClick={() => { void copy(message, 'Mensagem copiada. Cole no LinkedIn se desejar adicionar o texto.') }} aria-label="Compartilhar no LinkedIn" title="LinkedIn"><img src="/assets/social/linkedin.png" alt="" /></a>
      <a href={`https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`} target="_blank" rel="noopener noreferrer" onClick={() => { void copy(message, 'Mensagem copiada. Cole no Facebook se desejar adicionar o texto.') }} aria-label="Compartilhar no Facebook" title="Facebook"><img src="/assets/social/facebook.png" alt="" /></a>
      <a href={`mailto:?subject=${encodeURIComponent(`Produto na Ômega Distribuidora: ${name}`)}&body=${encodeURIComponent(message)}`} aria-label="Compartilhar por e-mail" title="E-mail"><Mail aria-hidden="true" /></a>
      <button type="button" onClick={() => { void copy(url, 'Link do produto copiado.') }} aria-label="Copiar link do produto" title="Copiar link"><Link2 aria-hidden="true" /></button>
    </div>
    <span className="product-share-feedback" role="status" aria-live="polite">{feedback && <><Check size={14} aria-hidden="true" /> {feedback}</>}</span>
  </div>
}
