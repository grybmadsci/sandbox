// Dynamic pressure: one half of an air step on the coarse air grid (see AIR_CELL),
// one invocation per air cell. Reads `src`, writes `dst`, so it is race-free.
//
// Velocities are staggered: AIR_VX is the flow through a cell's right face, AIR_VY
// through its bottom face.
//
// phase 0: re-measure each cell's open volume, then accelerate the wind on each face
//          down the pressure difference across it.
// phase 1: move air across every face (airFlux): carried by the wind, and diffusing.
//
// Air mass is conserved exactly: each face's flux is one integer computed the same
// way by both cells beside it, so what one loses the other gains. The world edges
// are closed and nothing decays. A pocket that liquid or sand fills keeps all its air,
// compressed into the space that's left; a cell filled completely pushes its air out.
// The only sources are the air brush and a fill (which starts still air at ambient
// pressure). The wind is damped, so sloshing settles into still air.
fn airStep(
  cells: ptr<storage, array<u32>, read_write>,
  src: ptr<storage, array<i32>, read_write>,
  dst: ptr<storage, array<i32>, read_write>,
  index: u32,
  size: vec2u,
  airSize: vec2u,
  phase: u32,
) -> void {
  if (index >= airSize.x * airSize.y) {
    return;
  }
  let ac = vec2i(i32(index % airSize.x), i32(index / airSize.x));
  let i = index * 4u;
  var mass = (*src)[i + AIR_MASS];

  // Neighbours: left, right, up, down. `inside` is false past the world edge.
  var dirs = array<vec2i, 4>(vec2i(-1, 0), vec2i(1, 0), vec2i(0, -1), vec2i(0, 1));
  var nj: array<u32, 4>;
  var inside: array<bool, 4>;
  for (var n = 0u; n < 4u; n++) {
    let q = ac + dirs[n];
    inside[n] = q.x >= 0 && q.y >= 0 && q.x < i32(airSize.x) && q.y < i32(airSize.y);
    nj[n] = airIndex(q, airSize);
  }

  if (phase == 0u) {
    // Open volume: sand cells that are empty or gas (outside the world counts as solid).
    var volume = 0;
    for (var dy = 0; dy < i32(AIR_CELL); dy++) {
      for (var dx = 0; dx < i32(AIR_CELL); dx++) {
        let p = ac * i32(AIR_CELL) + vec2i(dx, dy);
        if (inGrid(p, size)) {
          let k = cellKind((*cells)[gridIndex(p, size)]);
          volume += select(0, 1, k == KIND_EMPTY || k == KIND_GAS);
        }
      }
    }
    if ((*src)[i + AIR_VOLUME] < 0) {
      // First step after a fill: still air at ambient pressure.
      mass = AIR_AMBIENT * volume / AIR_VOLUME_FULL;
    }
    let pressure = airPressure(mass, volume);

    // Each face's velocity: smoothed with the same component next door (viscosity),
    // pushed by the pressure difference across the face, damped. Zero at walls.
    var velocity = vec2i(0);
    if (volume > 0) {
      for (var axis = 0u; axis < 2u; axis++) {
        let ahead = 1u + axis * 2u;  // right for x, down for y
        let j = nj[ahead];
        if (inside[ahead] && (*src)[j + AIR_VOLUME] > 0) {
          let c = AIR_VX + axis;
          var sum = (*src)[i + c] * 12;
          for (var n = 0u; n < 4u; n++) {
            if (inside[n]) {
              sum += (*src)[nj[n] + c];
            }
          }
          let difference = airPressure((*src)[j + AIR_MASS], (*src)[j + AIR_VOLUME]) - pressure;
          velocity[axis] = clamp((sum / 16 - difference / 4) * 63 / 64, -AIR_MAX_V, AIR_MAX_V);
        }
      }
    }
    (*dst)[i + AIR_MASS] = mass;
    (*dst)[i + AIR_VX] = velocity.x;
    (*dst)[i + AIR_VY] = velocity.y;
    (*dst)[i + AIR_VOLUME] = volume;
    return;
  }

  // phase 1: net flow out through all four faces. airFlux(a, b) is positive from a to b.
  var outflow = 0;
  for (var n = 0u; n < 4u; n++) {
    if (inside[n]) {
      if (n == 0u || n == 2u) {
        outflow -= airFlux(src, nj[n], i, n / 2u);
      } else {
        outflow += airFlux(src, i, nj[n], n / 2u);
      }
    }
  }
  (*dst)[i + AIR_MASS] = mass - outflow;
  (*dst)[i + AIR_VX] = (*src)[i + AIR_VX];
  (*dst)[i + AIR_VY] = (*src)[i + AIR_VY];
  (*dst)[i + AIR_VOLUME] = (*src)[i + AIR_VOLUME];
}
