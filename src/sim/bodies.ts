import RAPIER from '@dimforge/rapier2d-compat'
import { LASER_FLOATS, LASER_RANGE, MAX_LASERS, deviceIds, type Device } from './objects'
import { minBearing } from './materials'

// Mirrors of constants in shaders/common.wgsl.
export const MAX_BODIES = 64
export const BODY_FLOATS = 32
export const BODY_FORCE_INTS = 8
export const SHELTER_FLOATS = 12
const BODY_POINTS = 8
const BODY_FORCE_ONE = 4

/** Loads Rapier's WASM; await it before making a BodyWorld. */
export const rapierReady = RAPIER.init()

/** Gravity on bodies, in cells per second squared (y down, like the grid). */
export const GRAVITY = 600

/**
 * Each collider is its stamped shape shrunk by this much. A cell next to a body has
 * its centre outside the stamp, but its square reaches up to half a cell into it (a
 * little more on a slant); the margin keeps those squares (ground voxels) clear of
 * the collider, so grains resting against a body don't push it.
 */
const STAMP_MARGIN = 0.75

/** Limits on the forces from the grid (as accelerations) and on bodies' motion, to keep things sane. */
const MAX_PUSH = 8 * GRAVITY
const MAX_SPIN_UP = 200 // radians per second squared
const MAX_SPEED = 1500 // cells per second
const MAX_SPIN = 40 // radians per second

const clampAbs = (n: number, most: number) => Math.min(most, Math.max(-most, n))

/** Largest body, across, in cells. */
export const MAX_BODY_SIZE = 128

/** Damping of bodies' motion (per second) in air, and fully submerged (in between when partly). */
const AIR_DAMPING = 0.05
const LIQUID_DAMPING = 12

/**
 * A body's shape, in its own frame (cells): every point within `radius` of the
 * convex hull of `points` (at most 8). One point is a ball, two a capsule, more a
 * rounded polygon.
 */
export type BodyShape = { points: [number, number][]; radius: number }

export type BodySpec = {
  x: number
  y: number
  angle: number
  shape: BodyShape
  /** Static bodies never move; dynamic ones are pushed by gravity, liquids and loads. */
  fixed: boolean
  /** Mass per cell, relative to water (below 1 floats). */
  density: number
  friction: number
  restitution: number
  /** sRGB 0..1. */
  color: [number, number, number]
  /** Placeable objects (objects.ts) are bodies that also do something. */
  device?: Device
  /**
   * A region in the body's own frame (min x, min y, max x, max y, cells) whose cells are
   * kept out of the wind (shelter.wgsl): the inside of a truck's bucket.
   */
  shelter?: [number, number, number, number]
}

export type BodyKind = 'wood' | 'rubber' | 'steel'

const kinds: Record<BodyKind, Pick<BodySpec, 'density' | 'friction' | 'restitution' | 'color'>> = {
  wood: { density: 0.6, friction: 0.7, restitution: 0.1, color: [0.62, 0.43, 0.24] },
  rubber: { density: 1.4, friction: 0.9, restitution: 0.5, color: [0.78, 0.22, 0.2] },
  steel: { density: 7.8, friction: 0.5, restitution: 0.05, color: [0.5, 0.56, 0.64] },
}

const clampSize = (n: number, min: number) => Math.min(MAX_BODY_SIZE, Math.max(min, n))

/** A box from corner to corner, with slightly rounded corners. */
export function boxBody(x0: number, y0: number, x1: number, y1: number, kind: BodyKind, fixed: boolean): BodySpec {
  const corner = 1.5
  const hw = clampSize(Math.abs(x1 - x0), 4) / 2 - corner
  const hh = clampSize(Math.abs(y1 - y0), 4) / 2 - corner
  const points: [number, number][] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, angle: 0, shape: { points, radius: corner }, fixed, ...kinds[kind] }
}

/** A ball around a centre. */
export function ballBody(x: number, y: number, radius: number, kind: BodyKind, fixed: boolean): BodySpec {
  const r = clampSize(radius * 2, 3) / 2
  return { x, y, angle: 0, shape: { points: [[0, 0]], radius: r }, fixed, ...kinds[kind] }
}

