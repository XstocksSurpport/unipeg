/**
 * 同源 /peg-api → server.peg2peg.app
 * 不用全局 fetch：在 Vercel Node 上常见「TypeError: fetch failed」（IPv6/DNS/ undici），改用 https + 强制 IPv4。
 */
import https from 'node:https'
import dns from 'node:dns'
import { URL } from 'node:url'

const UPSTREAM = 'https://server.peg2peg.app'

function lookupIpv4(hostname, _options, callback) {
  dns.lookup(hostname, { family: 4, all: false }, callback)
}

/** @param {string} targetUrl */
function requestUpstream(targetUrl, method, acceptHeader) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl)
    const opts = {
      agent: false,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: method === 'HEAD' ? 'HEAD' : 'GET',
      headers: {
        Accept: acceptHeader || 'application/json',
        'User-Agent': 'unipeg-vercel-api-proxy/2',
        Host: u.host,
      },
      lookup: lookupIpv4,
      servername: u.hostname,
    }
    const req = https.request(opts, (inc) => {
      const chunks = []
      inc.on('data', (c) => chunks.push(c))
      inc.on('end', () => {
        resolve({
          status: inc.statusCode ?? 500,
          headers: inc.headers,
          body: Buffer.concat(chunks),
        })
      })
    })
    req.on('error', reject)
    req.setTimeout(28_000, () => {
      req.destroy()
      reject(new Error('upstream timeout'))
    })
    req.end()
  })
}

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
    const accept = typeof req.headers.accept === 'string' ? req.headers.accept : 'application/json'
    const out = await requestUpstream(upstreamUrl, req.method, accept)
    res.status(out.status)
    const h = out.headers
    if (h['content-type']) res.setHeader('Content-Type', h['content-type'])
    if (h['content-encoding']) res.setHeader('Content-Encoding', h['content-encoding'])
    res.send(out.body)
  } catch (e) {
    console.error('[peg-api]', upstreamUrl, e)
    res.status(502).json({ error: { message: String(e) } })
  }
}
