import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const base = '/'

// Plugin do Vite: no servidor de desenvolvimento, devolve à página inicial os endereços que não são arquivo nem API.
const redirectToHome: Plugin = {
  name: 'redirect-to-home',
  // Registra o middleware que redireciona navegações desconhecidas para a base do site.
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const { pathname } = new URL(req.url ?? '/', 'http://localhost')
      const isNavigation = req.method === 'GET' && req.headers.accept?.includes('text/html')
      const isFile = /\.\w+$/.test(pathname)
      const isApi = pathname === '/api' || pathname.startsWith('/api/')

      if (!isNavigation || isFile || isApi || pathname === base) return next()
      res.writeHead(302, { Location: base })
      res.end()
    })
  },
}

export default defineConfig({
  plugins: [react(), redirectToHome],
  base,
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
