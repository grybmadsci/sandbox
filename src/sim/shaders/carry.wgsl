// Carries particles resting on moving bodies along with them, sideways (bodies.ts
// `carries`): sand in a moving bucket, or on a moving crate. A particle (powder or
// liquid) rides a body when everything below it, down to one of the body's cells, is
// particles too. Riders move whole cells, as the body crosses cell boundaries, and only
// into empty space; a body moving up pushes its riders up anyway (stamp.wgsl), and
// gravity brings them down after one moving down. `carry` lists the bodies that moved:
// slot and shift (cells, never 0), `count` of them. Run before the stamp, so the grid
// still holds the bodies where they were. Two passes:
//
// phase 0, per cell: mark riders in `riders` (scratch) with their body's shift, 0 if not.
// phase 1, per row: move them a cell at a time, the cells nearest the way they're going
//          first, so a whole pile moves together. Only columns range.x to range.y
//          (exclusive), around the bodies, are looked at.
fn carryRiders(
  cells: ptr<storage, array<u32>, read_write>,
  bodies: ptr<storage, array<f32>, read_write>,
  carry: ptr<storage, array<i32>, read_write>,
  riders: ptr<storage, array<u32>, read_write>,
  index: u32,
  size: vec2u,
  count: u32,
  range: vec2u,
  phase: u32,
) -> void {
  // Most cells a body moves its riders in one step (bodies.ts CARRY_MAX).
  const CARRY_MAX = 3;
  if (phase == 0u) {
    if (index >= size.x * size.y) {
      return;
    }
    (*riders)[index] = 0u;
    let kind = cellKind((*cells)[index]);
    if (kind != KIND_POWDER && kind != KIND_LIQUID) {
      return;
    }
    let p = vec2i(i32(index % size.x), i32(index / size.x));
    let centre = vec2f(p) + 0.5;
    for (var e = 0u; e < count; e++) {
      let slot = u32((*carry)[e * 2u]);
      let base = slot * BODY_FLOATS;
      let lo = vec2f((*bodies)[base + 6u], (*bodies)[base + 7u]);
      let hi = vec2f((*bodies)[base + 8u], (*bodies)[base + 9u]);
      if (centre.x < lo.x - 1.0 || centre.x > hi.x + 1.0 || centre.y > hi.y || centre.y < lo.y - f32(BODY_MAX_LOAD)) {
        continue;
      }
      for (var d = 1; d <= BODY_MAX_LOAD && p.y + d < i32(size.y); d++) {
        let below = (*cells)[gridIndex(p + vec2i(0, d), size)];
        if (cellMaterial(below) == MAT_BODY && cellShade(below) == slot) {
          (*riders)[index] = bitcast<u32>((*carry)[e * 2u + 1u]);
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

  if (index >= size.y) {
    return;
  }
  let row = index * size.x;
  let first = i32(range.x);
  let last = i32(range.y);
  for (var s = 0; s < CARRY_MAX; s++) {
    // Toward +x, from the right; then toward -x, from the left. A cell that moves lands
    // where the sweep has already been, so it moves at most once a sweep.
    for (var x = last - 2; x >= first; x--) {
      let i = row + u32(x);
      let shift = bitcast<i32>((*riders)[i]);
      if (shift > 0 && cellMaterial((*cells)[i + 1u]) == MAT_EMPTY) {
        (*cells)[i + 1u] = (*cells)[i];
        (*cells)[i] = MAT_EMPTY;
        (*riders)[i + 1u] = bitcast<u32>(shift - 1);
        (*riders)[i] = 0u;
      }
    }
    for (var x = first + 1; x < last; x++) {
      let i = row + u32(x);
      let shift = bitcast<i32>((*riders)[i]);
      if (shift < 0 && cellMaterial((*cells)[i - 1u]) == MAT_EMPTY) {
        (*cells)[i - 1u] = (*cells)[i];
        (*cells)[i] = MAT_EMPTY;
        (*riders)[i - 1u] = bitcast<u32>(shift + 1);
        (*riders)[i] = 0u;
      }
    }
  }
}
