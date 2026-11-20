// The panel <-> worker contract, declared once: src/worker.ts, src/panel.tsx and tests all read
// it, and the declaration merging below is what types `plugin.request` and `orca.panels`.

/** The quota windows the OpenCode Go endpoint reports. */
export type WindowName = 'rolling' | 'weekly' | 'monthly'

/** One quota window as the endpoint reports it; `resetsAt` is an ISO timestamp. */
export type UsageWindow = { status: string; percent: number; resetsAt: string }

/** Every window, in the endpoint's own terms; null marks a window the payload did not carry. */
export type Usage = Record<WindowName, UsageWindow | null>

/** Where the key the worker used came from, so the panel can say so honestly. */
export type KeySource = 'secret' | 'setting' | 'pi-auth' | 'opencode-auth' | 'none'

/** The last failed fetch. Auth errors persist in the cache so the bar does not flash good data. */
export type QuotaError = { kind: 'auth' | 'network' | 'shape'; message: string }

/** Everything a panel or the status bar needs, whether it came from the cache or a live fetch. */
export type QuotaSnapshot = {
  /** Last good data, possibly served from the cache. */
  usage: Usage | null
  /** ISO timestamp of the last successful fetch. */
  fetchedAt: string | null
  /** The last failed fetch, auth errors included; null while healthy. */
  error: QuotaError | null
  /** Which key source the last fetch (or lookup) used. */
  keySource: KeySource
  /** True while a live fetch is in flight. */
  fetching: boolean
}

declare module 'orca' {
  interface PluginRequests {
    /** Cache-first; fetches live when the cache is stale. */
    'quota.get': { output: QuotaSnapshot }
    /** Forces a live fetch, bypassing the staleness and gap guards. */
    'quota.refresh': { input: {}; output: QuotaSnapshot }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after every fetch outcome, success or failure. */
    'quota.changed': QuotaSnapshot
  }
}
