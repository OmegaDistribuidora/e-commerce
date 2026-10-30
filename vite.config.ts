import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const port = Number(loadEnv(mode, '.', '').VITE_PORT) || 5173

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port,
      proxy: { '/api': 'http://localhost:3000' },
    },
    preview: { host: '0.0.0.0', port },
  }
})
