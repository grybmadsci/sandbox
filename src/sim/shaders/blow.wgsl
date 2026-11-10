// Air brush: inside the capsule strokeStart -> strokeEnd (cell units), pumps in
// pressure and adds wind along the stroke. One invocation per air cell.
fn blowAir(
  air: ptr<storage, array<i32>, read_write>,
  index: u32,
  airSize: vec2u,
  strokeStart: vec2f,
  strokeEnd: vec2f,
  radius: f32,
  pressure: i32,
) -> void {
  if (index >= airSize.x * airSize.y) {
    return;
  }
  let i = index * 4u;
  let volume = (*air)[i + AIR_VOLUME];
  if (volume <= 0) {
    return;
  }
  let p = (vec2f(f32(index % airSize.x), f32(index / airSize.x)) + 0.5) * f32(AIR_CELL);

  let ab = strokeEnd - strokeStart;
  let t = clamp(dot(p - strokeStart, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  if (length(p - (strokeStart + ab * t)) > max(radius, f32(AIR_CELL))) {
    return;
  }

  // A drag of one cell per frame adds a quarter of AIR_ONE of wind.
  let gust = vec2i(ab * f32(AIR_ONE / 4));
  // Pump in `pressure` worth of air, up to a gauge pressure of AIR_MAX_P, never
  // clipping air that is already there.
  let mass = (*air)[i + AIR_MASS];
  let most = (AIR_AMBIENT + AIR_MAX_P) * volume / AIR_VOLUME_FULL;
  (*air)[i + AIR_MASS] = max(mass, min(mass + pressure * volume / AIR_VOLUME_FULL, most));
  (*air)[i + AIR_VX] = clamp((*air)[i + AIR_VX] + gust.x, -AIR_MAX_V, AIR_MAX_V);
  (*air)[i + AIR_VY] = clamp((*air)[i + AIR_VY] + gust.y, -AIR_MAX_V, AIR_MAX_V);
}
