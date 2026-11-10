// Fragment color for the world plane: looks up the cell under `uv` and shades it.
// Colors are authored in sRGB and converted to linear for three's output pipeline.
fn sandColor(
  cells: ptr<storage, array<u32>, read>,
  uv: vec2f,
  size: vec2u,
  time: f32,
) -> vec4f {
  let gx = min(u32(max(uv.x, 0.0) * f32(size.x)), size.x - 1u);
  let gy = min(u32(max(1.0 - uv.y, 0.0) * f32(size.y)), size.y - 1u);
  let cell = (*cells)[gy * size.x + gx];
  let m = cellMaterial(cell);

  var color: vec3f;
  if (m == MAT_EMPTY) {
    color = mix(vec3f(0.06, 0.08, 0.14), vec3f(0.12, 0.14, 0.22), f32(gy) / f32(size.y));
  } else {
    // Per-cell shade in [-1, 1], scaled by the material's grain.
    let s = f32(cellShade(cell)) / 127.5 - 1.0;
    color = MATERIAL_COLOR[m] * (1.0 + MATERIAL_GRAIN[m] * s);
    if (cellKind(cell) == KIND_LIQUID) {
      // Smooth travelling ripple, the same for neighbouring cells (no per-cell flicker).
      color *= 1.0 + 0.04 * sin(time * 2.0 + f32(gx) * 0.08 + f32(gy) * 0.05);
    }
  }
  return vec4f(pow(color, vec3f(2.2)), 1.0);
}
