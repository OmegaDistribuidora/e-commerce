export function formatCatalogName(value: string) {
  return value
    .toLocaleLowerCase('pt-BR')
    .replace(/\p{L}[\p{L}\p{M}]*/gu, (word) =>
      word.charAt(0).toLocaleUpperCase('pt-BR') + word.slice(1),
    )
}
