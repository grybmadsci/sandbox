// Shared prelude: helpers used by every kernel. Material constants and tables
// (MAT_*, KIND_*, MATERIAL_*) are generated in materials.ts and placed before this.
//
// Cell layout (u32): bits 0-7 material id, bits 8-15 per-grain shade, bit 16 flow
// direction (0 = right, 1 = left), bits 17-31 liquid credit (see cellCredit). The whole
// cell moves together, so all of it travels with the grain.
// Grid y grows downward (row 0 is the top); gravity is +y.
//
// Everything that affects the simulation is integer math on hashes of an explicit
// seed, so a run is reproducible from the same inputs.

fn cellMaterial(cell: u32) -> u32 {
  return min(cell & 0xffu, MATERIAL_COUNT - 1u);
}

fn cellShade(cell: u32) -> u32 {
  return (cell >> 8u) & 0xffu;
}

fn cellKind(cell: u32) -> u32 {
  return MATERIAL_KIND[cellMaterial(cell)];
}

fn cellDensity(cell: u32) -> u32 {
  return MATERIAL_DENSITY[cellMaterial(cell)];
}

// Static (hydrostatic) pressure, see pressure.wgsl. Liquid cells can carry credit:
// cells of liquid in transit from the body's highest surface to a surface that
// pressure pushes up. Cells + credit is conserved.
// Credit must never exceed CREDIT_MAX: callers check, so none is ever clipped off.
const CREDIT_MAX: u32 = 0x7fffu;

fn cellCredit(cell: u32) -> u32 {
  return cell >> 17u;
}

fn withCredit(cell: u32, credit: u32) -> u32 {
  return (cell & 0x1ffffu) | (credit << 17u);
}

// Pressure field, one u32 per liquid cell (written by pressure.wgsl), FIELD_NONE elsewhere:
//   bits 0-13  head: row of the body's highest free surface plus HEAD_BASE (air
//              pressure can lift a surface above row 0), in 1/HEAD_ONE rows
//   bits 14-15 which side the head came from (FROM_*)
//   bits 16-29 hop distance to the nearest sink
//   bits 30-31 which side the distance came from
const HEAD_ONE: u32 = 16u;
// Rows added to every head, so it stays positive (AIR_MAX_P / AIR_ROW). With a 512-row
// world the largest head is (512 + 2 * 256) * 16 = FIELD_INF + 1, clamped just below it.
const HEAD_BASE: u32 = 256u;
const FIELD_NONE: u32 = 0xffffffffu;
const FIELD_INF: u32 = 0x3fffu;
const FROM_SELF: u32 = 0u;
const FROM_LEFT: u32 = 1u;
const FROM_RIGHT: u32 = 2u;

fn makeField(head: u32, headFrom: u32, distance: u32, distanceFrom: u32) -> u32 {
  return min(head, FIELD_INF) | (headFrom << 14u) | (min(distance, FIELD_INF) << 16u) | (distanceFrom << 30u);
}

fn fieldHead(f: u32) -> u32 {
  return f & 0x3fffu;
}

fn fieldHeadFrom(f: u32) -> u32 {
  return (f >> 14u) & 3u;
}

fn fieldDistance(f: u32) -> u32 {
  return (f >> 16u) & 0x3fffu;
}

fn fieldDistanceFrom(f: u32) -> u32 {
  return f >> 30u;
}

// `variant` is random bits: the low 8 pick the shade, bit 8 the initial flow direction.
fn makeCell(materialId: u32, variant: u32) -> u32 {
  return materialId | ((variant & 0x1ffu) << 8u);
}

const DIR_RIGHT: u32 = 0u;
const DIR_LEFT: u32 = 1u;

fn cellDirection(cell: u32) -> u32 {
  return (cell >> 16u) & 1u;
}

fn flipDirection(cell: u32) -> u32 {
  return cell ^ (1u << 16u);
}

fn inGrid(p: vec2i, size: vec2u) -> bool {
  return p.x >= 0 && p.y >= 0 && p.x < i32(size.x) && p.y < i32(size.y);
}

fn gridIndex(p: vec2i, size: vec2u) -> u32 {
  return u32(p.y) * size.x + u32(p.x);
}

// PCG hash: https://www.jcgt.org/published/0009/03/02/
fn hashPcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

// Low 16 bits of a hash as a float in [0, 1].
fn hashUnit(bits: u32) -> f32 {
  return f32(bits & 0xffffu) / 65535.0;
}

// True with probability chance / 65536 (chance is 16-bit fixed point).
fn chance16(bits: u32, chance: u32) -> bool {
  return (bits & 0xffffu) < chance;
}

fn isMovable(cell: u32) -> bool {
  let k = cellKind(cell);
  return k == KIND_POWDER || k == KIND_LIQUID || k == KIND_GAS;
}

// Should `a`, directly above `b`, trade places with it? True when `a` is heavier and
// neither is solid: sand sinks in water, water falls into empty space, and empty
// space "falls" into gas (the gas rises).
fn sinksInto(a: u32, b: u32) -> bool {
  return cellKind(a) != KIND_SOLID && cellKind(b) != KIND_SOLID && cellDensity(a) > cellDensity(b);
}

// Moves between empty space and gases aren't slowed by viscosity.
fn passesFreely(a: u32, b: u32) -> bool {
  return cellKind(a) == KIND_EMPTY || cellKind(b) == KIND_EMPTY || cellKind(b) == KIND_GAS;
}

