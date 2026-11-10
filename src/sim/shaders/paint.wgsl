// Stamps a capsule-shaped brush stroke (segment strokeStart -> strokeEnd, with
// radius, in cell units) into the grid. One invocation per cell.
fn paintStroke(
  cells: ptr<storage, array<u32>, read_write>,
  index: u32,
  size: vec2u,
  strokeStart: vec2f,
  strokeEnd: vec2f,
  radius: f32,
  materialId: u32,
  seed: u32,
) -> void {
  if (index >= size.x * size.y) {
    return;
  }
  let p = vec2f(f32(index % size.x), f32(index / size.x)) + 0.5;

  let ab = strokeEnd - strokeStart;
  let t = clamp(dot(p - strokeStart, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  if (length(p - (strokeStart + ab * t)) > radius) {
    return;
  }

  if (materialId == MAT_EMPTY) {
    (*cells)[index] = MAT_EMPTY;
    return;
  }

  let h = hashPcg(index ^ hashPcg(seed));
  if (MATERIAL_KIND[materialId] != KIND_SOLID) {
    // Particles only fill empty space, and only sparsely.
    if (cellMaterial((*cells)[index]) != MAT_EMPTY || hashUnit(h) > MATERIAL_FILL[materialId]) {
      return;
    }
  }
  (*cells)[index] = makeCell(materialId, h >> 16u);  // random shade + flow direction
}
