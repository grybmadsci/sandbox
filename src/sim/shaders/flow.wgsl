// One sideways-flow pass for liquids, run `maxSpread` times per simulation step.
//
// Each invocation owns a horizontal pair of cells (x, x+1) on one row; `offset`
// alternates between passes so liquid can cross pair boundaries. A dispatch only
// touches rows of one parity, so the row below each pair (which decides whether
// a liquid is resting) is never written during the same dispatch.
//
// Liquids keep moving in their stored direction and turn around when blocked,
// which levels pools far faster than a random walk. A liquid takes part only in
// the first MATERIAL_SPREAD[m] passes of a step, and only while resting on
// something it can't sink into (falling streams don't spray sideways).
fn flowPair(
  cells: ptr<storage, array<u32>, read_write>,
  index: u32,
  size: vec2u,
  offset: u32,
  rowParity: u32,
  passIndex: u32,
) -> void {
  let pairsPerRow = size.x / 2u + 1u;
  let rows = (size.y + 1u) / 2u;
  if (index >= pairsPerRow * rows) {
    return;
  }
  let pa = vec2i(i32(index % pairsPerRow) * 2 - i32(offset), i32((index / pairsPerRow) * 2u + rowParity));
  let pb = pa + vec2i(1, 0);
  if (pa.x >= i32(size.x) || pa.y >= i32(size.y)) {
    return;
  }

  // Outside the grid reads as stone.
  var a = MAT_STONE;
  var b = MAT_STONE;
  var belowA = MAT_STONE;
  var belowB = MAT_STONE;
  if (inGrid(pa, size)) { a = (*cells)[gridIndex(pa, size)]; }
  if (inGrid(pb, size)) { b = (*cells)[gridIndex(pb, size)]; }
  if (inGrid(pa + vec2i(0, 1), size)) { belowA = (*cells)[gridIndex(pa + vec2i(0, 1), size)]; }
  if (inGrid(pb + vec2i(0, 1), size)) { belowB = (*cells)[gridIndex(pb + vec2i(0, 1), size)]; }

  let flowsA = cellKind(a) == KIND_LIQUID && passIndex < MATERIAL_SPREAD[cellMaterial(a)] && !sinksInto(a, belowA);
  let flowsB = cellKind(b) == KIND_LIQUID && passIndex < MATERIAL_SPREAD[cellMaterial(b)] && !sinksInto(b, belowB);
  let wantsRight = flowsA && cellDirection(a) == DIR_RIGHT;
  let wantsLeft = flowsB && cellDirection(b) == DIR_LEFT;

  var newA = a;
  var newB = b;
  if ((wantsRight && sinksInto(a, b)) || (wantsLeft && sinksInto(b, a))) {
    newA = b;
    newB = a;
  } else {
    // Blocked: turn around.
    if (wantsRight) { newA = flipDirection(a); }
    if (wantsLeft) { newB = flipDirection(b); }
  }

  if (newA != a && inGrid(pa, size)) { (*cells)[gridIndex(pa, size)] = newA; }
  if (newB != b && inGrid(pb, size)) { (*cells)[gridIndex(pb, size)] = newB; }
}
