// Moves one chunk's state between a slot of the buffers (`slot`) and `data`, a flat array
// of 32-bit words laid out as in world/config.ts: its cells, its air (4 words per air
// cell) and its gauges (8). With `write` 0 it copies the slot out, with 1 in: the
// pressure field restarts.
fn chunkTransfer(
  cells: ptr<storage, array<u32>, read_write>,
  air: ptr<storage, array<i32>, read_write>,
  gauges: ptr<storage, array<i32>, read_write>,
  data: ptr<storage, array<i32>, read_write>,
  field: ptr<storage, array<u32>, read_write>,
  index: u32,
  slot: u32,
  write: u32,
) -> void {
  let airCells = AIR_SIDE * AIR_SIDE;
  if (index < CHUNK_CELLS) {
    let i = slot * CHUNK_CELLS + index;
    if (write != 0u) {
      (*cells)[i] = bitcast<u32>((*data)[index]);
      (*field)[i] = FIELD_NONE;
    } else {
      (*data)[index] = bitcast<i32>((*cells)[i]);
    }
    return;
  }
  // The air, then the gauges: words per air cell, and which part of the array this is.
  var k = index - CHUNK_CELLS;
  var stride = 4u;
  if (k >= airCells * 4u) {
    k -= airCells * 4u;
    stride = 8u;
  }
  if (k >= airCells * stride) {
    return;
  }
  let word = slot * airCells * stride + k;
  if (stride == 4u) {
    if (write != 0u) {
      (*air)[word] = (*data)[index];
    } else {
      (*data)[index] = (*air)[word];
    }
  } else {
    if (write != 0u) {
      (*gauges)[word] = (*data)[index];
    } else {
      (*data)[index] = (*gauges)[word];
    }
  }
}
