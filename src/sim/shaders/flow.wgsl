// One sideways-flow pass for liquids and gases, run `maxSpread` times per simulation step.
//
// Each invocation owns a horizontal pair of cells (x, x+1) on one row; `offset`
// alternates between passes so liquid can cross pair boundaries. A pass is three
// dispatches, one per row modulo 3 (`rowPhase`), so the two rows below each pair
// (which decide whether a liquid is resting) are never written during the same
// dispatch, keeping the result deterministic.
//
// Liquids and gases keep moving in their stored direction and turn around when
// blocked, which levels pools far faster than a random walk. A cell takes part only
// in the first MATERIAL_SPREAD[m] passes of a step. Liquids flow only while resting
// on something they can't sink into that isn't itself falling (so a falling stream
// doesn't spray sideways); gases
// always drift, and step.wgsl turns them around at random so they spread out.
// Neighbouring cells of the same liquid also hand on pressure credit (pressure.wgsl)
// toward the side fewer hops from a sink.
//
// Runs over the live chunks (LIST_LIVE): PAIRS_ACROSS pairs on each of the chunk's rows of
// this row phase. A pair belongs to the chunk holding the cell 2 * (its place in the row)
// from the chunk's first column (its left cell in even passes, its right in odd ones); in
// odd passes the pair hanging over the world's right edge belongs to the last chunks.

fn flowPair(
  cells: ptr<storage, array<u32>, read_write>,
  field: ptr<storage, array<u32>, read_write>,
  table: ptr<storage, array<u32>, read_write>,
  index: u32,
  offset: u32,
  rowPhase: u32,
  passIndex: u32,
) -> void {
  let n = index / (PAIRS_ACROSS * PHASE_ROWS);
  if (n >= listCount(table, LIST_LIVE)) {
    return;
  }
  let first = chunkOrigin(listEntry(table, LIST_LIVE, n));
  let k = index % (PAIRS_ACROSS * PHASE_ROWS);
  let pair = i32(k % PAIRS_ACROSS);
  // The chunk's first row in this row phase (rows modulo 3 count from the top of the world).
  let row = (rowPhase + 3u - u32(first.y) % 3u) % 3u + (k / PAIRS_ACROSS) * 3u;
  if (row >= CHUNK_SIZE || (pair == i32(CHUNK_SIZE / 2u) && (offset == 0u || first.x + i32(CHUNK_SIZE) < i32(WORLD_SIZE)))) {
    return;
  }
  let pa = first + vec2i(pair * 2 - i32(offset), i32(row));
  let pb = pa + vec2i(1, 0);
  let ia = liveCell(table, pa);
  let ib = liveCell(table, pb);
  if ((inWorld(pa) && ia == CELL_NONE) || (inWorld(pb) && ib == CELL_NONE)) {
    return;
  }

  // Outside the world, or a chunk with no slot, reads as stone.
  var a = MAT_STONE;
  var b = MAT_STONE;
  if (ia != CELL_NONE) { a = (*cells)[ia]; }
  if (ib != CELL_NONE) { b = (*cells)[ib]; }
  let belowA = cellOrStone(cells, table, pa + vec2i(0, 1));
  let belowB = cellOrStone(cells, table, pb + vec2i(0, 1));
  let twoBelowA = cellOrStone(cells, table, pa + vec2i(0, 2));
  let twoBelowB = cellOrStone(cells, table, pb + vec2i(0, 2));

  let flowsA = passIndex < MATERIAL_SPREAD[cellMaterial(a)] && flowsSideways(a, belowA, twoBelowA);
  let flowsB = passIndex < MATERIAL_SPREAD[cellMaterial(b)] && flowsSideways(b, belowB, twoBelowB);
  let wantsRight = flowsA && cellDirection(a) == DIR_RIGHT;
  let wantsLeft = flowsB && cellDirection(b) == DIR_LEFT;

  var newA = a;
  var newB = b;
  if ((wantsRight && flowsInto(a, b)) || (wantsLeft && flowsInto(b, a))) {
    newA = b;
    newB = a;
  } else {
    // Blocked: turn around.
    if (wantsRight) { newA = flipDirection(a); }
    if (wantsLeft) { newB = flipDirection(b); }
    if (cellKind(a) == KIND_LIQUID && cellMaterial(a) == cellMaterial(b)
      && cellCredit(a) + cellCredit(b) <= CREDIT_MAX) {
      let da = fieldDistance((*field)[ia]);
      let db = fieldDistance((*field)[ib]);
      if (cellCredit(newA) != 0u && db < da) {
        newB = withCredit(newB, cellCredit(newB) + cellCredit(newA));
        newA = withCredit(newA, 0u);
      } else if (cellCredit(newB) != 0u && da < db) {
        newA = withCredit(newA, cellCredit(newA) + cellCredit(newB));
        newB = withCredit(newB, 0u);
      }
    }
  }

  if (newA != a && ia != CELL_NONE) { (*cells)[ia] = newA; }
  if (newB != b && ib != CELL_NONE) { (*cells)[ib] = newB; }
}
