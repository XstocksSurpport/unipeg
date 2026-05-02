/** 同源 /peg-api → server.peg2peg.app（Node Serverless，比 Edge middleware 在纯静态部署里更稳） */
const UPSTREAM = 'https://server.peg2peg.app'

/** Vercel rewrite 后常常不把 [...path] 填进 req.query，必须从 pathname 解析 */
function pegSubpathFromRequest(req) {
  const raw = req.query.path
  if (raw !== undefined && raw !== '') {
    const segments = Array.isArray(raw) ? raw : [String(raw)]
    return segments.filter(Boolean).join('/')
  }
  try {
    const reqUrl = new URL(req.url || '/', 'http://localhost')
    const pathname = decodeURIComponent(reqUrl.pathname)
    const apiMarker = '/api/peg/'
    const pegMarker = '/peg-api/'
    if (pathname.startsWith(apiMarker)) {
      return pathname.slice(apiMarker.length).replace(/\/+$/, '') || ''
    }
    if (pathname.startsWith(pegMarker)) {
      return pathname.slice(pegMarker.length).replace(/\/+$/, '') || ''
    }
    if (pathname === '/api/peg' || pathname === '/peg-api') return ''
  } catch {
    // ignore
  }
  return ''
}

export default async function handler(req, res) {
  const subpath = pegSubpathFromRequest(req)
  if (!subpath || subpath.includes('..')) {
    console.error('[peg-api] bad path', { url: req.url, query: req.query })
    res.status(400).json({ error: 'Bad path' })
    return
  }

  const reqUrl = new URL(req.url || '/', 'http://localhost')
  const upstreamUrl = `${UPSTREAM}/${subpath}${reqUrl.search}`

  try {
    const r = await fetch(upstreamUrl, {
      method: req.method,
      headers: {
        Accept: req.headers.accept || 'application/json',
        'User-Agent': 'unipeg-vercel-api-proxy/1',
      },
      cache: 'no-store',
    })
    const buf = Buffer.from(await r.arrayBuffer())
    const ct = r.headers.get('content-type')
    if (ct) res.setHeader('Content-Type', ct)
    res.status(r.status).send(buf)
  } catch (e) {
    console.error('[peg-api]', upstreamUrl, e)
    res.status(502).json({ error: { message: String(e) } })
  }
}
