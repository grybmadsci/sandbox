// Inspect tool: copies everything there is to know about the cell at `at` (world cells,
// y down) and its air cell into `out`, for the CPU to read back. One invocation.
//   0 cell, 1 field, 2 hops (packHops), 3 x, 4 y,
//   5 air mass, 6 flow x, 7 flow y, 8 volume slot,
//   9 fast gauge, 10 averaged gauge (what liquids feel), 11 1 if its chunk has a slot (else
//   the rest are empty)
fn inspectCell(
  cells: ptr<storage, array<u32>, read_write>,
  air: ptr<storage, array<i32>, read_write>,
  gauges: ptr<storage, array<i32>, read_write>,
  field: ptr<storage, array<u32>, read_write>,
  hops: ptr<storage, array<u32>, read_write>,
  out: ptr<storage, array<i32>, read_write>,
  table: ptr<storage, array<u32>, read_write>,
  index: u32,
  at: vec2f,
) -> void {
  if (index != 0u) {
    return;
  }
  let p = clamp(vec2i(floor(at)), vec2i(0), vec2i(i32(WORLD_SIZE) - 1));
  let i = cellIndex(table, p);
  (*out)[3] = p.x;
  (*out)[4] = p.y;
  if (i == CELL_NONE) {
    (*out)[0] = 0;
    (*out)[1] = bitcast<i32>(FIELD_NONE);
    (*out)[8] = -1;
    (*out)[11] = 0;
    return;
  }
  let a = airIndex(table, p / i32(AIR_CELL));
  let g = gaugeIndex(a);
  (*out)[0] = bitcast<i32>((*cells)[i]);
  (*out)[1] = bitcast<i32>((*field)[i]);
  (*out)[2] = bitcast<i32>((*hops)[i]);
  (*out)[5] = (*air)[a + AIR_MASS];
  (*out)[6] = (*air)[a + AIR_VX];
  (*out)[7] = (*air)[a + AIR_VY];
  (*out)[8] = (*air)[a + AIR_VOLUME];
  (*out)[9] = (*gauges)[g + GAUGE_FAST];
  (*out)[10] = (*gauges)[g + GAUGE_AVERAGE];
  (*out)[11] = 1;
}
