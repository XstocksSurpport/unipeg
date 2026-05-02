/** 同源 /peg-api → server.peg2peg.app（Node Serverless，比 Edge middleware 在纯静态部署里更稳） */
const UPSTREAM = 'https://server.peg2peg.app'

export default async function handler(req, res) {
  const raw = req.query.path
  const segments = Array.isArray(raw) ? raw : raw != null && raw !== '' ? [String(raw)] : []
  const subpath = segments.join('/')
  if (!subpath || subpath.includes('..')) {
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
