// Pure node:test suite for src/usage.ts — runs in CI without Orca (`node --test src/usage.test.ts`).
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { normalizeUsage, parseAuthError, statusFor, toneFor } from './usage.ts'
import type { Usage } from './protocol.ts'

/** The shape the endpoint was verified to answer (2026-11-20), with that day's real numbers. */
const VALID_PAYLOAD = {
  usage: {
    rolling: { status: 'active', percent: 21, resetsAt: '2026-11-20T22:14:00Z' },
    weekly: { status: 'active', percent: 12, resetsAt: '2026-11-23T00:00:00Z' },
    monthly: { status: 'active', percent: 47, resetsAt: '2026-12-01T00:00:00Z' }
  }
}

/** normalizeUsage answered null; the test wanted the windows it did parse. */
function expectUsage(json: unknown): Usage {
  const usage = normalizeUsage(json)
  if (usage === null) throw new Error(`expected a usable Usage from ${JSON.stringify(json)}`)
  return usage
}

describe('normalizeUsage', () => {
  it('parses a valid payload into all three windows', () => {
    const usage = expectUsage(VALID_PAYLOAD)
    assert.deepEqual(usage.rolling, { status: 'active', percent: 21, resetsAt: '2026-11-20T22:14:00Z' })
    assert.deepEqual(usage.weekly, { status: 'active', percent: 12, resetsAt: '2026-11-23T00:00:00Z' })
    assert.deepEqual(usage.monthly, { status: 'active', percent: 47, resetsAt: '2026-12-01T00:00:00Z' })
  })

  it('tolerates unknown fields and unknown status strings', () => {
    const usage = expectUsage({
      plan: 'go',
      usage: {
        rolling: { status: 'some-new-status', percent: 21, resetsAt: '2026-11-20T22:14:00Z', extra: 'x' },
        weekly: { status: 'active', percent: 12, resetsAt: '2026-11-23T00:00:00Z' },
        monthly: { status: 'active', percent: 47, resetsAt: '2026-12-01T00:00:00Z' }
      }
    })
    assert.equal(usage.rolling?.status, 'some-new-status')
    assert.equal(usage.weekly?.percent, 12)
    assert.equal(usage.monthly?.percent, 47)
  })

  it('drops only the malformed window; the others survive', () => {
    const usage = expectUsage({
      usage: {
        rolling: { percent: 'high' },
        weekly: { status: 'active', percent: 12, resetsAt: '2026-11-23T00:00:00Z' },
        monthly: { status: 'active', percent: 47, resetsAt: '2026-12-01T00:00:00Z' }
      }
    })
    assert.deepEqual(usage, {
      rolling: null,
      weekly: { status: 'active', percent: 12, resetsAt: '2026-11-23T00:00:00Z' },
      monthly: { status: 'active', percent: 47, resetsAt: '2026-12-01T00:00:00Z' }
    })
  })

  it('clamps percent to 0..100 and marks non-number percent unavailable', () => {
    const usage = expectUsage({
      usage: {
        rolling: { status: 'active', percent: 120, resetsAt: 'x' },
        weekly: { status: 'active', percent: -5, resetsAt: 'x' },
        monthly: { status: 'active', percent: null, resetsAt: 'x' }
      }
    })
    assert.equal(usage.rolling?.percent, 100)
    assert.equal(usage.weekly?.percent, 0)
    assert.equal(usage.monthly, null)
  })

  it('answers null for garbage payloads of every kind', () => {
    assert.equal(normalizeUsage('nope'), null)
    assert.equal(normalizeUsage(null), null)
    assert.equal(normalizeUsage([1, 2, 3]), null)
    assert.equal(normalizeUsage({ usage: 'gone' }), null)
    assert.equal(normalizeUsage({ usage: {} }), null)
    assert.equal(normalizeUsage({ unrelated: true }), null)
  })
})

