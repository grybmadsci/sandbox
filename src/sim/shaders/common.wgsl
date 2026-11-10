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
//   bits 0-15  head: row of the body's highest free surface plus HEAD_BASE (air
//              pressure can lift a surface above row 0), in 1/HEAD_ONE rows
//   bits 16-17 which side the head came from (FROM_*)
//   bits 18-29 hop distance to the nearest sink
//   bits 30-31 which side the distance came from
const HEAD_ONE: u32 = 16u;
// Rows added to every head, so it stays positive however hard air pushes on a surface
// (AIR_MAX_LIFT). The largest head, (512 + HEAD_BASE + 1024 rows of suction) * 16,
// fits below HEAD_INF.
const HEAD_BASE: u32 = 1024u;
const FIELD_NONE: u32 = 0xffffffffu;
const HEAD_INF: u32 = 0xffffu;
const DIST_INF: u32 = 0xfffu;
const FROM_SELF: u32 = 0u;
const FROM_LEFT: u32 = 1u;
const FROM_RIGHT: u32 = 2u;

fn makeField(head: u32, headFrom: u32, distance: u32, distanceFrom: u32) -> u32 {
  return min(head, HEAD_INF) | (headFrom << 16u) | (min(distance, DIST_INF) << 18u) | (distanceFrom << 30u);
}

fn fieldHead(f: u32) -> u32 {
  return f & 0xffffu;
}

fn fieldHeadFrom(f: u32) -> u32 {
  return (f >> 16u) & 3u;
}

fn fieldDistance(f: u32) -> u32 {
  return (f >> 18u) & 0xfffu;
}

fn fieldDistanceFrom(f: u32) -> u32 {
  return f >> 30u;
}

// Alongside the field, each liquid cell keeps how many columns its head has come (bits
// 0-11) and the air's push on the surface the head came from (bits 12-27, in 1/HEAD_ONE
// rows, offset by 32768; it is at most 1024 rows either way).
fn packHops(hops: u32, air: i32) -> u32 {
  return min(hops, 0xfffu) | (u32(clamp(air, -32768, 32767) + 32768) << 12u);
}

fn hopsCount(packed: u32) -> u32 {
  return packed & 0xfffu;
}

fn hopsAir(packed: u32) -> i32 {
  return i32((packed >> 12u) & 0xffffu) - 32768;
}

// Air-pressure differences between a surface and the highest one that the sink test
// ignores (pressure.wgsl), in 1/HEAD_ONE rows: 6 rows.
const AIR_SINK_DEADBAND: i32 = 6 * i32(HEAD_ONE);

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

// Chance (16-bit) that a falling liquid cell skips a fall in a pass (step.wgsl): 1/4.
const LIQUID_FALL_SKIP: u32 = 16384u;
// Wind speed liquids ignore (blownInto): 2 cells per step.
const LIQUID_WIND_THRESHOLD: u32 = 2048u;

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
// Liquids only feel wind beyond LIQUID_WIND_THRESHOLD, so the gentle wind a waterfall
// stirs up doesn't blow spray about, while a strong gust (the air brush) still does.
fn blownInto(a: u32, b: u32, speed: u32, bits: u32) -> bool {
  let drag = MATERIAL_DRAG[cellMaterial(a)];
  let kb = cellKind(b);
  if (drag == 0u || (kb != KIND_EMPTY && kb != KIND_GAS) || cellMaterial(a) == cellMaterial(b)) {
    return false;
  }
  let felt = select(speed, max(speed, LIQUID_WIND_THRESHOLD) - LIQUID_WIND_THRESHOLD, cellKind(a) == KIND_LIQUID);
  return chance16(bits, min(felt * drag / u32(AIR_ONE), 65535u));
}

// Can `a` move sideways into `b`? Liquids displace anything lighter; gases only spread into empty space.
fn flowsInto(a: u32, b: u32) -> bool {
  if (cellKind(a) == KIND_GAS) {
    return cellMaterial(b) == MAT_EMPTY;
  }
  return sinksInto(a, b);
}

// May it flow sideways? Liquids only while resting on something they can't sink
// into, which isn't itself falling (sinking into what is below it), so a falling
// stream doesn't spray sideways; gases always drift, so plumes spread.
fn flowsSideways(cell: u32, below: u32, twoBelow: u32) -> bool {
  switch (cellKind(cell)) {
    case KIND_LIQUID: { return !sinksInto(cell, below) && !sinksInto(below, twoBelow); }
    case KIND_GAS: { return true; }
    default: { return false; }
  }
}

