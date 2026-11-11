// Shared prelude: helpers used by every kernel. Material constants and tables
// (MAT_*, KIND_*, MATERIAL_*) are generated in materials.ts and placed before this.
//
// Cell layout (u32): bits 0-7 material id, bits 8-15 per-grain shade, bit 16 flow
// direction (0 = right, 1 = left), bits 17-31 liquid credit (see cellCredit) or, in
// stone, laser damage (see stoneDamage). The whole
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

// Stone keeps the damage a mining laser has done to it (laser.wgsl), in
// 1/LASER_DAMAGE_ONE of a full step's hit, where liquids keep credit; at
// LASER_BREAK_DAMAGE it decomposes into sand.
fn stoneDamage(cell: u32) -> u32 {
  return cell >> 17u;
}

fn withStoneDamage(cell: u32, damage: u32) -> u32 {
  return (cell & 0x1ffffu) | (damage << 17u);
}

// Pressure field, one u32 per liquid cell (written by pressure.wgsl), FIELD_NONE elsewhere:
//   bits 0-15  head: row of the body's highest free surface, counted from the top row of
//              the cell's chunk plus HEAD_BASE (the surface may be chunks above it, and
//              air pressure can lift it further), in 1/HEAD_ONE rows
//   bits 16-17 which side the head came from (FROM_*)
//   bits 18-29 hop distance to the nearest sink
//   bits 30-31 which side the distance came from
// Counting from the chunk's top keeps heads small in a world of any height: cells in the
// same row, which are the only ones that compare heads, count from the same row.
const HEAD_ONE: u32 = 16u;
// Rows added to every head, so it stays positive for a surface up to HEAD_BASE - 1024
// rows above the chunk however hard air pushes on it (AIR_MAX_LIFT); deeper bodies of
// liquid stop levelling out. The largest head, (CHUNK_SIZE + HEAD_BASE + 1024 rows of
// suction) * 16, fits below HEAD_INF.
const HEAD_BASE: u32 = 2048u;
// A chunk's worth of rows, in head units: what a head changes by from one chunk row to the next.
const HEAD_CHUNK: u32 = CHUNK_SIZE * HEAD_ONE;
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

