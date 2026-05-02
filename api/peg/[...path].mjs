/**
 * 同源 /peg-api → Peg2Peg（默认 server.peg2peg.app）
 * PEG_UPSTREAM 可覆盖上游根 URL。
 *
 * 不再挂自定义 dns.lookup：避免 Vercel 高并发下 getaddrinfo EBUSY。
 * 用 dns.setDefaultResultOrder('ipv4first') 偏好 IPv4。
 *
 * 转发上游时去掉 query 里的 path/slug（Vercel 动态路由注入），否则会污染 Peg2Peg。
 */
import https from 'node:https'
import dns from 'node:dns'
import { URL } from 'node:url'

try {
  dns.setDefaultResultOrder('ipv4first')
} catch {
  // Node < 17 无此方法
}

const UPSTREAM_BASE = (process.env.PEG_UPSTREAM || 'https://server.peg2peg.app').replace(/\/+$/, '')

const UPSTREAM_TIMEOUT_MS = 9000

/** 去掉 Vercel / Next 风格注入的字段，只把真实查询参数带给 Peg2Peg */
function cleanUpstreamSearch(reqUrl) {
  const sp = new URLSearchParams(reqUrl.search)
  sp.delete('path')
  sp.delete('slug')
  sp.delete('catchAll')
  const s = sp.toString()
  return s ? `?${s}` : ''
}

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
        'User-Agent': 'unipeg-vercel-api-proxy/4',
        Host: u.host,
      },
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
  const search = cleanUpstreamSearch(reqUrl)
  const upstreamUrl = `${UPSTREAM_BASE}/${subpath}${search}`

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
    res.status(502).json({ error: serializeErr(e), upstream: upstreamUrl })
  }
}
