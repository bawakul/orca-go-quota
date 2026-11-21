// The Go Quota panel suite, run by `orca plugin test .`: the panel over a mockHost whose
// requests stand in for the worker (src/worker.test.ts covers the worker itself). No test
// uses a real key — every key literal below is fake, written only to the mock host's
// secret/settings stores, never logged, never leaked.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import { SECRET_NAME, SETTING_KEY } from './protocol.ts'
import type { QuotaSnapshot, Usage } from './protocol.ts'

const NOW = Date.now()

const usageOf = (over: Partial<Usage> = {}): Usage => ({
  // ~4.5 h out: comfortably "in 4h" even after the test's own milliseconds.
  rolling: { status: 'active', percent: 21, resetsAt: new Date(NOW + 4.5 * 3_600_000).toISOString() },
  weekly: { status: 'active', percent: 72, resetsAt: new Date(NOW + 30 * 3_600_000).toISOString() },
  monthly: { status: 'active', percent: 47, resetsAt: new Date(NOW + 8 * 86_400_000).toISOString() },
  ...over
})

const snapshotOf = (over: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
  usage: usageOf(),
  fetchedAt: new Date(NOW - 60_000).toISOString(),
  error: null,
  keySource: 'pi-auth',
  fetching: false,
  ...over
})

