// The Go Quota worker suite. `mountWorker` starts the real src/worker.ts over a `mockHost`,
// with the fs, fetch, clock and cadence injected — no test touches the network, a real key
// or a real timer longer than a few milliseconds. `orca plugin test .` is the runner: it is
// the one that resolves the virtual 'orca/testing' module (plain `node --test` cannot, which
// is why src/usage.test.ts is the CI-runnable half of the suite).
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { MockHost, MockHostOptions, TestWorker } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { start, type FetchLike, type ReadFile, type Stop, type WorkerDeps } from './worker.ts'

// Asserted against, never imported from the worker: the privacy guarantee is that this exact
// URL is the only one the plugin ever fetches.
const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

// One fake key per source, so the resolution-order test can prove which source won from the
// Authorization header alone. These literals are the key-leak suite's needles: none may ever
// appear in a log line, a panel post, a host call or the storage cache.
const SECRET_KEY = 'oc_sk_fake_secret_source_key_1'
const SETTING_KEY = 'oc_sk_fake_setting_source_key_2'
const PI_KEY = 'oc_sk_fake_pi_auth_source_key_3'
const OC_KEY = 'oc_sk_fake_opencode_auth_source_key_4'
const ALL_FAKE_KEYS = [SECRET_KEY, SETTING_KEY, PI_KEY, OC_KEY]

const HOME = '/testhome'
const PI_PATH = `${HOME}/.pi/agent/auth.json`
const OC_PATH = `${HOME}/.local/share/opencode/auth.json`

/** The shape the endpoint was verified to answer (2026-11-20), with that day's real numbers. */
const VALID_PAYLOAD = {
  usage: {
    rolling: { status: 'active', percent: 21, resetsAt: '2026-11-20T22:14:00Z' },
    weekly: { status: 'active', percent: 12, resetsAt: '2026-11-23T00:00:00Z' },
    monthly: { status: 'active', percent: 47, resetsAt: '2026-12-01T00:00:00Z' }
  }
}

const AUTH_ERROR_BODY = {
  error: { type: 'authentication_error', code: 'api_key_expired', message: 'API key expired' }
}

const piAuthFile = (key: string): string => JSON.stringify({ 'opencode-go': { type: 'api', key } })
const ocAuthFile = (key: string): string => JSON.stringify({ opencode: { type: 'api', key } })

const T0 = '2026-11-20T22:00:00Z'
/** What `toISOString()` makes of T0 — the cache's fetchedAt for a fetch at the frozen clock. */
const T0_ISO = new Date(Date.parse(T0)).toISOString()

/** A clock the test advances, for staleness and cadence gaps. */
function fakeClock(): { now: () => Date; advance(ms: number): void } {
  let at = Date.parse(T0)
  return { now: () => new Date(at), advance: (ms: number) => { at += ms } }
}

/** Every (url, init) the injected fetch saw — the init carries the Authorization header by
 *  design, so the leak scan below never scans these, only what the plugin surfaced. */
type FetchCall = { url: string; init: RequestInit | undefined }
type Recorder = { calls: FetchCall[]; fetch: FetchLike }

function respondingFetch(respond: () => Promise<Response>): Recorder {
  const calls: FetchCall[] = []
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init })
    return respond()
  }
  return { calls, fetch }
}

const okFetch = (body: unknown): Recorder => respondingFetch(() => Promise.resolve(new Response(JSON.stringify(body))))
const unauthorizedFetch = (body: unknown): Recorder =>
  respondingFetch(() => Promise.resolve(new Response(JSON.stringify(body), { status: 401 })))
const deadFetch = (): Recorder => respondingFetch(() => Promise.reject(new TypeError('fetch failed')))

function fakeFs(files: Record<string, string>): ReadFile {
  return {
    readFile: async (path: string): Promise<string> => {
      if (Object.prototype.hasOwnProperty.call(files, path)) return files[path]
      const error = new Error(`no such file: ${path}`) as Error & { code?: string }
      error.code = 'ENOENT'
      throw error
    }
  }
}