// Dynamic pressure: a coarse air grid, one air cell per AIR_CELL x AIR_CELL sand
// cells, stored as 4 i32 per air cell: air mass, flow x, flow y, volume. The volume
// slot holds how many of its sand cells are open to air (empty or gas,
// 0..AIR_VOLUME_FULL; airVolume), how many grains or drops in it are falling
// (airFalling), and a smoothed open volume that follows the real one over a few steps
// (airSoftVolume); -1 marks a cell not yet initialised since the last fill. Absolute
// pressure is mass per smoothed volume, so a pocket that shrinks gets denser (Boyle),
// but a grain passing through doesn't set off a sharp pressure pulse. Flows are staggered (flow
// x through a cell's right face, flow y through its bottom face) and measured as air
// mass per air substep; airWind turns them into wind speed. Pressures are in units of
// AIR_ROW per row of liquid.
const AIR_CELL: u32 = 4u;
// Wind speed fixed point: a wind of AIR_ONE moves a material with drag 1 by about one
// cell per step.
const AIR_ONE: i32 = 1024;
const AIR_MASS: u32 = 0u;
const AIR_VX: u32 = 1u;
const AIR_VY: u32 = 2u;
const AIR_VOLUME: u32 = 3u;
const AIR_VOLUME_FULL: i32 = 16;  // AIR_CELL * AIR_CELL
// Air pressure equal to one row of liquid.
const AIR_ROW: i32 = 256;
// Absolute pressure of still air: one atmosphere, about 10 m of water, taken as 1024
// rows (a cell is about 1 cm). That is far more than any column of liquid in the world,
// so sealed air barely compresses or stretches: it holds liquid up by suction
// (siphons, upturned bottles) and pushes back hard when squeezed.
const AIR_AMBIENT: i32 = 1024 * AIR_ROW;
// Gauge pressure (above ambient) the air brush can pump up to: 256 rows.
const AIR_MAX_P: i32 = 256 * AIR_ROW;
// The most that air pressure can lift a liquid surface by (pressure.wgsl): 1024 rows.
const AIR_MAX_LIFT: i32 = 1024 * AIR_ROW;
// Air substeps per simulation step (AIR_SUBSTEPS in SandSim.ts must match).
const AIR_SUBSTEPS: i32 = 16;
// Entrainment: falling grains and drops drag the air toward their speed, closing
// 1/AIR_ENTRAIN of the gap per falling cell per substep (air.wgsl).
const AIR_ENTRAIN: i32 = 64;
// Flows lose 1/AIR_DAMP per substep: a light drag, so steady streams (venting a
// draining vessel) flow almost freely; bulk viscosity does most of the wave damping.
const AIR_DAMP: i32 = 2048;
// Bulk viscosity: a face's flow evens out changes in compression on its two sides by
// 1/AIR_BULK per substep. Changes, measured against each cell's recent average
// (GAUGE_SPREAD, over AIR_SPREAD_STEPS substeps), so it damps pressure waves but not
// the steady inflow above a draining surface.
const AIR_BULK: i32 = 16;
const AIR_SPREAD_STEPS: i32 = 16;
// The smoothed open volume closes 1/AIR_SOFTEN of the gap to the real one per step.
const AIR_SOFTEN: i32 = 4;
// The gauge pressure liquids feel is filtered once a step (air.wgsl), in two stages
// kept with GAUGE_SPREAD in 8 ints per air cell (gaugeIndex, plus these offsets):
// - GAUGE_FAST: an average over AIR_GAUGE_FAST steps, which strips out the ringing
//   that moving material sets off;
// - GAUGE_AVERAGE: follows the fast average over AIR_GAUGE_SLOW steps while they are
//   within AIR_GAUGE_KNEE of each other (surface churn), faster in proportion beyond
//   (pumping, a siphon starting), but never faster than the fast average. It also
//   tracks the fast average's trend (GAUGE_TREND, 16x per step, learned over
//   AIR_GAUGE_TREND steps and fading by 1/AIR_GAUGE_FADE a step) and projects it, so a
//   steady change (suction easing above a draining arm) is followed without lag, while
//   churn, which keeps changing direction, has no trend to follow. This is what
//   liquids feel (and the pressure view shows); pressure.wgsl also ignores small
//   differences between surfaces (AIR_SINK_DEADBAND).
const GAUGE_FAST: u32 = 0u;
const GAUGE_AVERAGE: u32 = 1u;
const GAUGE_TREND: u32 = 3u;
const GAUGE_SPREAD: u32 = 4u;
const AIR_GAUGE_TREND: i32 = 32;
const AIR_GAUGE_FADE: i32 = 16;
const AIR_GAUGE_FAST: i32 = 16;
const AIR_GAUGE_SLOW: i32 = 256;
const AIR_GAUGE_KNEE: i32 = 4 * AIR_ROW;
// Largest flow through one face per substep: a quarter of a cell of still air.
const AIR_MAX_FLOW: i32 = AIR_AMBIENT / 4;

