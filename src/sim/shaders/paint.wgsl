// Stamps a capsule-shaped brush stroke (segment strokeStart -> strokeEnd, with
// radius, in cell units) into the grid. One invocation per cell of the stroke's bounds
// (`boxX`, `boxY`: its first cell, `boxWidth`: cells across), in the chunks with a slot.
fn paintStroke(
  cells: ptr<storage, array<u32>, read_write>,
  table: ptr<storage, array<u32>, read_write>,
  index: u32,
  boxX: i32,
  boxY: i32,
  boxWidth: i32,
  strokeStart: vec2f,
  strokeEnd: vec2f,
  radius: f32,
  materialId: u32,
  seed: u32,
) -> void {
  let cell = vec2i(boxX, boxY) + vec2i(i32(index) % boxWidth, i32(index) / boxWidth);
  let p = vec2f(cell) + 0.5;

  let ab = strokeEnd - strokeStart;
  let t = clamp(dot(p - strokeStart, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  if (length(p - (strokeStart + ab * t)) > radius) {
    return;
  }
  let i = cellIndex(table, cell);
  if (i == CELL_NONE) {
    return;
  }

  // Rigid bodies own their cells (stamp.wgsl); the eraser removes whole bodies (bodies.ts).
  if (cellMaterial((*cells)[i]) == MAT_BODY) {
    return;
  }
  if (materialId == MAT_EMPTY) {
    (*cells)[i] = MAT_EMPTY;
    return;
  }

  let h = hashPcg(worldCellId(cell) ^ hashPcg(seed));
  if (MATERIAL_KIND[materialId] != KIND_SOLID) {
    // Particles only fill empty space, and only sparsely.
    if (cellMaterial((*cells)[i]) != MAT_EMPTY || hashUnit(h) > MATERIAL_FILL[materialId]) {
      return;
    }
  }
  (*cells)[i] = makeCell(materialId, h >> 16u);  // random shade + flow direction
}
