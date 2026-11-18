import { LockKeyhole } from 'lucide-react'

const whatsappUrl = `https://wa.me/558592020207?text=${encodeURIComponent('Olá! Venho do e-Commerce da Ômega Distribuidora e preciso de atendimento!')}`

export default function PublicSiteFooter() {
  return <footer>
    <div className="container footer-grid">
      <div className="footer-brand"><img src="/assets/omega-logo.png" alt="Ômega Distribuidora" /><p>Distribuindo mais do que produtos: parcerias de sucesso.</p></div>
      <div><strong>Institucional</strong><a href="/sobre">Sobre a Ômega</a><a href="/parceiros">Nossos parceiros</a><a href={whatsappUrl} target="_blank" rel="noreferrer">Fale conosco</a></div>
      <div><strong>Atendimento</strong><span>Segunda a sexta, 8h às 17h</span><a href={whatsappUrl} target="_blank" rel="noreferrer">WhatsApp: (85) 9202-0207</a></div>
      <div><strong>Compra protegida</strong><p className="security-copy"><LockKeyhole size={19} /> Ambiente seguro para seus pedidos.</p></div>
    </div>
    <div className="container footer-bottom"><span>© 2026 Ômega Distribuidora. Todos os direitos reservados.</span><span>Preços unitários sujeitos à confirmação comercial.</span></div>
  </footer>
}
