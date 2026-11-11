import type { BodySpec } from './bodies'

// Mirrors of constants in shaders/common.wgsl.
export const MAX_LASERS = 16
export const LASER_FLOATS = 8
export const LASER_RAYS = 9

/** How far a mining laser reaches, in cells. */
export const LASER_RANGE = 600

/**
 * What a placeable object does beyond being a static body, as the GPU knows it (body
 * float 11, DEVICE_* in common.wgsl). A laser fires along its body's local +x, from
 * `reach` cells out (its tip).
 */
export type Device = { kind: 'laser'; reach: number }

export const deviceIds: Record<Device['kind'], number> = { laser: 1 }

/** Placeable objects: static bodies with a device, placed only where they fit (SandSim.checkPlacement). */
export type ObjectKind = 'laser'

const LASER_LENGTH = 14
const LASER_THICKNESS = 7

/** A mining laser centred on (x, y), aimed at (tx, ty); straight right when that is too close to tell. */
export function laserObject(x: number, y: number, tx: number, ty: number): BodySpec {
  const corner = 1.5
  const hw = LASER_LENGTH / 2 - corner
  const hh = LASER_THICKNESS / 2 - corner
  const points: [number, number][] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
  const angle = Math.hypot(tx - x, ty - y) < 3 ? 0 : Math.atan2(ty - y, tx - x)
  return {
    x,
    y,
    angle,
    shape: { points, radius: corner },
    fixed: true,
    density: 7.8,
    friction: 0.6,
    restitution: 0.05,
    color: [0.3, 0.32, 0.36],
    device: { kind: 'laser', reach: hw + corner },
  }
}

/** Where a laser's beam starts (its tip), in grid cells. */
export function laserTip({ x, y, angle, device }: BodySpec): [number, number] {
  const reach = device?.reach ?? 0
  return [x + Math.cos(angle) * reach, y + Math.sin(angle) * reach]
}
