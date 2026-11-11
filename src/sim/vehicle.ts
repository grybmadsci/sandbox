import { ballBody, boxBody, type Assembly, type BodySpec } from './bodies'

type Color = [number, number, number]

const plate = (x0: number, y0: number, x1: number, y1: number, density: number, color: Color): BodySpec => ({
  ...boxBody(x0, y0, x1, y1, 'steel', false),
  density,
  color,
})

/** How far the bucket tips to dump (radians). */
const TIP_ANGLE = 2.0

/**
 * A two-wheeled cart with a bucket, its chassis centred on (x, y), the bucket hinged at
 * the back (-x when `facing` is 1, +x when -1) to tip out over it. Parts: chassis, two
 * wheels on driven revolute joints, and the bucket: a floor plate with two walls welded
 * to it (fixed joints), hinged to the chassis by a revolute joint that a motor holds
 * level, or tips (BodyWorld.control). Sand in the bucket rides in the grid, held in by
 * the walls and out of the wind (the floor's shelter); its weight presses on the floor
 * (bodyForces.wgsl).
 */
export function vehicleAssembly(x: number, y: number, facing: 1 | -1): Assembly {
  const chassis = plate(x - 22, y - 3, x + 22, y + 3, 2, [0.86, 0.64, 0.16])
  const tyre: Color = [0.17, 0.17, 0.19]
  const wheel = (dx: number): BodySpec => ({ ...ballBody(x + dx, y + 6, 8, 'rubber', false), restitution: 0.1, color: tyre })
  const steel: Color = [0.55, 0.58, 0.63]
  // The inside of the bucket, between the walls and from the floor up to their tops (in
  // the floor's frame), is out of the wind: the air the truck stirs up would blow its load
  // about.
  const floor: BodySpec = { ...plate(x - 20, y - 8, x + 20, y - 4, 1.5, steel), shelter: [-18, -18, 18, -2] }
  const wall = (x0: number) => plate(x + x0, y - 24, x + x0 + 4, y - 4, 1.5, steel)
  const parts = [chassis, wheel(-16), wheel(16), floor, wall(-22), wall(18)]
  const [, back, front, , left, right] = parts
  // Just past the bucket's back corner, so all of it swings up when it tips.
  const hinge: [number, number] = [x - 23 * facing, y - 3.5]
  const tip = -TIP_ANGLE * facing
  return {
    parts,
    joints: [
      { a: 0, b: 1, kind: 'revolute', at: [back.x, back.y], motor: { kind: 'drive' } },
      { a: 0, b: 2, kind: 'revolute', at: [front.x, front.y], motor: { kind: 'drive' } },
      { a: 0, b: 3, kind: 'revolute', at: hinge, limits: [Math.min(tip, 0), Math.max(tip, 0)], motor: { kind: 'tip', angle: tip } },
      { a: 3, b: 4, kind: 'fixed', at: [left.x, left.y] },
      { a: 3, b: 5, kind: 'fixed', at: [right.x, right.y] },
    ],
  }
}
