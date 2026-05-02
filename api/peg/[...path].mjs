/**
 * 同源 /peg-api → Peg2Peg（默认 server.peg2peg.app）
 * 可用环境变量 PEG_UPSTREAM=https://server.peg2peg.app 覆盖。
 */
import https from 'node:https'
import dns from 'node:dns'
import { URL } from 'node:url'

const UPSTREAM_BASE = (process.env.PEG_UPSTREAM || 'https://server.peg2peg.app').replace(/\/+$/, '')

/** @param {'ipv4' | 'system'} mode */
function makeLookup(mode) {
  return (hostname, _options, callback) => {
    if (mode === 'ipv4') {
      dns.lookup(hostname, { family: 4, all: false }, callback)
    } else {
      dns.lookup(hostname, { all: false }, callback)
    }
  }
}

/** Vercel Hobby 函数默认约 10s 上限；双次重试需留足余量 */
const UPSTREAM_TIMEOUT_MS = 4000

/**
 * @param {string} targetUrl
 * @param {'ipv4' | 'system'} dnsMode
 */
function requestUpstream(targetUrl, method, acceptHeader, dnsMode) {
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
        'User-Agent': 'unipeg-vercel-api-proxy/3',
        Host: u.host,
      },
      lookup: makeLookup(dnsMode),
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
    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      req.destroy()
      reject(new Error('upstream timeout'))
    })
    req.end()
  })
}

async function requestUpstreamWithFallback(targetUrl, method, acceptHeader) {
  try {
    return await requestUpstream(targetUrl, method, acceptHeader, 'ipv4')
  } catch (e1) {
    console.error('[peg-api] ipv4/system dns failed, retry system order', e1)
    return await requestUpstream(targetUrl, method, acceptHeader, 'system')
  }
}

function serializeErr(e) {
  const err = /** @type {NodeJS.ErrnoException} */ (e)
  return {
    message: String(e),
    code: err.code,
    syscall: err.syscall,
  }
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
  const upstreamUrl = `${UPSTREAM_BASE}/${subpath}${reqUrl.search}`

  try {
    const accept = typeof req.headers.accept === 'string' ? req.headers.accept : 'application/json'
    const out = await requestUpstreamWithFallback(upstreamUrl, req.method, accept)
    res.status(out.status)
    const h = out.headers
    if (h['content-type']) res.setHeader('Content-Type', h['content-type'])
    if (h['content-encoding']) res.setHeader('Content-Encoding', h['content-encoding'])
    res.send(out.body)
  } catch (e) {
    console.error('[peg-api]', upstreamUrl, e)
    res.status(502).json({ error: serializeErr(e), upstream: upstreamUrl })
  }
}
