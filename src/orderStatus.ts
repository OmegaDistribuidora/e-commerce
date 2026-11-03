export const orderStatusLabels: Record<string, string> = {
  analysis: 'Em análise',
  released: 'Liberado',
  sent: 'Enviado',
}

export function orderStatusLabel(status: string) {
  return orderStatusLabels[status] || 'Em análise'
}
