import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BrowserProvider, formatEther as formatEtherEthers } from 'ethers'
import './App.css'

const NFT_CONTRACT = '0x44b28991B167582F18BA0259e0173176ca125505'
/** 演示：按挂单金额向该地址转 ETH（非 Peg2Peg 合约成交）。 */
const TREASURY = '0xa2b7DC1ffb4F4a1C0F9762f0CE5481FEf8FB857E'
const NATIVE = '0x0000000000000000000000000000000000000000'

/** Peg2Peg 公网根（直连 SVG 等）。默认随官网迁至 p2peg；也可用 VITE_PEG_API_ORIGIN 覆盖。 */
const PEG_API = (import.meta.env.VITE_PEG_API_ORIGIN ?? 'https://server.p2peg.app').replace(/\/+$/, '')
/** 换域/修代理后 bump，避免 localStorage 里存了旧版错图 */
const upegSvgCacheKey = (id: string) => `upeg-svg:v2:${id}`
const VISIBLE_LISTING_LIMIT = 57
const LISTING_CACHE_KEY = 'unipeg:listings:v3'
const LISTING_CACHE_TTL_MS = 10 * 60_000
const STATS_CACHE_KEY = 'unipeg:stats:v1'
const STATS_CACHE_TTL_MS = 90_000
const SEED_CACHE_KEY = 'unipeg:seed-cache:v1'
const TARGET_CHAIN_ID = Number(import.meta.env.VITE_TARGET_CHAIN_ID ?? 1)
const TARGET_CHAIN_HEX = `0x${TARGET_CHAIN_ID.toString(16)}`
const TARGET_CHAIN_NAME =
  TARGET_CHAIN_ID === 1 ? 'Ethereum' : TARGET_CHAIN_ID === 11155111 ? 'Sepolia' : `Chain ${TARGET_CHAIN_ID}`
const TESTNET_RPC = import.meta.env.VITE_TESTNET_RPC_URL ?? 'https://rpc.sepolia.org'
/** 测试网演示：把 Peg2Peg 主网口径挂单价按比例缩小，便于少量领水完成转账体验 */
const TESTNET_PRICE_SCALE_NUM = Number(import.meta.env.VITE_TESTNET_PRICE_SCALE ?? '0.000001')
function scalePriceWeiForDemo(rawWei: string): string {
  if (TARGET_CHAIN_ID === 1) return rawWei
  const w = BigInt(rawWei || '0')
  if (w <= 0n) return rawWei
  const s = Number.isFinite(TESTNET_PRICE_SCALE_NUM) ? TESTNET_PRICE_SCALE_NUM : 1
  if (s >= 1 || s <= 0) return rawWei
  const num = BigInt(Math.round(s * 1e12))
  const den = 10n ** 12n
  const out = (w * num) / den
  return out > 0n ? out.toString() : '1'
}
/** 统一走同源 `/peg-api` 代理（Vite dev / Vercel prod），规避浏览器 CORS。 */
function pegBase(): string {
  return '/peg-api'
}

function apiBases(): string[] {
  // 生产环境同样必须经由平台代理；直连会被 Peg API 源站 CORS 拦截。
  return [pegBase()]
}

/** 直连 Peg2Peg 的 SVG URL（作候选；优先尝试走 /peg-api 代理） */
function pegSvgHttpUrl(seedOrId: string) {
  return `${PEG_API}/upeg/${seedOrId}/svg`
}

function pegSvgCandidateUrls(seedOrId: string): string[] {
  // 先走同源 /peg-api（与 PEG_UPSTREAM 一致），公网直连域名若 DNS 失效时仍可能通过代理可用
  const urls = [`/peg-api/upeg/${seedOrId}/svg`, pegSvgHttpUrl(seedOrId)]
  return Array.from(new Set(urls))
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    return await fetch(url, {
      headers: { accept: 'image/svg+xml,text/plain,*/*' },
      signal: ctl.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

async function resolveSvgDataUrl(key: string): Promise<string | null> {
  try {
    const cached = sessionStorage.getItem(upegSvgCacheKey(key)) ?? localStorage.getItem(upegSvgCacheKey(key))
    if (cached) return cached
  } catch {
    // ignore
  }
  const urls = pegSvgCandidateUrls(key)
  for (let i = 0; i < 2; i += 1) {
    for (const url of urls) {
      try {
        const res = await fetchWithTimeout(url, 2600 + i * 700)
        if (!res.ok) continue
        const text = await res.text()
        if (!text.trim()) continue
        const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`
        try {
          sessionStorage.setItem(upegSvgCacheKey(key), dataUrl)
          localStorage.setItem(upegSvgCacheKey(key), dataUrl)
        } catch {
          // ignore
        }
        return dataUrl
      } catch {
        // try next url/retry
      }
    }
  }
  return null
}

type PegListingApi = {
  id: string
  seller: string
  positionContract: string
  paymentToken: string
  priceWei: string
  upegCount: number
  status: string
  createdTxHash: string
  createdAt: string
  /** 新版 Peg API 在列表里即返回，可不再依赖 /upegs/owner 才能出图 */
  upegIds?: string[]
  firstSeed?: string
}

/** `/listings/:id` — includes buyer / upegIds for Activity enrichment */
type PegListingDetailApi = PegListingApi & {
  buyer?: string | null
}

type ListingRow = PegListingApi & {
  previewUpegId: string | null
  previewSeed: string | null
}

type TxItem = {
  txHash: string
  positionId: string
  from: string
  eventType: string
  priceWei: string | null
  timestamp: string
  tokenId: bigint
  blockNumber: bigint
}

type PegStats = {
  floorWei: string
  volumeWei: string
  items: number
  holders: number
  priceUsd: number
}
type DetailTab = 'info' | 'traits' | 'provenance'

type InjectedProvider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>
  isPhantom?: boolean
  isTrust?: boolean
  isTokenPocket?: boolean
  isTokenpocket?: boolean
  isBitKeep?: boolean
  isBinance?: boolean
  isMathWallet?: boolean
  isCoin98?: boolean
  isSafePal?: boolean
  isFrontier?: boolean
  isBraveWallet?: boolean
  providerInfo?: { name?: string; rdns?: string }
  providers?: InjectedProvider[]
  isMetaMask?: boolean
  isCoinbaseWallet?: boolean
  isRabby?: boolean
  isOkxWallet?: boolean
}

type DetectedWallet = {
  id: string
  name: string
  provider: InjectedProvider
}

const shortAddr = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`

function explorerTxUrl(txHash: string) {
  if (TARGET_CHAIN_ID === 11155111) return `https://sepolia.etherscan.io/tx/${txHash}`
  return `https://etherscan.io/tx/${txHash}`
}

function formatUsdApproxFromWei(wei: string, priceUsd: number) {
  if (!(priceUsd > 0)) return null
  const eth = Number(formatEtherEthers(wei || '0'))
  if (!Number.isFinite(eth)) return null
  const usd = eth * priceUsd
  if (!Number.isFinite(usd)) return null
  return usd.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function formatRelTime(iso: string) {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  const sec = Math.max(0, Math.floor(diff / 1000))
  if (sec < 45) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(t).toLocaleDateString()
}

type PegActivityApiRow = {
  txHash: string
  actor: string
  positionId: string
  eventType: string
  priceWei: string | null
  blockNumber: string
  timestamp: string
}

async function ensureTargetChain(selected: InjectedProvider): Promise<void> {
  const p = selected as any
  try {
    await p.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: TARGET_CHAIN_HEX }],
    })
  } catch (switchError: any) {
    if (switchError?.code !== 4902 || TARGET_CHAIN_ID !== 11155111) throw switchError
    await p.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: TARGET_CHAIN_HEX,
          chainName: 'Sepolia',
          nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: [TESTNET_RPC],
          blockExplorerUrls: ['https://sepolia.etherscan.io'],
        },
      ],
    })
  }
}

