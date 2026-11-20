// The Go Quota panel (plan D5): one snapshot in, one panel out. It asks the worker
// (quota.get), re-renders on every quota.changed, and refreshes on demand. The Save-key box
// writes straight into Orca's encrypted secret store from the panel — falling back to the
// plugin's apiKey setting where Orca reports no OS key store — then asks the worker for a
// live fetch. The key value lives only in this panel run's memory atoms: never persisted,
// never logged, never posted anywhere.
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Field,
  Heading,
  IconButton,
  Input,
  KeyValue,
  Progress,
  RelativeTime,
  Row,
  Separator,
  Stack,
  Text,
  atom,
  host,
  plugin,
  read,
  secrets,
  settings,
  set,
  type PanelContext
} from 'orca'
import {
  SECRET_NAME,
  SETTING_KEY,
  SOURCE_LABELS,
  type QuotaError,
  type QuotaSnapshot,
  type UsageWindow,
  type WindowName
} from './protocol.ts'
import { toneFor } from './usage.ts'

const WINDOWS: readonly { name: WindowName; title: string }[] = [
  { name: 'rolling', title: 'Rolling' },
  { name: 'weekly', title: 'Weekly' },
  { name: 'monthly', title: 'Monthly' }
]

/** The last snapshot the worker answered or posted; null until the first answer lands. */
const snap = atom<QuotaSnapshot | null>(null)
/** What the API-key input holds. Memory only: never persisted, and it goes nowhere except
 *  the secret or settings store the Save button writes it to. */
const draftKey = atom('')
/** True while Save is storing a key. */
const saving = atom(false)
/** The note under the Save button after a save attempt; null before the first one. */
const saveNote = atom<string | null>(null)

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('quota.changed', (payload) => set(snap, payload)))
  void plugin
    .request('quota.get')
    .then((answer) => set(snap, answer))
    .catch(() => {})
}

/** Manual refresh: the answer is the fresh snapshot; quota.changed carries it to every
 *  open panel besides. */
async function refreshNow(): Promise<void> {
  try {
    set(snap, await plugin.request('quota.refresh', {}))
  } catch {
    // The worker logs its own failures; the next quota.changed still re-renders the panel.
  }
}

/** Save flow (plan D1): the encrypted Orca secret first; when Orca reports no OS key store
 *  (`secrets.protection: 'unavailable'`) or the write itself fails, the apiKey setting is
 *  the fallback — plain text, but it works everywhere. Then one live refresh, key in place. */
async function saveKey(): Promise<void> {
  const value = read(draftKey).trim()
  if (value === '' || read(saving)) return
  set(saving, true)
  let savedTo: 'secret' | 'setting' | null = null
  let secretUsable = true
  try {
    secretUsable = (await host.call('secrets.protection')).status !== 'unavailable'
  } catch {
    // The protection status is unknown; try the secret anyway.
  }
  if (secretUsable) {
    try {
      await secrets.set(SECRET_NAME, value)
      savedTo = 'secret'
    } catch {
      // Fall back to the setting below.
    }
  }
  if (savedTo === null) {
    try {
      await settings.set(SETTING_KEY, value)
      savedTo = 'setting'
    } catch {
      // The note below says the save failed.
    }
  }
  set(saving, false)
  set(draftKey, '')
  set(
    saveNote,
    savedTo === 'secret'
      ? 'Key saved to Orca’s encrypted secret store.'
      : savedTo === 'setting'
        ? 'Saved to the plugin’s apiKey setting — Orca’s secret store is unavailable here, so it is not encrypted.'
        : 'Could not save the key. Try Settings → Plugins → Go Quota instead.'
  )
  if (savedTo !== null) void refreshNow()
}

/** One quota window: the percent badge in the shared threshold tone, the bar, the reset
 *  time. A window the payload did not carry renders "unavailable" and sinks nothing else. */