fn airIndex(p: vec2i, airSize: vec2u) -> u32 {
  let q = clamp(p, vec2i(0), vec2i(airSize) - 1);
  return (u32(q.y) * airSize.x + u32(q.x)) * 4u;
}

// Where an air cell's filter values (GAUGE_*) start, from its airIndex.
fn gaugeIndex(a: u32) -> u32 {
  return a * 2u;
}

// Volume slot layout: open cells (bits 0-4), falling cells (5-9), smoothed open volume
// in 1/64 cells (10-20).
fn airSlot(open: i32, falling: i32, soft: i32) -> i32 {
  return open | (falling << 5u) | (soft << 10u);
}

// Open volume from a volume slot (-1, not yet initialised, stays -1).
fn airVolume(slot: i32) -> i32 {
  return select(slot & 31, slot, slot < 0);
}

// Falling grains and drops from a volume slot.
fn airFalling(slot: i32) -> i32 {
  return select((slot >> 5u) & 31, 0, slot < 0);
}

// Smoothed open volume from a volume slot, in 1/64 cells.
fn airSoftVolume(slot: i32) -> i32 {
  return select(slot >> 10u, 0, slot < 0);
}

// Absolute pressure of `mass` in the smoothed volume of `slot` (0 for no room).
fn airPressure(mass: i32, slot: i32) -> i32 {
  let soft = airSoftVolume(slot);
  return select(0, mass * (AIR_VOLUME_FULL * 64) / max(soft, 1), soft > 0);
}

// Gauge pressure (relative to still air), which is what pushes on liquids.
fn airGauge(mass: i32, slot: i32) -> i32 {
  return select(0, airPressure(mass, slot) - AIR_AMBIENT, airVolume(slot) > 0);
}

// Wind speed (AIR_ONE = a cell per step) of a face flow: the volume of still air it
// moves, spread over the face. A full cell of air per substep through a full face moves
// AIR_CELL sand cells per substep.
fn airWind(flow: i32) -> i32 {
  return flow / (AIR_AMBIENT / (AIR_ONE * i32(AIR_CELL) * AIR_SUBSTEPS));
}

// The face flow that carries a wind of `wind` (the inverse of airWind).
fn airFlowForWind(wind: i32) -> i32 {
  return wind * (AIR_AMBIENT / (AIR_ONE * i32(AIR_CELL) * AIR_SUBSTEPS));
}

// Air flowing across the face between air cells `a` and `b` (indices from airIndex;
// `b` is right of `a` for axis 0, below it for axis 1), positive from a to b. Both
// cells compute exactly the same integer, so air is conserved, and no face takes more
// than a quarter of a cell's mass, so mass never goes negative. Air is carried by the
// face's flow plus a little diffusion down the pressure difference, through an opening
// as wide as the smaller open volume (which keeps nearly filled cells stable). A cell
// with no room left (filled with material) pushes all its air out into open neighbours.
fn airFlux(air: ptr<storage, array<i32>, read_write>, a: u32, b: u32, axis: u32) -> i32 {
  let slotA = (*air)[a + AIR_VOLUME];
  let slotB = (*air)[b + AIR_VOLUME];
  let volumeA = airVolume(slotA);
  let volumeB = airVolume(slotB);
  let massA = (*air)[a + AIR_MASS];
  let massB = (*air)[b + AIR_MASS];
  if (volumeA <= 0 && volumeB <= 0) {
    return 0;
  }
  // Gently, so a cell that fills up doesn't send out a sharp pulse.
  if (volumeA <= 0) {
    return massA / 16;
  }
  if (volumeB <= 0) {
    return -(massB / 16);
  }
  let opening = min(volumeA, volumeB);
  let spread = (airPressure(massA, slotA) - airPressure(massB, slotB)) / AIR_VOLUME_FULL * opening / 16;
  return clamp((*air)[a + AIR_VX + axis] + spread, -(massB / 4), massA / 4);
}

// Viridis-like colour ramp: dark purple at 0, blue, teal, green, yellow at 1.
fn pressureColor(t: f32) -> vec3f {
  var stops = array<vec3f, 5>(
    vec3f(0.27, 0.0, 0.33),
    vec3f(0.23, 0.32, 0.55),
    vec3f(0.13, 0.57, 0.55),
    vec3f(0.37, 0.79, 0.38),
    vec3f(0.99, 0.91, 0.14),
  );
  let x = t * 4.0;
  let k = min(u32(x), 3u);
  return mix(stops[k], stops[k + 1u], x - f32(k));
}