const DEFAULT_DEPS: WorkerDeps = {
  fs: fakeFs({}),
  fetch: okFetch(VALID_PAYLOAD).fetch,
  now: () => new Date(T0),
  settleMs: 5,
  gapMs: 60_000,
  floorMs: 1_000_000_000,
  minGapMs: 30_000,
  home: HOME
}

/** One mounted worker and its host, kept for the whole-suite privacy scan at the end. */
type Mounted = { worker: TestWorker; host: MockHost; fetches: FetchCall[]; stop(): void }
const RECORDED: Mounted[] = []

async function mountGoWorker(deps: WorkerDeps, fetches: FetchCall[], hostOptions: MockHostOptions = {}): Promise<Mounted> {
  const host = mockHost(hostOptions)
  let handle: Stop | undefined
  const worker = await mountWorker(
    {
      default: (orca: OrcaWorkerApi): Stop => {
        handle = start(orca, deps)
        return handle
      }
    },
    { host }
  )
  if (handle === undefined) throw new Error('the worker never started')
  const mounted: Mounted = { worker, host, fetches, stop: () => handle?.stop() }
  RECORDED.push(mounted)
  return mounted
}

function lastBar(host: MockHost): { id?: string; text?: string; tone?: string; tooltip?: string } {
  const calls = host.callsOf('statusBar.update') as { id?: string; text?: string; tone?: string; tooltip?: string }[]
  const last = calls[calls.length - 1]
  if (last === undefined) throw new Error('the worker never updated the status bar')
  return last
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate: () => boolean, what: string, ms = 1_000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (predicate()) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

test('no key anywhere answers keySource none and never fetches', async () => {
  const recorder = okFetch(VALID_PAYLOAD)
  const mounted = await mountGoWorker({ ...DEFAULT_DEPS, fetch: recorder.fetch }, recorder.calls)
  await until(() => mounted.worker.posts.length === 1, 'the boot refresh')
  const snapshot = await mounted.worker.request('quota.get')
  assert.equal(snapshot.keySource, 'none')
  assert.equal(snapshot.usage, null)
  assert.equal(snapshot.error, null)
  assert.equal(snapshot.fetching, false)
  assert.deepEqual(recorder.calls, [])
  assert.deepEqual(mounted.worker.refusals, [])
  const bar = lastBar(mounted.host)
  assert.equal(bar.id, 'quota')
  assert.equal(bar.text, 'Go: no key')
  assert.equal(bar.tone, 'neutral')
  assert.deepEqual(mounted.host.data().storage.quota, { v: 1, usage: null, fetchedAt: null, error: null, keySource: 'none' })
  mounted.stop()
})

test('resolves the key in order secret > setting > pi auth > OpenCode CLI auth', async () => {
  const scenarios: { name: string; host: MockHostOptions; files: Record<string, string>; source: string; key: string }[] = [
    {
      name: 'the Orca secret wins over everything',
      host: { secrets: { 'opencode-go-key': SECRET_KEY }, settings: { apiKey: SETTING_KEY } },
      files: { [PI_PATH]: piAuthFile(PI_KEY), [OC_PATH]: ocAuthFile(OC_KEY) },
      source: 'secret',
      key: SECRET_KEY
    },
    {
      name: 'the setting beats the discovered files',
      host: { settings: { apiKey: SETTING_KEY } },
      files: { [PI_PATH]: piAuthFile(PI_KEY), [OC_PATH]: ocAuthFile(OC_KEY) },
      source: 'setting',
      key: SETTING_KEY
    },
    {
      name: 'pi auth beats the OpenCode CLI auth',
      host: {},
      files: { [PI_PATH]: piAuthFile(PI_KEY), [OC_PATH]: ocAuthFile(OC_KEY) },
      source: 'pi-auth',
      key: PI_KEY
    },
    {
      name: 'the OpenCode CLI auth is the last resort',
      host: {},
      files: { [OC_PATH]: ocAuthFile(OC_KEY) },
      source: 'opencode-auth',
      key: OC_KEY
    }
  ]
  for (const scenario of scenarios) {
    const recorder = okFetch(VALID_PAYLOAD)
    const deps: WorkerDeps = { ...DEFAULT_DEPS, fetch: recorder.fetch, fs: fakeFs(scenario.files) }
    const mounted = await mountGoWorker(deps, recorder.calls, scenario.host)
    await until(() => mounted.worker.posts.length === 1, `the boot fetch (${scenario.name})`)
    const snapshot = await mounted.worker.request('quota.get')
    assert.equal(snapshot.keySource, scenario.source, scenario.name)
    assert.equal(recorder.calls.length, 1, scenario.name)
    const headers = recorder.calls[0]?.init?.headers as Record<string, string> | undefined
    assert.equal(headers?.Authorization, `Bearer ${scenario.key}`, scenario.name)
    assert.equal(mounted.worker.refusals.length, 0, scenario.name)
    mounted.stop()
  }
})

test('a successful fetch updates the bar, writes the cache and tells panels', async () => {
  const recorder = okFetch(VALID_PAYLOAD)
  const deps: WorkerDeps = { ...DEFAULT_DEPS, fetch: recorder.fetch, fs: fakeFs({ [PI_PATH]: piAuthFile(PI_KEY) }) }
  const mounted = await mountGoWorker(deps, recorder.calls)
  await until(() => mounted.worker.posts.length === 1, 'the boot fetch')
  const snapshot = await mounted.worker.request('quota.get')
  assert.equal(snapshot.keySource, 'pi-auth')
  assert.equal(snapshot.usage?.monthly?.percent, 47)
  assert.equal(snapshot.error, null)
  assert.equal(snapshot.fetching, false)
  assert.deepEqual(mounted.worker.posts[0]?.payload, snapshot)
  assert.deepEqual(mounted.host.data().storage.quota, {
    v: 1,
    usage: VALID_PAYLOAD.usage,
    fetchedAt: T0_ISO,
    error: null,
    keySource: 'pi-auth'
  })
  const bar = lastBar(mounted.host)
  assert.equal(bar.text, 'Go 47%')
  assert.equal(bar.tone, 'neutral')
  assert.match(bar.tooltip ?? '', /Tightest window: monthly\./)
  assert.deepEqual(mounted.worker.refusals, [])
  mounted.stop()
})

test('a 401 keeps the cached usage and answers an auth error that names the source', async () => {
  // Thirty seconds old: fresh enough that quota.get does not trigger a second fetch.
  const seeded = {
    v: 1,
    usage: VALID_PAYLOAD.usage,
    fetchedAt: '2026-11-20T21:59:30Z',
    error: null,
    keySource: 'pi-auth'
  }
  const recorder = unauthorizedFetch(AUTH_ERROR_BODY)
  const deps: WorkerDeps = { ...DEFAULT_DEPS, fetch: recorder.fetch, fs: fakeFs({ [PI_PATH]: piAuthFile(PI_KEY) }) }
  const mounted = await mountGoWorker(deps, recorder.calls, { storage: { quota: seeded } })
  await until(() => mounted.worker.posts.length === 1, 'the boot fetch')
  const snapshot = await mounted.worker.request('quota.get')
  assert.equal(snapshot.error?.kind, 'auth')
  assert.match(snapshot.error?.message ?? '', /expired/i)
  assert.equal(snapshot.usage?.monthly?.percent, 47, 'the cached usage is retained')
  assert.equal(snapshot.fetchedAt, '2026-11-20T21:59:30Z', 'fetchedAt is the last success, not the failure')
  assert.equal(snapshot.keySource, 'pi-auth')
  const bar = lastBar(mounted.host)
  assert.equal(bar.text, 'Go: bad key')
  assert.equal(bar.tone, 'danger')
  assert.match(bar.tooltip ?? '', /\.pi\/agent\/auth\.json/, 'the tooltip names the rejected source')
  const cache = mounted.host.data().storage.quota as { error?: { kind?: string } }
  assert.equal(cache.error?.kind, 'auth', 'the auth error persists in the cache')
  mounted.stop()
})

test('a failing fetch keeps the cached usage and answers a network error', async () => {
  const seeded = {
    v: 1,
    usage: VALID_PAYLOAD.usage,
    fetchedAt: '2026-11-20T21:59:30Z',
    error: null,
    keySource: 'pi-auth'
  }
  const recorder = deadFetch()
  const deps: WorkerDeps = { ...DEFAULT_DEPS, fetch: recorder.fetch, fs: fakeFs({ [PI_PATH]: piAuthFile(PI_KEY) }) }
  const mounted = await mountGoWorker(deps, recorder.calls, { storage: { quota: seeded } })
  await until(() => mounted.worker.posts.length === 1, 'the boot fetch')
  const snapshot = await mounted.worker.request('quota.get')
  assert.equal(snapshot.error?.kind, 'network')
  assert.equal(snapshot.usage?.monthly?.percent, 47, 'the cached usage is retained')
  assert.equal(snapshot.fetchedAt, '2026-11-20T21:59:30Z')
  const bar = lastBar(mounted.host)
  assert.equal(bar.text, 'Go: offline')
  assert.equal(bar.tone, 'warning')
  mounted.stop()
})

test('two quota.refresh calls in flight together share one fetch', async () => {
  let gate!: (response: Response) => void
  const held = new Promise<Response>((resolve) => {
    gate = resolve
  })
  let call = 0
  const calls: FetchCall[] = []
  const fetch: FetchLike = async (url, init) => {
    call += 1
    calls.push({ url, init })
    return call === 1 ? Promise.resolve(new Response(JSON.stringify(VALID_PAYLOAD))) : held
  }
  const deps: WorkerDeps = { ...DEFAULT_DEPS, fetch, fs: fakeFs({ [PI_PATH]: piAuthFile(PI_KEY) }) }
  const mounted = await mountGoWorker(deps, calls)
  await until(() => mounted.worker.posts.length === 1, 'the boot fetch')
  assert.equal(call, 1)
  const first = mounted.worker.request('quota.refresh')
  const second = mounted.worker.request('quota.refresh')
  await until(() => call === 2, 'the forced fetch')
  await sleep(10)
  assert.equal(call, 2, 'two concurrent refreshes dedupe into one fetch')
  gate(new Response(JSON.stringify(VALID_PAYLOAD)))
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a, b)
  assert.equal(a.fetching, false)
  assert.equal(call, 2)
  mounted.stop()
})

