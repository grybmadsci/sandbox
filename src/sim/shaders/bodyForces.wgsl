// Adds up the weight of powder piled on every rigid body (BODY_FORCE_INTS per slot,
// cleared by stamp.wgsl), for bodies.ts to apply: each body cell with powder resting on
// it is pushed down by the weight of the pile above it, up to BODY_MAX_LOAD cells. (Sand
// resting on the ground through other sand is ground the bodies collide with instead,
// solidMask.wgsl.) One invocation per cell of the chunks bodies are near (LIST_BODIES); the sums are integer atomics, so the result
// doesn't depend on the order. Liquids float bodies in bodyBuoyancy.wgsl.
fn bodyForces(
  cells: ptr<storage, array<u32>, read_write>,
  bodies: ptr<storage, array<f32>, read_write>,
  forces: ptr<storage, array<atomic<i32>>, read_write>,
  table: ptr<storage, array<u32>, read_write>,
  index: u32,
) -> void {
  let n = index / CHUNK_CELLS;
  if (n >= listCount(table, LIST_BODIES)) {
    return;
  }
  let chunk = listEntry(table, LIST_BODIES, n);
  let k = index % CHUNK_CELLS;
  let p = chunkOrigin(chunk) + vec2i(i32(k % CHUNK_SIZE), i32(k / CHUNK_SIZE));
  let cell = (*cells)[slotCell((*table)[chunk], p)];
  if (cellMaterial(cell) != MAT_BODY || cellKind(cellOrStone(cells, table, p - vec2i(0, 1))) != KIND_POWDER) {
    return;
  }
  let slot = cellShade(cell);
  if (slot >= MAX_BODIES) {
    return;
  }
  var load = 0.0;
  for (var up = 1; up <= BODY_MAX_LOAD; up++) {
    let above = cellOrStone(cells, table, p - vec2i(0, up));
    if (cellKind(above) != KIND_POWDER) {
      break;
    }
    load += MATERIAL_WEIGHT[cellMaterial(above)];
  }
  // Pushes down (+y) on the top of the cell; torque about the body's position.
  let base = slot * BODY_FLOATS;
  let r = vec2f(p) + vec2f(0.5, 0.0) - vec2f((*bodies)[base], (*bodies)[base + 1u]);
  let out = slot * BODY_FORCE_INTS;
  atomicAdd(&(*forces)[out + BODY_FORCE_Y], i32(round(load * BODY_FORCE_ONE)));
  atomicAdd(&(*forces)[out + BODY_TORQUE], i32(round(r.x * load * BODY_FORCE_ONE)));
}
