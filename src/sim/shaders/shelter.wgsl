// Marks the cells inside shelters as out of the wind (step.wgsl skips the wind in their
// blocks): regions bodies declare in their own frame, like the inside of a truck's bucket.
// A moving body stirs up the air around it (and its load moves with it, carry.wgsl), so
// that wind would otherwise blow its load about. `shelters` holds `count` of them,
// SHELTER_FLOATS each (bodies.ts packShelters): 0-1 the body's position, 2-3 its rotation
// (cos, sin), 4-7 the region in its frame (min x, min y, max x, max y), 8-11 the cells it
// may cover (min x, min y, max x, max y). One bit per cell, in each slot's mask like
// solidMask.wgsl; one invocation per column of each live chunk (LIST_LIVE), writing all of
// its column's words.
fn markShelter(
  shelters: ptr<storage, array<f32>, read_write>,
  mask: ptr<storage, array<u32>, read_write>,
  table: ptr<storage, array<u32>, read_write>,
  index: u32,
  count: u32,
) -> void {
  let n = index / CHUNK_SIZE;
  if (n >= listCount(table, LIST_LIVE)) {
    return;
  }
  let chunk = listEntry(table, LIST_LIVE, n);
  let page = (*table)[chunk];
  let first = chunkOrigin(chunk);
  let column = (pageSlot(page) * CHUNK_SIZE + index % CHUNK_SIZE) * MASK_WORDS;
  for (var w = 0u; w < MASK_WORDS; w++) {
    (*mask)[column + w] = 0u;
  }
  let x = f32(first.x + i32(index % CHUNK_SIZE)) + 0.5;
  for (var e = 0u; e < count; e++) {
    let base = e * SHELTER_FLOATS;
    if (x < (*shelters)[base + 8u] || x > (*shelters)[base + 10u]) {
      continue;
    }
    let position = vec2f((*shelters)[base], (*shelters)[base + 1u]);
    let rotation = vec2f((*shelters)[base + 2u], (*shelters)[base + 3u]);
    let lo = vec2f((*shelters)[base + 4u], (*shelters)[base + 5u]);
    let hi = vec2f((*shelters)[base + 6u], (*shelters)[base + 7u]);
    let top = max(i32(floor((*shelters)[base + 9u])), first.y);
    let bottom = min(i32(ceil((*shelters)[base + 11u])), first.y + i32(CHUNK_SIZE) - 1);
    for (var y = top; y <= bottom; y++) {
      let d = vec2f(x, f32(y) + 0.5) - position;
      let local = vec2f(rotation.x * d.x + rotation.y * d.y, rotation.x * d.y - rotation.y * d.x);
      if (all(local >= lo) && all(local <= hi)) {
        let row = u32(y - first.y);
        (*mask)[column + row / 32u] |= 1u << (row % 32u);
      }
    }
  }
}
