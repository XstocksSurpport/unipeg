/**
 * 同源 /peg-api → Peg2Peg。PEG_UPSTREAM 可改上游根（不要末尾 /）。
 *
 * Vercel 上常出现 getaddrinfo ENOTFOUND（系统解析不到 server.peg2peg.app）：
 * 失败时走 DoH 取 A 记录，再按 IP + TLS SNI 连上游。
 * 查询串只放行白名单，避免 Vercel 注入的 path= 等污染。
 */
import https from 'node:https'
import dns from 'node:dns'
import { URL } from 'node:url'

try {
  dns.setDefaultResultOrder('ipv4first')
} catch {
  // ignore
}

const UPSTREAM_BASE = (process.env.PEG_UPSTREAM || 'https://server.peg2peg.app').replace(/\/+$/, '')

/** Hobby 函数约 10s：DoH + TLS 需压在时限内 */
const UPSTREAM_TIMEOUT_MS = 7000
const DOH_TIMEOUT_MS = 2000

/** 仅透传浏览器/Peg2Peg 会用的参数，其余（含 Vercel 的 path=）全部丢弃 */
const FORWARD_QUERY_KEYS = new Set(['t', 'limit', 'offset', 'sort', 'status', 'page', 'pageSize', 'q'])

function cleanUpstreamSearch(reqUrl) {
  const out = new URLSearchParams()
  for (const [k, v] of new URLSearchParams(reqUrl.search)) {
    if (FORWARD_QUERY_KEYS.has(k)) out.append(k, v)
  }
  const s = out.toString()
  return s ? `?${s}` : ''
}

function requestOnceByHostname(targetUrl, method, acceptHeader) {
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
        'User-Agent': 'unipeg-vercel-api-proxy/5',
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

/** 用 IP 建连，SNI/Host 仍用域名 */
function requestOnceByIp(ip, hostHeader, hostSni, pathAndQuery, method, acceptHeader) {
  return new Promise((resolve, reject) => {
    const opts = {
      agent: false,
      host: ip,
      port: 443,
      path: pathAndQuery,
      method: method === 'HEAD' ? 'HEAD' : 'GET',
      headers: {
        Accept: acceptHeader || 'application/json',
        'User-Agent': 'unipeg-vercel-api-proxy/5',
        Host: hostHeader,
      },
      servername: hostSni,
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

async function fetchDohJson(url) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), DOH_TIMEOUT_MS)
  try {
    const r = await fetch(url, {
      headers: { accept: 'application/dns-json' },
      signal: ac.signal,
    })
    if (!r.ok) return null
    return r.json()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/** 从 DoH 取首条 A 记录 */
async function resolveARecordDoh(hostname) {
  const cf = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`
  const j1 = await fetchDohJson(cf)
  for (const a of j1?.Answer ?? []) {
    if (a.type === 1 && a.data && /^\d{1,3}(\.\d{1,3}){3}$/.test(a.data)) return a.data
  }
  const g = `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=1`
  const j2 = await fetchDohJson(g)
  for (const a of j2?.Answer ?? []) {
    if (a.type === 1 && a.data && /^\d{1,3}(\.\d{1,3}){3}$/.test(a.data)) return a.data
  }
  return null
}

function isEnotfound(e) {
  if (!e) return false
  const err = /** @type {NodeJS.ErrnoException} */ (e)
  if (err.code === 'ENOTFOUND') return true
  const m = String(e)
  return m.includes('ENOTFOUND') && m.includes('getaddrinfo')
}

async function requestUpstreamResilient(targetUrl, method, acceptHeader) {
  try {
    return await requestOnceByHostname(targetUrl, method, acceptHeader)
  } catch (e) {
    if (!isEnotfound(e)) throw e
    const u = new URL(targetUrl)
    const ip = await resolveARecordDoh(u.hostname)
    if (!ip) {
      console.error('[peg-api] DoH also found no A record for', u.hostname)
      throw e
    }
    const pathAndQuery = u.pathname + u.search
    return await requestOnceByIp(ip, u.host, u.hostname, pathAndQuery, method, acceptHeader)
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
    const out = await requestUpstreamResilient(upstreamUrl, req.method, accept)
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
