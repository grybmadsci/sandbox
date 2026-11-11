// Fragment color for the world plane: looks up the cell under `uv` and shades it.
// Colors are authored in sRGB and converted to linear for three's output pipeline.
// view 1 is the pressure view: liquid pressure (rows of liquid above, from the body's
// highest surface, plus the air pushing on it) on a log scale from 0 to 256 rows, with
// a contour every 16 rows; and the filtered air pressure liquids feel (GAUGE_AVERAGE) over
// darkened materials: no tint at one atmosphere, toward red up to two atmospheres and
// toward blue down to vacuum. Mining lasers' beams (laser.wgsl) are drawn over it all.
fn sandColor(
  cells: ptr<storage, array<u32>, read>,
  gauges: ptr<storage, array<i32>, read>,
  field: ptr<storage, array<u32>, read>,
  hops: ptr<storage, array<u32>, read>,
  bodies: ptr<storage, array<f32>, read>,
  lasers: ptr<storage, array<f32>, read>,
  laserHits: ptr<storage, array<f32>, read>,
  laserCount: u32,
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
  } else if (m == MAT_BODY) {
    // Rigid body: its own colour, with a grain that turns with it and a darker rim.
    var f: array<f32, BODY_FLOATS>;
    let base = min(cellShade(cell), MAX_BODIES - 1u) * BODY_FLOATS;
    for (var i = 0u; i < BODY_FLOATS; i++) {
      f[i] = (*bodies)[base + i];
    }
    let b = bodyFromFloats(f);
    let local = bodyLocal(b, vec2f(f32(gx), f32(gy)) + 0.5);
    let grain = select(sin(local.y * 1.7 + sin(local.x * 0.15) * 2.0), 0.0, b.isStatic);
    let speckle = hashUnit(hashPcg(u32(i32(floor(local.x)) + 4096) * 7919u + u32(i32(floor(local.y)) + 4096)));
    let rim = b.radius - bodyCoreDistance(b, local);
    color = b.color * (1.0 + 0.06 * grain + 0.06 * (speckle - 0.5)) * select(1.0, 0.65, rim < 1.5);
    // A laser's lens, at its tip.
    if (b.device == DEVICE_LASER && local.x > b.reach - 2.5 && abs(local.y) < 1.5) {
      color = vec3f(0.95, 0.22, 0.16) * (0.9 + 0.1 * sin(time * 9.0));
    }
  } else {
    // Per-cell shade in [-1, 1], scaled by the material's grain.
    let s = f32(cellShade(cell)) / 127.5 - 1.0;
    color = MATERIAL_COLOR[m] * (1.0 + MATERIAL_GRAIN[m] * s);
    if (m == MAT_STONE) {
      // Scorched by a laser, darker the closer it is to breaking.
      color *= 1.0 - 0.45 * f32(min(stoneDamage(cell), LASER_BREAK_DAMAGE)) / f32(LASER_BREAK_DAMAGE);
    }
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
  // Laser beams: a hot core with a glow, as far as each ray got (the rays span wider than
  // the beam is drawn), pulses running toward the target, a glow where each ray bites
  // into something, and sparks flying off it; the glow and sparks are brightest where the
  // beam itself lands, fading toward the edges of the band the rays cut.
  let at = vec2f(uv.x * f32(size.x), (1.0 - uv.y) * f32(size.y));
  const BEAM_HALF = 0.75;
  // Flying sparks: SPARK_COUNT per laser, each living SPARK_LIFE seconds (then born again
  // at another bite), flung back off the stone at SPARK_SPEED cells a second and falling;
  // none gets further than SPARK_FLIGHT cells from where it was born.
  const SPARK_COUNT = 24u;
  const SPARK_LIFE = 0.35;
  const SPARK_SPEED = vec2f(25.0, 70.0);
  const SPARK_GRAVITY = 120.0;
  const SPARK_FLIGHT = 28.0;
  let middle = f32(LASER_RAYS - 1u) * 0.5;
  // How bright the bite glow and sparks of ray r are: 1 at the middle ray, about 1/7 at
  // the outermost.
  let biteFalloff = 2.0 / (middle * middle);
  for (var k = 0u; k < laserCount; k++) {
    let base = k * LASER_FLOATS;
    let o = vec2f((*lasers)[base], (*lasers)[base + 1u]);
    let d = vec2f((*lasers)[base + 2u], (*lasers)[base + 3u]);
    let range = (*lasers)[base + 5u];
    let rel = at - o;
    let along = dot(rel, d);
    // Across the beam, the same way laser.wgsl offsets its rays.
    let side = d.x * rel.y - d.y * rel.x;
    if (abs(side) > middle + SPARK_FLIGHT) {
      continue;
    }
    let ray = u32(clamp(round(side + middle), 0.0, f32(LASER_RAYS - 1u)));
    let reach = (*laserHits)[k * LASER_RAYS + ray];
    let flicker = 0.85 + 0.15 * sin(along * 0.7 - time * 40.0);
    if (along >= 0.0 && along <= reach + 0.5 && abs(side) < BEAM_HALF + 1.25) {
      let glow = 1.0 - smoothstep(BEAM_HALF - 0.25, BEAM_HALF + 1.25, abs(side));
      let core = 1.0 - smoothstep(0.0, BEAM_HALF, abs(side));
      color = mix(color, vec3f(1.0, 0.25, 0.15), glow * 0.6 * flicker) + vec3f(1.0, 0.75, 0.6) * core * 0.5 * flicker;
    }
    var spark = 0.0;
    var nearest = range;
    var furthest = 0.0;
    for (var r = 0u; r < LASER_RAYS; r++) {
      let bitten = (*laserHits)[k * LASER_RAYS + r];
      if (bitten < range) {
        nearest = min(nearest, bitten);
        furthest = max(furthest, bitten);
        let bite = o + d * bitten + vec2f(-d.y, d.x) * (f32(r) - middle);
        let gap = dot(at - bite, at - bite);
        let sputter = 0.7 + 0.3 * sin(time * 63.0 + f32(r) * 2.1);
        let off = f32(r) - middle;
        let bright = exp(-off * off * biteFalloff);
        spark = max(spark, (exp(-gap / 14.0) * 0.8 + exp(-gap / 2.0)) * sputter * bright);
      }
    }
    color += vec3f(1.0, 0.8, 0.35) * spark;
    if (nearest >= range || along < nearest - SPARK_FLIGHT || along > furthest + SPARK_FLIGHT) {
      continue;
    }
    for (var i = 0u; i < SPARK_COUNT; i++) {
      // Each spark's lives are staggered, and each life picks its ray, angle and speed.
      let clock = time / SPARK_LIFE + f32(i) / f32(SPARK_COUNT);
      let age = fract(clock) * SPARK_LIFE;
      let h = hashPcg(hashPcg(u32(floor(clock)) ^ (i * 7919u)) ^ (k * 104729u));
      // Any ray's bite but the outermost two.
      let r = 1u + h % (LASER_RAYS - 2u);
      let bitten = (*laserHits)[k * LASER_RAYS + r];
      if (bitten >= range) {
        continue;
      }
      let bite = o + d * bitten + vec2f(-d.y, d.x) * (f32(r) - middle);
      // Back along the beam, up to 60 degrees either side.
      let turn = (hashUnit(hashPcg(h ^ 1u)) - 0.5) * 2.1;
      let speed = mix(SPARK_SPEED.x, SPARK_SPEED.y, hashUnit(hashPcg(h ^ 2u)));
      let v = -vec2f(d.x * cos(turn) - d.y * sin(turn), d.x * sin(turn) + d.y * cos(turn)) * speed;
      let tail = max(age - 0.02, 0.0);
      let head = bite + v * age + vec2f(0.0, 0.5 * SPARK_GRAVITY * age * age);
      let back = bite + v * tail + vec2f(0.0, 0.5 * SPARK_GRAVITY * tail * tail);
      // Drawn as a short streak, fading as it cools.
      let streak = head - back;
      let s = clamp(dot(at - back, streak) / max(dot(streak, streak), 1e-6), 0.0, 1.0);
      let gap = length(at - back - streak * s);
      let off = f32(r) - middle;
      let ember = (1.0 - smoothstep(0.25, 0.8, gap)) * (1.0 - age / SPARK_LIFE) * exp(-off * off * biteFalloff);
      color += vec3f(1.0, 0.7, 0.25) * ember * 1.5;
    }
  }
  return vec4f(pow(min(color, vec3f(1.0)), vec3f(2.2)), 1.0);
}
