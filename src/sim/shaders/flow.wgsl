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
fn flowPair(
  cells: ptr<storage, array<u32>, read_write>,
  field: ptr<storage, array<u32>, read_write>,
  index: u32,
  size: vec2u,
  offset: u32,
  rowPhase: u32,
  passIndex: u32,
) -> void {
  let pairsPerRow = size.x / 2u + 1u;
  let rows = (size.y + 2u) / 3u;
  if (index >= pairsPerRow * rows) {
    return;
  }
  let pa = vec2i(i32(index % pairsPerRow) * 2 - i32(offset), i32((index / pairsPerRow) * 3u + rowPhase));
  let pb = pa + vec2i(1, 0);
  if (pa.x >= i32(size.x) || pa.y >= i32(size.y)) {
    return;
  }

  // Outside the grid reads as stone.
  var a = MAT_STONE;
  var b = MAT_STONE;
  var belowA = MAT_STONE;
  var belowB = MAT_STONE;
  var twoBelowA = MAT_STONE;
  var twoBelowB = MAT_STONE;
  if (inGrid(pa, size)) { a = (*cells)[gridIndex(pa, size)]; }
  if (inGrid(pb, size)) { b = (*cells)[gridIndex(pb, size)]; }
  if (inGrid(pa + vec2i(0, 1), size)) { belowA = (*cells)[gridIndex(pa + vec2i(0, 1), size)]; }
  if (inGrid(pb + vec2i(0, 1), size)) { belowB = (*cells)[gridIndex(pb + vec2i(0, 1), size)]; }
  if (inGrid(pa + vec2i(0, 2), size)) { twoBelowA = (*cells)[gridIndex(pa + vec2i(0, 2), size)]; }
  if (inGrid(pb + vec2i(0, 2), size)) { twoBelowB = (*cells)[gridIndex(pb + vec2i(0, 2), size)]; }

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
      let da = fieldDistance((*field)[gridIndex(pa, size)]);
      let db = fieldDistance((*field)[gridIndex(pb, size)]);
      if (cellCredit(newA) != 0u && db < da) {
        newB = withCredit(newB, cellCredit(newB) + cellCredit(newA));
        newA = withCredit(newA, 0u);
      } else if (cellCredit(newB) != 0u && da < db) {
        newA = withCredit(newA, cellCredit(newA) + cellCredit(newB));
        newB = withCredit(newB, 0u);
      }
    }
  }

  if (newA != a && inGrid(pa, size)) { (*cells)[gridIndex(pa, size)] = newA; }
  if (newB != b && inGrid(pb, size)) { (*cells)[gridIndex(pb, size)] = newB; }
}
