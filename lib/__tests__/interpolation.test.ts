import test from "node:test"
import assert from "node:assert/strict"
import { interpolateControlPoints } from "reze-engine"
import { splitInterpolationPair, splitInterpolation, VMD_LINEAR_DEFAULT_IP } from "../utils"

/**
 * Curves whose value climbs from its start to its end without leaving that
 * range — every easing MMD authors, and every preset the editor offers except
 * "Over". These can be cut exactly.
 */
const MONOTONIC: [number, number, number, number][] = [
  [20, 20, 107, 107], // Linear
  [64, 0, 107, 107], // In
  [20, 20, 64, 127], // Out
  [64, 0, 64, 127], // InOut
  [100, 0, 27, 127], // Slow In
  [20, 20, 27, 127], // Slow Out
  [100, 0, 27, 127], // Slow IO
  [5, 90, 120, 40], // arbitrary, still monotonic
]

/**
 * Curves that leave that range — the "Over" preset, and an S so steep the half
 * of it needs handles past the end of the byte.
 *
 * These CANNOT be cut exactly, and the limit is the file format rather than
 * the arithmetic: a cubic is trapped inside the convex hull of its control
 * points, so with both handles capped at 127 no VMD curve can rise above its
 * own endpoint. Half of a curve that overshoots has to do exactly that. The
 * split gets as close as the box allows and the test holds it to that.
 */
const UNREPRESENTABLE: [number, number, number, number][] = [
  [0, 127, 127, 0], // "Over"
  [110, 10, 15, 118],
]

const PAIRS = [...MONOTONIC, ...UNREPRESENTABLE]

const pair = (p: [number, number, number, number]) => [
  { x: p[0], y: p[1] },
  { x: p[2], y: p[3] },
]

/** Worst gap between the original curve and its two halves played in sequence. */
function splitError(p: [number, number, number, number]): number {
  const cp = pair(p)
  let worst = 0
  for (let ti = 1; ti < 20; ti++) {
    const t = ti / 20
    const cut = interpolateControlPoints(cp, t)
    if (cut <= 1e-6 || cut >= 1 - 1e-6) continue
    const { left, right } = splitInterpolationPair(cp, t)
    for (let ui = 0; ui <= 100; ui++) {
      const u = ui / 100
      const expected = interpolateControlPoints(cp, u)
      const actual =
        u <= t
          ? interpolateControlPoints(left, u / t) * cut
          : cut + interpolateControlPoints(right, (u - t) / (1 - t)) * (1 - cut)
      worst = Math.max(worst, Math.abs(expected - actual))
    }
  }
  return worst
}

/**
 * The property the bake depends on: cutting a segment and playing the two
 * halves reproduces the pose the original produced, at every frame inside it.
 *
 * The tolerance is the format's, not the arithmetic's — handles are bytes, so
 * a renormalised half lands on the nearest 1/127. 0.01 of the eased parameter
 * is a fraction of a degree on a typical rotation.
 */
test("a monotonic curve survives being cut anywhere", () => {
  for (const p of MONOTONIC) {
    const err = splitError(p)
    assert.ok(err < 0.01, `[${p}] was off by ${err}`)
  }
})

test("an overshooting curve gets as close as the byte box allows", () => {
  for (const p of UNREPRESENTABLE) {
    const err = splitError(p)
    // Well under the gap left by copying a neighbour's handles, and bounded —
    // if this ever climbs, the refit stopped finding the best available curve.
    assert.ok(err < 0.09, `[${p}] was off by ${err}`)
  }
})

test("every shape is closer than copying the neighbour's handles would be", () => {
  for (const p of PAIRS) {
    const cp = pair(p)
    let naive = 0
    for (let ti = 1; ti < 20; ti++) {
      const t = ti / 20
      const cut = interpolateControlPoints(cp, t)
      if (cut <= 1e-6 || cut >= 1 - 1e-6) continue
      for (let ui = 0; ui <= 100; ui++) {
        const u = ui / 100
        const expected = interpolateControlPoints(cp, u)
        const actual =
          u <= t
            ? interpolateControlPoints(cp, u / t) * cut
            : cut + interpolateControlPoints(cp, (u - t) / (1 - t)) * (1 - cut)
        naive = Math.max(naive, Math.abs(expected - actual))
      }
    }
    // Never worse. A linear curve is the one shape where copying is already
    // right, and there the two tie inside the evaluator's own search noise.
    assert.ok(splitError(p) <= naive + 1e-3, `[${p}] split ${splitError(p)} vs copied ${naive}`)
  }
})

/** The thing this exists instead of: inheriting a neighbour's handles. If this
 *  ever stops being much worse, the split is not doing anything. */
test("copying the handles instead would visibly drift", () => {
  let worst = 0
  for (const p of MONOTONIC) {
    const cp = pair(p)
    for (let ti = 1; ti < 20; ti++) {
      const t = ti / 20
      const cut = interpolateControlPoints(cp, t)
      if (cut <= 1e-6 || cut >= 1 - 1e-6) continue
      for (let ui = 0; ui <= 100; ui++) {
        const u = ui / 100
        const expected = interpolateControlPoints(cp, u)
        const actual =
          u <= t
            ? interpolateControlPoints(cp, u / t) * cut
            : cut + interpolateControlPoints(cp, (u - t) / (1 - t)) * (1 - cut)
        worst = Math.max(worst, Math.abs(expected - actual))
      }
    }
  }
  assert.ok(worst > 0.05, `copying handles was only off by ${worst}`)
})

test("splitting a linear curve leaves it linear", () => {
  const { left, right } = splitInterpolationPair(pair([20, 20, 107, 107]), 0.5)
  for (const half of [left, right]) {
    assert.ok(Math.abs(half[0].x - half[0].y) <= 1, `${half[0].x} vs ${half[0].y}`)
    assert.ok(Math.abs(half[1].x - half[1].y) <= 1, `${half[1].x} vs ${half[1].y}`)
  }
})

test("a cut at either end falls back to linear rather than dividing by zero", () => {
  for (const t of [0, 1, -0.5, 1.5, Number.NaN]) {
    const { left, right } = splitInterpolationPair(pair([64, 0, 64, 127]), t)
    for (const half of [left, right]) {
      assert.deepEqual(half, [
        { x: 20, y: 20 },
        { x: 107, y: 107 },
      ])
    }
  }
})

test("every handle stays inside the byte range the format stores", () => {
  for (const p of PAIRS) {
    for (let ti = 1; ti < 20; ti++) {
      const { left, right } = splitInterpolationPair(pair(p), ti / 20)
      for (const half of [left, right]) {
        for (const cp of half) {
          assert.ok(Number.isInteger(cp.x) && cp.x >= 0 && cp.x <= 127, `x=${cp.x}`)
          assert.ok(Number.isInteger(cp.y) && cp.y >= 0 && cp.y <= 127, `y=${cp.y}`)
        }
      }
    }
  }
})

test("all four channels split independently", () => {
  const ip = {
    rotation: pair([64, 0, 107, 107]),
    translationX: pair([20, 20, 64, 127]),
    translationY: pair([100, 0, 27, 127]),
    translationZ: pair([20, 20, 107, 107]),
  }
  const { left, right } = splitInterpolation(ip, 0.5)
  // The linear channel stays linear while the eased ones do not — proof the
  // channels are not sharing one result.
  assert.ok(Math.abs(left.translationZ[0].x - left.translationZ[0].y) <= 1)
  assert.notDeepEqual(left.rotation, right.rotation)
  assert.equal(Object.keys(left).length, Object.keys(VMD_LINEAR_DEFAULT_IP).length)
})
