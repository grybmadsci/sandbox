// Stone must be at least 4 cells thick: a stone cell stays stone only if some 4x4
// square of stone covers it, and anything thinner crumbles to sand. (Thick walls also
// keep the 4x4 air grid sealed.) Run after the grid is painted or filled, as two passes
// with one invocation per cell:
//
// phase 0: mark the cells whose 4x4 square (them at its top left) is all stone; outside
//          the world, and chunks with no slot, count as stone. Over every chunk with a
//          slot (LIST_RESIDENT), since the live chunks' stone looks at squares in them.
// phase 1: stone not covered by any marked square turns to sand, in the live chunks (LIST_LIVE).
fn crumbleStone(
  cells: ptr<storage, array<u32>, read_write>,
  solid: ptr<storage, array<u32>, read_write>,
  table: ptr<storage, array<u32>, read_write>,
  index: u32,
  phase: u32,
) -> void {
  let list = select(LIST_LIVE, LIST_RESIDENT, phase == 0u);
  let n = index / CHUNK_CELLS;
  if (n >= listCount(table, list)) {
    return;
  }
  let chunk = listEntry(table, list, n);
  let page = (*table)[chunk];
  let k = index % CHUNK_CELLS;
  let p = chunkOrigin(chunk) + vec2i(i32(k % CHUNK_SIZE), i32(k / CHUNK_SIZE));
  let i = slotCell(page, p);

  if (phase == 0u) {
    var all = 1u;
    for (var dy = 0; dy < 4; dy++) {
      for (var dx = 0; dx < 4; dx++) {
        if (cellMaterial(cellOrStone(cells, table, p + vec2i(dx, dy))) != MAT_STONE) {
          all = 0u;
        }
      }
    }
    (*solid)[i] = all;
    return;
  }

  if (cellMaterial((*cells)[i]) != MAT_STONE) {
    return;
  }
  for (var dy = -3; dy <= 0; dy++) {
    for (var dx = -3; dx <= 0; dx++) {
      // Squares starting past the world's edge: use the nearest one inside it.
      let q = clamp(p + vec2i(dx, dy), vec2i(0), vec2i(i32(WORLD_SIZE) - 1));
      let j = cellIndex(table, q);
      if (j == CELL_NONE || (*solid)[j] == 1u) {
        return;
      }
    }
  }
  (*cells)[i] = makeCell(MAT_SAND, hashPcg(worldCellId(p) ^ 0x5bd1e995u));
}
