import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://invalid.supabase.co'
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'missing-publishable-key'

export const supabaseConfigured = Boolean(
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
)

// Links de primeiro acesso enviados pelo backend (POST /auth/v1/recover) usam o fluxo
// implícito e voltam com os tokens no hash. O cliente em modo PKCE recusa esse formato,
// então os tokens são lidos aqui, antes de o cliente processar a URL.
const urlHash = typeof window !== 'undefined' ? new URLSearchParams(window.location.hash.slice(1)) : null
const implicitRecovery = urlHash?.get('access_token') && urlHash.get('refresh_token')
  ? { access_token: urlHash.get('access_token') as string, refresh_token: urlHash.get('refresh_token') as string }
  : null
export const recoveryLinkError = urlHash?.get('error_description') || ''
if (implicitRecovery || recoveryLinkError) {
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
}

export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
  },
})

// Resolve quando a sessão do link (se houver) já estiver ativa.
export const recoverySessionReady: Promise<string> = implicitRecovery
  ? supabase.auth.setSession(implicitRecovery).then(({ error }) => error?.message || '')
  : Promise.resolve('')
