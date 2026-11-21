// Generates images/icon.png — the Go Quota gauge — with zero dependencies: shapes are
// rasterized by supersampling (4x4 subsamples per pixel, analytic coverage tests) and the
// PNG is encoded by hand (IHDR/IDAT/IEND + a table CRC32; Node's builtin zlib does the
// deflate). Run: node scripts/make-icon.mjs
//
// Design: a flat, high-contrast semicircular gauge on a rounded-square background —
// a slate track, a bright mint arc at ~62% sweep, a near-white needle and pivot disc.
// Solid colors, no gradients, so the glyph still reads at 16–32 px and in dark and light
// themes alike. Swap the constants below to re-tune; re-run to regenerate.

import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const SIZE = 256
const SUB = 4 // 4x4 subsamples per pixel -> 16x supersampling
const OUT = 'images/icon.png'

// Geometry (in 256-space).
const PIVOT = { x: 128, y: 170 }
const RADIUS = 80 // gauge arc centerline
const STROKE = 9 // half stroke width; the annulus is RADIUS ± STROKE
const SWEEP = 0.62 // fraction of the semicircle the bright arc covers
const NEEDLE_TIP = 60 // needle length from the pivot
const NEEDLE_BASE_W = 7 // half width at the pivot
const NEEDLE_TIP_W = 3.5 // half width at the tip
const CORNER = 60 // rounded-square corner radius, full-bleed

// Palette: flat, high contrast on dark and light hosts alike.
const BG = [30, 42, 56] // #1e2a38 — dark slate
const TRACK = [74, 85, 104] // #4a5568 — muted slate
const ARC = [57, 217, 138] // #39d98a — bright mint
const NEEDLE = [242, 246, 250] // #f2f6fa — near white
const DISC = 12 // pivot disc radius
const NEEDLE_ANGLE = 180 * (1 - SWEEP) // degrees, math convention (y up)

const rad = (deg) => (deg * Math.PI) / 180
const needleDir = { x: Math.cos(rad(NEEDLE_ANGLE)), y: -Math.sin(rad(NEEDLE_ANGLE)) }
const tip = { x: PIVOT.x + NEEDLE_TIP * needleDir.x, y: PIVOT.y + NEEDLE_TIP * needleDir.y }
const perp = { x: -needleDir.y, y: needleDir.x }
// The needle as a convex quad; point-in-polygon by cross products. This quad winds so an
// inside point makes every edge cross negative (screen coords), so `> 0` means outside.
const NEEDLE_QUAD = [
  { x: PIVOT.x + NEEDLE_BASE_W * perp.x, y: PIVOT.y + NEEDLE_BASE_W * perp.y },
  { x: tip.x + NEEDLE_TIP_W * perp.x, y: tip.y + NEEDLE_TIP_W * perp.y },
  { x: tip.x - NEEDLE_TIP_W * perp.x, y: tip.y - NEEDLE_TIP_W * perp.y },
  { x: PIVOT.x - NEEDLE_BASE_W * perp.x, y: PIVOT.y - NEEDLE_BASE_W * perp.y }
]

/** Inside the rounded square: within the box, and within `CORNER` of every corner centre. */
function inBackground(x, y) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return false
  const cx = Math.min(Math.max(x, CORNER), SIZE - CORNER)
  const cy = Math.min(Math.max(y, CORNER), SIZE - CORNER)
  return (x - cx) ** 2 + (y - cy) ** 2 <= CORNER * CORNER
}

/** Inside the semicircular annulus (upper half in screen space). */
function inArc(x, y) {
  const dx = x - PIVOT.x
  const dy = y - PIVOT.y
  if (dy > 0) return false // the semicircle lives above the pivot line
  const dist2 = dx * dx + dy * dy
  return dist2 <= (RADIUS + STROKE) ** 2 && dist2 >= (RADIUS - STROKE) ** 2
}

/** Inside the bright arc's sweep: from the far left (180°) down to the needle angle. */
function inActiveArc(x, y) {
  if (!inArc(x, y)) return false
  const angle = (Math.atan2(-(y - PIVOT.y), x - PIVOT.x) * 180) / Math.PI
  return angle >= NEEDLE_ANGLE && angle <= 180
}

function inNeedle(x, y) {
  for (let i = 0; i < NEEDLE_QUAD.length; i++) {
    const a = NEEDLE_QUAD[i]
    const b = NEEDLE_QUAD[(i + 1) % NEEDLE_QUAD.length]
    if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) > 0) return false
  }
  return true
}

function inDisc(x, y) {
  return (x - PIVOT.x) ** 2 + (y - PIVOT.y) ** 2 <= DISC * DISC
}

/** The topmost shape at a point, back to front. */
function shade(x, y) {
  if (!inBackground(x, y)) return [0, 0, 0, 0]
  if (inDisc(x, y)) return [...NEEDLE, 255]
  if (inNeedle(x, y)) return [...NEEDLE, 255]
  if (inActiveArc(x, y)) return [...ARC, 255]
  if (inArc(x, y)) return [...TRACK, 255]
  return [...BG, 255]
}

// Rasterize with supersampling: 4x4 subsamples per pixel, averaged.
const raw = new Uint8Array(SIZE * SIZE * 4)
for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    for (let sy = 0; sy < SUB; sy++) {
      for (let sx = 0; sx < SUB; sx++) {
        const c = shade(px + (sx + 0.5) / SUB, py + (sy + 0.5) / SUB)
        r += c[0] * c[3]
        g += c[1] * c[3]
        b += c[2] * c[3]
        a += c[3]
      }
    }
    const n = SUB * SUB
    const at = (py * SIZE + px) * 4
    raw[at] = a === 0 ? 0 : Math.round(r / a)
    raw[at + 1] = a === 0 ? 0 : Math.round(g / a)
    raw[at + 2] = a === 0 ? 0 : Math.round(b / a)
    raw[at + 3] = Math.round(a / n)
  }
}

// --- Hand-rolled PNG encoder: 8-bit RGBA, filter 0, one IDAT, zlib (builtin) deflate. ---

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length)
  return out
}

// Scanlines with a leading filter byte (type 0 = none).
const scanlines = Buffer.alloc(SIZE * (1 + SIZE * 4))
for (let y = 0; y < SIZE; y++) {
  scanlines[y * (1 + SIZE * 4)] = 0
  raw.subarray(y * SIZE * 4, (y + 1) * SIZE * 4).forEach((v, i) => {
    scanlines[y * (1 + SIZE * 4) + 1 + i] = v
  })
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(scanlines, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

writeFileSync(OUT, png)
console.log(`wrote ${OUT}: ${SIZE}x${SIZE}, ${png.length} bytes`)
