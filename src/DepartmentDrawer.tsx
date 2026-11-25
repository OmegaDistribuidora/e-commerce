import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Store, X } from 'lucide-react'
import { formatCatalogName } from './catalog'
import type { CatalogDepartment } from './types'

// Lista de departamentos para as páginas fora da loja (campanhas, produto, institucionais).
// Cada opção abre a loja já filtrada pelo departamento ou seção escolhido.
export default function DepartmentDrawer({ departments, onClose }: { departments?: CatalogDepartment[]; onClose: () => void }) {
  const [items, setItems] = useState<CatalogDepartment[]>(departments ?? [])
  const [expanded, setExpanded] = useState('')

  useEffect(() => {
    if (departments?.length) {
      setItems(departments)
      return
    }
    const controller = new AbortController()
    fetch('/api/catalog/navigation', { signal: controller.signal })
      .then((response) => response.json())
      .then((data) => { if (Array.isArray(data.departments)) setItems(data.departments) })
      .catch(() => undefined)
    return () => controller.abort()
  }, [departments])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const go = (url: string) => { window.location.href = url }
  const departmentUrl = (name: string) => `/?departamento=${encodeURIComponent(name)}#produtos`

  return <div className="overlay" onMouseDown={onClose}>
    <aside className="side-panel menu-panel department-drawer" onMouseDown={(event) => event.stopPropagation()}>
      <div className="drawer-heading"><div><span className="eyebrow">CATÁLOGO</span><h2>Departamentos</h2></div><button className="icon-btn" onClick={onClose} aria-label="Fechar"><X /></button></div>
      <button className="drawer-all-products" onClick={() => go('/#produtos')}><Store size={20} />Todos os produtos<ChevronRight size={18} /></button>
      <div className="drawer-taxonomy">{items.map((department) => {
        const open = expanded === department.name
        return <div className="drawer-department" key={department.code || department.name}>
          <button onClick={() => setExpanded(open ? '' : department.name)}><span>{formatCatalogName(department.name)}<small>{department.productCount} produtos</small></span><ChevronDown className={open ? 'rotated' : ''} size={18} /></button>
          {open && <div>
            <button className="drawer-department-all" onClick={() => go(departmentUrl(department.name))}>Todos em {formatCatalogName(department.name)}</button>
            {department.sections.map((section) => <button key={`${department.name}-${section.code || section.name}`} onClick={() => go(`/?departamento=${encodeURIComponent(department.name)}&secao=${encodeURIComponent(section.name)}#produtos`)}>{formatCatalogName(section.name)}<small>{section.productCount}</small></button>)}
          </div>}
        </div>
      })}</div>
      <a className="drawer-partners drawer-campaigns" href="/campanhas">Clube de Ofertas<ChevronRight size={18} /></a>
      <a className="drawer-partners" href="/parceiros">Parceiros<ChevronRight size={18} /></a>
      <a className="drawer-partners drawer-login" href="/conta">Entrar ou acessar minha conta<ChevronRight size={18} /></a>
    </aside>
  </div>
}
