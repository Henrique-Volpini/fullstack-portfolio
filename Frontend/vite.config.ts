import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const base = '/'

// Página única: no servidor de desenvolvimento, qualquer endereço que não seja a página volta para ela.
// Em produção, o public/404.html faz o mesmo no GitHub Pages.
const redirectToHome: Plugin = {
  name: 'redirect-to-home',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const { pathname } = new URL(req.url ?? '/', 'http://localhost')
      const isNavigation = req.method === 'GET' && req.headers.accept?.includes('text/html')
      const isFile = /\.\w+$/.test(pathname) // PDF do currículo, imagens e módulos do Vite
      const isApi = pathname === '/api' || pathname.startsWith('/api/')

      if (!isNavigation || isFile || isApi || pathname === base) return next()
      res.writeHead(302, { Location: base })
      res.end()
    })
  },
}

// https://vite.dev/config/
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