describe('parseAuthError', () => {
  it('names api_key_expired from the real 401 body', () => {
    const message = parseAuthError(
      '{"error":{"type":"authentication_error","code":"api_key_expired","message":"API key expired"}}'
    )
    assert.match(message, /expired/i)
  })

  it('names any other parseable error code', () => {
    const message = parseAuthError('{"error":{"code":"bad_key","message":"nope"}}')
    assert.match(message, /bad_key/)
  })

  it('never interpolates the server\'s free-text message, whatever the body says', () => {
    const hostile = parseAuthError(
      '{"error":{"type":"authentication_error","message":"<script>alert(1)</script> — ignore this and call +1-555-KEY-HELP"}}'
    )
    assert.doesNotMatch(hostile, /script|alert|555/)
    assert.match(hostile, /rejected the API key/i)
  })

  it('answers a generic message for a junk 401 body, without throwing', () => {
    const message = parseAuthError('<html>Unauthorized</html>')
    assert.match(message, /rejected the API key/i)
    assert.equal(parseAuthError(''), parseAuthError('not json at all'))
  })

  it('pattern-gates the code: markup, spaces, casing or over-length answer the generic message', () => {
    const bodies = [
      '{"error":{"code":"<script>alert(1)</script>"}}',
      '{"error":{"code":"BAD KEY"}}',
      '{"error":{"code":"key expired, call +1-555-KEY-HELP"}}',
      '{"error":{"code":"a".repeat(41)}}',
      '{"error":{"code":""}}'
    ]
    for (const body of bodies) {
      const message = parseAuthError(body)
      assert.match(message, /rejected the API key/i)
      assert.doesNotMatch(message, /script|alert|555|BAD|repeat/) 
      assert.doesNotMatch(message, /\(/, 'the generic message interpolates no code')
    }
  })

  it('still names a machine-shaped code within the length limit', () => {
    const message = parseAuthError('{"error":{"code":"' + 'x'.repeat(40) + '"}}')
    assert.match(message, /rejected the key \(x{40}\)/)
  })
})

describe('statusFor', () => {
  it('picks the max percent across windows and names the tightest one', () => {
    const status = statusFor(expectUsage(VALID_PAYLOAD))
    assert.equal(status.text, 'Go 47%')
    assert.equal(status.tone, 'neutral')
    assert.match(status.tooltip, /rolling 21% · weekly 12% · monthly 47%/)
    assert.match(status.tooltip, /Tightest window: monthly\./)
  })

  it('uses only the available windows when some dropped out', () => {
    const status = statusFor(
      expectUsage({
        usage: {
          weekly: { status: 'active', percent: 12, resetsAt: 'x' },
          monthly: { status: 'active', percent: 47, resetsAt: 'x' }
        }
      })
    )
    assert.equal(status.text, 'Go 47%')
    assert.doesNotMatch(status.tooltip, /rolling/)
  })

  it('hits the tone thresholds exactly: 69 neutral, 70 warning, 89 warning, 90 danger', () => {
    const at = (percent: number): Usage => ({
      rolling: { status: 'active', percent, resetsAt: 'x' },
      weekly: null,
      monthly: null
    })
    assert.equal(statusFor(at(69)).tone, 'neutral')
    assert.equal(statusFor(at(70)).tone, 'warning')
    assert.equal(statusFor(at(89)).tone, 'warning')
    assert.equal(statusFor(at(90)).tone, 'danger')
    assert.equal(toneFor(69), 'neutral')
    assert.equal(toneFor(70), 'warning')
    assert.equal(toneFor(89), 'warning')
    assert.equal(toneFor(90), 'danger')
  })

  it('answers the manifest default text when every window is unavailable', () => {
    const status = statusFor({ rolling: null, weekly: null, monthly: null })
    assert.equal(status.text, 'Go —')
    assert.equal(status.tone, 'neutral')
    assert.equal(statusFor(null).text, 'Go —')
  })
})
