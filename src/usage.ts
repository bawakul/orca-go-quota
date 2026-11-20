// Pure usage parsing and status-bar math for the OpenCode Go quota endpoint: no imports from
// 'orca', no network, no clock — the worker (src/worker.ts) and the tests (src/usage.test.ts)
// both read it. Every function is total: malformed input degrades to null windows or a generic
// message, never a throw.

import type { Usage, UsageWindow, WindowName } from './protocol.ts'

/** The status-bar tones the Orca catalog shares. */
export type BarTone = 'neutral' | 'warning' | 'danger'

/** What the worker hands `statusBar.update`: the text, its tone and the hover tooltip. */
export type BarStatus = { text: string; tone: BarTone; tooltip: string }

const WINDOWS: readonly WindowName[] = ['rolling', 'weekly', 'monthly']

/** A window is usable when it is an object with a finite `percent`; status and resetsAt are
 *  tolerated as missing (empty string). A non-number percent marks the window unavailable. */
function parseWindow(value: unknown): UsageWindow | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const percent = raw.percent
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null
  return {
    status: typeof raw.status === 'string' ? raw.status : '',
    percent: Math.min(100, Math.max(0, percent)),
    resetsAt: typeof raw.resetsAt === 'string' ? raw.resetsAt : ''
  }
}

/** Tolerant parse of the endpoint body `{usage:{rolling:{...},weekly:{...},monthly:{...}}}`:
 *  unknown fields are ignored, each window parses or drops to null on its own, percent is
 *  clamped to 0..100, and a payload with no usable window answers null (the caller's shape
 *  error), so one bad window never sinks the other two and garbage never crashes the worker. */
export function normalizeUsage(json: unknown): Usage | null {
  let body: unknown = json
  if (typeof body === 'object' && body !== null) {
    const envelope = (body as Record<string, unknown>).usage
    if (typeof envelope === 'object' && envelope !== null) body = envelope
  }
  if (typeof body !== 'object' || body === null) return null
  const raw = body as Record<string, unknown>
  const usage: Usage = { rolling: null, weekly: null, monthly: null }
  let usable = false
  for (const name of WINDOWS) {
    const window = parseWindow(raw[name])
    usage[name] = window
    if (window !== null) usable = true
  }
  return usable ? usage : null
}

/** A 401 body to a person-facing message: includes the body's `error.code` when it parses
 *  (`api_key_expired` gets the clearest wording) and a generic message for junk bodies. */
export function parseAuthError(body: unknown): string {
  let error: unknown
  try {
    const parsed: unknown = JSON.parse(typeof body === 'string' ? body : '')
    error =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>).error
        : undefined
  } catch {
    // A junk body (HTML, plain text, empty): fall through to the generic message.
  }
  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>
    const code = typeof e.code === 'string' ? e.code : ''
    const message = typeof e.message === 'string' ? e.message : ''
    if (code === 'api_key_expired')
      return 'The OpenCode Go API key expired. Add a new key in the Go Quota panel.'
    if (code) return `OpenCode Go rejected the key (${code}). Add a new key in the Go Quota panel.`
    if (message) return `OpenCode Go rejected the key: ${message}`
  }
  return 'OpenCode Go rejected the API key. Add a valid key in the Go Quota panel.'
}

/** Bar tone by the tightest window: neutral below 70, warning 70..89, danger 90 and up. */
export function toneFor(percent: number): BarTone {
  if (percent >= 90) return 'danger'
  if (percent >= 70) return 'warning'
  return 'neutral'
}

/** The status-bar item for a snapshot's usage: the max percent across available windows (the
 *  "will I be blocked" number), the tone it earns, and a tooltip that names every available
 *  window and the tightest one. All-unavailable answers the manifest default text `Go —`. */
export function statusFor(usage: Usage | null, fetchedAt: string | null = null): BarStatus {
  const available: { name: WindowName; window: UsageWindow }[] = []
  for (const name of WINDOWS) {
    const window = usage === null ? null : usage[name]
    if (window !== null) available.push({ name, window })
  }
  if (available.length === 0) {
    let tooltip = 'OpenCode Go quota — no data yet.'
    if (fetchedAt !== null && fetchedAt !== '') tooltip += ` Fetched ${fetchedAt}.`
    return { text: 'Go —', tone: 'neutral', tooltip }
  }
  const tightest = available.reduce((a, b) => (b.window.percent > a.window.percent ? b : a))
  const parts = available.map(({ name, window }) => `${name} ${window.percent}%`)
  let tooltip = `OpenCode Go — ${parts.join(' · ')}. Tightest window: ${tightest.name}.`
  if (fetchedAt !== null && fetchedAt !== '') tooltip += ` Fetched ${fetchedAt}.`
  return { text: `Go ${Math.round(tightest.window.percent)}%`, tone: toneFor(tightest.window.percent), tooltip }
}