/** A beam (capsule) from one end to the other. */
export function beamBody(ax: number, ay: number, bx: number, by: number, thickness: number, kind: BodyKind, fixed: boolean): BodySpec {
  const r = clampSize(thickness, 3) / 2
  const half = Math.max(clampSize(Math.hypot(bx - ax, by - ay) + 2 * r, 2 * r) / 2 - r, 0.5)
  const shape: BodyShape = { points: [[-half, 0], [half, 0]], radius: r }
  return { x: (ax + bx) / 2, y: (ay + by) / 2, angle: Math.atan2(by - ay, bx - ax), shape, fixed, ...kinds[kind] }
}

/** Points around a body's outline (grid cells), for previews: the shape's support point in each direction. */
export function bodyOutline({ x, y, angle, shape }: BodySpec, segments = 48): [number, number][] {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const out: [number, number][] = []
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2
    const dx = Math.cos(t)
    const dy = Math.sin(t)
    let best = shape.points[0]
    let reach = -Infinity
    for (const p of shape.points) {
      const px = c * p[0] - s * p[1]
      const py = s * p[0] + c * p[1]
      const d = px * dx + py * dy
      if (d > reach) {
        reach = d
        best = p
      }
    }
    out.push([x + c * best[0] - s * best[1] + dx * shape.radius, y + s * best[0] + c * best[1] + dy * shape.radius])
  }
  return out
}

