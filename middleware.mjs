/** Peg2Peg API：绕开 vercel.json 直连外部的 rewrite（易出现 502 Bad Gateway），改为 Edge 显式转发。 */
const UPSTREAM = 'https://server.peg2peg.app'

export const config = {
  matcher: ['/peg-api/:path*'],
}

export default async function middleware(request) {
  const url = new URL(request.url)
  const rest = url.pathname.replace(/^\/peg-api\/?/, '')
  if (!rest || rest.includes('..')) {
    return new Response('Bad path', { status: 400 })
  }

  const upstreamUrl = new URL(`${UPSTREAM}/${rest}`)
  upstreamUrl.search = url.search

  /** SPA 仅对 Peg2Peg 发 GET；不因 duplex/stream 在 Edge 上踩坑。 */
  const init = {
    method: request.method,
    headers: {
      Accept: request.headers.get('accept') ?? 'application/json',
      'User-Agent': 'unipeg-vercel-proxy/1',
    },
    cache: 'no-store',
  }

  let upstream
  try {
    upstream = await fetch(upstreamUrl, init)
  } catch (e) {
    console.error('[peg-api proxy] fetch failed', upstreamUrl.toString(), e)
    return new Response(
      JSON.stringify({
        error: { code: 'PROXY_FETCH_FAILED', message: String(e) },
      }),
      { status: 502, headers: { 'content-type': 'application/json; charset=utf-8' } },
    )
  }

  const headers = new Headers(upstream.headers)
  headers.delete('transfer-encoding')

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}
