import { createHash } from 'node:crypto'
import react from '@vitejs/plugin-react'
import { defineConfig, type HtmlTagDescriptor, type Plugin } from 'vite'
import { texts } from './src/texts.ts'

const base = '/'
const SITE_URL = 'https://henriquevolpini.com.br/'
const SHARE_IMAGE = 'previa-henrique-volpini.jpg'

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

// Escapa os caracteres especiais de um texto colocado dentro do HTML.
const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Plugin do Vite: preenche no index.html o idioma, o título, a descrição e a prévia de link com os textos de src/texts.ts.
const siteMeta: Plugin = {
  name: 'site-meta',
  transformIndexHtml(html) {
    if (!html.includes('<html>')) throw new Error('index.html precisa da tag <html> sem atributos para receber o idioma.')

    const { meta } = texts
    // Monta uma meta tag para o fim do head.
    const metaTag = (attrs: Record<string, string>): HtmlTagDescriptor => ({ tag: 'meta', attrs, injectTo: 'head' })
    return {
      html: html.replace('<html>', `<html lang="${escapeHtml(texts.locale)}">`),
      tags: [
        { tag: 'title', children: escapeHtml(meta.title), injectTo: 'head' },
        metaTag({ name: 'description', content: meta.description }),
        { tag: 'link', attrs: { rel: 'canonical', href: SITE_URL }, injectTo: 'head' },
        metaTag({ property: 'og:type', content: 'website' }),
        metaTag({ property: 'og:site_name', content: meta.title }),
        metaTag({ property: 'og:locale', content: meta.ogLocale }),
        metaTag({ property: 'og:url', content: SITE_URL }),
        metaTag({ property: 'og:title', content: meta.shareTitle }),
        metaTag({ property: 'og:description', content: meta.description }),
        metaTag({ property: 'og:image', content: new URL(SHARE_IMAGE, SITE_URL).href }),
        metaTag({ property: 'og:image:type', content: 'image/jpeg' }),
        metaTag({ property: 'og:image:width', content: '1200' }),
        metaTag({ property: 'og:image:height', content: '630' }),
        metaTag({ property: 'og:image:alt', content: meta.shareImageAlt }),
        metaTag({ name: 'twitter:card', content: 'summary_large_image' }),
      ],
    }
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
  plugins: [react(), redirectToHome, siteMeta, contentSecurityPolicy],
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
