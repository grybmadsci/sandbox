// Floats rigid bodies (Archimedes). A body cell displaces liquid when its row of the
// body is in liquid: the cell just past the body's edge along the row, on the nearer
// side, holds liquid. It is then pushed up by the weight of that liquid, at the cell,
// so the push also turns a body upright about its centre of buoyancy. Unlike adding up
// the pressure on its faces, this floats a body resting on the bottom (with no liquid
// under it) too, and it only follows the liquid actually beside each row, so a few
// drops beside a body barely lift it and a gap the liquid hasn't filled yet doesn't.
// Also counts the body's cells, and how many are submerged (for the liquid's drag,
// bodies.ts). One invocation per cell.
fn bodyBuoyancy(
  cells: ptr<storage, array<u32>, read_write>,
  bodies: ptr<storage, array<f32>, read_write>,
  forces: ptr<storage, array<atomic<i32>>, read_write>,
  index: u32,
  size: vec2u,
) -> void {
  if (index >= size.x * size.y) {
    return;
  }
  let cell = (*cells)[index];
  if (cellMaterial(cell) != MAT_BODY) {
    return;
  }
  let slot = cellShade(cell);
  if (slot >= MAX_BODIES) {
    return;
  }
  let out = slot * BODY_FORCE_INTS;
  atomicAdd(&(*forces)[out + BODY_CELLS], 1);

  // What lies just past the body along this row, on each side (outside the grid is
  // stone), and how far away.
  let p = vec2i(i32(index % size.x), i32(index / size.x));
  var past = array<u32, 2>(MAT_STONE, MAT_STONE);
  var reach = array<i32, 2>(0, 0);
  for (var i = 0; i < 2; i++) {
    let side = i * 2 - 1;
    var x = p.x + side;
    while (x >= 0 && x < i32(size.x) && (*cells)[gridIndex(vec2i(x, p.y), size)] == cell) {
      x += side;
    }
    reach[i] = abs(x - p.x);
    if (x >= 0 && x < i32(size.x)) {
      past[i] = (*cells)[gridIndex(vec2i(x, p.y), size)];
    }
  }
  // The nearer side decides, so where a tilted body's row crosses the surface only its
  // lower end is under; the other side if the nearer one is a wall.
  var near = select(1, 0, reach[0] <= reach[1]);
  if (cellKind(past[near]) == KIND_SOLID) {
    near = 1 - near;
  }
  if (cellKind(past[near]) != KIND_LIQUID) {
    return;
  }
  let lift = MATERIAL_WEIGHT[cellMaterial(past[near])];
  atomicAdd(&(*forces)[out + BODY_SUBMERGED], 1);
  let base = slot * BODY_FLOATS;
  let r = vec2f(p) + 0.5 - vec2f((*bodies)[base], (*bodies)[base + 1u]);
  // Up is -y: force (0, -lift), torque r x force.
  atomicAdd(&(*forces)[out + BODY_FORCE_Y], -i32(round(lift * BODY_FORCE_ONE)));
  atomicAdd(&(*forces)[out + BODY_TORQUE], -i32(round(r.x * lift * BODY_FORCE_ONE)));
}
