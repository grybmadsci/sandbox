// Static (hydrostatic) pressure. One invocation per column, walking it top to bottom
// one vertical run of liquid at a time, so a whole run is handled in one go with no
// races. Reads the pressure field of neighbouring columns from `fieldIn` (the
// previous pass) and writes this column's to `fieldOut`.
//
// - Head: the row of the highest free surface of the run's liquid body. A run's own
//   free surface counts, and neighbouring runs pass theirs on (plus 1/HEAD_ONE row
//   per hop). Values are never passed back the way they came ("split horizon"), so a
//   surface that drops isn't held up by its own old head echoing back.
// - Sink: a run whose free surface sits PUSH_ROWS or more below the head; pressure
//   pushes it up. Every run also knows its hop distance to the nearest sink.
// - Donor: a run whose free surface is the head (the body's highest surface). While
//   a sink is reachable, it gives up its top cell as credit: liquid in transit.
// - Credit is gathered into the run cell next to the neighbour nearest a sink, and
//   flow.wgsl hands it across, so it travels to the sink, which grows a cell per unit.
//
// - Air pressure above a free surface counts as extra liquid on top of it (AIR_ROW per
//   row), so a pressurised sealed arm pushes the liquid up in the open one.
//
// Net effect: connected vessels level out, and liquid volume (cells + credit) is
// conserved exactly. A stale field only stalls the transfer, it can't create liquid.
fn pressureColumn(
  cells: ptr<storage, array<u32>, read_write>,
  air: ptr<storage, array<i32>, read_write>,
  fieldIn: ptr<storage, array<u32>, read_write>,
  fieldOut: ptr<storage, array<u32>, read_write>,
  index: u32,
  size: vec2u,
  airSize: vec2u,
) -> void {
  const PUSH_ROWS = 3u;
  // A donor stops giving once its run holds this much credit (limits liquid in transit).
  const CREDIT_CAP = 4u;
  if (index >= size.x) {
    return;
  }
  let w = size.x;
  let h = i32(size.y);
  let hasLeft = index > 0u;
  let hasRight = index + 1u < w;

  var y = 0;
  loop {
    if (y >= h) {
      break;
    }
    let first = (*cells)[u32(y) * w + index];
    if (cellKind(first) != KIND_LIQUID) {
      let i = u32(y) * w + index;
      if ((*fieldOut)[i] != FIELD_NONE) {
        (*fieldOut)[i] = FIELD_NONE;
      }
      y++;
      continue;
    }

    // Scan the run: gather credit, the best head, and the exit toward the nearest sink.
    let m = cellMaterial(first);
    let top = y;
    var above = MAT_EMPTY;  // the top of the world is open
    if (top > 0) {
      above = (*cells)[u32(top - 1) * w + index];
    }
    let free = cellKind(above) == KIND_EMPTY || cellKind(above) == KIND_GAS;
    // The free surface's level (offset by HEAD_BASE rows), raised by the gauge pressure
    // of the air on it: the air pooled over nearby cells (3 across, in the surface's air
    // row and the one above), so single noisy air cells don't push the liquid around.
    // Partly filled cells (like those the surface ripples through) jump in pressure as
    // grains move, so only fully open cells are pooled when there are any; filled
    // cells have no volume and never count.
    var surface = (top + i32(HEAD_BASE)) * i32(HEAD_ONE);
    var airHead = 0;  // the air's push, in 1/HEAD_ONE rows
    if (free) {
      let around = vec2i(i32(index), top - 1) / i32(AIR_CELL);
      var pools = array<vec2i, 2>(vec2i(0), vec2i(0));  // (mass, volume): open cells, all cells
      for (var dy = -1; dy <= 0; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          let q = around + vec2i(dx, dy);
          if (q.x >= 0 && q.y >= 0 && q.x < i32(airSize.x)) {
            let a = airIndex(q, airSize);
            let cell = vec2i((*air)[a + AIR_MASS], (*air)[a + AIR_VOLUME]);
            if (cell.y > 0) {
              pools[1] += cell;
              if (cell.y == AIR_VOLUME_FULL) {
                pools[0] += cell;
              }
            }
          }
        }
      }
      let pool = select(pools[1], pools[0], pools[0].y > 0);
      if (pool.y > 0) {
        let gauge = pool.x * AIR_VOLUME_FULL / pool.y - AIR_AMBIENT;
        airHead = clamp(gauge, -AIR_MAX_P, AIR_MAX_P) * i32(HEAD_ONE) / AIR_ROW;
        surface -= airHead;
      }
    }
    let level = u32(clamp(surface, 0, i32(FIELD_INF) - 1));
    var head = select(FIELD_INF, level, free);
    var headFrom = FROM_SELF;
    var distance = FIELD_INF;
    var distanceFrom = FROM_SELF;
    var exitY = top;
    var credit = 0u;
    loop {
      if (y >= h) {
        break;
      }
      let j = u32(y) * w + index;
      let cell = (*cells)[j];
      if (cellMaterial(cell) != m) {
        break;
      }
      credit += cellCredit(cell);
      for (var side = 0u; side < 2u; side++) {
        if ((side == 0u && hasLeft) || (side == 1u && hasRight)) {
          let f = (*fieldIn)[select(j + 1u, j - 1u, side == 0u)];
          // The side a neighbour's value names if it came from us, and the side it is on.
          let fromUs = select(FROM_LEFT, FROM_RIGHT, side == 0u);
          let fromThem = select(FROM_RIGHT, FROM_LEFT, side == 0u);
          if (f != FIELD_NONE) {
            let h2 = min(fieldHead(f) + 1u, FIELD_INF);
            if (fieldHeadFrom(f) != fromUs && h2 < head) {
              head = h2;
              headFrom = fromThem;
            }
            let d2 = min(fieldDistance(f) + 1u, FIELD_INF);
            if (fieldDistanceFrom(f) != fromUs && d2 < distance) {
              distance = d2;
              distanceFrom = fromThem;
              exitY = y;
            }
          }
        }
      }
      y++;
    }
    let bottom = y - 1;

    let canGrow = free && top > 0 && cellMaterial(above) == MAT_EMPTY;
    // Strong air pressure is never perfectly even, so under it a surface must sit
    // further below the head to count as a sink (else ripples in one pressurised
    // vessel make sinks of its own columns, and they soak up all the credit).
    let slack = PUSH_ROWS * HEAD_ONE + u32(abs(airHead)) / 16u;
    let sink = canGrow && level >= head + slack;
    let donor = free && level <= head;
    if (sink) {
      distance = 0u;
      distanceFrom = FROM_SELF;
    }

    var newTop = top;
    if (credit > 0u && canGrow && (sink || distance == FIELD_INF)) {
      // Grow a cell from credit: pushed up at a sink, or handed back when no sink is left.
      (*cells)[u32(top - 1) * w + index] = withCredit(flipDirection(first), 0u);
      credit -= 1u;
      newTop = top - 1;
    } else if (donor && distance != FIELD_INF && credit < CREDIT_CAP && bottom > top) {
      // The highest surface gives up its top cell toward the sink.
      (*cells)[u32(top) * w + index] = MAT_EMPTY;
      (*fieldOut)[u32(top) * w + index] = FIELD_NONE;
      credit += 1u;
      newTop = top + 1;
    }
    // Credit waits at the top of a sink, or at the exit toward the nearest sink.
    let holder = select(max(exitY, newTop), newTop, sink || distance == FIELD_INF);

    // The holder takes all the credit it can; any excess (rare) waits in the other
    // cells of the run, which held at least that much between them before.
    let held = min(credit, CREDIT_MAX);
    var excess = credit - held;
    let f = makeField(head, headFrom, distance, distanceFrom);
    for (var yy = newTop; yy <= bottom; yy++) {
      let j = u32(yy) * w + index;
      let cell = (*cells)[j];
      var share = held;
      if (yy != holder) {
        share = min(excess, CREDIT_MAX);
        excess -= share;
      }
      let wanted = withCredit(cell, share);
      if (wanted != cell) {
        (*cells)[j] = wanted;
      }
      (*fieldOut)[j] = f;
    }
  }
}