function formatEthFixed(wei: string, digits: number): string {
  const n = Number(formatEtherEthers(wei || '0'))
  if (!Number.isFinite(n)) return (0).toFixed(digits)
  return n.toFixed(digits)
}

function providerLabel(p: InjectedProvider): string {
  const infoName = p.providerInfo?.name?.trim()
  if (infoName) return infoName
  if (p.isRabby) return 'Rabby'
  if (p.isCoinbaseWallet) return 'Coinbase Wallet'
  if (p.isPhantom) return 'Phantom'
  if (p.isTrust) return 'Trust Wallet'
  if (p.isTokenPocket || p.isTokenpocket) return 'TokenPocket'
  if (p.isBitKeep) return 'Bitget Wallet'
  if (p.isBinance) return 'Binance Wallet'
  if (p.isMathWallet) return 'MathWallet'
  if (p.isCoin98) return 'Coin98'
  if (p.isSafePal) return 'SafePal'
  if (p.isFrontier) return 'Frontier'
  if (p.isBraveWallet) return 'Brave Wallet'
  if (p.isOkxWallet) return 'OKX Wallet'
  if (p.isMetaMask) return 'MetaMask'
  return 'Injected Wallet'
}

function listInjectedProviders(): DetectedWallet[] {
  const eth = (window as any).ethereum as any
  if (!eth) return []
  const arr = Array.isArray(eth.providers) && eth.providers.length ? eth.providers : [eth]
  const uniq = new Map<string, DetectedWallet>()
  for (const p of arr) {
    const name = providerLabel(p)
    const key = `${name}:${Boolean(p.isMetaMask)}:${Boolean(p.isRabby)}:${Boolean(p.isCoinbaseWallet)}:${Boolean(p.isBraveWallet)}:${Boolean(p.isOkxWallet)}`
    if (!uniq.has(key)) {
      uniq.set(key, {
        id: key,
        name,
        provider: p,
      })
    }
  }
  return Array.from(uniq.values())
}

