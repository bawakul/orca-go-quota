// TEMPLATE BRIDGE — delete this file in M2/M3, when src/worker.ts and src/panel.tsx are
// replaced by the Go Quota implementations. Until then the template's counter handlers in
// those files (and their tests in worker.test.ts / panel.test.tsx / panel.check.ts) need the
// counter requests and events declared here to keep `npx tsc -p .` clean. Go Quota's own
// contract lives in src/protocol.ts and is already final.

export {}

declare module 'orca' {
  interface PluginRequests {
    /** The total the worker keeps in storage. */
    'counter.get': { output: { total: number } }
    /** Adds `by` to the stored total and answers the new total. */
    'counter.add': { input: { by: number }; output: { total: number } }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after the total changes. */
    'counter.changed': { total: number }
  }
}
