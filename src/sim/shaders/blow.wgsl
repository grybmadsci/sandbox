// Air brush: inside the capsule strokeStart -> strokeEnd (cell units), pumps in
// pressure and adds wind along the stroke; with a negative `pressure` (the vacuum
// tool) it takes air out instead, down to none, without wind. One invocation per air
// cell of the stroke's bounds (`boxX`, `boxY`: its first air cell, `boxWidth`: air cells across), in the
// chunks with a slot.
fn blowAir(
  air: ptr<storage, array<i32>, read_write>,
  table: ptr<storage, array<u32>, read_write>,
  index: u32,
  boxX: i32,
  boxY: i32,
  boxWidth: i32,
  strokeStart: vec2f,
  strokeEnd: vec2f,
  radius: f32,
  pressure: i32,
) -> void {
  let q = vec2i(boxX, boxY) + vec2i(i32(index) % boxWidth, i32(index) / boxWidth);
  let i = airIndex(table, q);
  if (i == CELL_NONE) {
    return;
  }
  let volume = airVolume((*air)[i + AIR_VOLUME]);
  if (volume <= 0) {
    return;
  }
  let p = (vec2f(q) + 0.5) * f32(AIR_CELL);

  let ab = strokeEnd - strokeStart;
  let t = clamp(dot(p - strokeStart, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  if (length(p - (strokeStart + ab * t)) > max(radius, f32(AIR_CELL))) {
    return;
  }

  // A drag of one cell per frame adds a quarter of AIR_ONE of wind (pumping only).
  let gust = select(vec2i(0), vec2i(ab * f32(AIR_ONE / 4)), pressure > 0);
  let flow = vec2i(airFlowForWind(gust.x), airFlowForWind(gust.y));
  // Pump in `pressure` worth of air, up to a gauge pressure of AIR_MAX_P, never
  // clipping air that is already there; or take it out, down to none.
  let mass = (*air)[i + AIR_MASS];
  let change = pressure * volume / AIR_VOLUME_FULL;
  if (pressure >= 0) {
    let most = (AIR_AMBIENT + AIR_MAX_P) * volume / AIR_VOLUME_FULL;
    (*air)[i + AIR_MASS] = max(mass, min(mass + change, most));
  } else {
    (*air)[i + AIR_MASS] = max(min(mass, mass + change), 0);
  }
  (*air)[i + AIR_VX] = clamp((*air)[i + AIR_VX] + flow.x, -AIR_MAX_FLOW, AIR_MAX_FLOW);
  (*air)[i + AIR_VY] = clamp((*air)[i + AIR_VY] + flow.y, -AIR_MAX_FLOW, AIR_MAX_FLOW);
}
