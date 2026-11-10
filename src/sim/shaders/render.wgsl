// Fragment color for the world plane: looks up the cell under `uv` and shades it.
// Colors are authored in sRGB and converted to linear for three's output pipeline.
// view 1 is the pressure view: liquid pressure (depth below the body's highest
// surface) as a heat map, air pressure as red (high) / blue (low) over darkened materials.
fn sandColor(
  cells: ptr<storage, array<u32>, read>,
  air: ptr<storage, array<i32>, read>,
  field: ptr<storage, array<u32>, read>,
  uv: vec2f,
  size: vec2u,
  airSize: vec2u,
  time: f32,
  view: u32,
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

  if (view == 1u) {
    let a = airIndex(vec2i(i32(gx), i32(gy)) / i32(AIR_CELL), airSize);
    // Soft-saturating, so sealed high-pressure pockets stay readable: p / (|p| + 4).
    let p = f32(airGauge((*air)[a + AIR_MASS], (*air)[a + AIR_VOLUME])) / f32(AIR_ONE);
    let shown = p / (abs(p) + 4.0);
    color = color * 0.3 + vec3f(max(shown, 0.0), 0.0, max(-shown, 0.0));
    let f = (*field)[gy * size.x + gx];
    if (cellKind(cell) == KIND_LIQUID && f != FIELD_NONE) {
      // Pressure in rows of depth: dark at the surface (or with no free surface), bright deep down.
      let depth = f32(gy) - f32(fieldHead(f)) / f32(HEAD_ONE) + f32(HEAD_BASE);
      color = mix(vec3f(0.05, 0.1, 0.3), vec3f(1.0, 0.95, 0.4), clamp(depth / 160.0, 0.0, 1.0));
    }
  }
  return vec4f(pow(color, vec3f(2.2)), 1.0);
}