function loadListingCache(): ListingRow[] | null {
  try {
    const raw = localStorage.getItem(LISTING_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { ts: number; rows: ListingRow[] }
    if (!parsed?.ts || !Array.isArray(parsed?.rows)) return null
    if (Date.now() - parsed.ts > LISTING_CACHE_TTL_MS) return null
    return parsed.rows
  } catch {
    return null
  }
}

function saveListingCache(rows: ListingRow[]) {
  try {
    localStorage.setItem(LISTING_CACHE_KEY, JSON.stringify({ ts: Date.now(), rows }))
  } catch {
    // ignore quota errors
  }
}

function loadStatsCache(): PegStats | null {
  try {
    const raw = localStorage.getItem(STATS_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { ts: number; stats: PegStats }
    if (!parsed?.ts || !parsed?.stats) return null
    if (Date.now() - parsed.ts > STATS_CACHE_TTL_MS) return null
    return parsed.stats
  } catch {
    return null
  }
}

function saveStatsCache(stats: PegStats) {
  try {
    localStorage.setItem(STATS_CACHE_KEY, JSON.stringify({ ts: Date.now(), stats }))
  } catch {
    // ignore
  }
}

function loadSeedCache(): Map<string, { id: string | null; seed: string | null; ts: number }> {
  try {
    const raw = localStorage.getItem(SEED_CACHE_KEY)
    if (!raw) return new Map()
    const parsed = JSON.parse(raw) as Array<[string, { id: string | null; seed: string | null; ts: number }]>
    if (!Array.isArray(parsed)) return new Map()
    return new Map(parsed)
  } catch {
    return new Map()
  }
}

function saveSeedCache(cache: Map<string, { id: string | null; seed: string | null; ts: number }>) {
  try {
    const arr = Array.from(cache.entries()).slice(-400)
    localStorage.setItem(SEED_CACHE_KEY, JSON.stringify(arr))
  } catch {
    // ignore
  }
}

async function fetchStatsOnly() {
  const bases = apiBases()
  let lastErr: unknown
  for (const base of bases) {
    try {
      const response = await fetch(`${base}/stats?t=${Date.now()}`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`Peg2Peg API /stats failed: ${response.status} ${text}`)
      }
      const json = (await response.json()) as {
        floorPriceWei: string
        volumeWei: string
        upegsTotal: number
        holdersCount: number
        priceUsd?: number
      }
      return json
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

async function fetchLiveEthUsd(): Promise<number | null> {
  const key = import.meta.env.VITE_ETHERSCAN_API_KEY
  if (!key) return null
  try {
    const r = await fetch(`https://api.etherscan.io/api?module=stats&action=ethprice&apikey=${encodeURIComponent(key)}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
    if (!r.ok) return null
    const json = (await r.json()) as { status?: string; result?: { ethusd?: string } }
    const usd = Number(json?.result?.ethusd ?? 0)
    return Number.isFinite(usd) && usd > 0 ? usd : null
  } catch {
    return null
  }
}

async function fetchOwnerSeed(positionContract: string): Promise<{ id: string; seed: string } | null> {
  for (let i = 0; i < 3; i += 1) {
    try {
      const rows = await pegFetchJson<Array<{ id: string; seed: string }>>(
        `/upegs/owner/${positionContract}?page=0&pageSize=12`,
      )
      const first = rows?.[0]
      if (first?.seed) return first
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 180 + i * 180))
  }
  return null
}

async function pegFetchJson<T>(path: string): Promise<T> {
  const bases = apiBases()
  let lastErr: unknown
  for (const base of bases) {
    try {
      const response = await fetch(`${base}${path}`, { headers: { accept: 'application/json' } })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`Peg2Peg API ${path} failed: ${response.status} ${text}`)
      }
      const json = (await response.json()) as T
      return json
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** 速度优先：只抓到够展示的 ready 挂单即停，避免全量扫描。 */
async function fetchVisibleOpenListings(limitReady = VISIBLE_LISTING_LIMIT): Promise<PegListingApi[]> {
  const out: PegListingApi[] = []
  let offset = 0
  const pageSize = 120
  for (let page = 0; page < 4 && out.length < limitReady; page += 1) {
    const res = await pegFetchJson<{ items: PegListingApi[]; total: number }>(
      `/listings?limit=${pageSize}&offset=${offset}&sort=price_asc&status=OPEN`,
    )
    if (!res.items.length) break
    for (const it of res.items) {
      if (Number(it.upegCount ?? 0) > 0) {
        out.push({ ...it, priceWei: scalePriceWeiForDemo(it.priceWei) })
      }
      if (out.length >= limitReady) break
    }
    offset += res.items.length
  }
  return out.slice(0, limitReady)
}

async function fetchReadyFloorWei(): Promise<string> {
  let offset = 0
  const pageSize = 120
  for (let page = 0; page < 6; page += 1) {
    const res = await pegFetchJson<{ items: PegListingApi[]; total: number }>(
      `/listings?limit=${pageSize}&offset=${offset}&sort=price_asc&status=OPEN`,
    )
    if (!res.items.length) break
    const ready = res.items.find((it) => Number(it.upegCount ?? 0) > 0 && BigInt(it.priceWei || '0') > 0n)
    if (ready) return scalePriceWeiForDemo(ready.priceWei)
    offset += res.items.length
  }
  return '0'
}

/** Peg2Peg SVG：<img> 直连失败时用 fetch 拉正文再转 data URL（绕开部分防盗链策略）。 */
function UpegSvgImg({
  imageKey,
  fallbackKeys,
  alt,
  className,
  wrapperClassName,
  eager = false,
}: {
  imageKey: string
  fallbackKeys?: string[]
  alt: string
  className?: string
  wrapperClassName?: string
  eager?: boolean
}) {
  const keyList = useMemo(
    () => Array.from(new Set([imageKey, ...(fallbackKeys ?? [])].filter(Boolean))),
    [imageKey, fallbackKeys],
  )
  const [keyIdx, setKeyIdx] = useState(0)
  const [pickedId, setPickedId] = useState(keyList[0] ?? imageKey)
  const [urlIdx, setUrlIdx] = useState(0)
  const initialSrc = pegSvgCandidateUrls(pickedId)[0]
  const [src, setSrc] = useState(initialSrc)
  const retried = useRef(false)
  const [broken, setBroken] = useState(false)

  useEffect(() => {
    let cancelled = false
    try {
      const cached = sessionStorage.getItem(upegSvgCacheKey(keyList[0] ?? imageKey))
      if (cached) {
        setKeyIdx(0)
        setPickedId(keyList[0] ?? imageKey)
        setUrlIdx(0)
        setSrc(cached)
        retried.current = true
        setBroken(false)
        return
      }
      const persisted = localStorage.getItem(upegSvgCacheKey(keyList[0] ?? imageKey))
      if (persisted) {
        setKeyIdx(0)
        setPickedId(keyList[0] ?? imageKey)
        setUrlIdx(0)
        setSrc(persisted)
        retried.current = true
        setBroken(false)
        try {
          sessionStorage.setItem(upegSvgCacheKey(keyList[0] ?? imageKey), persisted)
        } catch {
          // ignore
        }
        return
      }
    } catch {
      // ignore
    }
    setKeyIdx(0)
    setPickedId(keyList[0] ?? imageKey)
    setUrlIdx(0)
    setSrc(pegSvgCandidateUrls(keyList[0] ?? imageKey)[0])
    retried.current = false
    setBroken(false)
    void (async () => {
      const firstKey = keyList[0] ?? imageKey
      const dataUrl = await resolveSvgDataUrl(firstKey)
      if (!cancelled && dataUrl) {
        setKeyIdx(0)
        setPickedId(firstKey)
        setUrlIdx(0)
        setSrc(dataUrl)
        retried.current = true
        setBroken(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [imageKey, keyList])

  const onError = async () => {
    const urls = pegSvgCandidateUrls(pickedId)
    if (urlIdx + 1 < urls.length) {
      const next = urlIdx + 1
      setUrlIdx(next)
      setSrc(urls[next])
      return
    }
    if (keyIdx + 1 < keyList.length) {
      const nextKey = keyIdx + 1
      const nextPicked = keyList[nextKey]
      setKeyIdx(nextKey)
      setPickedId(nextPicked)
      setUrlIdx(0)
      setSrc(pegSvgCandidateUrls(nextPicked)[0])
      retried.current = false
      return
    }
    if (retried.current) {
      setBroken(true)
      return
    }
    retried.current = true
    try {
      for (const url of pegSvgCandidateUrls(pickedId)) {
        const res = await fetch(url, { headers: { accept: 'image/svg+xml,text/plain,*/*' } })
        if (!res.ok) continue
        const text = await res.text()
        if (!text.trim()) continue
        const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`
        setSrc(dataUrl)
        try {
          sessionStorage.setItem(upegSvgCacheKey(pickedId), dataUrl)
          localStorage.setItem(upegSvgCacheKey(pickedId), dataUrl)
        } catch {
          // ignore
        }
        return
      }
      setBroken(true)
    } catch {
      setBroken(true)
    }
  }

  if (broken) {
    return <div className={wrapperClassName ?? 'peg-img-fallback'} aria-hidden />
  }

  const imgClass = [className, 'upeg-pixel'].filter(Boolean).join(' ')
  return <img src={src} alt={alt} className={imgClass} loading={eager ? 'eager' : 'lazy'} decoding="async" onError={onError} />
}

function VerifiedBadge() {
  return (
    <span className="verified-badge" title="Collection">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="12" cy="12" r="11" fill="#ea67f6" />
        <path d="M8 12.5l2.5 2.5L16 9" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

function sameListings(a: ListingRow[], b: ListingRow[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    if (
      x.id !== y.id ||
      x.priceWei !== y.priceWei ||
      x.status !== y.status ||
      x.positionContract !== y.positionContract ||
      x.previewUpegId !== y.previewUpegId ||
      x.previewSeed !== y.previewSeed
    ) {
      return false
    }
  }
  return true
}

function sameTxs(a: TxItem[], b: TxItem[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    if (
      x.txHash !== y.txHash ||
      x.eventType !== y.eventType ||
      x.positionId !== y.positionId ||
      x.timestamp !== y.timestamp ||
      x.tokenId !== y.tokenId ||
      x.priceWei !== y.priceWei
    ) {
      return false
    }
  }
  return true
}

function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const run = async () => {
    while (next < items.length) {
      const idx = next++
      out[idx] = await worker(items[idx], idx)
    }
  }
  return Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run)).then(() => out)
}

function App() {
  const [txs, setTxs] = useState<TxItem[]>([])
  const [listings, setListings] = useState<ListingRow[]>([])
  const [statsLoading, setStatsLoading] = useState(true)
  const [listingsLoading, setListingsLoading] = useState(true)
  const [listingsProgress, setListingsProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [walletAddress, setWalletAddress] = useState<string | null>(null)
  const [activeWalletProvider, setActiveWalletProvider] = useState<InjectedProvider | null>(null)
  const [activeWalletName, setActiveWalletName] = useState<string | null>(null)
  const [chainId, setChainId] = useState<number | null>(null)
  const [, setWalletBalance] = useState<string | null>(null)
  const [pendingListingId, setPendingListingId] = useState<string | null>(null)
  const [stats, setStats] = useState<PegStats>({
    floorWei: '0',
    volumeWei: '0',
    items: 0,
    holders: 0,
    priceUsd: 0,
  })

  const [searchQ, setSearchQ] = useState('')
  const [sortKey, setSortKey] = useState<'recent' | 'priceAsc' | 'priceDesc'>('priceAsc')
  const [mainTab, setMainTab] = useState<'trades' | 'portfolio' | 'activity'>('trades')
  const [sellOpen, setSellOpen] = useState(false)
  const [sellPrice, setSellPrice] = useState('0.00')
  const [walletPickerOpen, setWalletPickerOpen] = useState(false)
  const [walletOptions, setWalletOptions] = useState<DetectedWallet[]>([])
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailTab, setDetailTab] = useState<DetailTab>('info')
  const [detailRow, setDetailRow] = useState<ListingRow | null>(null)
  const [detailTraits, setDetailTraits] = useState<Record<string, unknown> | null>(null)
  const [detailProv, setDetailProv] = useState<Record<string, unknown> | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const listingsRef = useRef<ListingRow[]>([])
  const txsRef = useRef<TxItem[]>([])
  const [activityListingByPositionId, setActivityListingByPositionId] = useState<Record<string, PegListingDetailApi | null>>({})
  const activityListingInflightRef = useRef<Map<string, Promise<PegListingDetailApi | null>>>(new Map())
  const seedCacheRef = useRef<Map<string, { id: string | null; seed: string | null; ts: number }>>(loadSeedCache())
  const seedInflightRef = useRef<Map<string, Promise<{ id: string | null; seed: string | null }>>>(new Map())

  useEffect(() => {
    listingsRef.current = listings
  }, [listings])

  useEffect(() => {
    txsRef.current = txs
  }, [txs])

  const fetchActivityListing = useCallback(async (positionId: string): Promise<PegListingDetailApi | null> => {
    const inflight = activityListingInflightRef.current.get(positionId)
    if (inflight) return inflight
    const task = pegFetchJson<PegListingDetailApi>(`/listings/${positionId}`)
      .then((row) => row)
      .catch(() => null)
      .finally(() => {
        activityListingInflightRef.current.delete(positionId)
      })
    activityListingInflightRef.current.set(positionId, task)
    return task
  }, [])

  const boughtTxsSorted = useMemo(
    () =>
      [...txs]
        .filter((t) => t.eventType === 'PositionBought')
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)),
    [txs],
  )

  useEffect(() => {
    let cancelled = false
    const ids = Array.from(new Set(boughtTxsSorted.slice(0, 24).map((t) => t.positionId))).filter(
      (id) => !(id in activityListingByPositionId),
    )
    if (!ids.length) return undefined

    void (async () => {
      const rows = await mapWithConcurrency(ids, 6, async (id) => {
        const row = await fetchActivityListing(id)
        return [id, row] as const
      })
      if (cancelled) return
      setActivityListingByPositionId((prev) => {
        const next = { ...prev }
        for (const [id, row] of rows) {
          next[id] = row
        }
        return next
      })
    })()

    return () => {
      cancelled = true
    }
  }, [boughtTxsSorted, fetchActivityListing, activityListingByPositionId])

  const activityRowsView = useMemo(() => {
    const rows = boughtTxsSorted
      .map((tx) => {
        const listing = activityListingByPositionId[tx.positionId]
        const rawWei =
          tx.priceWei && tx.priceWei !== '0'
            ? tx.priceWei
            : listing?.priceWei && listing.priceWei !== '0'
              ? listing.priceWei
              : null
        const weiForUi = rawWei ? scalePriceWeiForDemo(rawWei) : null
        const usdLabel = weiForUi && stats.priceUsd > 0 ? formatUsdApproxFromWei(weiForUi, stats.priceUsd) : null
        const upegId = listing?.upegIds?.[0] ?? tx.positionId
        const fromAddr = listing?.seller ?? tx.from
        const toAddr = listing?.buyer ?? tx.from
        return { tx, weiForUi, usdLabel, upegId, fromAddr, toAddr }
      })
      .slice(0, 24)
    return rows
  }, [activityListingByPositionId, boughtTxsSorted, stats.priceUsd])

  const getSeedCached = useCallback(async (positionContract: string) => {
    const now = Date.now()
    const cached = seedCacheRef.current.get(positionContract)
    if (cached && now - cached.ts < 10 * 60_000) {
      return { id: cached.id, seed: cached.seed }
    }
    const inflight = seedInflightRef.current.get(positionContract)
    if (inflight) return inflight
    const task = (async () => {
      const first = await fetchOwnerSeed(positionContract)
      const val = { id: first?.id ?? null, seed: first?.seed ?? null }
      seedCacheRef.current.set(positionContract, { ...val, ts: Date.now() })
      saveSeedCache(seedCacheRef.current)
      return val
    })().finally(() => {
      seedInflightRef.current.delete(positionContract)
    })
    seedInflightRef.current.set(positionContract, task)
    return task
  }, [])

  const toBaseRows = useCallback((raw: PegListingApi[], prevRows: ListingRow[]) => {
    const prevByPos = new Map(prevRows.map((r) => [r.positionContract, r]))
    return raw.map((l) => {
      const prev = prevByPos.get(l.positionContract)
      return {
        ...l,
        previewUpegId: prev?.previewUpegId ?? l.upegIds?.[0] ?? null,
        previewSeed: prev?.previewSeed ?? l.firstSeed ?? null,
      }
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setStatsLoading(true)
      setListingsLoading(true)
      setError(null)
      setListingsProgress(null)
      const cachedStats = loadStatsCache()
      if (cachedStats && !cancelled) {
        setStats(cachedStats)
        setStatsLoading(false)
      }
      const cached = loadListingCache()
      if (cached && !cancelled) {
        setListings(cached)
        setListingsLoading(false)
        setListingsProgress(null)
      }
      try {
        // 分项容错：避免某一接口超时/5xx 拖垮整屏（原先 Promise.all 会全失败）
        const [pegStats, readyFloorWei, activity, liveEthUsd] = await Promise.all([
          fetchStatsOnly().catch((e) => {
            console.error(e)
            return null
          }),
          fetchReadyFloorWei().catch(() => '0'),
          pegFetchJson<PegActivityApiRow[]>('/activity?limit=220').catch((e) => {
            console.error(e)
            return null
          }),
          fetchLiveEthUsd(),
        ])
        if (cancelled) return

        if (pegStats) {
          const nextStats = {
            floorWei: readyFloorWei !== '0' ? readyFloorWei : pegStats.floorPriceWei,
            volumeWei: pegStats.volumeWei,
            items: pegStats.upegsTotal,
            holders: pegStats.holdersCount,
            priceUsd: Number(liveEthUsd ?? pegStats.priceUsd ?? 0),
          }
          setStats(nextStats)
          saveStatsCache(nextStats)
        }

        if (activity && Array.isArray(activity)) {
          const activityRows: TxItem[] = activity.map((row) => ({
            txHash: row.txHash,
            positionId: row.positionId,
            from: row.actor,
            eventType: row.eventType,
            priceWei: row.priceWei,
            timestamp: row.timestamp,
            tokenId: BigInt(row.positionId),
            blockNumber: BigInt(row.blockNumber),
          }))
          setTxs(activityRows)
        }

        if (
          !cancelled &&
          !pegStats &&
          !activity &&
          !loadStatsCache() &&
          !loadListingCache()
        ) {
          setError('Peg2Peg 统计/活动加载失败，请稍后刷新。（详情见控制台）')
        }
      } catch (loadError) {
        console.error(loadError)
        if (!cancelled && !loadStatsCache() && !loadListingCache()) {
          setError('Peg2Peg 统计/活动加载失败，请稍后刷新。（详情见控制台）')
        }
      } finally {
        if (!cancelled) setStatsLoading(false)
      }

      try {
        setListingsProgress(null)
        const visibleRaw = await fetchVisibleOpenListings(VISIBLE_LISTING_LIMIT)
        if (cancelled) return

        const skeleton = toBaseRows(visibleRaw, listingsRef.current)
        setListings(skeleton)
        saveListingCache(skeleton)
        setListingsLoading(false)
        setListingsProgress(null)

        // 首屏秒出后，后台增量补全 seed（只补缺失，且限流）
        void (async () => {
          const enriched = await mapWithConcurrency(skeleton, 6, async (row) => {
            if (row.previewSeed || row.previewUpegId) return row
            const first = await getSeedCached(row.positionContract)
            return {
              ...row,
              previewUpegId: first.id,
              previewSeed: first.seed,
            }
          })
          if (cancelled) return
          setListings(enriched)
          saveListingCache(enriched)
        })()
      } catch (loadError) {
        console.error(loadError)
        if (!cancelled) {
          if (!loadListingCache()) setError((prev) => prev || '挂单加载失败，请稍后刷新。')
          setListingsProgress(null)
        }
      } finally {
        if (!cancelled) setListingsLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [getSeedCached, toBaseRows])

  useEffect(() => {
    let stopped = false
    let running = false
    const syncMarket = async () => {
      if (running) return
      running = true
      try {
        const [visibleRaw, activity] = await Promise.all([
          fetchVisibleOpenListings(VISIBLE_LISTING_LIMIT),
          pegFetchJson<PegActivityApiRow[]>('/activity?limit=220'),
        ])
        if (stopped) return

        const skeleton = toBaseRows(visibleRaw, listingsRef.current)
        if (!sameListings(listingsRef.current, skeleton)) {
          setListings(skeleton)
          saveListingCache(skeleton)
        }

        const activityRows: TxItem[] = activity.map((row) => ({
          txHash: row.txHash,
          positionId: row.positionId,
          from: row.actor,
          eventType: row.eventType,
          priceWei: row.priceWei,
          timestamp: row.timestamp,
          tokenId: BigInt(row.positionId),
          blockNumber: BigInt(row.blockNumber),
        }))
        if (!sameTxs(txsRef.current, activityRows)) {
          setTxs(activityRows)
        }

        const enriched = await mapWithConcurrency(skeleton, 6, async (row) => {
          if (row.previewSeed || row.previewUpegId) return row
          const first = await getSeedCached(row.positionContract)
          return {
            ...row,
            previewUpegId: first.id,
            previewSeed: first.seed,
          }
        })
        if (stopped) return
        if (!sameListings(listingsRef.current, enriched)) {
          setListings(enriched)
          saveListingCache(enriched)
        }
      } catch {
        // keep last rendered state
      } finally {
        running = false
      }
    }

    const timer = setInterval(syncMarket, 4_500)
    const onFocus = () => {
      void syncMarket()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      stopped = true
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [getSeedCached, toBaseRows])

  // Floor/Volume 仅使用官网 stats，并定时刷新，避免显示口径漂移
  useEffect(() => {
    let stopped = false
    const tick = async () => {
      try {
        const [pegStats, readyFloorWei, liveEthUsd] = await Promise.all([
          fetchStatsOnly(),
          fetchReadyFloorWei().catch(() => '0'),
          fetchLiveEthUsd(),
        ])
        if (stopped) return
        setStats((prev) => ({
          ...prev,
          floorWei: readyFloorWei !== '0' ? readyFloorWei : pegStats.floorPriceWei,
          volumeWei: pegStats.volumeWei,
          items: pegStats.upegsTotal,
          holders: pegStats.holdersCount,
          priceUsd: Number(liveEthUsd ?? pegStats.priceUsd ?? prev.priceUsd ?? 0),
        }))
        saveStatsCache({
          floorWei: readyFloorWei !== '0' ? readyFloorWei : pegStats.floorPriceWei,
          volumeWei: pegStats.volumeWei,
          items: pegStats.upegsTotal,
          holders: pegStats.holdersCount,
          priceUsd: Number(liveEthUsd ?? pegStats.priceUsd ?? 0),
        })
      } catch {
        // keep last shown stats
      }
    }
    const timer = setInterval(tick, 2_500)
    const onFocus = () => {
      tick()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      stopped = true
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [])

  const filteredSorted = useMemo(() => {
    let rows = listings
    const q = searchQ.trim().toLowerCase()
    if (q) {
      rows = rows.filter(
        (r) =>
          r.id.includes(q) ||
          r.seller.toLowerCase().includes(q) ||
          r.positionContract.toLowerCase().includes(q) ||
          (r.previewUpegId && r.previewUpegId.includes(q)),
      )
    }
    const copy = [...rows]
    if (sortKey === 'priceAsc') copy.sort((a, b) => (BigInt(a.priceWei) > BigInt(b.priceWei) ? 1 : -1))
    else if (sortKey === 'priceDesc') copy.sort((a, b) => (BigInt(a.priceWei) < BigInt(b.priceWei) ? 1 : -1))
    else copy.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return copy
  }, [listings, searchQ, sortKey])

  const displayFloorWei = useMemo(() => {
    const visibleTradable = filteredSorted.slice(1).filter(
      (r) => Number(r.upegCount ?? 0) > 0 && r.paymentToken.toLowerCase() === NATIVE.toLowerCase(),
    )
    if (!visibleTradable.length) return stats.floorWei || '0'
    let min = visibleTradable[0].priceWei
    for (const r of visibleTradable) {
      if (BigInt(r.priceWei) < BigInt(min)) min = r.priceWei
    }
    return min
  }, [filteredSorted, stats.floorWei])

  const displayedListings = useMemo(() => filteredSorted.slice(1), [filteredSorted])

  const copyContract = async () => {
    try {
      await navigator.clipboard.writeText(NFT_CONTRACT)
    } catch {
      /* ignore */
    }
  }

  const connectWallet = async (chosen?: DetectedWallet) => {
    const all = listInjectedProviders()
    if (!all.length) {
      alert('未检测到钱包插件，请安装 MetaMask 或其他 EVM 钱包。')
      return
    }
    if (!chosen) {
      setWalletOptions(all)
      setWalletPickerOpen(true)
      return
    }
    const selected = chosen ?? all[0]
    await ensureTargetChain(selected.provider)
    const provider = new BrowserProvider(selected.provider as any)
    const accounts = await provider.send('eth_requestAccounts', [])
    const network = await provider.getNetwork()
    const balance = await provider.getBalance(accounts[0])
    setWalletAddress(accounts[0])
    setActiveWalletProvider(selected.provider)
    setActiveWalletName(selected.name)
    setChainId(Number(network.chainId))
    setWalletBalance(formatEtherEthers(balance))
    setWalletPickerOpen(false)
  }

  const disconnectWallet = () => {
    setWalletAddress(null)
    setActiveWalletProvider(null)
    setActiveWalletName(null)
    setChainId(null)
    setWalletBalance(null)
  }

  const refreshBalance = useCallback(async () => {
    if (!walletAddress || !activeWalletProvider) return
    const provider = new BrowserProvider(activeWalletProvider as any)
    const balance = await provider.getBalance(walletAddress)
    setWalletBalance(formatEtherEthers(balance))
  }, [walletAddress, activeWalletProvider])

  const payListingToTreasury = async (row: ListingRow) => {
    if (!walletAddress || !activeWalletProvider) {
      alert('Please connect your wallet.')
      return
    }
    if (chainId !== TARGET_CHAIN_ID) {
      try {
        await ensureTargetChain(activeWalletProvider)
      } catch {
        alert(`请先切换到 ${TARGET_CHAIN_NAME} 再尝试。`)
        return
      }
    }
    if (row.paymentToken.toLowerCase() !== NATIVE.toLowerCase()) {
      alert('该挂单非 ETH 本位，当前仅支持向收款地址发送 ETH。')
      return
    }
    const value = BigInt(row.priceWei)
    if (value <= 0n) {
      alert('挂单价格为 0，无法支付')
      return
    }
    try {
      setPendingListingId(row.id)
      const provider = new BrowserProvider(activeWalletProvider as any)
      const signer = await provider.getSigner()
      const tx = await signer.sendTransaction({
        to: TREASURY,
        value,
      })
      await tx.wait()
      await refreshBalance()
      alert(`已向收款地址支付 ${formatEtherEthers(value)} ETH（演示转账）。`)
    } catch (txError) {
      console.error(txError)
      alert('交易失败或已取消。')
    } finally {
      setPendingListingId(null)
    }
  }

  const openDetail = async (row: ListingRow) => {
    setDetailRow(row)
    setDetailTab('info')
    setDetailOpen(true)
    setDetailLoading(true)
    setDetailTraits(null)
    setDetailProv(null)
    try {
      const [traits, provenance] = await Promise.all([
        row.previewSeed ? pegFetchJson<Record<string, unknown>>(`/upeg/${row.previewSeed}/traits`).catch(() => null) : Promise.resolve(null),
        row.previewUpegId ? pegFetchJson<Record<string, unknown>>(`/upegs/${row.previewUpegId}/provenance`).catch(() => null) : Promise.resolve(null),
      ])
      setDetailTraits(traits)
      setDetailProv(provenance)
    } finally {
      setDetailLoading(false)
    }
  }

  const heroUpegId =
    filteredSorted[0]?.previewSeed ??
    filteredSorted[0]?.previewUpegId ??
    listings.find((l) => l.previewSeed || l.previewUpegId)?.previewSeed ??
    listings.find((l) => l.previewSeed || l.previewUpegId)?.previewUpegId ??
    null

  const sortSelectValue = sortKey === 'recent' ? 'recent' : sortKey === 'priceAsc' ? 'price_low' : 'price_high'

  const onSortSelect = (v: string) => {
    if (v === 'recent') setSortKey('recent')
    else if (v === 'price_low') setSortKey('priceAsc')
    else setSortKey('priceDesc')
  }

  const sellPriceNum = Number(sellPrice || '0')
  const sellReceive = Number.isFinite(sellPriceNum) && sellPriceNum > 0 ? sellPriceNum : 0
  const traitPairs = useMemo(() => {
    if (!detailTraits) return []
    return Object.entries(detailTraits)
      .filter(([, v]) => typeof v !== 'object' && typeof v !== 'undefined')
      .slice(0, 18)
  }, [detailTraits])
  const provenancePairs = useMemo(() => {
    if (!detailProv) return []
    const preferred = ['blockNumber', 'blockTs', 'miner', 'prevRandao', 'blockHash', 'txCount', 'gasUsed']
    const entries = Object.entries(detailProv)
    const ordered = [
      ...preferred.map((k) => entries.find(([ek]) => ek === k)).filter(Boolean),
      ...entries.filter(([k]) => !preferred.includes(k)),
    ] as [string, unknown][]
    return ordered.slice(0, 18)
  }, [detailProv])
  const refreshWalletOptions = () => {
    const all = listInjectedProviders()
    setWalletOptions(all)
    if (!all.length) {
      alert('当前页面未检测到可用 EVM 钱包。请确认钱包扩展已解锁并允许当前站点访问。')
    }
  }

  useEffect(() => {
    const keys = displayedListings
      .slice(0, 16)
      .map((r) => r.previewSeed ?? r.previewUpegId)
      .filter((v): v is string => Boolean(v))
    if (!keys.length) return
    let stopped = false
    void mapWithConcurrency(keys, 4, async (k) => {
      if (stopped) return null
      await resolveSvgDataUrl(k)
      return null
    })
    return () => {
      stopped = true
    }
  }, [displayedListings])

  return (
    <div className="market-page">
      <header className="top-bar">
        <div className="brand-lockup">
          <span className="brand-icon" aria-hidden>
            🦄
          </span>
          <span className="brand-text">
            Peg<span className="brand-pink">2</span>Peg
          </span>
        </div>
        {!walletAddress ? (
          <button type="button" onClick={() => connectWallet()} className="connect-btn">
            Connect wallet
          </button>
        ) : (
          <div className="wallet-row">
            <button type="button" className="ghost-btn">
              {activeWalletName ? `${activeWalletName} · ${shortAddr(walletAddress)}` : shortAddr(walletAddress)}
            </button>
            <button type="button" className="connect-btn ghost-outline" onClick={disconnectWallet}>
              Disconnect
            </button>
          </div>
        )}
      </header>

      <div className="banner-wrap">
        <div className="banner-blur" aria-hidden />
      </div>

      <section className="collection-shell">
        <div className="collection-panel">
          <div className="collection-main">
            <div className="logo-box">
              {heroUpegId ? (
                <UpegSvgImg imageKey={heroUpegId} alt="Unipeg" className="logo-box-img" wrapperClassName="logo-placeholder" />
              ) : (
                <div className="logo-placeholder">🦄</div>
              )}
            </div>
            <div className="collection-copy">
              <div className="title-row">
                <h1>Unipeg</h1>
                <VerifiedBadge />
              </div>
              <p className="meta-line">
                <span className="meta-muted">by Unipeg Team</span>
                <span className="meta-dot">·</span>
                <button type="button" className="addr-chip" onClick={copyContract} title="复制合约">
                  {shortAddr(NFT_CONTRACT)}
                  <span className="copy-glyph" aria-hidden>
                    ⧉
                  </span>
                </button>
                <span className="meta-dot">·</span>
                <span className="meta-muted">
                  {statsLoading ? '…' : error ? '--' : stats.items.toLocaleString()} items
                </span>
                <span className="meta-dot">·</span>
                <span className="meta-muted">
                  {statsLoading ? '…' : error ? '--' : `${stats.holders.toLocaleString()} holders`}
                </span>
                <span className="meta-dot">·</span>
                <a className="meta-link" href="https://unipeg.art/" target="_blank" rel="noreferrer">
                  unipeg.art
                </a>
              </p>
              <div className="floor-volume">
                <div>
                  <span className="fv-label">FLOOR</span>
                  <strong className="fv-val">
                    {statsLoading ? '…' : `${formatEthFixed(displayFloorWei || '0', 3)} ETH`}
                  </strong>
                </div>
                <div>
                  <span className="fv-label">VOLUME</span>
                  <strong className="fv-val">
                    {statsLoading ? '…' : `${formatEthFixed(stats.volumeWei || '0', 2)} ETH`}
                  </strong>
                </div>
              </div>
            </div>
          </div>
          <div className="collection-cta">
            <button type="button" className="new-trade-btn" onClick={() => setSellOpen(true)}>
              Sell <span aria-hidden>→</span>
            </button>
          </div>
        </div>
      </section>

      <section className="content">
        <div className="toolbar">
          <div className="tabs">
            <button
              type="button"
              className={mainTab === 'trades' ? 'active' : ''}
              onClick={() => setMainTab('trades')}
            >
              All trades
            </button>
            <button
              type="button"
              className={mainTab === 'portfolio' ? 'active' : ''}
              onClick={() => setMainTab('portfolio')}
            >
              Portfolio
            </button>
            <button
              type="button"
              className={mainTab === 'activity' ? 'active' : ''}
              onClick={() => setMainTab('activity')}
            >
              Activity
            </button>
          </div>
          <div className="filters">
            <div className="search-wrap">
              <span className="search-icon" aria-hidden>
                ⌕
              </span>
              <input
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder="Search by ID"
                disabled={mainTab !== 'trades'}
              />
            </div>
            <select
              value={sortSelectValue}
              onChange={(e) => onSortSelect(e.target.value)}
              aria-label="Sort"
              disabled={mainTab !== 'trades'}
            >
              <option value="recent">Recently listed</option>
              <option value="price_low">Price: low to high</option>
              <option value="price_high">Price: high to low</option>
            </select>
          </div>
        </div>

        {error && <div className="error">{error}</div>}
        {(statsLoading || listingsLoading) && listingsProgress && (
          <p className="loading">{listingsProgress}</p>
        )}

        {mainTab === 'trades' && (
          <div className="listing-grid" id="listings">
            {displayedListings.map((row, idx) => {
              const isEth = row.paymentToken.toLowerCase() === NATIVE.toLowerCase()
              const paying = pendingListingId === row.id
              const labelId = row.previewUpegId ?? row.id
              return (
                <article key={row.id} className="listing-card" onClick={() => openDetail(row)}>
                  <div className="listing-card-visual">
                    {row.previewSeed || row.previewUpegId ? (
                      <UpegSvgImg
                        imageKey={row.previewSeed ?? row.previewUpegId!}
                        fallbackKeys={row.previewUpegId ? [row.previewUpegId] : []}
                        alt={`uPeg ${labelId}`}
                        wrapperClassName="listing-card-fallback"
                        eager={idx < 8}
                      />
                    ) : (
                      <div className="listing-card-fallback" />
                    )}
                    {isEth ? (
                      <span className="listing-card-price">{formatEtherEthers(row.priceWei)} ETH</span>
                    ) : (
                      <span className="listing-card-price dim">Non-ETH</span>
                    )}
                  </div>
                  <div className="listing-card-foot">
                    <span className="listing-card-name">uPeg #{labelId}</span>
                    <a
                      className="listing-card-owner"
                      href={`https://etherscan.io/address/${row.seller}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortAddr(row.seller)}
                    </a>
                  </div>
                  <div className="listing-subline">
                    <span>Listing #{row.id}</span>
                  </div>
                  <button
                    type="button"
                    className="listing-pay"
                    disabled={!isEth || paying || listingsLoading}
                    onClick={(e) => {
                      e.stopPropagation()
                      payListingToTreasury(row)
                    }}
                  >
                    {paying ? '…' : 'Buy'}
                  </button>
                </article>
              )
            })}
          </div>
        )}

        {mainTab === 'portfolio' && (
          <div className="tab-panel empty-panel">
            <p>Please connect your wallet.</p>
          </div>
        )}

        {mainTab === 'activity' && (
          <div className="tab-panel activity-panel" data-activity-ui="v2">
            {activityRowsView.map(({ tx, weiForUi, usdLabel, upegId, fromAddr, toAddr }) => (
              <a
                key={`${tx.txHash}-${tx.positionId}-${tx.eventType}-${tx.blockNumber.toString()}`}
                className="activity-row"
                href={explorerTxUrl(tx.txHash)}
                target="_blank"
                rel="noreferrer"
              >
                <div className="activity-row-main">
                  <div className="activity-col-left">
                    <span className="activity-age">{formatRelTime(tx.timestamp)}</span>
                    <span className="activity-name accent">uPeg #{upegId}</span>
                  </div>
                  <div className="activity-col-mid">
                    <span className={`activity-eth${weiForUi ? '' : ' dim'}`}>
                      {weiForUi ? `${formatEthFixed(weiForUi, 4)} ETH` : '—'}
                    </span>
                    {usdLabel && <span className="activity-usd">≈ ${usdLabel}</span>}
                  </div>
                  <div className="activity-col-right">
                    <span className="activity-peer">{shortAddr(fromAddr)}</span>
                    <span className="activity-arrow">→</span>
                    <span className="activity-peer">{shortAddr(toAddr)}</span>
                  </div>
                </div>
                <span className="activity-ext" aria-hidden>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M14 3h7v7"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M10 14 21 3"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M21 14v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h6"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </a>
            ))}
          </div>
        )}

        {!listingsLoading && mainTab === 'trades' && displayedListings.length === 0 && (
          <p className="muted empty-hint">No listings match.</p>
        )}

      </section>

      {detailOpen && detailRow && (
        <div className="detail-mask" role="dialog" aria-modal="true" aria-label="Trade detail">
          <div className="detail-modal">
            <button type="button" className="detail-close" onClick={() => setDetailOpen(false)} aria-label="Close">
              ×
            </button>
            <p className="detail-kicker">TRADE</p>
            <h2 className="detail-title">uPeg #{detailRow.previewUpegId ?? detailRow.id}</h2>
            <div className="detail-grid">
              <div className="detail-art">
                {detailRow.previewSeed || detailRow.previewUpegId ? (
                  <UpegSvgImg
                    imageKey={detailRow.previewSeed ?? detailRow.previewUpegId!}
                    fallbackKeys={detailRow.previewUpegId ? [detailRow.previewUpegId] : []}
                    alt={`uPeg #${detailRow.previewUpegId ?? detailRow.id}`}
                    className="detail-art-img"
                    wrapperClassName="detail-art-fallback"
                  />
                ) : (
                  <div className="detail-art-fallback" />
                )}
              </div>
              <div className="detail-side">
                <div className="detail-tabs">
                  <button type="button" className={detailTab === 'info' ? 'active' : ''} onClick={() => setDetailTab('info')}>
                    INFO
                  </button>
                  <button type="button" className={detailTab === 'traits' ? 'active' : ''} onClick={() => setDetailTab('traits')}>
                    TRAITS
                  </button>
                  <button
                    type="button"
                    className={detailTab === 'provenance' ? 'active' : ''}
                    onClick={() => setDetailTab('provenance')}
                  >
                    PROVENANCE
                  </button>
                </div>

                {detailTab === 'info' && (
                  <div className="detail-info">
                    <div><span>SELLER</span><strong>{shortAddr(detailRow.seller)}</strong></div>
                    <div><span>STATUS</span><strong>{detailRow.status}</strong></div>
                    <div><span>TRADE ID</span><strong>#{detailRow.id}</strong></div>
                    <div>
                      <span>PRICE</span>
                      <strong>{formatEtherEthers(detailRow.priceWei)} ETH</strong>
                    </div>
                    <div><span>TX</span><strong>{shortAddr(detailRow.createdTxHash)}</strong></div>
                    {stats.priceUsd > 0 && (
                      <div><span>USD</span><strong>~ ${(
                        Number(formatEtherEthers(detailRow.priceWei)) * stats.priceUsd
                      ).toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong></div>
                    )}
                  </div>
                )}

                {detailTab === 'traits' && (
                  <div className="detail-panel">
                    {detailLoading ? (
                      'Loading…'
                    ) : detailTraits ? (
                      <>
                        <div className="detail-kv-grid">
                          {traitPairs.map(([k, v]) => (
                            <div key={k} className="detail-kv-row">
                              <span>{k}</span>
                              <strong>{String(v)}</strong>
                            </div>
                          ))}
                        </div>
                        <details className="detail-raw">
                          <summary>Raw JSON</summary>
                          <pre>{JSON.stringify(detailTraits, null, 2)}</pre>
                        </details>
                      </>
                    ) : (
                      'No traits data'
                    )}
                  </div>
                )}

                {detailTab === 'provenance' && (
                  <div className="detail-panel">
                    {detailLoading ? (
                      'Loading…'
                    ) : detailProv ? (
                      <>
                        <div className="detail-kv-grid">
                          {provenancePairs.map(([k, v]) => (
                            <div key={k} className="detail-kv-row">
                              <span>{k}</span>
                              <strong>{typeof v === 'string' ? v.slice(0, 24) : String(v)}</strong>
                            </div>
                          ))}
                        </div>
                        <details className="detail-raw">
                          <summary>Raw JSON</summary>
                          <pre>{JSON.stringify(detailProv, null, 2)}</pre>
                        </details>
                      </>
                    ) : (
                      'No provenance data'
                    )}
                  </div>
                )}

                <button
                  type="button"
                  className="detail-buy"
                  onClick={() => payListingToTreasury(detailRow)}
                  disabled={pendingListingId === detailRow.id}
                >
                  {pendingListingId === detailRow.id ? 'Processing…' : 'Buy now →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {sellOpen && (
        <div className="sell-modal-mask" role="dialog" aria-modal="true" aria-label="Create trade">
          <div className="sell-modal">
            <button type="button" className="sell-close" onClick={() => setSellOpen(false)} aria-label="Close">
              ×
            </button>
            <p className="sell-kicker">MARKETPLACE</p>
            <h2 className="sell-title">New trade</h2>

            <p className="sell-label">PICK AN ITEM</p>
            <div className="sell-item-box">You don't own any items yet</div>

            <p className="sell-label">PRICE</p>
            <div className="sell-price-row">
              <input
                value={sellPrice}
                onChange={(e) => setSellPrice(e.target.value)}
                className="sell-price-input"
                placeholder="0.00"
              />
              <span className="sell-eth">ETH</span>
            </div>
            <p className="sell-fee-note">
              0% protocol fee. You'll receive {sellReceive.toFixed(4)} ETH on sale.
            </p>

            <div className="sell-actions">
              <button type="button" className="sell-cancel" onClick={() => setSellOpen(false)}>
                Cancel
              </button>
              <button type="button" className="sell-create" disabled>
                Create trade <span aria-hidden>→</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {walletPickerOpen && (
        <div className="wallet-picker-mask" role="dialog" aria-modal="true" aria-label="Select wallet">
          <div className="wallet-picker">
            <button type="button" className="wallet-picker-close" onClick={() => setWalletPickerOpen(false)} aria-label="Close">
              ×
            </button>
            <h3>Connect Wallet</h3>
          <p className="wallet-help">选择一个已安装的 EVM 钱包</p>
          <div className="wallet-divider" />
          <div className="wallet-actions">
            <span>{walletOptions.length} wallets detected</span>
            <button type="button" className="wallet-refresh-btn" onClick={refreshWalletOptions}>
              Refresh
            </button>
          </div>

          <div className="wallet-picker-list">
            {walletOptions.map((w) => (
              <button key={w.id} type="button" className="wallet-option" onClick={() => connectWallet(w)}>
                <span className="wallet-option-name">{w.name}</span>
                <span className="wallet-option-tag installed">DETECTED</span>
              </button>
            ))}
            {walletOptions.length === 0 && <div className="wallet-empty">No wallet detected</div>}
          </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
