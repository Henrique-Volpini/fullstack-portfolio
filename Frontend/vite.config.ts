import { createHash } from 'node:crypto'
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

const GOOGLE_SIGN_IN = 'https://accounts.google.com/gsi/'
let apiUrl = ''

// Plugin do Vite: no build, insere a CSP, que diz ao navegador de onde a página pode carregar e executar código.
// Fica fora do servidor de desenvolvimento porque ele depende de scripts inline.
const contentSecurityPolicy: Plugin = {
  name: 'content-security-policy',
  apply: 'build',
  // Lê a URL da API deste build, a mesma variável usada pelo frontend.
  configResolved(config) {
    apiUrl = config.env.VITE_API_URL?.trim() ?? ''
  },
  transformIndexHtml: {
    order: 'post',
    // Calcula o hash dos scripts inline e coloca a política antes de qualquer script ou estilo.
    handler(html) {
      const inlineScripts = Array.from(
        html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi),
        ([, code]) => `'sha256-${createHash('sha256').update(code).digest('base64')}'`,
      )
      const api = /^https?:\/\//i.test(apiUrl) ? new URL(apiUrl).origin : null
      const policy = [
        "default-src 'self'",
        ['script-src', "'self'", ...inlineScripts, `${GOOGLE_SIGN_IN}client`].join(' '),
        // O script do Google injeta estilos inline e usa uma imagem em data:; a execução de scripts continua bloqueada.
        `style-src 'self' 'unsafe-inline' ${GOOGLE_SIGN_IN}style`,
        "img-src 'self' data:",
        ['connect-src', "'self'", ...(api ? [api, api.replace(/^http/i, 'ws')] : []), GOOGLE_SIGN_IN].join(' '),
        `frame-src ${GOOGLE_SIGN_IN}`,
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; ')

      return [{
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
        injectTo: 'head-prepend',
      }]
    },
  },
}

export default defineConfig({
  plugins: [react(), redirectToHome, contentSecurityPolicy],
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