// A head counted from `chunks` chunk rows further down (a smaller number; 0, the highest,
// if it doesn't fit), keeping HEAD_INF (no head) as it is.
fn headBelow(head: u32, chunks: u32) -> u32 {
  return select(head - min(head, chunks * HEAD_CHUNK), HEAD_INF, head >= HEAD_INF);
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

// The world is WORLD_CHUNKS x WORLD_CHUNKS chunks, CHUNK_SIZE cells across, and positions
// are world cells. Only some chunks are on the GPU, each in a slot of the buffers (its
// cells, its air, its masks), found through the page table (`table`, world/config.ts): a
// page per chunk, 0 when it has no slot, else the slot + 1, with PAGE_LIVE set when it is
// simulated. Kernels run over lists of chunks in the table (LIST_*), leave the cells of
// chunks that aren't live alone, and treat them (and the rest of the world, and outside it)
// like walls.
const CELL_NONE: u32 = 0xffffffffu;
const CHUNK_CELLS: u32 = CHUNK_SIZE * CHUNK_SIZE;

fn inWorld(p: vec2i) -> bool {
  return p.x >= 0 && p.y >= 0 && p.x < i32(WORLD_SIZE) && p.y < i32(WORLD_SIZE);
}

// The page of the chunk holding cell p (0 outside the world).
fn pageAt(table: ptr<storage, array<u32>, read_write>, p: vec2i) -> u32 {
  if (!inWorld(p)) {
    return 0u;
  }
  let c = vec2u(p) / CHUNK_SIZE;
  return (*table)[c.y * WORLD_CHUNKS + c.x];
}

fn pageSlot(page: u32) -> u32 {
  return (page & ~PAGE_LIVE) - 1u;
}

fn pageLive(page: u32) -> bool {
  return (page & PAGE_LIVE) != 0u;
}

// Where cell p is in the cell buffers, in the slot of its chunk's page (which isn't 0).
fn slotCell(page: u32, p: vec2i) -> u32 {
  let local = vec2u(p) % CHUNK_SIZE;
  return pageSlot(page) * CHUNK_CELLS + local.y * CHUNK_SIZE + local.x;
}

// Where cell p is in the cell buffers, or CELL_NONE when its chunk has no slot.
fn cellIndex(table: ptr<storage, array<u32>, read_write>, p: vec2i) -> u32 {
  let page = pageAt(table, p);
  return select(CELL_NONE, slotCell(page, p), page != 0u);
}

// The same, but CELL_NONE unless its chunk is live.
fn liveCell(table: ptr<storage, array<u32>, read_write>, p: vec2i) -> u32 {
  let page = pageAt(table, p);
  return select(CELL_NONE, slotCell(page, p), pageLive(page));
}

// For walking down column x (pressure.wgsl), looking up chunks once per chunk rather than
// once per cell: where the chunk row holding row y starts in the cell buffers, for column
// x and the columns either side (x - 1, x, x + 1), each CELL_NONE where that chunk isn't
// live (or is outside the world). `liveAt` then finds a cell of the chunk row.
fn liveBases(table: ptr<storage, array<u32>, read_write>, x: i32, y: i32) -> vec3u {
  let top = y - y % i32(CHUNK_SIZE);
  return vec3u(liveCell(table, vec2i(x - 1, top)), liveCell(table, vec2i(x, top)), liveCell(table, vec2i(x + 1, top)));
}

fn liveAt(base: u32, y: i32) -> u32 {
  return select(CELL_NONE, base + u32(y % i32(CHUNK_SIZE)) * CHUNK_SIZE, base != CELL_NONE);
}

// A cell, as stone where its chunk has no slot (or outside the world).
fn cellOrStone(cells: ptr<storage, array<u32>, read_write>, table: ptr<storage, array<u32>, read_write>, p: vec2i) -> u32 {
  let i = cellIndex(table, p);
  return select(MAT_STONE, (*cells)[min(i, SLOT_COUNT * CHUNK_CELLS - 1u)], i != CELL_NONE);
}

// The lists of chunks kernels run over: how many, and the n-th (a chunk index).
fn listCount(table: ptr<storage, array<u32>, read_write>, list: u32) -> u32 {
  return (*table)[TABLE_LISTS + list * LIST_STRIDE];
}

fn listEntry(table: ptr<storage, array<u32>, read_write>, list: u32, n: u32) -> u32 {
  return (*table)[TABLE_LISTS + list * LIST_STRIDE + 1u + n];
}

// Invocations per chunk of step.wgsl (blocks across, with a spare) and flow.wgsl (pairs
// across, with a spare, and rows of one row phase).
const BLOCKS_ACROSS: u32 = CHUNK_SIZE / 2u + 1u;
const PAIRS_ACROSS: u32 = CHUNK_SIZE / 2u + 1u;
const PHASE_ROWS: u32 = (CHUNK_SIZE + 2u) / 3u;

// A chunk's first cell, from its index.
fn chunkOrigin(chunk: u32) -> vec2i {
  return vec2i(i32(chunk % WORLD_CHUNKS), i32(chunk / WORLD_CHUNKS)) * i32(CHUNK_SIZE);
}

// A world cell's number, for hashing: random choices depend on where they're made, not on
// which slot a chunk happens to be in.
fn worldCellId(p: vec2i) -> u32 {
  return u32(p.y + 1) * (WORLD_SIZE + 2u) + u32(p.x + 1);
}

// Masks of one bit per cell (shelter.wgsl, solidMask.wgsl), a slot's after another's:
// column-major in each, MASK_WORDS words per column.
const MASK_WORDS: u32 = CHUNK_SIZE / 32u;

fn maskWord(page: u32, p: vec2i) -> u32 {
  let local = vec2u(p) % CHUNK_SIZE;
  return (pageSlot(page) * CHUNK_SIZE + local.x) * MASK_WORDS + local.y / 32u;
}

fn maskBit(mask: ptr<storage, array<u32>, read_write>, page: u32, p: vec2i) -> bool {
  return (((*mask)[maskWord(page, p)] >> (u32(p.y) % 32u)) & 1u) != 0u;
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

// Chance (16-bit) that `top` and the diagonally adjacent `bottom` swap when they could:
// the falling one's (MATERIAL_SLIDE), or the rising gas's.
fn slideChance(top: u32, bottom: u32) -> u32 {
  let falls = cellKind(top) == KIND_POWDER || cellKind(top) == KIND_LIQUID;
  return MATERIAL_SLIDE[cellMaterial(select(bottom, top, falls))];
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
// rows (a cell is about 1 cm). That is far more than most columns of liquid in the world,
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

// Air cells across a chunk; each slot's air cells follow the last slot's, row by row.
const AIR_SIDE: u32 = CHUNK_SIZE / AIR_CELL;

// Where air cell q (in air cells) is in the air buffer, in the slot of its chunk's page (which isn't 0).
fn slotAir(page: u32, q: vec2i) -> u32 {
  let local = vec2u(q) % AIR_SIDE;
  return (pageSlot(page) * AIR_SIDE * AIR_SIDE + local.y * AIR_SIDE + local.x) * 4u;
}

// Where air cell q is in the air buffer, or CELL_NONE when its chunk has no slot.
fn airIndex(table: ptr<storage, array<u32>, read_write>, q: vec2i) -> u32 {
  let page = pageAt(table, q * i32(AIR_CELL));
  return select(CELL_NONE, slotAir(page, q), page != 0u);
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

// Rigid bodies (bodies.ts) are stamped into the grid as MAT_BODY cells whose shade bits
// hold the body's slot. The CPU writes each slot as BODY_FLOATS floats, in grid units
// (y down):
//   0-1 position, 2-3 rotation (cos, sin), 4 radius, 5 core point count (0 = free slot),
//   6-9 the cells it may cover (min x, min y, max x, max y), 10 static (1) or dynamic (0),
//   11 device (DEVICE_*: what a placeable object does), 12-14 colour (sRGB), 15 the
//   device's reach (a laser fires from this far along its local +x), 16-31 up to 8 core
//   points (local).
// A body is every point within `radius` of the convex hull of its core points: one point
// is a ball, two a capsule, more a rounded polygon. A cell belongs to it when the cell's
// centre does.
const MAX_BODIES: u32 = 64u;
const BODY_FLOATS: u32 = 32u;
const BODY_POINTS: u32 = 8u;
// Per slot, bodyForces.wgsl and bodyBuoyancy.wgsl add up (atomically, see BODY_*) the
// push on the body and its torque about the body's position, in 1/BODY_FORCE_ONE cells'
// weight of water; and how many of its cells are submerged in liquid, of how many.
const BODY_FORCE_INTS: u32 = 8u;
const BODY_FORCE_X: u32 = 0u;
const BODY_FORCE_Y: u32 = 1u;
const BODY_TORQUE: u32 = 2u;
const BODY_SUBMERGED: u32 = 3u;
const BODY_CELLS: u32 = 4u;
const BODY_FORCE_ONE: f32 = 4.0;
// How far up a pile of powder resting on a body is weighed.
const BODY_MAX_LOAD: i32 = 128;

// Shelters (shelter.wgsl): regions bodies declare in their own frame, kept out of the wind.
const SHELTER_FLOATS: u32 = 12u;

// Placeable objects (objects.ts) are static bodies with a device.
const DEVICE_NONE: u32 = 0u;
const DEVICE_LASER: u32 = 1u;

// Mining lasers (laser.wgsl). The CPU writes each as LASER_FLOATS floats: 0-1 where the
// beam starts, 2-3 its direction (unit), 4 its body's slot, 5 its range (cells). Each
// fires LASER_RAYS parallel rays, a cell apart; laser.wgsl writes how far each got.
const MAX_LASERS: u32 = 16u;
const LASER_FLOATS: u32 = 8u;
const LASER_RAYS: u32 = 9u;
// Steps of a ray's hits that break a stone cell: 3 seconds at 120 steps a second.
const LASER_BREAK_STEPS: u32 = 360u;
// A full step's hit, in damage units (fine enough for weaker hits deeper in the stone).
// The most damage a cell holds, 360 * 64, fits in bits 17-31.
const LASER_DAMAGE_ONE: u32 = 64u;
const LASER_BREAK_DAMAGE: u32 = LASER_BREAK_STEPS * LASER_DAMAGE_ONE;

struct Body {
  position: vec2f,
  rotation: vec2f,
  radius: f32,
  count: u32,
  lo: vec2f,
  hi: vec2f,
  isStatic: bool,
  device: u32,
  color: vec3f,
  reach: f32,
  points: array<vec2f, BODY_POINTS>,
}

fn bodyFromFloats(f: array<f32, BODY_FLOATS>) -> Body {
  var b: Body;
  b.position = vec2f(f[0], f[1]);
  b.rotation = vec2f(f[2], f[3]);
  b.radius = f[4];
  b.count = u32(f[5]);
  b.lo = vec2f(f[6], f[7]);
  b.hi = vec2f(f[8], f[9]);
  b.isStatic = f[10] != 0.0;
  b.device = u32(f[11]);
  b.color = vec3f(f[12], f[13], f[14]);
  b.reach = f[15];
  for (var i = 0u; i < BODY_POINTS; i++) {
    b.points[i] = vec2f(f[16u + i * 2u], f[17u + i * 2u]);
  }
  return b;
}

fn loadBody(bodies: ptr<storage, array<f32>, read_write>, slot: u32) -> Body {
  var f: array<f32, BODY_FLOATS>;
  for (var i = 0u; i < BODY_FLOATS; i++) {
    f[i] = (*bodies)[slot * BODY_FLOATS + i];
  }
  return bodyFromFloats(f);
}

// A world point (grid units) in the body's own frame.
fn bodyLocal(b: Body, p: vec2f) -> vec2f {
  let d = p - b.position;
  return vec2f(b.rotation.x * d.x + b.rotation.y * d.y, b.rotation.x * d.y - b.rotation.y * d.x);
}

// Distance from a local point to the convex hull of the body's core points (0 inside).
fn bodyCoreDistance(b: Body, q: vec2f) -> f32 {
  var nearest = 1e9;
  var inside = b.count >= 3u;
  var turn = 0.0;
  for (var i = 0u; i < b.count; i++) {
    let a = b.points[i];
    let e = b.points[(i + 1u) % b.count] - a;
    let t = clamp(dot(q - a, e) / max(dot(e, e), 1e-6), 0.0, 1.0);
    nearest = min(nearest, length(q - a - e * t));
    // Inside a convex polygon, q is on the same side of every edge.
    let side = e.x * (q.y - a.y) - e.y * (q.x - a.x);
    if (turn == 0.0) {
      turn = sign(side);
    } else if (side * turn < 0.0) {
      inside = false;
    }
  }
  return select(nearest, 0.0, inside);
}

fn bodyContains(b: Body, p: vec2f) -> bool {
  return bodyCoreDistance(b, bodyLocal(b, p)) <= b.radius;
}

fn bodyCell(slot: u32) -> u32 {
  return MAT_BODY | (slot << 8u);
}
