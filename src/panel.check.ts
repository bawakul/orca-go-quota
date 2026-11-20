// `orca plugin check` renders the panel once per scenario, with the plugin's real worker on
// the same fresh host; `orca plugin shot . --scenario <name>` saves each as a PNG. The
// worker's boot fetch is still in flight when the render is captured, so each scenario
// shows exactly the seeded cache: no key, healthy data, and a rejected key with the cached
// numbers. The reset times are seeded in the future so the shots also show how RelativeTime
// reads a "resets in …" time (plan OQ-1).
import { defineCheck } from 'orca/testing'

const usage = {
  rolling: { status: 'active', percent: 21, resetsAt: new Date(Date.now() + 45 * 60_000).toISOString() },
  weekly: { status: 'active', percent: 72, resetsAt: new Date(Date.now() + 30 * 3_600_000).toISOString() },
  monthly: { status: 'active', percent: 47, resetsAt: new Date(Date.now() + 8 * 86_400_000).toISOString() }
}
const fetchedAt = new Date(Date.now() - 3 * 60_000).toISOString()

export default defineCheck({
  fresh: {},
  ok: { storage: { quota: { v: 1, usage, fetchedAt, error: null, keySource: 'pi-auth' } } },
  authError: {
    storage: {
      quota: {
        v: 1,
        usage,
        fetchedAt,
        error: { kind: 'auth', message: 'The OpenCode Go API key expired. Add a new key in the Go Quota panel.' },
        keySource: 'setting'
      }
    }
  }
})
