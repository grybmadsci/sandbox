// Deterministic 2D value noise: integer hashing and polynomial blending only, so a seed
// generates the same world on every machine.

function hash(seed: number, x: number, y: number) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

/** A hash of the seed and an integer point, in [0, 1). */
export const hashUnit = (seed: number, x: number, y: number) => hash(seed, x, y) / 4294967296

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

/** Smooth noise in [0, 1], with features about one unit across. */
export function noise2(seed: number, x: number, y: number) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const u = fade(x - x0)
  const v = fade(y - y0)
  return lerp(
    lerp(hashUnit(seed, x0, y0), hashUnit(seed, x0 + 1, y0), u),
    lerp(hashUnit(seed, x0, y0 + 1), hashUnit(seed, x0 + 1, y0 + 1), u),
    v,
  )
}

/** `octaves` layers of noise, each half the size and height of the one before, in [0, 1]. */
export function fbm(seed: number, x: number, y: number, octaves: number) {
  let sum = 0
  let amplitude = 1
  let total = 0
  for (let i = 0; i < octaves; i++) {
    sum += noise2(seed + i * 1013, x, y) * amplitude
    total += amplitude
    amplitude *= 0.5
    x *= 2
    y *= 2
  }
  return sum / total
}