test("an agent's done state fetches once after the settle window; bursts collapse", async () => {
  const clock = fakeClock()
  const recorder = okFetch(VALID_PAYLOAD)
  const deps: WorkerDeps = {
    ...DEFAULT_DEPS,
    fetch: recorder.fetch,
    fs: fakeFs({ [PI_PATH]: piAuthFile(PI_KEY) }),
    now: clock.now
  }
  const mounted = await mountGoWorker(deps, recorder.calls)
  await until(() => mounted.worker.posts.length === 1, 'the boot fetch')
  assert.equal(recorder.calls.length, 1)
  clock.advance(61_000)
  await mounted.worker.emit('agent.status.changed', { workspaceId: null, paneKey: 'pane-1', state: 'done', receivedAt: Date.now() })
  await mounted.worker.emit('agent.status.changed', { workspaceId: null, paneKey: 'pane-1', state: 'done', receivedAt: Date.now() })
  await mounted.worker.emit('agent.status.changed', { workspaceId: null, paneKey: 'pane-1', state: 'working', receivedAt: Date.now() })
  await until(() => recorder.calls.length === 2, 'the settle fetch')
  await sleep(40)
  assert.equal(recorder.calls.length, 2, 'a burst of done states collapses into one fetch')
  // The fetch just landed: another done stays quiet until the gap passes again.
  await mounted.worker.emit('agent.status.changed', { workspaceId: null, paneKey: 'pane-1', state: 'done', receivedAt: Date.now() })
  await sleep(40)
  assert.equal(recorder.calls.length, 2)
  mounted.stop()
})

