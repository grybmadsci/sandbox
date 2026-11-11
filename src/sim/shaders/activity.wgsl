// Sums up what each live chunk holds along every row and every column (ChunkManager
// compares the sums between scans to tell how much is moving). Each cell adds its
// material id + 1 (nothing for empty space) to its row's sum and its column's sum:
// 2 * CHUNK_SIZE counters per live chunk, in LIST_LIVE's order, rows then columns. Cells
// sliding along a row (a pool's surface, settled but never quite still) leave the row sums
// alone, while falling, filling and draining change them. Two passes:
//
// phase 0: clear the sums (one invocation per counter).
// phase 1: add up (one invocation per cell of the live chunks).
fn scanActivity(
  cells: ptr<storage, array<u32>, read_write>,
  sums: ptr<storage, array<atomic<u32>>, read_write>,
  table: ptr<storage, array<u32>, read_write>,
  index: u32,
  phase: u32,
) -> void {
  if (phase == 0u) {
    if (index < SLOT_COUNT * CHUNK_SIZE * 2u) {
      atomicStore(&(*sums)[index], 0u);
    }
    return;
  }
  let n = index / CHUNK_CELLS;
  if (n >= listCount(table, LIST_LIVE)) {
    return;
  }
  let page = (*table)[listEntry(table, LIST_LIVE, n)];
  let k = index % CHUNK_CELLS;
  let m = cellMaterial((*cells)[pageSlot(page) * CHUNK_CELLS + k]);
  if (m == MAT_EMPTY) {
    return;
  }
  let base = n * CHUNK_SIZE * 2u;
  atomicAdd(&(*sums)[base + k / CHUNK_SIZE], m + 1u);
  atomicAdd(&(*sums)[base + CHUNK_SIZE + k % CHUNK_SIZE], m + 1u);
}
