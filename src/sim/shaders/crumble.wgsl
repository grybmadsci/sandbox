// Stone must be at least 4 cells thick: a stone cell stays stone only if some 4x4
// square of stone covers it, and anything thinner crumbles to sand. (Thick walls also
// keep the 4x4 air grid sealed.) Run after the grid is painted or filled, as two passes
// with one invocation per cell:
//
// phase 0: mark the cells whose 4x4 square (them at its top left) is all stone; outside
//          the world counts as stone.
// phase 1: stone not covered by any marked square turns to sand.
fn crumbleStone(
  cells: ptr<storage, array<u32>, read_write>,
  solid: ptr<storage, array<u32>, read_write>,
  index: u32,
  size: vec2u,
  phase: u32,
) -> void {
  if (index >= size.x * size.y) {
    return;
  }
  let p = vec2i(i32(index % size.x), i32(index / size.x));

  if (phase == 0u) {
    var all = 1u;
    for (var dy = 0; dy < 4; dy++) {
      for (var dx = 0; dx < 4; dx++) {
        let q = p + vec2i(dx, dy);
        if (inGrid(q, size) && cellMaterial((*cells)[gridIndex(q, size)]) != MAT_STONE) {
          all = 0u;
        }
      }
    }
    (*solid)[index] = all;
    return;
  }

  if (cellMaterial((*cells)[index]) != MAT_STONE) {
    return;
  }
  for (var dy = -3; dy <= 0; dy++) {
    for (var dx = -3; dx <= 0; dx++) {
      // Squares starting past the world's edge: use the nearest one inside it.
      let q = clamp(p + vec2i(dx, dy), vec2i(0), vec2i(size) - 1);
      if ((*solid)[gridIndex(q, size)] == 1u) {
        return;
      }
    }
  }
  (*cells)[index] = makeCell(MAT_SAND, hashPcg(index ^ 0x5bd1e995u));
}