test('a corrupt cache is ignored, not served and not fatal', async () => {
  const recorder = okFetch(VALID_PAYLOAD)
  const deps: WorkerDeps = { ...DEFAULT_DEPS, fetch: recorder.fetch, fs: fakeFs({ [PI_PATH]: piAuthFile(PI_KEY) }) }
  const mounted = await mountGoWorker(deps, recorder.calls, { storage: { quota: 'garbage, not the entry shape' } })
  await until(() => mounted.worker.posts.length === 1, 'the boot fetch')
  const snapshot = await mounted.worker.request('quota.get')
  assert.equal(snapshot.error, null)
  assert.equal(snapshot.usage?.monthly?.percent, 47)
  const cache = mounted.host.data().storage.quota as { v?: number }
  assert.equal(cache.v, 1, 'the good outcome replaced the corrupt cache')
  mounted.stop()
})

test('the floor re-arms: a second idle interval refreshes again', async () => {
  const clock = fakeClock()
  const recorder = okFetch(VALID_PAYLOAD)
  // A floor tick every 20 ms of real time; the frozen clock is what the min-gap guard sees,
  // so the test advances it past the gap between waits for the two floor fetches.
  const deps: WorkerDeps = {
    ...DEFAULT_DEPS,
    fetch: recorder.fetch,
    fs: fakeFs({ [PI_PATH]: piAuthFile(PI_KEY) }),
    now: clock.now,
    floorMs: 20
  }
  const mounted = await mountGoWorker(deps, recorder.calls)
  await until(() => recorder.calls.length === 1, 'the boot fetch')
  clock.advance(31_000)
  await until(() => recorder.calls.length === 2, 'the first floor refresh')
  clock.advance(31_000)
  await until(() => recorder.calls.length === 3, 'the second floor refresh (the floor re-armed)')
  await sleep(60)
  assert.equal(recorder.calls.length, 3, 'no third fetch without another gap')
  mounted.stop()
})

