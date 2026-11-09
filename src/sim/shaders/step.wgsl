// One pass of a Margolus-neighborhood falling-sand automaton.
//
// The grid is partitioned into disjoint 2x2 blocks and each invocation owns one
// block, so it can read and write it in place with no races. Alternate passes
// shift the block grid by (1, 1) so material can cross block boundaries.
// Cells outside the grid read as stone, so nothing leaves through the edges.
fn stepBlock(
  cells: ptr<storage, array<u32>, read_write>,
  index: u32,
  size: vec2u,
  offset: u32,
  seed: u32,
) -> void {
  let blocks = size / 2u + 1u;
  if (index >= blocks.x * blocks.y) {
    return;
  }
  let origin = vec2i(i32(index % blocks.x), i32(index / blocks.x)) * 2 - vec2i(i32(offset));
  if (origin.x >= i32(size.x) || origin.y >= i32(size.y)) {
    return;
  }

  // 0 = top-left, 1 = top-right, 2 = bottom-left, 3 = bottom-right.
  // `var` (not `let`) so the arrays can be indexed with a loop variable everywhere.
  var p = array<vec2i, 4>(origin, origin + vec2i(1, 0), origin + vec2i(0, 1), origin + vec2i(1, 1));
  var c = array<u32, 4>(MAT_STONE, MAT_STONE, MAT_STONE, MAT_STONE);
  for (var i = 0u; i < 4u; i++) {
    if (inGrid(p[i], size)) {
      c[i] = (*cells)[gridIndex(p[i], size)];
    }
  }
  var before = c;

  let r = hashPcg(index ^ hashPcg(seed));
  var t: u32;

  // 1. Fall straight down. Sinking through a liquid is slowed (viscosity).
  if (sinksInto(c[0], c[2]) && (cellMaterial(c[2]) == MAT_EMPTY || hashUnit(r) < 0.5)) {
    t = c[0]; c[0] = c[2]; c[2] = t;
  }
  if (sinksInto(c[1], c[3]) && (cellMaterial(c[3]) == MAT_EMPTY || hashUnit(r >> 16u) < 0.5)) {
    t = c[1]; c[1] = c[3]; c[3] = t;
  }

  // 2. Slide diagonally when blocked below. Random order avoids a left/right bias.
  let diagonalChance = 0.85;
  let leftFirst = (r & 0x80000000u) != 0u;
  for (var i = 0u; i < 2u; i++) {
    if ((i == 0u) == leftFirst) {
      // top-left -> bottom-right
      if (sinksInto(c[0], c[3]) && !sinksInto(c[0], c[2]) && cellKind(c[1]) != KIND_SOLID
          && hashUnit(hashPcg(r + 1u)) < diagonalChance) {
        t = c[0]; c[0] = c[3]; c[3] = t;
      }
    } else {
      // top-right -> bottom-left
      if (sinksInto(c[1], c[2]) && !sinksInto(c[1], c[3]) && cellKind(c[0]) != KIND_SOLID
          && hashUnit(hashPcg(r + 2u)) < diagonalChance) {
        t = c[1]; c[1] = c[2]; c[2] = t;
      }
    }
  }

  // 3. Liquids spread sideways into lighter, non-solid neighbours.
  let flowChance = 0.6;
  if (flowsBetween(c[2], c[3]) && hashUnit(hashPcg(r + 3u)) < flowChance) {
    t = c[2]; c[2] = c[3]; c[3] = t;
  }
  if (flowsBetween(c[0], c[1]) && hashUnit(hashPcg(r + 4u)) < flowChance) {
    t = c[0]; c[0] = c[1]; c[1] = t;
  }

  for (var i = 0u; i < 4u; i++) {
    if (c[i] != before[i] && inGrid(p[i], size)) {
      (*cells)[gridIndex(p[i], size)] = c[i];
    }
  }
}
