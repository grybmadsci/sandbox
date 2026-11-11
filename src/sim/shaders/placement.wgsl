// Whether a placeable object fits (SandSim.checkPlacement): counts the cells under the
// body in `probe` (one body, BODY_FLOATS floats, see common.wgsl) that would block it:
// stone, powder, other bodies, outside the world, or in a chunk with no slot. Air, gases and liquids don't (the
// stamp pushes them aside). Two passes, with one invocation per cell of the body's
// bounds (at most PLACE_SIDE across):
//
// phase 0: clear the count.
// phase 1: count.
fn checkPlacement(
  cells: ptr<storage, array<u32>, read_write>,
  probe: ptr<storage, array<f32>, read_write>,
  out: ptr<storage, array<atomic<i32>>, read_write>,
  table: ptr<storage, array<u32>, read_write>,
  index: u32,
  phase: u32,
) -> void {
  // Bounds of the largest body (MAX_BODY_SIZE) and then some.
  const PLACE_SIDE = 132;
  if (phase == 0u) {
    if (index == 0u) {
      atomicStore(&(*out)[0], 0);
    }
    return;
  }
  let b = loadBody(probe, 0u);
  let lo = vec2i(floor(b.lo));
  let span = min(vec2i(ceil(b.hi)) - lo + 1, vec2i(PLACE_SIDE));
  if (i32(index) >= span.x * span.y) {
    return;
  }
  let p = lo + vec2i(i32(index) % span.x, i32(index) / span.x);
  if (!bodyContains(b, vec2f(p) + 0.5)) {
    return;
  }
  let i = cellIndex(table, p);
  if (i == CELL_NONE) {
    atomicAdd(&(*out)[0], 1);
    return;
  }
  let kind = cellKind((*cells)[i]);
  if (kind == KIND_SOLID || kind == KIND_POWDER) {
    atomicAdd(&(*out)[0], 1);
  }
}