test('a stop mid-fetch publishes nothing: the dead worker writes no cache, bar or panel post', async () => {
  let gate!: (response: Response) => void
  const held = new Promise<Response>((resolve) => {
    gate = resolve
  })
  const calls: FetchCall[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return held
  }
  const deps: WorkerDeps = { ...DEFAULT_DEPS, fetch, fs: fakeFs({ [PI_PATH]: piAuthFile(PI_KEY) }) }
  const mounted = await mountGoWorker(deps, calls, { storage: {} })
  await until(() => calls.length === 1, 'the boot fetch to be in flight')
  const postsBefore = mounted.worker.posts.length
  const barBefore = (mounted.host.callsOf('statusBar.update') as unknown[]).length
  mounted.stop()
  gate(new Response(JSON.stringify(VALID_PAYLOAD)))
  await sleep(30)
  assert.equal(mounted.host.data().storage.quota, undefined, 'a fetch landing after stop writes no cache')
  assert.equal(mounted.worker.posts.length, postsBefore, 'and posts no quota.changed')
  assert.equal((mounted.host.callsOf('statusBar.update') as unknown[]).length, barBefore, 'and updates no bar')
})

test('privacy: every fetch went to the one endpoint, and no key leaked anywhere the plugin surfaces', async () => {
  assert.ok(RECORDED.length >= 7, 'the suites above must have run and recorded their workers')
  const urls: string[] = []
  for (const entry of RECORDED) {
    for (const call of entry.fetches) urls.push(call.url)
    // Everything the plugin surfaced: its log lines, its panel posts, every host call it
    // made, and its storage cache. Orca's own settings and secrets stores are excluded —
    // the key living there is D1's design, not a leak.
    const surfaced = JSON.stringify({
      logs: entry.worker.logs,
      posts: entry.worker.posts,
      hostCalls: entry.host.calls,
      storage: entry.host.data().storage
    })
    for (const key of ALL_FAKE_KEYS) {
      assert.ok(!surfaced.includes(key), `${key} leaked into a log, post, host call or the cache`)
    }
  }
  assert.ok(urls.length > 0, 'the suite must have fetched at least once to check the URLs')
  for (const url of urls) assert.equal(url, USAGE_URL)
})
