export const orderStatusLabels: Record<string, string> = {
  analysis: 'Em análise',
  released: 'Liberado',
  sent: 'Enviado',
  delivered: 'Entregue',
  cancelled: 'Cancelado',
}

// Converte AAAA-MM-DD em DD/MM/AAAA sem passar por fuso horário.
export function formatDeliveryDate(value?: string | null) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '')
  return match ? `${match[3]}/${match[2]}/${match[1]}` : ''
}

export function orderStatusLabel(status: string) {
  return orderStatusLabels[status] || 'Em análise'
}
