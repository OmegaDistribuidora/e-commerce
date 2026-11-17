export async function productImageAsWebp(file: File) {
  if (file.size > 20 * 1024 * 1024) throw new Error('O arquivo deve ter no máximo 20 MB.')
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Selecione uma imagem PNG, JPG ou WEBP.')
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('Não foi possível abrir esta imagem.'))
      element.src = objectUrl
    })
    const maxDimension = 1600
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Seu navegador não conseguiu processar a imagem.')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/webp', .84)
    if (!dataUrl.startsWith('data:image/webp')) throw new Error('Este navegador não oferece conversão para WEBP.')
    if ((dataUrl.length * 3) / 4 > 5 * 1024 * 1024) throw new Error('A imagem continua maior que 5 MB após a otimização.')
    return dataUrl
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