function WindowRow({ title, window }: { title: string; window: UsageWindow | null }) {
  if (window === null) {
    return (
      <Row justify="between">
        <Text>{title}</Text>
        <Text muted>unavailable</Text>
      </Row>
    )
  }
  const resetsAt = Date.parse(window.resetsAt)
  return (
    <Stack gap="xs">
      <Row justify="between">
        <Text>{title}</Text>
        <Badge tone={toneFor(window.percent)}>{`${Math.round(window.percent)}%`}</Badge>
      </Row>
      <Progress label={`${title} window used`} labelHidden value={window.percent} />
      <Text muted size="xs">
        resets{' '}
        {Number.isFinite(resetsAt) ? <RelativeTime at={resetsAt} format="short" /> : 'at an unknown time'}
      </Text>
    </Stack>
  )
}

/** The last failed fetch: danger for a rejected key, warning for anything else, with the
 *  cached-data note whenever usage is still on show below it. */
function ErrorCallout({ error, cached }: { error: QuotaError; cached: boolean }) {
  const title = error.kind === 'auth' ? 'Bad key' : error.kind === 'network' ? 'Offline' : 'Unexpected reply'
  return (
    <Callout tone={error.kind === 'auth' ? 'danger' : 'warning'} title={title}>
      <Text size="sm">{error.message}</Text>
      {cached ? (
        <Text muted size="xs">
          Showing the cached data below until a fetch succeeds.
        </Text>
      ) : null}
    </Callout>
  )
}

/** The paste-a-key box, shared by the no-key state and the rejected-key state. */
function SaveKeyBox({ lead }: { lead: string }) {
  return (
    <Stack gap="sm">
      <Text muted size="sm">{lead}</Text>
      <Field label="API key">
        <Input
          label="API key"
          labelHidden
          type="password"
          placeholder="oc_sk_…"
          value={read(draftKey)}
          onChange={(value) => set(draftKey, value)}
          onSubmit={saveKey}
        />
      </Field>
      <Row>
        <Button onPress={saveKey} disabled={read(saving) || read(draftKey).trim() === ''}>
          Save key
        </Button>
      </Row>
      {read(saveNote) !== null ? <Text muted size="xs">{read(saveNote)}</Text> : null}
    </Stack>
  )
}

export default function Panel() {
  const snapshot = read(snap)
  if (snapshot === null) {
    return (
      <Stack gap="md">
        <Row justify="between">
          <Heading level={2}>OpenCode Go</Heading>
        </Row>
        <Text muted>Waiting for the Go Quota worker…</Text>
      </Stack>
    )
  }
  const fetchedAt = snapshot.fetchedAt !== null ? Date.parse(snapshot.fetchedAt) : Number.NaN
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading level={2}>OpenCode Go</Heading>
        <IconButton icon="refresh" label="Refresh quota" disabled={snapshot.fetching} onPress={refreshNow} />
      </Row>
      {snapshot.error !== null ? <ErrorCallout error={snapshot.error} cached={snapshot.usage !== null} /> : null}
      {WINDOWS.map(({ name, title }) => (
        <WindowRow key={name} title={title} window={snapshot.usage !== null ? snapshot.usage[name] : null} />
      ))}
      <Separator />
      <KeyValue items={[{ label: 'Key', value: SOURCE_LABELS[snapshot.keySource] }]} />
      {snapshot.keySource === 'none' ? (
        <EmptyState icon="plug" title="No OpenCode Go key yet">
          <SaveKeyBox lead="Paste your OpenCode Go API key to see your quota here. The worker also looks for keys in ~/.pi/agent/auth.json and the OpenCode CLI auth file." />
        </EmptyState>
      ) : snapshot.error?.kind === 'auth' ? (
        <SaveKeyBox lead="Paste a new key to replace the rejected one." />
      ) : null}
      <Text muted size="xs">
        One endpoint: opencode.ai/zen/go/v1/usage · fetched{' '}
        {Number.isFinite(fetchedAt) ? <RelativeTime at={fetchedAt} format="short" /> : 'never'}
      </Text>
    </Stack>
  )
}