test('renders the three windows, the badge tones, the bars and the key source row', async () => {
  const host = mockHost({ requests: { 'quota.get': () => snapshotOf() } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Rolling' }))
  assert.ok(view.find({ text: 'Weekly' }))
  assert.ok(view.find({ text: 'Monthly' }))
  const rolling = view.find({ role: 'status', text: '21%' })
  assert.equal(rolling?.type, 'Badge')
  assert.equal(rolling?.props.tone, 'neutral')
  assert.equal(view.find({ role: 'status', text: '72%' })?.props.tone, 'warning')
  assert.equal(view.find({ role: 'status', text: '47%' })?.props.tone, 'neutral')
  // OQ-2: the plan's bar is the catalog's Progress, values 0..100 (Orca's own prop schema).
  assert.deepEqual(
    view.findAll({ type: 'Progress' }).map((bar) => bar.props.value),
    [21, 72, 47]
  )
  assert.match(view.find({ type: 'KeyValue' })?.text ?? '', /~\/\.pi\/agent\/auth\.json/)
  assert.equal(view.find({ type: 'EmptyState' }), null, 'there is a key, so no empty state')
  assert.equal(view.find({ text: 'Save key' }), null, 'and no save box')
  // Publish-readiness: every atom is memory-only, so nothing ever persists in any scope —
  // the snapshot (key source label included) must not outlive the panel run.
  assert.deepEqual(view.persisted.plugin, {}, 'no plugin-scoped atom ever persists')
  assert.deepEqual(view.persisted.workspace, {}, 'no workspace-scoped atom ever persists')
  assert.deepEqual(view.persisted.storage, {}, 'no storage-scoped atom ever persists')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('a window the payload did not carry renders unavailable; the others survive', async () => {
  const host = mockHost({ requests: { 'quota.get': () => snapshotOf({ usage: usageOf({ monthly: null }) }) } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'unavailable' }))
  assert.equal(view.findAll({ type: 'Progress' }).length, 2)
  assert.ok(view.find({ role: 'status', text: '21%' }))
  assert.ok(view.find({ role: 'status', text: '72%' }))
  await view.unmount()
})

test('OQ-1: a future reset reads as an "in …" time; the fetched stamp reads as ago', async () => {
  const host = mockHost({ requests: { 'quota.get': () => snapshotOf() } })
  const view = await mount(panel, { host })
  const times = view.findAll({ type: 'RelativeTime' }).map((element) => element.text)
  assert.equal(times.length, 4, 'three reset times and the fetched stamp')
  assert.match(times[0] ?? '', /in\s*4h/, 'rolling resets ~4.5 h out, short format')
  assert.match(times[3] ?? '', /ago/, 'the fetched stamp is a past reading')
  await view.unmount()
})

test('with no key: the empty state explains, and Save writes the encrypted secret, then refreshes', async () => {
  const snapshot = snapshotOf({ usage: null, fetchedAt: null, keySource: 'none' })
  const refreshes: number[] = []
  const host = mockHost({
    requests: {
      'quota.get': () => snapshot,
      'quota.refresh': () => {
        refreshes.push(1)
        return snapshot
      }
    }
  })
  const view = await mount(panel, { host })
  const empty = view.find({ type: 'EmptyState' })
  assert.match(empty?.text ?? '', /No OpenCode Go key yet/)
  await view.type({ type: 'Input' }, 'oc_sk_fake_panel_secret_key', { replace: true })
  await view.press({ text: 'Save key' })
  assert.equal(host.data().secrets[SECRET_NAME], 'oc_sk_fake_panel_secret_key')
  assert.equal(refreshes.length, 1, 'saving asks the worker for a live fetch')
  assert.equal(view.valueOf({ type: 'Input' }), '', 'the draft key never stays in the input')
  assert.ok(view.find({ text: /encrypted secret store/ }), 'the note names where the key went')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('when Orca has no OS key store, Save falls back to the apiKey setting and says so', async () => {
  const snapshot = snapshotOf({ usage: null, fetchedAt: null, keySource: 'none' })
  const host = mockHost({
    requests: { 'quota.get': () => snapshot, 'quota.refresh': () => snapshot },
    results: { 'secrets.protection': { status: 'unavailable' } }
  })
  const view = await mount(panel, { host })
  await view.type({ type: 'Input' }, 'oc_sk_fake_fallback_key', { replace: true })
  await view.press({ text: 'Save key' })
  assert.equal(host.data().secrets[SECRET_NAME], undefined, 'the secret store was skipped')
  assert.equal(host.data().settings[SETTING_KEY], 'oc_sk_fake_fallback_key')
  assert.ok(view.find({ text: /apiKey setting/ }), 'the note names the fallback')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('an auth error: a danger callout, the cached data still on show, and the save box', async () => {
  const snapshot = snapshotOf({
    error: { kind: 'auth', message: 'The OpenCode Go API key expired. Add a new key in the Go Quota panel.' }
  })
  const host = mockHost({ requests: { 'quota.get': () => snapshot } })
  const view = await mount(panel, { host })
  const callout = view.find({ type: 'Callout' })
  assert.equal(callout?.props.tone, 'danger')
  assert.match(callout?.text ?? '', /Bad key/)
  assert.match(callout?.text ?? '', /expired/i)
  assert.match(callout?.text ?? '', /cached data/)
  assert.ok(view.find({ role: 'status', text: '21%' }), 'the cached windows stay on show')
  assert.equal(view.find({ type: 'EmptyState' }), null, 'there is data, so no empty state')
  assert.ok(view.find({ text: 'Save key' }), 'the save box offers a replacement key')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('a network error: a warning callout with the cached data, and no save box', async () => {
  const snapshot = snapshotOf({ error: { kind: 'network', message: 'Could not reach OpenCode Go: fetch failed.' } })
  const host = mockHost({ requests: { 'quota.get': () => snapshot } })
  const view = await mount(panel, { host })
  const callout = view.find({ type: 'Callout' })
  assert.equal(callout?.props.tone, 'warning')
  assert.match(callout?.text ?? '', /Offline/)
  assert.match(callout?.text ?? '', /cached data/)
  assert.equal(view.find({ text: 'Save key' }), null, 'the key is fine; no save box')
  await view.unmount()
})

test('quota.changed re-renders without a remount; the refresh button asks the worker', async () => {
  const snapshot = snapshotOf()
  const refreshes: number[] = []
  const host = mockHost({
    requests: {
      'quota.get': () => snapshot,
      'quota.refresh': () => {
        refreshes.push(1)
        return snapshot
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: 'Refresh quota' })
  assert.equal(refreshes.length, 1)
  assert.equal(view.find({ role: 'status', text: '21%' })?.props.tone, 'neutral')
  const next = snapshotOf({
    usage: usageOf({
      rolling: { status: 'active', percent: 95, resetsAt: new Date(NOW + 3_600_000).toISOString() },
      weekly: null
    }),
    keySource: 'secret'
  })
  await view.post('quota.changed', next)
  assert.equal(view.find({ role: 'status', text: '95%' })?.props.tone, 'danger')
  assert.ok(view.find({ text: 'unavailable' }), 'weekly dropped out of the new snapshot')
  assert.match(view.find({ type: 'KeyValue' })?.text ?? '', /Orca secret/)
  assert.equal(view.find({ role: 'status', text: '72%' }), null, 'and its old badge is gone')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
