// Mining lasers (objects.ts): each fires LASER_RAYS parallel rays, a cell apart, from
// its tip along its direction. A ray passes through empty space, gases, liquids,
// powder and its own body, and stops at the first stone cell, other body or the edge
// of the world. It bites LASER_DEPTH cells deep: the stone it stops at takes a step's
// damage, and the stone right behind it along the ray LASER_DEPTH_FALLOFF as much per
// cell deeper; the two outermost rays (the band's edges) do LASER_EDGE_DAMAGE as much.
// Stone decomposes after LASER_BREAK_STEPS of full hits (3 seconds): into sand, or
// 2 times in 5 into nothing, so the sand takes up less room than the stone did. The
// sand is shot through, so the beam keeps digging.
// When `mine` is 0 (paused) it only traces, for drawing. Writes how far each ray got
// (cells) to `hits`, for render.wgsl. One invocation per ray.
fn fireLasers(
  cells: ptr<storage, array<u32>, read_write>,
  lasers: ptr<storage, array<f32>, read_write>,
  hits: ptr<storage, array<f32>, read_write>,
  index: u32,
  size: vec2u,
  count: u32,
  seed: u32,
  mine: u32,
) -> void {
  const LASER_MAX_CELLS = 1024;
  // Chance (16-bit) that broken stone vanishes instead of leaving sand: 40%.
  const LASER_VANISH_CHANCE = 26214u;
  // Stone cells in a row a ray damages, from where it lands, and how much less damage
  // each cell deeper takes than the one before it.
  const LASER_DEPTH = 3u;
  const LASER_DEPTH_FALLOFF = 0.5;
  // How much damage the outermost rays do, next to the others.
  const LASER_EDGE_DAMAGE = 0.5;
  let laser = index / LASER_RAYS;
  if (laser >= count) {
    return;
  }
  let base = laser * LASER_FLOATS;
  let d = vec2f((*lasers)[base + 2u], (*lasers)[base + 3u]);
  let slot = u32((*lasers)[base + 4u]);
  let range = (*lasers)[base + 5u];
  let ray = index % LASER_RAYS;
  let across = f32(ray) - f32(LASER_RAYS - 1u) * 0.5;
  let start = vec2f((*lasers)[base], (*lasers)[base + 1u]) + vec2f(-d.y, d.x) * across;

  // Walk the cells the ray crosses, in order (Amanatides & Woo).
  var p = vec2i(floor(start));
  let stride = vec2i(select(-1, 1, d.x >= 0.0), select(-1, 1, d.y >= 0.0));
  let delta = vec2f(
    select(1e9, 1.0 / abs(d.x), abs(d.x) > 1e-6),
    select(1e9, 1.0 / abs(d.y), abs(d.y) > 1e-6),
  );
  let into = start - floor(start);
  var next = vec2f(
    select(into.x, 1.0 - into.x, d.x >= 0.0) * delta.x,
    select(into.y, 1.0 - into.y, d.y >= 0.0) * delta.y,
  );
  var t = 0.0;
  var hit = range;
  var bitten = 0u;
  for (var n = 0; n < LASER_MAX_CELLS && t < range; n++) {
    if (!inGrid(p, size)) {
      hit = min(hit, t);
      break;
    }
    let i = gridIndex(p, size);
    let cell = (*cells)[i];
    let m = cellMaterial(cell);
    if (m == MAT_STONE) {
      hit = min(hit, t);
      if (mine != 0u) {
        let edge = select(1.0, LASER_EDGE_DAMAGE, ray == 0u || ray == LASER_RAYS - 1u);
        let hurt = u32(round(f32(LASER_DAMAGE_ONE) * pow(LASER_DEPTH_FALLOFF, f32(bitten)) * edge));
        let damage = stoneDamage(cell) + hurt;
        if (damage >= LASER_BREAK_DAMAGE) {
          let h = hashPcg(i ^ hashPcg(seed));
          (*cells)[i] = select(makeCell(MAT_SAND, h >> 16u), MAT_EMPTY, chance16(h, LASER_VANISH_CHANCE));
        } else {
          (*cells)[i] = withStoneDamage(cell, damage);
        }
      }
      bitten++;
      if (bitten == LASER_DEPTH) {
        break;
      }
    } else if (bitten > 0u || (m == MAT_BODY && cellShade(cell) != slot)) {
      // Past the stone it landed on (only stone right behind it is bitten), or blocked.
      hit = min(hit, t);
      break;
    }
    if (next.x < next.y) {
      t = next.x;
      next.x += delta.x;
      p.x += stride.x;
    } else {
      t = next.y;
      next.y += delta.y;
      p.y += stride.y;
    }
  }
  (*hits)[index] = min(hit, range);
}
