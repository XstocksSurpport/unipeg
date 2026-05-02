/**
 * /peg-api → Peg2Peg
 *
 * - PEG_UPSTREAM：上游根 URL（默认 https://server.p2peg.app）
 * - PEG_CONNECT_IP：若 Vercel 侧 DNS 全挂，在此填 **IPv4**（本机执行 nslookup/dig 得到），将跳过解析直连，TLS 仍用域名做 SNI。
 *
 * DoH 用 node:https 拉 JSON（不用全局 fetch，避免 Serverless 里 fetch 异常）。
 */
import https from 'node:https'
import dns from 'node:dns'
import { URL } from 'node:url'

try {
  dns.setDefaultResultOrder('ipv4first')
} catch {
  // ignore
}

const UPSTREAM_BASE = (process.env.PEG_UPSTREAM || 'https://server.p2peg.app').replace(/\/+$/, '')

const UPSTREAM_TIMEOUT_MS = 7000
const DOH_TIMEOUT_MS = 2500

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

const FORWARD_QUERY_KEYS = new Set(['t', 'limit', 'offset', 'sort', 'status', 'page', 'pageSize', 'q'])

function cleanUpstreamSearch(reqUrl) {
  const out = new URLSearchParams()
  for (const [k, v] of new URLSearchParams(reqUrl.search)) {
    if (FORWARD_QUERY_KEYS.has(k)) out.append(k, v)
  }
  const s = out.toString()
  return s ? `?${s}` : ''
}

/** GET JSON（DoH），全程 https 模块 */
function httpsGetJson(urlStr, timeoutMs) {
  return new Promise((resolve) => {
    let u
    try {
      u = new URL(urlStr)
    } catch {
      resolve(null)
      return
    }
    const opts = {
      agent: false,
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        Accept: 'application/dns-json',
        Host: u.host,
        'User-Agent': 'unipeg-doh/1',
      },
      servername: u.hostname,
    }
    const req = https.request(opts, (inc) => {
      const chunks = []
      inc.on('data', (c) => chunks.push(c))
      inc.on('end', () => {
        try {
          const txt = Buffer.concat(chunks).toString('utf8')
          resolve(JSON.parse(txt))
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve(null)
    })
    req.end()
  })
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
        'User-Agent': 'unipeg-vercel-api-proxy/6',
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
        'User-Agent': 'unipeg-vercel-api-proxy/6',
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

function pickAFromDohJson(j) {
  if (!j || !Array.isArray(j.Answer)) return null
  for (const a of j.Answer) {
    if (a.type === 1 && typeof a.data === 'string' && IPV4.test(a.data)) return a.data
  }
  return null
}

async function resolveARecordDoh(hostname) {
  const urls = [
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
    `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=1`,
    `https://dns.quad9.net/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
  ]
  for (const url of urls) {
    const j = await httpsGetJson(url, DOH_TIMEOUT_MS)
    const ip = pickAFromDohJson(j)
    if (ip) return ip
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
  const u = new URL(targetUrl)
  const pathAndQuery = u.pathname + u.search
  const forceIpRaw = process.env.PEG_CONNECT_IP?.trim()
  const forceIp = forceIpRaw && IPV4.test(forceIpRaw) ? forceIpRaw : null

  if (forceIp) {
    return requestOnceByIp(forceIp, u.host, u.hostname, pathAndQuery, method, acceptHeader)
  }

  try {
    return await requestOnceByHostname(targetUrl, method, acceptHeader)
  } catch (e) {
    if (!isEnotfound(e)) throw e
    const ip = await resolveARecordDoh(u.hostname)
    if (!ip) {
      console.error('[peg-api] ENOTFOUND and DoH empty for', u.hostname)
      throw e
    }
    return await requestOnceByIp(ip, u.host, u.hostname, pathAndQuery, method, acceptHeader)
  }
}

function serializeErr(e) {
  const err = /** @type {NodeJS.ErrnoException} */ (e)
  return {
    message: String(e),
    code: err.code,
    syscall: err.syscall,
    hint:
      err.code === 'ENOTFOUND'
        ? 'On Vercel, set env PEG_CONNECT_IP to the A record IPv4 (run nslookup server.p2peg.app on your computer) to bypass broken DNS in the function runtime.'
        : undefined,
  }
}

function pegSubpathFromRequest(req) {
  /**
   * Vercel 对 [...path] 不稳定：req.url 有时丢了多级路径，req.query.path 有时只有最后一段
   *（如只要 0x… 或 792）。收集 pathname 与 query 两种来源，取 **更长** 的那个作为上游子路径。
   */
  const candidates = []
  try {
    const reqUrl = new URL(req.url || '/', 'http://localhost')
    const pathname = decodeURIComponent(reqUrl.pathname)
    for (const marker of ['/api/peg/', '/peg-api/']) {
      if (pathname.startsWith(marker)) {
        const rest = pathname.slice(marker.length).replace(/\/+$/, '')
        if (rest) candidates.push(rest)
      }
    }
  } catch {
    // ignore
  }
  const raw = req.query?.path
  if (raw !== undefined && raw !== '') {
    const segments = Array.isArray(raw) ? raw : [String(raw)]
    const joined = segments.filter(Boolean).join('/')
    if (joined) candidates.push(joined)
  }
  if (!candidates.length) return ''
  return candidates.sort((a, b) => b.length - a.length)[0]
}

/** Vercel 上 Accept 可能是 string[]；img 请求缺省时勿默认 application/json（SVG 会拿不到图） */
function normalizeAcceptHeader(req) {
  const a = req.headers.accept
  if (Array.isArray(a)) return a.filter(Boolean).join(', ')
  if (typeof a === 'string') return a
  return ''
}

function upstreamAccept(req, subpath) {
  if (/\/svg$/i.test(subpath)) {
    return 'image/svg+xml,text/plain,*/*'
  }
  const fromClient = normalizeAcceptHeader(req)
  if (fromClient) return fromClient
  return 'application/json'
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
    const accept = upstreamAccept(req, subpath)
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
