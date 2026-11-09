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
    let s = f32(cellShade(cell)) / 255.0;
    color = MATERIAL_COLOR[m] * (0.82 + 0.3 * s);
    if (cellKind(cell) == KIND_LIQUID) {
      color *= 0.95 + 0.08 * sin(time * 3.0 + f32(gx) * 0.15 + s * 6.28);
    }
  }
  return vec4f(pow(color, vec3f(2.2)), 1.0);
}
