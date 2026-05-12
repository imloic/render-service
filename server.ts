import { Hono } from 'hono'
import { chromium, type Browser } from 'playwright'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const PORT = parseInt(process.env.PORT || '3000')
const STORAGE = process.env.STORAGE_DIR || '/data/renders'
const PUBLIC_BASE = process.env.PUBLIC_URL || `http://localhost:${PORT}`
const FILE_TTL_MS = parseInt(process.env.FILE_TTL_MS || String(24 * 60 * 60 * 1000)) // 24h
const MAX_HTML_SIZE = 5 * 1024 * 1024 // 5MB

mkdirSync(STORAGE, { recursive: true })

let browser: Browser | null = null
async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    })
  }
  return browser
}

setInterval(() => {
  const now = Date.now()
  for (const f of readdirSync(STORAGE)) {
    const p = join(STORAGE, f)
    try {
      if (now - statSync(p).mtimeMs > FILE_TTL_MS) unlinkSync(p)
    } catch {}
  }
}, 60 * 60 * 1000)

const app = new Hono()

app.get('/health', c => c.json({ ok: true, ts: new Date().toISOString() }))

app.post('/v1/image', async c => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }

  const html = body.html
  if (!html || typeof html !== 'string') return c.json({ error: 'html required (string)' }, 400)
  if (html.length > MAX_HTML_SIZE) return c.json({ error: 'html too large (max 5MB)' }, 413)

  const css = body.css || ''
  const googleFonts = body.google_fonts
  const viewportWidth = parseInt(body.viewport_width) || 1080
  const viewportHeight = parseInt(body.viewport_height) || 1920
  const deviceScaleFactor = parseFloat(body.device_scale) || 1
  const msDelay = parseInt(body.ms_delay) || 0
  const selector = body.selector
  const renderWhenReady = body.render_when_ready === true || body.render_when_ready === 'true'
  const fullPage = body.full_page === true || body.full_page === 'true'

  const fontsLink = googleFonts
    ? `<link href="https://fonts.googleapis.com/css2?family=${googleFonts.split(',').map((f: string) => f.trim().replace(/ /g, '+')).join('&family=')}&display=swap" rel="stylesheet">`
    : ''

  // Inject fontsLink + css into existing HTML's <head>, or wrap if no <html>
  const inject = `${fontsLink}<style>${css}</style>`
  const fullHtml = /<html[\s>]/i.test(html)
    ? (/<head[\s>]/i.test(html)
        ? html.replace(/<head[^>]*>/i, (m) => `${m}${inject}`)
        : html.replace(/<html[^>]*>/i, (m) => `${m}<head>${inject}</head>`))
    : `<!DOCTYPE html><html><head><meta charset="utf-8">${inject}</head><body>${html}</body></html>`

  const id = randomUUID()
  const filepath = join(STORAGE, `${id}.png`)

  const b = await getBrowser()
  const ctx = await b.newContext({
    viewport: { width: viewportWidth, height: viewportHeight },
    deviceScaleFactor
  })
  const page = await ctx.newPage()

  try {
    await page.setContent(fullHtml, { waitUntil: renderWhenReady ? 'networkidle' : 'load', timeout: 30000 })
    if (msDelay > 0) await page.waitForTimeout(Math.min(msDelay, 30000))

    let png: Buffer
    if (selector) {
      const el = await page.locator(selector).first()
      png = await el.screenshot({ type: 'png' })
    } else {
      png = await page.screenshot({ type: 'png', fullPage })
    }

    writeFileSync(filepath, png)
    return c.json({
      url: `${PUBLIC_BASE}/v1/image/${id}.png`,
      id,
      rendered_at: new Date().toISOString()
    })
  } catch (e: any) {
    return c.json({ error: 'render failed', message: String(e?.message || e) }, 500)
  } finally {
    await ctx.close().catch(() => {})
  }
})

app.get('/v1/image/:filename', c => {
  const filename = c.req.param('filename')
  if (!/^[0-9a-f-]+\.png$/i.test(filename)) return c.json({ error: 'invalid filename' }, 400)
  const filepath = join(STORAGE, filename)
  if (!existsSync(filepath)) return c.json({ error: 'not found' }, 404)
  const buf = readFileSync(filepath)
  return new Response(buf, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400'
    }
  })
})

app.get('/', c => c.json({
  service: 'render-service',
  endpoints: {
    'POST /v1/image': 'render HTML+CSS to PNG, returns {url, id}',
    'GET /v1/image/:id.png': 'serve rendered PNG',
    'GET /health': 'health check'
  }
}))

console.log(`render-service listening on :${PORT} (storage=${STORAGE}, public=${PUBLIC_BASE})`)
export default { port: PORT, fetch: app.fetch, idleTimeout: 60 }
