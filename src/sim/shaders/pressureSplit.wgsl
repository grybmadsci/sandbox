// Before each static-pressure pass (pressure.wgsl): marks where a column's walk can start
// afresh at the top of a live chunk, so the chunks of a column are walked in parallel
// rather than one after another. It can when the chunk above isn't live, or when neither
// the cell above the boundary nor the one below it is liquid as the pass starts: then no
// run crosses it, none grows up across it, none spills down across it, and nothing either
// side reads the other, so the walks either side do just what one walk would. Otherwise
// the walk from above carries on into the chunk. One invocation per column of each live
// chunk (LIST_LIVE); `splits` holds a word per column of each slot, 1 where it starts afresh.
fn pressureSplit(
  cells: ptr<storage, array<u32>, read_write>,
  splits: ptr<storage, array<u32>, read_write>,
  table: ptr<storage, array<u32>, read_write>,
  index: u32,
) -> void {
  let n = index / CHUNK_SIZE;
  if (n >= listCount(table, LIST_LIVE)) {
    return;
  }
  let chunk = listEntry(table, LIST_LIVE, n);
  let page = (*table)[chunk];
  let top = chunkOrigin(chunk) + vec2i(i32(index % CHUNK_SIZE), 0);
  let above = liveCell(table, top - vec2i(0, 1));
  var fresh = above == CELL_NONE;
  if (!fresh) {
    fresh = cellKind((*cells)[above]) != KIND_LIQUID && cellKind((*cells)[slotCell(page, top)]) != KIND_LIQUID;
  }
  (*splits)[pageSlot(page) * CHUNK_SIZE + index % CHUNK_SIZE] = select(0u, 1u, fresh);
}
