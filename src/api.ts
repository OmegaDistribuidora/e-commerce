import { supabase } from './supabase'

export async function authenticatedFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = new Headers(init.headers)
  if (session?.access_token) headers.set('Authorization', `Bearer ${session.access_token}`)
  return fetch(input, { ...init, headers })
}

export async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.text()
  if (!body) throw new Error(response.ok ? 'O servidor respondeu sem os dados esperados.' : 'Não foi possível acessar o servidor.')
  try {
    return JSON.parse(body) as T
  } catch {
    throw new Error('O servidor enviou uma resposta inválida. Tente novamente.')
  }
}
