// Fragment color for the world plane: looks up the cell under `uv` and shades it.
// Colors are authored in sRGB and converted to linear for three's output pipeline.
// view 1 is the pressure view: liquid pressure (rows of liquid above, from the body's
// highest surface, plus the air pushing on it) on a log scale from 0 to 256 rows, with
// a contour every 16 rows; and the filtered air pressure liquids feel (GAUGE_AVERAGE) over
// darkened materials: no tint at one atmosphere, toward red up to two atmospheres and
// toward blue down to vacuum.
fn sandColor(
  cells: ptr<storage, array<u32>, read>,
  gauges: ptr<storage, array<i32>, read>,
  field: ptr<storage, array<u32>, read>,
  hops: ptr<storage, array<u32>, read>,
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
  let sky = mix(vec3f(0.06, 0.08, 0.14), vec3f(0.12, 0.14, 0.22), f32(gy) / f32(size.y));

  var color: vec3f;
  if (m == MAT_EMPTY) {
    color = sky;
  } else {
    // Per-cell shade in [-1, 1], scaled by the material's grain.
    let s = f32(cellShade(cell)) / 127.5 - 1.0;
    color = MATERIAL_COLOR[m] * (1.0 + MATERIAL_GRAIN[m] * s);
    if (cellKind(cell) == KIND_LIQUID) {
      // Smooth travelling ripple, the same for neighbouring cells (no per-cell flicker).
      color *= 1.0 + 0.04 * sin(time * 2.0 + f32(gx) * 0.08 + f32(gy) * 0.05);
    }
  }

  // A pool's top row, when only partly full, is drawn as an even film as full as the
  // row is nearby, so loose cells sliding along it don't flicker. Only where the row
  // below is mostly liquid, so falling drops and streams stay crisp.
  if (gy + 1u < size.y && (cellKind(cell) == KIND_LIQUID || cellKind(cell) == KIND_EMPTY)) {
    var liquid = 0;
    var open = 0;
    var below = 0;
    var pool = MAT_EMPTY;
    for (var dx = -3; dx <= 3; dx++) {
      let x = i32(gx) + dx;
      if (x >= 0 && x < i32(size.x)) {
        let here = (*cells)[gy * size.x + u32(x)];
        let under = (*cells)[(gy + 1u) * size.x + u32(x)];
        if (cellKind(here) == KIND_LIQUID) {
          liquid++;
          pool = cellMaterial(here);
        }
        open += select(0, 1, cellKind(here) == KIND_LIQUID || cellKind(here) == KIND_EMPTY);
        if (cellKind(under) == KIND_LIQUID) {
          below++;
          pool = select(pool, cellMaterial(under), pool == MAT_EMPTY);
        }
      }
    }
    let above = select(MAT_EMPTY, (*cells)[(gy - 1u) * size.x + gx], gy > 0u);
    let surfaceRow = liquid > 0 && liquid < open && cellKind(above) != KIND_LIQUID;
    if (surfaceRow && below >= 5) {
      let fill = f32(liquid) / f32(open);
      color = mix(sky, MATERIAL_COLOR[pool], fill);
    }
  }

  if (view == 1u) {
    let a = airIndex(vec2i(i32(gx), i32(gy)) / i32(AIR_CELL), airSize);
    // -1 at vacuum, 0 at one atmosphere, 1 at two; square-rooted so small differences
    // still show.
    let relative = clamp(f32((*gauges)[gaugeIndex(a) + GAUGE_AVERAGE]) / f32(AIR_AMBIENT), -1.0, 1.0);
    let shown = sign(relative) * sqrt(abs(relative));
    color = color * 0.3 + vec3f(max(shown, 0.0), 0.0, max(-shown, 0.0)) * 0.7;
    let f = (*field)[gy * size.x + gx];
    if (cellKind(cell) == KIND_LIQUID && f != FIELD_NONE && fieldHead(f) != HEAD_INF) {
      // Rows of depth below the highest surface (the head, less what it gained crossing
      // columns), which already includes the air pushing on that surface.
      let highest = f32(fieldHead(f)) - f32(hopsCount((*hops)[gy * size.x + gx]));
      let depth = max(f32(gy) - highest / f32(HEAD_ONE) + f32(HEAD_BASE), 0.0);
      // Log scale, so shallow water (most of it) spreads over most of the colours.
      let t = clamp(log2(1.0 + depth / 8.0) / log2(33.0), 0.0, 1.0);
      color = pressureColor(t);
      // A thin contour every 16 rows of pressure.
      if (fract(depth / 16.0) < 1.0 / 16.0 && depth >= 1.0) {
        color *= 0.7;
      }
    }
  }
  return vec4f(pow(color, vec3f(2.2)), 1.0);
}
