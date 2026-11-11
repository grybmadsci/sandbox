// Packs the ground the rigid bodies collide with into bits for bodies.ts, which keeps a
// Rapier voxel collider in step with it: stone, and powder resting (through more
// powder) on stone or on a static body. Powder resting on a dynamic body isn't ground
// (it would hold the body down like a ceiling); its weight is a load instead
// (bodyForces.wgsl). Liquids, gases and bodies aren't ground.
//
// One invocation per column, walking it bottom to top. Bits are column-major: column x
// is words x * wordsPerColumn .. (x + 1) * wordsPerColumn - 1, bit y % 32 of word y / 32.
fn solidMask(
  cells: ptr<storage, array<u32>, read_write>,
  bodies: ptr<storage, array<f32>, read_write>,
  mask: ptr<storage, array<u32>, read_write>,
  index: u32,
  size: vec2u,
) -> void {
  if (index >= size.x) {
    return;
  }
  let words = (size.y + 31u) / 32u;
  var supported = true;  // below the world counts as stone
  for (var w = i32(words) - 1; w >= 0; w--) {
    var bits = 0u;
    for (var b = 31; b >= 0; b--) {
      let y = u32(w) * 32u + u32(b);
      if (y >= size.y) {
        continue;
      }
      let cell = (*cells)[y * size.x + index];
      let m = cellMaterial(cell);
      var solid = false;
      if (m == MAT_BODY) {
        let slot = min(cellShade(cell), MAX_BODIES - 1u);
        supported = (*bodies)[slot * BODY_FLOATS + 10u] != 0.0;
      } else if (cellKind(cell) == KIND_SOLID) {
        solid = true;
        supported = true;
      } else if (cellKind(cell) == KIND_POWDER) {
        solid = supported;
      } else {
        supported = false;
      }
      if (solid) {
        bits |= 1u << u32(b);
      }
    }
    (*mask)[index * words + u32(w)] = bits;
  }
}