/** Rapier collider for the points within `r` of the convex hull of `points`. */
function colliderFor(points: [number, number][], r: number) {
  const [a, b] = points
  if (points.length > 2) {
    const hull = RAPIER.ColliderDesc.roundConvexHull(new Float32Array(points.flat()), r)
    if (hull) return hull
  }
  if (points.length === 1 || Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-3) {
    return RAPIER.ColliderDesc.ball(r).setTranslation(a[0], a[1])
  }
  // Rapier's capsules run along y.
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0]) - Math.PI / 2
  return RAPIER.ColliderDesc.capsule(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2, r)
    .setTranslation((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    .setRotation(angle)
}

/** Distance from a point (in a body's own frame) to the convex hull of its core points, 0 inside (as bodyCoreDistance in common.wgsl). */
function coreDistance(points: [number, number][], qx: number, qy: number) {
  let nearest = Infinity
  let inside = points.length >= 3
  let turn = 0
  points.forEach(([ax, ay], i) => {
    const [bx, by] = points[(i + 1) % points.length]
    const ex = bx - ax
    const ey = by - ay
    const t = Math.min(1, Math.max(0, ((qx - ax) * ex + (qy - ay) * ey) / Math.max(ex * ex + ey * ey, 1e-6)))
    nearest = Math.min(nearest, Math.hypot(qx - ax - ex * t, qy - ay - ey * t))
    const side = Math.sign(ex * (qy - ay) - ey * (qx - ax))
    if (turn === 0) turn = side
    else if (side * turn < 0) inside = false
  })
  return inside ? 0 : nearest
}

/** A grid point in a body's own frame, where the body is as specified. */
function toLocal({ x, y, angle }: BodySpec, [px, py]: [number, number]) {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { x: c * (px - x) + s * (py - y), y: c * (py - y) - s * (px - x) }
}

/**
 * Write a body at a pose into `out` at `o`, BODY_FLOATS floats as the GPU reads them
 * (see common.wgsl). Returns the cells it may cover: min x, min y, max x, max y.
 */
export function packBody({ x, y, angle, shape, fixed, color, device }: BodySpec, out: Float32Array, o: number) {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const { points, radius } = shape
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  out.fill(0, o, o + BODY_FLOATS)
  points.slice(0, BODY_POINTS).forEach(([px, py], k) => {
    const wx = x + c * px - s * py
    const wy = y + s * px + c * py
    x0 = Math.min(x0, wx - radius)
    y0 = Math.min(y0, wy - radius)
    x1 = Math.max(x1, wx + radius)
    y1 = Math.max(y1, wy + radius)
    out[o + 16 + k * 2] = px
    out[o + 17 + k * 2] = py
  })
  const deviceId = device ? deviceIds[device.kind] : 0
  out.set([x, y, c, s, radius, Math.min(points.length, BODY_POINTS), x0, y0, x1, y1, fixed ? 1 : 0, deviceId, ...color, device?.reach ?? 0], o)
  return [x0, y0, x1, y1]
}

/**
 * What a joint's motor does: `drive` spins a wheel (BodyWorld.control's drive), `tip`
 * swings a joint to `angle` and back (control's tip), and holds it there otherwise.
 */
export type JointMotor = { kind: 'drive' } | { kind: 'tip'; angle: number }

/**
 * A joint between parts `a` and `b` of an assembly (indices into its parts), at a grid
 * point (where the parts are as specified). Revolute joints leave the parts free to turn
 * about it (within `limits`, radians of b's turn relative to a, if given); fixed joints
 * weld them together. Parts joined don't collide with each other.
 */
export type JointSpec = {
  a: number
  b: number
  kind: 'revolute' | 'fixed'
  at: [number, number]
  limits?: [number, number]
  motor?: JointMotor
}

/** Bodies joined together, added and removed as one (a vehicle, say). */
export type Assembly = { parts: BodySpec[]; joints: JointSpec[] }

/** The bodies of an assembly in the world (by slot), and its motorised joints. */
type Group = { slots: number[]; motors: { joint: RAPIER.UnitImpulseJoint; motor: JointMotor }[] }

/** Wheel motors: target spin (radians per second; wheels roll toward +x when positive) and how hard they hold it. */
const DRIVE_SPIN = 12
const DRIVE_FACTOR = 60
/** Tipping motors: how stiffly they hold their angle, and their damping. */
const TIP_STIFFNESS = 4000
const TIP_DAMPING = 120

/** Most cells a body carries what rests on it in one step (carry.wgsl's CARRY_MAX). */
const CARRY_MAX = 3

/** How much of each step's measured ground pressure goes into a body's smoothed pressure. */
const PRESSURE_SMOOTHING = 0.2

/**
 * How far (cells) a body's outline must move before it is stamped again: it rests on the
 * grid jittering by far less, and restamping costs a serial walk of every column it covers.
 */
const STAMP_SLACK = 0.05

type Pose = { x: number; y: number; angle: number }

/**
 * A body in the world: its assembly, if any, the column its riders (what rests on it)
 * were last carried to, as its rounded x, how hard it presses on the ground (smoothed,
 * see `measurePressure`), where it was last stamped and the columns that covered (see
 * `pack`), and how far its outline reaches from its position.
 */
type Slot = {
  body: RAPIER.RigidBody
  spec: BodySpec
  group: Group | null
  carriedX: number
  pressure: number
  stamped: Pose | null
  columns: [number, number] | null
  reach: number
}

/**
 * Rigid bodies, simulated by Rapier in grid units (cells, y down) and coupled to the
 * sand grid both ways:
 * - SandSim stamps them into the grid every step (stamp.wgsl) from `pack`, so sand,
 *   liquids and air treat them as solid (and particles in their way are pushed aside);
 * - a voxel collider mirrors the ground they collide with (stone and settled powder,
 *   solidMask.wgsl), kept up to date by `applyGround`;
 * - the liquid they displace (bodyBuoyancy.wgsl) and the powder piled on them
 *   (bodyForces.wgsl) push on them through `applyForces`, so they float, sink, right
 *   themselves, and get buried. The liquid also drags on them (damping).
 * The grid's measurements reach Rapier a frame or two late (GPU readback).
 */
export class BodyWorld {
  readonly world: RAPIER.World
  private readonly terrain: RAPIER.Collider
  private readonly slots: (Slot | null)[] = new Array(MAX_BODIES).fill(null)
  private readonly data = new Float32Array(MAX_BODIES * BODY_FLOATS)
  private readonly laserData = new Float32Array(MAX_LASERS * LASER_FLOATS)
  private readonly carryData = new Int32Array(MAX_BODIES * 2)
  private readonly pressureData = new Float32Array(MAX_BODIES)
  private readonly shelterData = new Float32Array(MAX_BODIES * SHELTER_FLOATS)
  /** The ground bits the voxel collider holds (as last applied). */
  private ground: Uint32Array
  /** Columns that bodies removed since the last pack covered, so the stamp clears them. */
  private cleared: [number, number] | null = null

  readonly width: number
  readonly height: number
  private readonly wordsPerColumn: number

  constructor(width: number, height: number, wordsPerColumn: number, stepsPerSecond: number) {
    this.width = width
    this.height = height
    this.wordsPerColumn = wordsPerColumn
    this.world = new RAPIER.World({ x: 0, y: GRAVITY })
    this.world.timestep = 1 / stepsPerSecond
    // Rapier's tolerances are tuned for metres; bodies here are tens of cells across.
    this.world.lengthUnit = 10
    this.terrain = this.world.createCollider(RAPIER.ColliderDesc.voxels(new Int32Array(0), { x: 1, y: 1 }))
    this.ground = new Uint32Array(width * wordsPerColumn)

    // Outside the grid counts as stone.
    const wall = (x: number, y: number, hw: number, hh: number) =>
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(hw, hh).setTranslation(x, y))
    wall(-50, height / 2, 50, height / 2 + 100)
    wall(width + 50, height / 2, 50, height / 2 + 100)
    wall(width / 2, -50, width / 2 + 100, 50)
    wall(width / 2, height + 50, width / 2 + 100, 50)
  }

  get count() {
    return this.slots.filter(Boolean).length
  }

  /** Add a body; false when all MAX_BODIES slots are taken. */
  add(spec: BodySpec) {
    const slot = this.slots.indexOf(null)
    if (slot >= 0) this.create(slot, spec, null)
    return slot >= 0
  }

  /**
   * Add the bodies of an assembly and join them (see JointSpec); false, adding nothing,
   * when there aren't enough free slots.
   */
  addAssembly({ parts, joints }: Assembly) {
    const free = this.slots.flatMap((slot, i) => (slot ? [] : [i]))
    if (free.length < parts.length) return false
    const group: Group = { slots: free.slice(0, parts.length), motors: [] }
    const bodies = parts.map((spec, k) => this.create(group.slots[k], spec, group))
    for (const { a, b, kind, at, limits, motor } of joints) {
      const [pa, pb] = [parts[a], parts[b]]
      const anchorA = toLocal(pa, at)
      const anchorB = toLocal(pb, at)
      const data =
        kind === 'fixed'
          ? RAPIER.JointData.fixed(anchorA, pb.angle - pa.angle, anchorB, 0)
          : RAPIER.JointData.revolute(anchorA, anchorB)
      const joint = this.world.createImpulseJoint(data, bodies[a], bodies[b], true)
      joint.setContactsEnabled(false)
      // (Limits set on the JointData aren't applied to revolute joints.)
      if (limits) (joint as RAPIER.UnitImpulseJoint).setLimits(...limits)
      if (motor) group.motors.push({ joint: joint as RAPIER.UnitImpulseJoint, motor })
    }
    this.control(0, false)
    return true
  }

  /**
   * Run the motors of every assembly: wheels spin toward +x (`drive` 1), -x (-1) or brake
   * (0); tipping joints swing to their angle while `tip`, and back otherwise.
   */
  control(drive: number, tip: boolean) {
    for (const group of this.groups()) {
      for (const { joint, motor } of group.motors) {
        if (motor.kind === 'drive') joint.configureMotorVelocity(drive * DRIVE_SPIN, DRIVE_FACTOR)
        else joint.configureMotorPosition(tip ? motor.angle : 0, TIP_STIFFNESS, TIP_DAMPING)
      }
    }
  }

  private groups() {
    return new Set(this.slots.flatMap((slot) => (slot?.group ? [slot.group] : [])))
  }

  private create(slot: number, spec: BodySpec, group: Group | null) {
    const desc = spec.fixed ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic()
    // Never sleep: the ground and the forces on a body change under it without Rapier knowing.
    desc.setTranslation(spec.x, spec.y).setRotation(spec.angle).setCanSleep(false).setCcdEnabled(true)
    desc.setLinearDamping(AIR_DAMPING).setAngularDamping(AIR_DAMPING)
    const body = this.world.createRigidBody(desc)

    const r = Math.max(spec.shape.radius - STAMP_MARGIN, 0.1)
    const points = spec.shape.points.slice(0, BODY_POINTS)
    const collider = colliderFor(points, r)
    collider.setDensity(spec.density).setFriction(spec.friction).setRestitution(spec.restitution)
    this.world.createCollider(collider, body)
    const reach = Math.max(...points.map(([px, py]) => Math.hypot(px, py))) + spec.shape.radius
    this.slots[slot] = {
      body,
      spec: { ...spec, shape: { ...spec.shape, points } },
      group,
      carriedX: Math.round(spec.x),
      pressure: 0,
      stamped: null,
      columns: null,
      reach,
    }
    return body
  }

  /** Remove every body within `radius` of a grid point, with the rest of its assembly. */
  removeNear(x: number, y: number, radius: number) {
    const probe = new RAPIER.Ball(radius + STAMP_MARGIN)
    this.slots.forEach((slot, i) => {
      if (!slot || !slot.body.collider(0).intersectsShape(probe, { x, y }, 0)) return
      // Removing a body removes its joints too.
      for (const j of slot.group?.slots ?? [i]) if (this.slots[j]) this.remove(j)
    })
  }

  clear() {
    this.slots.forEach((slot, i) => slot && this.remove(i))
  }

  private remove(i: number) {
    const { body, columns } = this.slots[i]!
    if (columns) this.cleared = [Math.min(columns[0], this.cleared?.[0] ?? Infinity), Math.max(columns[1], this.cleared?.[1] ?? -Infinity)]
    this.world.removeRigidBody(body)
    this.slots[i] = null
  }

  step() {
    this.world.step()
    for (const slot of this.slots) {
      if (!slot || slot.spec.fixed) continue
      this.measurePressure(slot)
      const v = slot.body.linvel()
      const speed = Math.hypot(v.x, v.y)
      if (speed > MAX_SPEED) slot.body.setLinvel({ x: (v.x * MAX_SPEED) / speed, y: (v.y * MAX_SPEED) / speed }, false)
      const spin = slot.body.angvel()
      if (Math.abs(spin) > MAX_SPIN) slot.body.setAngvel(clampAbs(spin, MAX_SPIN), false)
    }
  }

  /**
   * How hard a body pressed on the ground (the voxel collider) this step, in cells of
   * water's weight per cell of contact, as powders' bearing strength is (stamp.wgsl): the
   * contact force, over the ground cells bearing it. It includes what the body carries
   * (its load, other parts of its assembly), as all of that rests on the ground through
   * it. Smoothed over a few steps, since contacts come and go.
   */
  private measurePressure(slot: Slot) {
    let fx = 0
    let fy = 0
    this.world.contactPair(this.terrain, slot.body.collider(0), (manifold) => {
      const n = manifold.normal()
      for (let i = 0; i < manifold.numContacts(); i++) {
        const impulse = Math.max(manifold.contactImpulse(i), 0)
        fx += n.x * impulse
        fy += n.y * impulse
      }
    })
    const force = Math.hypot(fx, fy) / this.world.timestep
    const cells = force > 0 ? this.bearingCells(slot) : 0
    const pressure = cells > 0 ? force / GRAVITY / cells : 0
    slot.pressure += (pressure - slot.pressure) * PRESSURE_SMOOTHING
  }

  /**
   * The ground cells touching a body: under its stamp (which is a little bigger than its
   * collider) or the next cell out, the cells bearing its weight. (Rapier reports only a
   * contact point or two against the voxels, too few to tell how wide a contact is; and
   * the cells under the stamp alone are only the ones that haven't given way yet, not the
   * cradle the body rests in.)
   */
  private bearingCells(slot: Slot) {
    const { x, y } = slot.body.translation()
    const angle = slot.body.rotation()
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    const { points, radius } = slot.spec.shape
    const touch = radius + 1
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [px, py] of points) {
      const wx = x + c * px - s * py
      const wy = y + s * px + c * py
      x0 = Math.min(x0, wx)
      y0 = Math.min(y0, wy)
      x1 = Math.max(x1, wx)
      y1 = Math.max(y1, wy)
    }
    const words = this.wordsPerColumn
    let cells = 0
    for (let cx = Math.max(0, Math.floor(x0 - touch)); cx < Math.min(this.width, Math.ceil(x1 + touch)); cx++) {
      for (let cy = Math.max(0, Math.floor(y0 - touch)); cy < Math.min(this.height, Math.ceil(y1 + touch)); cy++) {
        if (((this.ground[cx * words + (cy >> 5)] >>> (cy & 31)) & 1) === 0) continue
        const dx = cx + 0.5 - x
        const dy = cy + 0.5 - y
        if (coreDistance(points, c * dx + s * dy, c * dy - s * dx) <= touch) cells++
      }
    }
    return cells
  }

  /**
   * The bodies as the GPU reads them (see common.wgsl), and the columns the stamp must
   * rewrite. A body is packed where it was last stamped until its outline has moved by
   * STAMP_SLACK, so the stamp of a body at rest doesn't change; and only the columns of
   * bodies whose stamp changes (where they are and were), or that press hard enough to
   * push powder aside, or that were removed, are rewritten. Null when there are no
   * bodies, and none to clear.
   */
  pack(): { data: Float32Array; pressures: Float32Array; from: number; to: number } | null {
    const data = this.data
    data.fill(0)
    this.pressureData.fill(0)
    let from = this.cleared?.[0] ?? Infinity
    let to = this.cleared?.[1] ?? -Infinity
    const any = this.cleared !== null || this.slots.some(Boolean)
    this.cleared = null
    this.slots.forEach((slot, i) => {
      if (!slot) return
      const { x, y } = slot.body.translation()
      const angle = slot.body.rotation()
      const was = slot.stamped
      const moved = !was || Math.hypot(x - was.x, y - was.y) > STAMP_SLACK || Math.abs(angle - was.angle) * slot.reach > STAMP_SLACK
      if (moved) slot.stamped = { x, y, angle }
      const [x0, , x1] = packBody({ ...slot.spec, ...slot.stamped! }, data, i * BODY_FLOATS)
      this.pressureData[i] = slot.pressure
      if (moved || slot.pressure > minBearing) {
        from = Math.min(from, x0, slot.columns?.[0] ?? Infinity)
        to = Math.max(to, x1, slot.columns?.[1] ?? -Infinity)
      }
      slot.columns = [x0, x1]
    })
    if (!any) return null
    if (to < from) return { data, pressures: this.pressureData, from: 0, to: 0 }
    return { data, pressures: this.pressureData, from: Math.max(0, Math.floor(from)), to: Math.min(this.width, Math.ceil(to) + 1) }
  }

  /**
   * The bodies that have crossed cell boundaries sideways since their riders were last
   * carried, as carry.wgsl reads them (slot, shift in cells), and the columns to look at:
   * around where they were last packed (where the grid still has them). Call after
   * stepping, before packing.
   */
  carries(): { data: Int32Array; count: number; from: number; to: number } {
    const data = this.carryData
    let count = 0
    let from = Infinity
    let to = -Infinity
    this.slots.forEach((slot, i) => {
      if (!slot || slot.spec.fixed) return
      const x = Math.round(slot.body.translation().x)
      const shift = clampAbs(x - slot.carriedX, CARRY_MAX)
      slot.carriedX = x
      if (shift === 0) return
      data[count * 2] = i
      data[count * 2 + 1] = shift
      count++
      const o = i * BODY_FLOATS
      from = Math.min(from, this.data[o + 6])
      to = Math.max(to, this.data[o + 8])
    })
    const reach = CARRY_MAX + 2
    return { data, count, from: Math.max(0, Math.floor(from) - reach), to: Math.min(this.width, Math.ceil(to) + reach) }
  }

  /** The bodies' shelters as shelter.wgsl reads them (SHELTER_FLOATS each), where the bodies are now. */
  packShelters(): { data: Float32Array; count: number } {
    const data = this.shelterData
    let count = 0
    for (const slot of this.slots) {
      const shelter = slot?.spec.shelter
      if (!slot || !shelter) continue
      const { x, y } = slot.body.translation()
      const angle = slot.body.rotation()
      const c = Math.cos(angle)
      const s = Math.sin(angle)
      const [x0, y0, x1, y1] = shelter
      const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([px, py]) => [x + c * px - s * py, y + s * px + c * py])
      const xs = corners.map((p) => p[0])
      const ys = corners.map((p) => p[1])
      data.set([x, y, c, s, x0, y0, x1, y1, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], count++ * SHELTER_FLOATS)
    }
    return { data, count }
  }

  /**
   * The lasers (objects.ts), LASER_FLOATS each as laser.wgsl reads them: where the beam
   * starts, its direction, its body's slot (so it passes through its own cells) and range.
   */
  packLasers(): { data: Float32Array; count: number } {
    const data = this.laserData
    data.fill(0)
    let count = 0
    this.slots.forEach((slot, i) => {
      if (slot?.spec.device?.kind !== 'laser' || count >= MAX_LASERS) return
      const { x, y } = slot.body.translation()
      const angle = slot.body.rotation()
      const c = Math.cos(angle)
      const s = Math.sin(angle)
      const reach = slot.spec.device.reach
      data.set([x + c * reach, y + s * reach, c, s, i, LASER_RANGE], count++ * LASER_FLOATS)
    })
    return { data, count }
  }

  /** Which body is in each slot, to match a force readback to the bodies it was measured on. */
  snapshot() {
    return this.slots.map((slot) => slot?.body ?? null)
  }

  /** Apply forces read back from the GPU (bodyForces.wgsl, bodyBuoyancy.wgsl), measured on the bodies in `measured`. */
  applyForces(raw: Int32Array, measured: (RAPIER.RigidBody | null)[]) {
    if (this.disposed) return
    this.slots.forEach((slot, i) => {
      if (!slot || slot.spec.fixed || measured[i] !== slot.body) return
      const o = i * BODY_FORCE_INTS
      const scale = GRAVITY / BODY_FORCE_ONE
      const body = slot.body
      body.resetForces(false)
      body.resetTorques(false)
      // Clipped, so a glitch in what the grid measured can't fling a body about. Torque
      // was summed about the body's position.
      const fx = raw[o] * scale
      const fy = raw[o + 1] * scale
      const most = MAX_PUSH * body.mass()
      const fit = Math.min(1, most / Math.max(Math.hypot(fx, fy), 1e-6))
      const torque = clampAbs(raw[o + 2] * scale, MAX_SPIN_UP * body.principalInertia())
      body.addForceAtPoint({ x: fx * fit, y: fy * fit }, body.translation(), true)
      body.addTorque(torque, true)
      const submerged = raw[o + 4] > 0 ? raw[o + 3] / raw[o + 4] : 0
      body.setLinearDamping(AIR_DAMPING + LIQUID_DAMPING * submerged)
      body.setAngularDamping(AIR_DAMPING + LIQUID_DAMPING * submerged)
    })
  }

  /** Bring the voxel collider in step with the ground bits read back from the GPU (see solidMask.wgsl). */
  applyGround(bits: Uint32Array) {
    if (this.disposed) return
    const words = this.wordsPerColumn
    for (let i = 0; i < bits.length; i++) {
      let changed = bits[i] ^ this.ground[i]
      if (changed === 0) continue
      const x = Math.floor(i / words)
      const y0 = (i % words) * 32
      while (changed !== 0) {
        const b = 31 - Math.clz32(changed)
        changed &= ~(1 << b)
        if (y0 + b < this.height) this.terrain.setVoxel(x, y0 + b, ((bits[i] >>> b) & 1) === 1)
      }
    }
    this.ground = bits
  }

  /** Readbacks still in flight are dropped once disposed: the WASM objects are gone. */
  private disposed = false

  dispose() {
    this.disposed = true
    this.world.free()
  }
}

/** Bodies in the starting level (see level.wgsl): a crate dropped into a pool, more on the dunes, a steel ramp with a ball on it, and another ball. */
export function levelBodies(): BodySpec[] {
  return [
    boxBody(940, 362, 976, 378, 'wood', false),
    boxBody(1250, 230, 1272, 252, 'wood', false),
    boxBody(1320, 240, 1364, 250, 'wood', false),
    beamBody(900, 196, 1060, 250, 6, 'steel', true),
    ballBody(915, 175, 9, 'rubber', false),
    ballBody(1640, 150, 7, 'rubber', false),
  ]
}
