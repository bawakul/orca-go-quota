// The plugin's worker: resolves the OpenCode Go API key (secret > setting > pi auth.json >
// OpenCode CLI auth.json), fetches the one endpoint, caches the outcome in orca.storage and
// keeps the status bar current. Every network answer, success or failure, is persisted so a
// restart never flashes good data over a known-bad key. The key itself is never written
// anywhere but Orca's own secret/settings stores, never logged, never posted to a panel —
// snapshots carry only the source LABEL (see src/protocol.ts).
//
// Orca calls the default export when the worker starts and `deactivate()` before it stops.
// Tests never mount the default export with the real dependencies: they call the same
// exported `start(orca, deps)` with an injected fs, fetch, clock and cadence.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { Disposable, JsonValue, OrcaWorkerApi, PluginEvents } from 'orca/worker'
import { SECRET_NAME, SETTING_KEY, SOURCE_LABELS } from './protocol.ts'
import type { KeySource, QuotaError, QuotaSnapshot, Usage } from './protocol.ts'
import { normalizeUsage, parseAuthError, statusFor, type BarStatus } from './usage.ts'

/** The only URL this plugin ever fetches. Hardcoded: never built from settings or user input. */
const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
/** orca.storage key holding the last fetch outcome, `{v:1, usage, fetchedAt, error, keySource}`. */
const CACHE_KEY = 'quota'
const CACHE_VERSION = 1
/** The manifest's `contributes.statusBarItems[0].id`. */
const BAR_ID = 'quota'
/** The fetch gives up after this long; `plugin.request` waits 30 s, so the panel never hangs. */
const FETCH_TIMEOUT_MS = 10_000
/** The usage payload is well under 1 KiB; anything bigger is not our endpoint. */
const MAX_BODY_BYTES = 256 * 1024

/** Reading a key file is the only fs this worker does; injected in tests. */
export type ReadFile = { readFile(path: string): Promise<string> }
/** The one network call; injected in tests. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Everything the worker needs from the outside world; every field is injectable. */
export type WorkerDeps = {
  fs: ReadFile
  fetch: FetchLike
  now: () => Date
  /** After `agent.status.changed` reports done, one fetch waits this long for the burst to settle. */
  settleMs: number
  /** An event- or panel-triggered fetch only runs when the last one is older than this. */
  gapMs: number
  /** The floor: one refresh every so often, however idle the machine. */
  floorMs: number
  /** The smallest gap between two refresh outcomes; `quota.refresh`'s force bypasses it. */
  minGapMs: number
  /** Where `~` points for the auto-discovered auth files. */
  home: string
}

/** What `start` returns; `stop` clears every timer and subscription. */
export type Stop = { stop(): void }

/** The dependencies Orca's own worker runs with. */
export function realDeps(): WorkerDeps {
  return {
    fs: { readFile: (path: string) => readFile(path, 'utf8') },
    fetch: (url: string, init?: RequestInit) => fetch(url, init),
    now: () => new Date(),
    settleMs: 10_000,
    gapMs: 60_000,
    floorMs: 15 * 60_000,
    minGapMs: 30_000,
    home: homedir()
  }
}

/** The cache entry and the worker's whole in-memory state are the same shape: the last
 *  fetch outcome, success or failure. Auth errors persist here so the bar never flashes
 *  good data on restart. */
type CacheEntry = {
  v: 1
  usage: Usage | null
  fetchedAt: string | null
  error: QuotaError | null
  keySource: KeySource
}

const KEY_SOURCES: readonly KeySource[] = ['secret', 'setting', 'pi-auth', 'opencode-auth', 'none']
const ERROR_KINDS: readonly QuotaError['kind'][] = ['auth', 'network', 'shape']

/** The last worker the default export started; `deactivate` (which Orca awaits before it
 *  stops the worker) clears its timers and subscriptions. */
let active: Stop | null = null

/** Orca's entry point: real dependencies, no injection. The same exported function with
 *  `deps` is the factory the tests mount, so the tested code is the shipped code. */
export function start(orca: OrcaWorkerApi, deps: Partial<WorkerDeps> = {}): Stop {
  const handle = run(orca, { ...realDeps(), ...deps })
  active = handle
  return handle
}

export default start

/** Optional worker lifecycle export; the typings say Orca awaits it before stopping. */
export function deactivate(): void {
  const handle = active
  active = null
  handle?.stop()
}