// Should `top` and the diagonally adjacent `bottom` swap? Either `top` falls and is
// blocked below (`belowTop`), or `bottom` is a gas blocked above (`aboveBottom`);
// the cell beside the path must not be solid.
fn slidesDiagonally(top: u32, bottom: u32, belowTop: u32, aboveBottom: u32) -> bool {
  if (!sinksInto(top, bottom)) {
    return false;
  }
  let falls = (cellKind(top) == KIND_POWDER || cellKind(top) == KIND_LIQUID)
    && !sinksInto(top, belowTop) && cellKind(aboveBottom) != KIND_SOLID;
  let rises = cellKind(bottom) == KIND_GAS && !sinksInto(aboveBottom, bottom) && cellKind(belowTop) != KIND_SOLID;
  return falls || rises;
}

// Does wind of `speed` (fixed point) push `a` into neighbouring `b` this time?
fn blownInto(a: u32, b: u32, speed: u32, bits: u32) -> bool {
  let drag = MATERIAL_DRAG[cellMaterial(a)];
  let kb = cellKind(b);
  if (drag == 0u || (kb != KIND_EMPTY && kb != KIND_GAS) || cellMaterial(a) == cellMaterial(b)) {
    return false;
  }
  return chance16(bits, min(speed * drag / u32(AIR_ONE), 65535u));
}

// Can `a` move sideways into `b`? Liquids displace anything lighter; gases only spread into empty space.
fn flowsInto(a: u32, b: u32) -> bool {
  if (cellKind(a) == KIND_GAS) {
    return cellMaterial(b) == MAT_EMPTY;
  }
  return sinksInto(a, b);
}

// May it flow sideways? Liquids only while resting on something they can't sink
// into (falling streams don't spray sideways); gases always drift, so plumes spread.
fn flowsSideways(cell: u32, below: u32) -> bool {
  switch (cellKind(cell)) {
    case KIND_LIQUID: { return !sinksInto(cell, below); }
    case KIND_GAS: { return true; }
    default: { return false; }
  }
}

// Dynamic pressure: a coarse air grid, one air cell per AIR_CELL x AIR_CELL sand
// cells, stored as 4 i32 per air cell: air mass, velocity x, velocity y, volume.
// Volume is how many of its sand cells are open to air (empty or gas, 0..AIR_VOLUME_FULL);
// -1 marks a cell not yet initialised since the last fill. Absolute pressure is mass
// per volume, so a pocket that shrinks gets denser (Boyle). Values are fixed point
// (AIR_ONE = 1.0); a velocity of AIR_ONE moves a material with drag 1 by about one
// cell per step.
const AIR_CELL: u32 = 4u;
const AIR_ONE: i32 = 1024;
const AIR_MASS: u32 = 0u;
const AIR_VX: u32 = 1u;
const AIR_VY: u32 = 2u;
const AIR_VOLUME: u32 = 3u;
const AIR_VOLUME_FULL: i32 = 16;  // AIR_CELL * AIR_CELL
const AIR_MAX_V: i32 = 4096;
// Gauge pressure (above ambient) the air brush can pump up to.
const AIR_MAX_P: i32 = 65536;
// Absolute pressure of still air: one row of liquid. Air is kept this soft so that
// material moving through it (each grain changes a cell's volume) and liquid draining
// from or filling a vessel make almost no pressure; halving a pocket's volume raises
// its gauge pressure by this much. Pumped air (AIR_MAX_P) is far denser than this.
const AIR_AMBIENT: i32 = 256;
// Air pressure equal to one row of liquid (pressure.wgsl): AIR_MAX_P is 256 rows.
const AIR_ROW: i32 = 256;

fn airIndex(p: vec2i, airSize: vec2u) -> u32 {
  let q = clamp(p, vec2i(0), vec2i(airSize) - 1);
  return (u32(q.y) * airSize.x + u32(q.x)) * 4u;
}

// Absolute pressure of `mass` in `volume` open cells (0 for a cell with no room).
fn airPressure(mass: i32, volume: i32) -> i32 {
  return select(0, mass * AIR_VOLUME_FULL / max(volume, 1), volume > 0);
}

// Gauge pressure (relative to still air), which is what pushes on liquids.
fn airGauge(mass: i32, volume: i32) -> i32 {
  return select(0, airPressure(mass, volume) - AIR_AMBIENT, volume > 0);
}

// Air flowing across the face between air cells `a` and `b` (indices from airIndex;
// `b` is right of `a` for axis 0, below it for axis 1), positive from a to b. Both
// cells compute exactly the same integer, so air is conserved, and no face takes more
// than a quarter of a cell's mass, so mass never goes negative. Air is carried by the
// face's wind and diffuses down the pressure difference, through an opening as wide
// as the smaller open volume: that keeps nearly filled cells (whose pressure jumps
// with every bit of air) stable. A cell with no room left (filled with material)
// pushes all its air out into open neighbours.
fn airFlux(air: ptr<storage, array<i32>, read_write>, a: u32, b: u32, axis: u32) -> i32 {
  let volumeA = (*air)[a + AIR_VOLUME];
  let volumeB = (*air)[b + AIR_VOLUME];
  let massA = (*air)[a + AIR_MASS];
  let massB = (*air)[b + AIR_MASS];
  if (volumeA <= 0 && volumeB <= 0) {
    return 0;
  }
  if (volumeA <= 0) {
    return massA / 4;
  }
  if (volumeB <= 0) {
    return -(massB / 4);
  }
  let opening = min(volumeA, volumeB);
  let carried = (*air)[a + AIR_VX + axis] * opening / (AIR_VOLUME_FULL * 4);
  let spread = (airPressure(massA, volumeA) - airPressure(massB, volumeB)) * opening / (AIR_VOLUME_FULL * 8);
  return clamp(carried + spread, -(massB / 4), massA / 4);
}
