// Static (hydrostatic) pressure. One invocation per column, walking it top to bottom
// one vertical run of liquid at a time, so a whole run is handled in one go with no
// races. Reads the pressure field of neighbouring columns from `fieldIn` and `hopsIn`
// (the previous pass) and writes this column's to `fieldOut` and `hopsOut` (each head's
// hop count and the air push on the surface it came from, see packHops).
//
// - Head: the row of the highest free surface of the run's liquid body. A run's own
//   free surface counts, and neighbouring runs pass theirs on (plus 1/HEAD_ONE row
//   per hop, so nearer surfaces win and stale values fade). Values are never passed
//   back the way they came ("split horizon"), so a surface that drops isn't held up by
//   its own old head echoing back. Each head also carries how many hops it has come.
// - Sink: a run whose free surface sits PUSH_ROWS or more below the highest surface
//   (the head less its hops, so a long channel doesn't leave vessels uneven); pressure
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
//
// Cells in chunks that aren't live are skipped and left unwritten, in both directions of
// the ping-pong (so their field stays as it was), and read as walls by the cells beside them.
// Runs over the live chunks (LIST_LIVE), an invocation per column of each, walking down it
// from the chunk's top where pressureSplit.wgsl says the walk can start afresh there (else
// the walk from above carries on into it), on past chunks the walk carries on into, until
// it reaches one that isn't live or where a walk starts afresh. Heads count from the top
// row of each cell's chunk (see HEAD_BASE): a run works in its top cell's, and converts.
fn pressureColumn(
  cells: ptr<storage, array<u32>, read_write>,
  air: ptr<storage, array<i32>, read_write>,
  gauges: ptr<storage, array<i32>, read_write>,
  fieldIn: ptr<storage, array<u32>, read_write>,
  fieldOut: ptr<storage, array<u32>, read_write>,
  hopsIn: ptr<storage, array<u32>, read_write>,
  hopsOut: ptr<storage, array<u32>, read_write>,
  splits: ptr<storage, array<u32>, read_write>,
  table: ptr<storage, array<u32>, read_write>,
  index: u32,
) -> void {
  const PUSH_ROWS = 4u;
  // A donor stops giving once its run holds this much credit (limits liquid in transit).
  const CREDIT_CAP = 4u;
  // Most credit a cell holds while it waits at a sink, unless there is more to share.
  const CREDIT_SPREAD = 8u;
  if (index / CHUNK_SIZE >= listCount(table, LIST_LIVE)) {
    return;
  }
  let column = index % CHUNK_SIZE;
  let start = chunkOrigin(listEntry(table, LIST_LIVE, index / CHUNK_SIZE)) + vec2i(i32(column), 0);
  if ((*splits)[pageSlot(pageAt(table, start)) * CHUNK_SIZE + column] == 0u) {
    return;
  }
  let x = start.x;
  let h = i32(WORLD_SIZE);
  // The chunk row the walk is in, and where it is in the buffers (liveBases).
  var row = start.y / i32(CHUNK_SIZE);
  var bases = liveBases(table, x, start.y);

  var y = start.y;
  loop {
    if (y >= h) {
      break;
    }
    if (y / i32(CHUNK_SIZE) != row) {
      row = y / i32(CHUNK_SIZE);
      bases = liveBases(table, x, y);
    }
    // At the top of a chunk below (not reached in the middle of a run): if it isn't live,
    // or a walk starts afresh there, this walk is done.
    if (y % i32(CHUNK_SIZE) == 0 && y != start.y && (bases.y == CELL_NONE || (*splits)[bases.y / CHUNK_CELLS * CHUNK_SIZE + column] != 0u)) {
      break;
    }
    let i = liveAt(bases.y, y);
    let first = (*cells)[i];
    if (cellKind(first) != KIND_LIQUID) {
      // Written blind: in this serial walk a write is far cheaper than a read to check it.
      (*fieldOut)[i] = FIELD_NONE;
      y++;
      continue;
    }

    // Scan the run: gather credit, the best head, and the exit toward the nearest sink.
    let m = cellMaterial(first);
    let top = y;
    let topChunk = top / i32(CHUNK_SIZE);
    var above = MAT_EMPTY;  // the top of the world is open
    let aboveAt = liveCell(table, vec2i(x, top - 1));
    if (top > 0) {
      above = select(MAT_STONE, (*cells)[min(aboveAt, i)], aboveAt != CELL_NONE);
    }
    let openAbove = cellKind(above) == KIND_EMPTY || cellKind(above) == KIND_GAS;
    // The free surface's level (from its chunk's top row, offset by HEAD_BASE rows), raised by the gauge pressure
    // of the air on it: the time-averaged gauge (air.wgsl) pooled over nearby cells (3
    // across, in the surface's air row and the one above), weighted by open volume, so
    // single noisy air cells don't push the liquid around. Partly filled cells (like
    // those the surface ripples through) jump in pressure as grains move, so only fully
    // open cells are pooled when there are any; filled cells never count. A surface with
    // less than a full air cell's worth of open air around it (an air bubble in the
    // liquid, a thin gap under stone) isn't treated as a free surface at all: air cells
    // that are mostly filled give erratic pressures, and the liquid mustn't be pushed
    // into a gap whose air it can't feel. The run takes its head from its neighbours.
    var surface = (top - topChunk * i32(CHUNK_SIZE) + i32(HEAD_BASE)) * i32(HEAD_ONE);
    var airHead = 0;  // the air's push, in 1/HEAD_ONE rows
    var free = false;
    if (openAbove) {
      let around = vec2i(x, top - 1) / i32(AIR_CELL);
      // (gauge * volume, volume): fully open cells, all open cells.
      var pools = array<vec2i, 2>(vec2i(0), vec2i(0));
      for (var dy = -1; dy <= 0; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          let q = around + vec2i(dx, dy);
          let a = airIndex(table, q);
          if (a != CELL_NONE) {
            let volume = airVolume((*air)[a + AIR_VOLUME]);
            if (volume > 0) {
              // In 1/HEAD_ONE rows, so the volume-weighted sum fits in an i32.
              let cell = vec2i((*gauges)[gaugeIndex(a) + GAUGE_AVERAGE] / (AIR_ROW / i32(HEAD_ONE)) * volume, volume);
              pools[1] += cell;
              if (volume == AIR_VOLUME_FULL) {
                pools[0] += cell;
              }
            }
          }
        }
      }
      let pool = select(pools[1], pools[0], pools[0].y > 0);
      if (pool.y >= AIR_VOLUME_FULL) {
        free = true;
        let toHead = AIR_ROW / i32(HEAD_ONE);
        airHead = clamp(pool.x / pool.y, -AIR_AMBIENT / toHead, AIR_MAX_LIFT / toHead);
        surface -= airHead;
      }
    }
    let level = u32(clamp(surface, 0, i32(HEAD_INF) - 1));
    var head = select(HEAD_INF, level, free);
    var headFrom = FROM_SELF;
    var headHops = 0u;  // columns the head has come (each added 1/HEAD_ONE row to it)
    var headAir = airHead;  // the air's push on the surface the head came from
    var distance = DIST_INF;
    var distanceFrom = FROM_SELF;
    var exitY = top;
    var credit = 0u;
    loop {
      if (y >= h) {
        break;
      }
      if (y / i32(CHUNK_SIZE) != row) {
        row = y / i32(CHUNK_SIZE);
        bases = liveBases(table, x, y);
      }
      let j = liveAt(bases.y, y);
      if (j == CELL_NONE) {
        break;
      }
      let cell = (*cells)[j];
      if (cellMaterial(cell) != m) {
        break;
      }
      credit += cellCredit(cell);
      // Neighbours' heads count from their chunk's top: from the run's, they're this many chunks down.
      let down = u32(y / i32(CHUNK_SIZE) - topChunk);
      for (var side = 0u; side < 2u; side++) {
        let k = liveAt(select(bases.z, bases.x, side == 0u), y);
        if (k != CELL_NONE) {
          let f = (*fieldIn)[k];
          // The side a neighbour's value names if it came from us, and the side it is on.
          let fromUs = select(FROM_LEFT, FROM_RIGHT, side == 0u);
          let fromThem = select(FROM_RIGHT, FROM_LEFT, side == 0u);
          if (f != FIELD_NONE) {
            let h2 = select(min(fieldHead(f) + down * HEAD_CHUNK + 1u, HEAD_INF), HEAD_INF, fieldHead(f) >= HEAD_INF);
            if (fieldHeadFrom(f) != fromUs && h2 < head) {
              head = h2;
              headFrom = fromThem;
              headHops = hopsCount((*hopsIn)[k]) + 1u;
              headAir = hopsAir((*hopsIn)[k]);
            }
            let d2 = min(fieldDistance(f) + 1u, DIST_INF);
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

    // A hanging run (its bottom would sink into what is below it: falling water, a
    // stream pouring from a hole) isn't part of any body: it gets no field, so credit
    // is never routed into it, and flow.wgsl hands any credit it has back to resting
    // neighbours. Credit it still holds (it spilled over an edge with some) comes out
    // below it as falling water, one cell per pass, rather than piling up above it.
    var under = MAT_STONE;  // below the world, or a chunk that isn't live, counts as stone
    let underAt = liveCell(table, vec2i(x, y));
    let bottomAt = liveCell(table, vec2i(x, bottom));
    if (underAt != CELL_NONE) {
      under = (*cells)[underAt];
    }
    if (sinksInto((*cells)[bottomAt], under)) {
      if (credit > 0u && cellMaterial(under) == MAT_EMPTY) {
        (*cells)[underAt] = withCredit(flipDirection(first), 0u);
        (*fieldOut)[underAt] = FIELD_NONE;
        credit -= 1u;
        y++;  // the new cell joins this run next pass, not this one
      }
      let held = min(credit, CREDIT_MAX);
      var excess = credit - held;
      for (var yy = top; yy <= bottom; yy++) {
        let j = liveCell(table, vec2i(x, yy));
        let cell = (*cells)[j];
        var share = held;
        if (yy != bottom) {
          share = min(excess, CREDIT_MAX);
          excess -= share;
        }
        let wanted = withCredit(cell, share);
        if (wanted != cell) {
          (*cells)[j] = wanted;
        }
        if ((*fieldOut)[j] != FIELD_NONE) {
          (*fieldOut)[j] = FIELD_NONE;
        }
      }
      continue;
    }

    let canGrow = free && top > 0 && cellMaterial(above) == MAT_EMPTY;
    // Strong air pressure is never perfectly even, so under it a surface must sit
    // further below the head to count as a sink (else ripples in one pressurised
    // vessel make sinks of its own columns, and they soak up all the credit).
    let slack = PUSH_ROWS * HEAD_ONE + u32(abs(airHead)) / 16u;
    let highest = head - min(headHops, head);
    // Differences in air pressure up to AIR_SINK_DEADBAND between this surface and the
    // highest one are ignored: the air over one vessel is never perfectly even (and
    // draining or filling stirs it), and without this its own columns would make sinks
    // of each other. Larger differences (pumping, suction) count in full beyond that.
    let ignored = clamp(airHead - headAir, -AIR_SINK_DEADBAND, AIR_SINK_DEADBAND);
    let sink = canGrow && i32(level) + ignored >= i32(highest + slack);
    let donor = free && level <= head;
    if (sink) {
      distance = 0u;
      distanceFrom = FROM_SELF;
    }

    var newTop = top;
    if (credit > 0u && canGrow && (sink || distance == DIST_INF)) {
      // Grow a cell from credit: pushed up at a sink, or handed back when no sink is left.
      (*cells)[aboveAt] = withCredit(flipDirection(first), 0u);
      credit -= 1u;
      newTop = top - 1;
    } else if (donor && distance != DIST_INF && credit < CREDIT_CAP && bottom > top) {
      // The highest surface gives up its top cell toward the sink.
      (*cells)[i] = MAT_EMPTY;
      (*fieldOut)[i] = FIELD_NONE;
      credit += 1u;
      newTop = top + 1;
    }
    // Credit in transit waits at the exit toward the nearest sink, in one lump (so
    // flow.wgsl hands it all across). Credit waiting at a sink (or with no sink left) is
    // spread down the run instead, at most CREDIT_SPREAD a cell or an even share, so a
    // surface cell that flows or spills away carries little of it (the run gathers it
    // all again next pass anyway). The holder takes its part; the rest fills the other
    // cells of the run, which held at least that much between them before.
    let waiting = sink || distance == DIST_INF;
    let holder = select(max(exitY, newTop), newTop, waiting);
    let runCells = u32(bottom - newTop + 1);
    let perCell = select(CREDIT_MAX, max(CREDIT_SPREAD, (credit + runCells - 1u) / runCells), waiting);
    let held = min(credit, min(perCell, CREDIT_MAX));
    var excess = credit - held;
    for (var yy = newTop; yy <= bottom; yy++) {
      let j = liveCell(table, vec2i(x, yy));
      let cell = (*cells)[j];
      var share = held;
      if (yy != holder) {
        share = min(excess, min(perCell, CREDIT_MAX));
        excess -= share;
      }
      let wanted = withCredit(cell, share);
      if (wanted != cell) {
        (*cells)[j] = wanted;
      }
      (*fieldOut)[j] = makeField(headBelow(head, u32(yy / i32(CHUNK_SIZE) - topChunk)), headFrom, distance, distanceFrom);
      (*hopsOut)[j] = packHops(headHops, headAir);
    }
  }
}
