import { supabase } from './supabase'

export async function authenticatedFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = new Headers(init.headers)
  if (session?.access_token) headers.set('Authorization', `Bearer ${session.access_token}`)
  return fetch(input, { ...init, headers })
}

export async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.text()
  if (!body) throw new Error(response.ok ? 'Não foi possível carregar as informações. Tente novamente.' : 'Não foi possível conectar à loja. Tente novamente.')
  try {
    return JSON.parse(body) as T
  } catch {
    throw new Error('Não foi possível carregar as informações. Tente novamente.')
  }
}
