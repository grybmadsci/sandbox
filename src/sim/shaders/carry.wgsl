// Carries particles resting on moving bodies along with them, sideways (bodies.ts
// `carries`): sand in a moving bucket, or on a moving crate. A particle (powder or
// liquid) rides a body when everything below it, down to one of the body's cells, is
// particles too. Riders move whole cells, as the body crosses cell boundaries, and only
// into empty space; a body moving up pushes its riders up anyway (stamp.wgsl), and
// gravity brings them down after one moving down. `carry` lists the bodies that moved:
// slot and shift (cells, never 0), `count` of them. Run before the stamp, so the grid
// still holds the bodies where they were. Two passes:
//
// phase 0, per cell of the chunks bodies are near (LIST_BODIES, which reach far enough
//          around them): mark riders in `riders` (scratch) with their body's shift, 0 if not.
// phase 1, per row from rows.x to rows.y (exclusive): move them a cell at a time, the
//          cells nearest the way they're going first, so a whole pile moves together. Only
//          columns range.x to range.y (exclusive), around the bodies, are looked at.
fn carryRiders(
  cells: ptr<storage, array<u32>, read_write>,
  bodies: ptr<storage, array<f32>, read_write>,
  carry: ptr<storage, array<i32>, read_write>,
  riders: ptr<storage, array<u32>, read_write>,
  table: ptr<storage, array<u32>, read_write>,
  index: u32,
  count: u32,
  range: vec2u,
  rows: vec2u,
  phase: u32,
) -> void {
  // Most cells a body moves its riders in one step (bodies.ts CARRY_MAX).
  const CARRY_MAX = 3;
  if (phase == 0u) {
    let n = index / CHUNK_CELLS;
    if (n >= listCount(table, LIST_BODIES)) {
      return;
    }
    let chunk = listEntry(table, LIST_BODIES, n);
    let k = index % CHUNK_CELLS;
    let p = chunkOrigin(chunk) + vec2i(i32(k % CHUNK_SIZE), i32(k / CHUNK_SIZE));
    let i = slotCell((*table)[chunk], p);
    (*riders)[i] = 0u;
    let kind = cellKind((*cells)[i]);
    if (kind != KIND_POWDER && kind != KIND_LIQUID) {
      return;
    }
    let centre = vec2f(p) + 0.5;
    for (var e = 0u; e < count; e++) {
      let slot = u32((*carry)[e * 2u]);
      let base = slot * BODY_FLOATS;
      let lo = vec2f((*bodies)[base + 6u], (*bodies)[base + 7u]);
      let hi = vec2f((*bodies)[base + 8u], (*bodies)[base + 9u]);
      if (centre.x < lo.x - 1.0 || centre.x > hi.x + 1.0 || centre.y > hi.y || centre.y < lo.y - f32(BODY_MAX_LOAD)) {
        continue;
      }
      for (var d = 1; d <= BODY_MAX_LOAD; d++) {
        let below = cellOrStone(cells, table, p + vec2i(0, d));
        if (cellMaterial(below) == MAT_BODY && cellShade(below) == slot) {
          (*riders)[i] = bitcast<u32>((*carry)[e * 2u + 1u]);
          return;
        }
        let k = cellKind(below);
        if (k != KIND_POWDER && k != KIND_LIQUID) {
          break;
        }
      }
    }
    return;
  }

  let y = i32(rows.x + index);
  if (y >= i32(rows.y)) {
    return;
  }
  let first = i32(range.x);
  let last = i32(range.y);
  for (var s = 0; s < CARRY_MAX; s++) {
    // Toward +x, from the right; then toward -x, from the left. A cell that moves lands
    // where the sweep has already been, so it moves at most once a sweep. Riders only
    // move within the chunks bodies are near (where `riders` was marked).
    for (var x = last - 2; x >= first; x--) {
      let i = cellIndex(table, vec2i(x, y));
      let j = cellIndex(table, vec2i(x + 1, y));
      if (i == CELL_NONE || j == CELL_NONE) {
        continue;
      }
      let shift = bitcast<i32>((*riders)[i]);
      if (shift > 0 && cellMaterial((*cells)[j]) == MAT_EMPTY) {
        (*cells)[j] = (*cells)[i];
        (*cells)[i] = MAT_EMPTY;
        (*riders)[j] = bitcast<u32>(shift - 1);
        (*riders)[i] = 0u;
      }
    }
    for (var x = first + 1; x < last; x++) {
      let i = cellIndex(table, vec2i(x, y));
      let j = cellIndex(table, vec2i(x - 1, y));
      if (i == CELL_NONE || j == CELL_NONE) {
        continue;
      }
      let shift = bitcast<i32>((*riders)[i]);
      if (shift < 0 && cellMaterial((*cells)[j]) == MAT_EMPTY) {
        (*cells)[j] = (*cells)[i];
        (*cells)[i] = MAT_EMPTY;
        (*riders)[j] = bitcast<u32>(shift + 1);
        (*riders)[i] = 0u;
      }
    }
  }
}
