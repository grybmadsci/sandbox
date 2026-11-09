// Shared prelude: helpers used by every kernel. Material constants and tables
// (MAT_*, KIND_*, MATERIAL_*) are generated in materials.ts and placed before this.
//
// Cell layout (u32): bits 0-7 material id, bits 8-15 per-grain shade (moves with the grain).
// Grid y grows downward (row 0 is the top); gravity is +y.

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

fn makeCell(materialId: u32, shade: u32) -> u32 {
  return materialId | ((shade & 0xffu) << 8u);
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

fn isMovable(cell: u32) -> bool {
  let k = cellKind(cell);
  return k == KIND_POWDER || k == KIND_LIQUID;
}

// Can `a` trade places with `b` by moving down (or sideways) into it?
fn sinksInto(a: u32, b: u32) -> bool {
  return isMovable(a) && cellKind(b) != KIND_SOLID && cellDensity(a) > cellDensity(b);
}

// Can a liquid in either cell flow sideways into the other?
fn flowsBetween(a: u32, b: u32) -> bool {
  return (cellKind(a) == KIND_LIQUID && sinksInto(a, b)) || (cellKind(b) == KIND_LIQUID && sinksInto(b, a));
}
