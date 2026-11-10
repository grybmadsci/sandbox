// Dynamic pressure: one half of an air substep on the coarse air grid (see AIR_CELL),
// one invocation per air cell. Reads `src`, writes `dst`, so it is race-free.
//
// phase 0: fold the gauge pressure into what liquids feel (`gauges`, see GAUGE_FAST),
//          re-measure each cell's open volume, then update the flow on
//          each face.
// phase 2: the same without measuring (later substeps of a step; volumes don't change
//          between them).
// phase 1: move air across every face (airFlux).
//
// Each face's flow speeds up down the pressure difference across it and is slightly
// damped (diffusion in airFlux damps it too), so pressure waves cross about half an air
// cell per substep, and sloshing settles into still air. Still air is stiff (AIR_AMBIENT), so pressure has to even out quickly:
// AIR_SUBSTEPS substeps run per simulation step.
//
// Air mass is conserved exactly: each face's flux is one integer computed the same way
// by both cells beside it, so what one loses the other gains. The world edges are
// closed and nothing decays. A pocket that liquid or sand fills keeps all its air,
// compressed into the space that's left; a cell filled completely pushes its air out.
// The only sources are the air brush and a fill (which starts still air at ambient
// pressure).
fn airStep(
  cells: ptr<storage, array<u32>, read_write>,
  gauges: ptr<storage, array<i32>, read_write>,
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
  let g = gaugeIndex(i);
  var mass = (*src)[i + AIR_MASS];
  var slot = (*src)[i + AIR_VOLUME];
  var volume = airVolume(slot);

  // Neighbours: left, right, up, down. `inside` is false past the world edge.
  var dirs = array<vec2i, 4>(vec2i(-1, 0), vec2i(1, 0), vec2i(0, -1), vec2i(0, 1));
  var nj: array<u32, 4>;
  var inside: array<bool, 4>;
  for (var n = 0u; n < 4u; n++) {
    let q = ac + dirs[n];
    inside[n] = q.x >= 0 && q.y >= 0 && q.x < i32(airSize.x) && q.y < i32(airSize.y);
    nj[n] = airIndex(q, airSize);
  }

  if (phase == 1u) {
    // Net flow out through all four faces. airFlux(a, b) is positive from a to b.
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
    // This cell's recent net outflow, for bulk viscosity (read in the other phases).
    let outward = (*src)[i + AIR_VX] - select(0, (*src)[nj[0] + AIR_VX], inside[0])
      + (*src)[i + AIR_VY] - select(0, (*src)[nj[2] + AIR_VY], inside[2]);
    let usual = (*gauges)[g + GAUGE_SPREAD];
    let toUsual = outward - usual;
    (*gauges)[g + GAUGE_SPREAD] = usual + select(toUsual / AIR_SPREAD_STEPS, sign(toUsual), abs(toUsual) < AIR_SPREAD_STEPS);
    (*dst)[i + AIR_VX] = (*src)[i + AIR_VX];
    (*dst)[i + AIR_VY] = (*src)[i + AIR_VY];
    (*dst)[i + AIR_VOLUME] = slot;
    return;
  }

  if (phase == 0u) {
    // Pressure waves ring through stiff air whenever material moves; liquids feel a
    // filtered gauge (see GAUGE_FAST) that keeps steady pressure (a sealed pocket,
    // suction, pumping) and drops the ringing and churn. Sampled before re-measuring
    // the volume: the air has had the last step's substeps to settle into the old volume.
    // Skipped until the smoothed volume has caught up with the real one: a cell that
    // liquid has just uncovered is nearly empty of air while it refills, and that brief
    // vacuum isn't the pressure the surface below it should feel.
    if (volume > 0 && airSoftVolume(slot) * 4 >= volume * 64 * 3) {
      let fast = (*gauges)[g + GAUGE_FAST];
      let toFast = airGauge(mass, slot) - fast;
      let newFast = fast + select(toFast / AIR_GAUGE_FAST, sign(toFast), abs(toFast) < AIR_GAUGE_FAST);
      // Adaptive average with trend: project the trend, then close part of the gap.
      let average = (*gauges)[g + GAUGE_AVERAGE];
      var trend = (*gauges)[g + GAUGE_TREND];
      let projected = average + trend / 16;
      let toAverage = newFast - projected;
      let steps = clamp(AIR_GAUGE_SLOW * AIR_GAUGE_KNEE / max(abs(toAverage), 1), AIR_GAUGE_FAST, AIR_GAUGE_SLOW);
      let newAverage = projected + select(toAverage / steps, sign(toAverage), abs(toAverage) < steps);
      trend -= trend / AIR_GAUGE_FADE;
      trend += ((newFast - fast) * 16 - trend) / AIR_GAUGE_TREND;
      (*gauges)[g + GAUGE_FAST] = newFast;
      (*gauges)[g + GAUGE_AVERAGE] = newAverage;
      (*gauges)[g + GAUGE_TREND] = trend;
    }

    // Open volume: sand cells that are empty or gas (outside the world counts as
    // solid). Falling: grains and drops with open space below them.
    var open = 0;
    var falling = 0;
    for (var dy = 0; dy < i32(AIR_CELL); dy++) {
      for (var dx = 0; dx < i32(AIR_CELL); dx++) {
        let p = ac * i32(AIR_CELL) + vec2i(dx, dy);
        if (inGrid(p, size)) {
          let k = cellKind((*cells)[gridIndex(p, size)]);
          let below = p + vec2i(0, 1);
          if (k == KIND_EMPTY || k == KIND_GAS) {
            open += 1;
          } else if ((k == KIND_LIQUID || k == KIND_POWDER) && inGrid(below, size)) {
            let kb = cellKind((*cells)[gridIndex(below, size)]);
            falling += select(0, 1, kb == KIND_EMPTY || kb == KIND_GAS);
          }
        }
      }
    }
    if (volume < 0) {
      // First step after a fill: still air at ambient pressure.
      mass = AIR_AMBIENT * open / AIR_VOLUME_FULL;
    }
    volume = open;
    // The smoothed volume follows the real one, a step at least 1 toward it.
    var soft = open * 64;
    if (slot >= 0) {
      let previous = airSoftVolume(slot);
      let gap = soft - previous;
      soft = previous + select(gap / AIR_SOFTEN, sign(gap), abs(gap) < AIR_SOFTEN);
    }
    if (open > 0) {
      soft = max(soft, 1);
    }
    slot = airSlot(open, falling, soft);
  }
  let pressure = airPressure(mass, slot);

  // Each face's flow: pushed by the pressure difference across the face (through the
  // smaller opening), damped, and with bulk viscosity: a drag on compression only, so
  // pressure waves (which squeeze and stretch the air) die out within a few hundred
  // cells, while a steady stream (say, venting a draining vessel) flows on. No shear
  // viscosity: air slides freely along walls, so it can stream through a narrow pipe.
  // Zero at walls.
  let own = vec2i((*src)[i + AIR_VX], (*src)[i + AIR_VY]);
  let fromLeft = select(0, (*src)[nj[0] + AIR_VX], inside[0]);
  let fromAbove = select(0, (*src)[nj[2] + AIR_VY], inside[2]);
  let spread = own.x - fromLeft + own.y - fromAbove;  // net outflow (divergence)
  var flow = vec2i(0);
  if (volume > 0) {
    for (var axis = 0u; axis < 2u; axis++) {
      let ahead = 1u + axis * 2u;  // right for x, down for y
      let j = nj[ahead];
      let volumeAhead = airVolume((*src)[j + AIR_VOLUME]);
      if (inside[ahead] && volumeAhead > 0) {
        let opening = min(volume, volumeAhead);
        let difference = airPressure((*src)[j + AIR_MASS], (*src)[j + AIR_VOLUME]) - pressure;
        let push = difference / AIR_VOLUME_FULL * opening / 4;
        let previous = own[axis];
        // Net outflow of the cell ahead: its own faces minus what comes in from us and
        // from its other upstream neighbour (diagonal to us).
        let theirs = vec2i((*src)[j + AIR_VX], (*src)[j + AIR_VY]);
        let diagonal = ac + select(vec2i(-1, 1), vec2i(1, -1), axis == 0u);
        let inGridDiagonal = diagonal.x >= 0 && diagonal.y >= 0
          && diagonal.x < i32(airSize.x) && diagonal.y < i32(airSize.y);
        let d = airIndex(diagonal, airSize);
        var spreadAhead = theirs.x + theirs.y - previous;
        spreadAhead -= select(0, (*src)[d + AIR_VX + 1u - axis], inGridDiagonal);
        // Against each side's usual net outflow, so only changes are damped.
        let usualAhead = (*gauges)[gaugeIndex(j) + GAUGE_SPREAD];
        let usual = (*gauges)[g + GAUGE_SPREAD];
        let bulk = ((spreadAhead - usualAhead) - (spread - usual)) / AIR_BULK;
        // Damping that always takes at least 1, so slow flows still settle to rest.
        let damping = select(previous / AIR_DAMP, sign(previous), abs(previous) < AIR_DAMP);
        var f = previous - damping - push + bulk;
        // Falling grains and drops drag the air along toward their own speed, a cell
        // per step when the whole cell is falling (entrainment).
        let falling = select(0, airFalling(slot), axis == 1u);
        if (falling > 0) {
          let goal = airFlowForWind(AIR_ONE * falling / AIR_VOLUME_FULL);
          f += (goal - f) * falling / AIR_ENTRAIN;
        }
        // As wide as the opening is now: when material narrows a face, the air that was
        // streaming through it mustn't keep cramming into the smaller space (that pumps
        // energy into the air with every grain that moves).
        let most = AIR_MAX_FLOW / AIR_VOLUME_FULL * opening;
        flow[axis] = clamp(f, -most, most);
      }
    }
  }
  (*dst)[i + AIR_MASS] = mass;
  (*dst)[i + AIR_VX] = flow.x;
  (*dst)[i + AIR_VY] = flow.y;
  (*dst)[i + AIR_VOLUME] = slot;
}
