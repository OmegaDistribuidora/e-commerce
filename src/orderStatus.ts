export const orderStatusLabels: Record<string, string> = {
  analysis: 'Em análise',
  released: 'Liberado',
  sent: 'Enviado',
  cancelled: 'Cancelado',
}

export function orderStatusLabel(status: string) {
  return orderStatusLabels[status] || 'Em análise'
}