/** A timer that never keeps the worker alive (`.unref()` where Node provides it). */
type ArmedTimer = { clear(): void }

function arm(callback: () => void, ms: number): ArmedTimer {
  const timer = setTimeout(callback, ms) as unknown as { unref?: () => void }
  timer.unref?.()
  return { clear: () => clearTimeout(timer as unknown as number) }
}

function run(orca: OrcaWorkerApi, d: WorkerDeps): Stop {
  let stopped = false
  let state: CacheEntry = { v: 1, usage: null, fetchedAt: null, error: null, keySource: 'none' }
  let inflight: Promise<QuotaSnapshot> | null = null
  /** When the last refresh outcome landed (any kind, keyless included), for the cadence gaps. */
  let lastFetchAt = Number.NEGATIVE_INFINITY
  let settle: ArmedTimer | null = null
  const warned = new Set<string>()
  const disposables: Disposable[] = []

  const nowMs = (): number => d.now().getTime()

  // A bad environment repeats itself; one log line per unique message keeps the log readable.
  function warn(message: string): void {
    if (warned.has(message)) return
    warned.add(message)
    orca.log(`Go Quota: ${message}`)
  }

  function snapshot(fetching: boolean = inflight !== null): QuotaSnapshot {
    return { usage: state.usage, fetchedAt: state.fetchedAt, error: state.error, keySource: state.keySource, fetching }
  }

  /** The status bar for the current state: the fetch outcome first (no key, bad key, offline),
   *  the usage numbers only when healthy. Tones are the catalog's; text stays one short word. */
  function statusFromState(): BarStatus {
    if (state.keySource === 'none') {
      return {
        text: 'Go: no key',
        tone: 'neutral',
        tooltip:
          'No OpenCode Go API key found (looked in the Orca secret, Orca settings, ~/.pi/agent/auth.json and the OpenCode CLI auth file). Add one in the Go Quota panel.'
      }
    }
    if (state.error !== null) {
      const cached =
        state.usage !== null && state.fetchedAt !== null ? ` Showing the usage fetched ${state.fetchedAt}.` : ''
      if (state.error.kind === 'auth') {
        return {
          text: 'Go: bad key',
          tone: 'danger',
          tooltip: `${state.error.message} (key source: ${SOURCE_LABELS[state.keySource]}.)${cached}`
        }
      }
      return { text: 'Go: offline', tone: 'warning', tooltip: `${state.error.message}${cached}` }
    }
    return statusFor(state.usage, state.fetchedAt)
  }

  async function updateBar(): Promise<void> {
    try {
      const bar = statusFromState()
      await orca.host.call('statusBar.update', { id: BAR_ID, text: bar.text, tone: bar.tone, tooltip: bar.tooltip })
    } catch (error) {
      warn(`could not update the status bar: ${shortMessage(error)}`)
    }
  }

  /** Persists the outcome, updates the bar, tells every open panel. Best-effort: a failing
   *  piece is logged and the rest still runs. A fetch landing after `deactivate()` must write
   *  nothing — the worker is dead, its panels and bar are not. */
  async function publish(): Promise<void> {
    if (stopped) return
    try {
      await orca.storage.set(CACHE_KEY, state as unknown as JsonValue)
    } catch (error) {
      warn(`could not write the quota cache: ${shortMessage(error)}`)
    }
    await updateBar()
    try {
      orca.panels.post('quota.changed', snapshot(false))
    } catch (error) {
      warn(`could not tell panels the quota changed: ${shortMessage(error)}`)
    }
  }

  function authPaths(): { pi: string; opencode: string } {
    const base = d.home.endsWith('/') ? d.home.slice(0, -1) : d.home
    return { pi: `${base}/.pi/agent/auth.json`, opencode: `${base}/.local/share/opencode/auth.json` }
  }

  /** `{"opencode-go":{"key":"…"}}`-shaped files, read tolerantly: unreadable or not JSON
   *  simply means this source has nothing to offer. The key never leaves this function
   *  except into the fetch's Authorization header. */
  async function keyFromFile(path: string, account: string): Promise<string | null> {
    let text: string
    try {
      text = await d.fs.readFile(path)
    } catch {
      return null
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
      const entry = (parsed as Record<string, unknown>)[account]
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
      const key = (entry as Record<string, unknown>)['key']
      if (typeof key === 'string' && key.trim() !== '') return key.trim()
    } catch {
      return null
    }
    return null
  }

  /** D1, fresh on every fetch: ① Orca secret ② apiKey setting ③ pi auth.json ④ OpenCode CLI
   *  auth.json. Cheap reads; a newly saved key is used without a worker restart. */
  async function resolveKey(): Promise<{ key: string; source: KeySource } | null> {
    try {
      const secret = await orca.secrets.get(SECRET_NAME)
      if (typeof secret === 'string' && secret.trim() !== '') return { key: secret.trim(), source: 'secret' }
    } catch (error) {
      warn(`reading the Orca secret failed: ${shortMessage(error)}`)
    }
    try {
      const value = await orca.settings.get(SETTING_KEY)
      if (typeof value === 'string' && value.trim() !== '') return { key: value.trim(), source: 'setting' }
    } catch (error) {
      warn(`reading the ${SETTING_KEY} setting failed: ${shortMessage(error)}`)
    }
    const paths = authPaths()
    const pi = await keyFromFile(paths.pi, 'opencode-go')
    if (pi !== null) return { key: pi, source: 'pi-auth' }
    const opencode = await keyFromFile(paths.opencode, 'opencode')
    if (opencode !== null) return { key: opencode, source: 'opencode-auth' }
    return null
  }

  /** Reads at most `maxBytes` of the body, then gives up — cloned from the reference plugin's
   *  price-book pattern. A body over the cap is a network error, never a memory sink. */
  async function readCapped(response: Response, maxBytes: number): Promise<string> {
    if (response.body === null) return response.text()
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const read = await reader.read()
      if (read.done) break
      const value = read.value ?? new Uint8Array()
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`the reply was over ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
    const merged = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(merged)
  }

  /** One live fetch, from key resolution to the published outcome. Never throws, never
   *  touches the key outside the Authorization header. D7: a 401 is an auth error whatever
   *  its body says, anything else that goes wrong is a network error, and the cached usage
   *  survives both, served next to the error. */
  async function runFetch(): Promise<QuotaSnapshot> {
    const found = await resolveKey()
    if (found === null) {
      state = { ...state, error: null, keySource: 'none' }
      await publish()
      return snapshot(false)
    }
    state = { ...state, keySource: found.source }
    try {
      const response = await d.fetch(USAGE_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${found.key}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'error'
      })
      if (response.status === 401) {
        const body = await readCapped(response, MAX_BODY_BYTES).catch(() => '')
        state = { ...state, error: { kind: 'auth', message: parseAuthError(body) } }
      } else if (!response.ok) {
        state = { ...state, error: { kind: 'network', message: `OpenCode Go answered HTTP ${response.status}.` } }
      } else {
        const body = await readCapped(response, MAX_BODY_BYTES)
        let json: unknown = null
        try {
          json = JSON.parse(body)
        } catch {
          json = null
        }
        const usage = normalizeUsage(json)
        if (usage === null) {
          state = {
            ...state,
            error: { kind: 'shape', message: 'OpenCode Go answered, but not in the usage shape this plugin understands.' }
          }
        } else {
          state = { v: 1, usage, fetchedAt: d.now().toISOString(), error: null, keySource: found.source }
        }
      }
    } catch (error) {
      // Timeout, DNS, redirect, oversize: none of these messages echo the key back.
      state = { ...state, error: { kind: 'network', message: `Could not reach OpenCode Go: ${shortMessage(error)}` } }
    }
    await publish()
    return snapshot(false)
  }

  /** The one refresh path (D2): in-flight dedupe first, then the min-gap guard, `force`
   *  (quota.refresh) past it. Never rejects — the caller may well be fire-and-forget. */
  async function refresh(options: { force?: boolean } = {}): Promise<QuotaSnapshot> {
    if (stopped) return snapshot()
    if (inflight !== null) return inflight
    if (options.force !== true && nowMs() - lastFetchAt < d.minGapMs) return snapshot()
    const job = runFetch()
      .catch((error: unknown): QuotaSnapshot => {
        warn(`a fetch failed unexpectedly: ${shortMessage(error)}`)
        return snapshot(false)
      })
      .finally(() => {
        if (inflight === job) inflight = null
        lastFetchAt = nowMs()
      })
    inflight = job
    return job
  }

  /** The last successful fetch is older than the gap (or there has never been one). */
  function stale(): boolean {
    if (state.fetchedAt === null) return true
    const at = Date.parse(state.fetchedAt)
    return Number.isNaN(at) || nowMs() - at > d.gapMs
  }

  /** Cache-first: the panel gets its answer at once, a stale cache refreshes in the
   *  background and the panel hears `quota.changed` when it lands. */
  disposables.push(
    orca.panels.handle('quota.get', async (): Promise<QuotaSnapshot> => {
      try {
        const answer = snapshot()
        if (stale()) void refresh()
        return answer
      } catch (error) {
        warn(`quota.get failed: ${shortMessage(error)}`)
        return { ...snapshot(false), error: { kind: 'network', message: `Go quota worker error: ${shortMessage(error)}` } }
      }
    })
  )

  /** Manual refresh: one forced live fetch, awaited. */
  disposables.push(
    orca.panels.handle('quota.refresh', async (): Promise<QuotaSnapshot> => {
      try {
        return await refresh({ force: true })
      } catch (error) {
        warn(`quota.refresh failed: ${shortMessage(error)}`)
        return { ...snapshot(false), error: { kind: 'network', message: `Go quota worker error: ${shortMessage(error)}` } }
      }
    })
  )

  // An agent finishing a turn has just spent quota: fetch once the burst settles, and only
  // if the last fetch is older than the gap. Bursts (several agents, done then working)
  // collapse into one fetch — the reference plugin's debounce, at network cadence.
  function onAgentStatus(event: PluginEvents['agent.status.changed']): void {
    if (event.state !== 'done') return
    settle?.clear()
    settle = arm(() => {
      settle = null
      if (stopped) return
      if (nowMs() - lastFetchAt > d.gapMs) void refresh()
    }, d.settleMs)
  }
  try {
    disposables.push(orca.events.on('agent.status.changed', onAgentStatus))
  } catch (error) {
    warn(`agent events unavailable: ${shortMessage(error)}`)
  }

  // The floor: however idle the machine, one refresh every interval keeps the bar honest.
  // Each tick re-arms the next, so the floor is recurring, not one-shot; `stop` clears it.
  let floor: ArmedTimer | null = arm(floorTick, d.floorMs)
  function floorTick(): void {
    if (stopped) return
    void refresh()
    floor = arm(floorTick, d.floorMs)
  }

  /** Start-up (D2 ①): serve the cache to the bar instantly — the manifest's `Go —` covers
   *  the no-cache window — then fetch live. */
  async function boot(): Promise<void> {
    if (await loadCache()) await updateBar()
    if (stopped) return
    await refresh()
  }

  /** The last outcome as this plugin wrote it; anything else is ignored silently (D3). */
  async function loadCache(): Promise<boolean> {
    let value: unknown = null
    try {
      value = await orca.storage.get(CACHE_KEY)
    } catch (error) {
      warn(`reading the quota cache failed: ${shortMessage(error)}`)
      return false
    }
    const entry = parseCacheEntry(value)
    if (entry === null) return false
    state = entry
    return true
  }

  function stop(): void {
    stopped = true
    settle?.clear()
    floor?.clear()
    while (disposables.length > 0) disposables.pop()?.dispose()
  }

  void boot()
  return { stop }
}

function parseCacheEntry(value: unknown): CacheEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.v !== CACHE_VERSION) return null
  return {
    v: 1,
    usage: normalizeUsage({ usage: raw.usage }),
    fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : null,
    error: parseCachedError(raw.error),
    keySource: parseKeySource(raw.keySource)
  }
}

function parseCachedError(value: unknown): QuotaError | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.kind !== 'string' || !ERROR_KINDS.includes(raw.kind as QuotaError['kind'])) return null
  if (typeof raw.message !== 'string' || raw.message === '') return null
  return { kind: raw.kind as QuotaError['kind'], message: raw.message }
}

function parseKeySource(value: unknown): KeySource {
  return typeof value === 'string' && KEY_SOURCES.includes(value as KeySource) ? (value as KeySource) : 'none'
}

/** First line of an error, cut so it fits a log line — and never the key, which no error
 *  message on this path carries. */
function shortMessage(error: unknown): string {
  const text =
    String((error as { message?: unknown } | null | undefined)?.message ?? error ?? '').split('\n')[0].trim() ||
    'unknown error'
  return text.length > 160 ? `${text.slice(0, 157)}...` : text
}
