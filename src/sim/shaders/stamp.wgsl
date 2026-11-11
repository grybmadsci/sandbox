// Stamps the rigid bodies (bodies.ts) into the grid as MAT_BODY cells, and clears the
// cells they have left. One invocation per column, for the columns from range.x to
// range.y (where bodies are now or were last time), so the column can be rewritten in
// place with no races. Also clears the force sums (bodyForces.wgsl) for this step.
//
// Particles in the way are pushed up the column into the nearest cell left empty: a
// body sinking through water swaps it from below to above, and one pushed into a pool
// raises its level. If there is no room above, they go into the highest empty cells
// left below. A particle is only pushed out if there is somewhere for it to go (and at
// most DISPLACE_MAX at a time), otherwise the body leaves a hole for it, so nothing is
// ever lost. Stone is never overwritten.
//
// Powder resting on solid ground (stone or static bodies, through more powder) bears a
// body's weight up to its MATERIAL_BEARING: a body pressing harder (`pressures`, per
// slot, from bodies.ts) pushes it aside by chance, more often the more it is overloaded,
// up to YIELD_MAX a step at twice its bearing. Otherwise it stays put like stone, and the
// body stands on it (it is ground for the body's collider, solidMask.wgsl). So bodies sink
// in until they spread their weight enough, wide light ones not at all.
//
// Each column is walked serially by one thread, so the walks are kept short: only the
// rows where bodies are now (`bodies`) or were at the last stamp (`before`, the bodies
// as uploaded then) can change, plus the empty cells above that displaced particles go
// to; the room for them is only counted as far as anything could need. Columns where
// nothing has changed are skipped. Cells in chunks with no slot are as stone.
fn stampBodies(
  cells: ptr<storage, array<u32>, read_write>,
  bodies: ptr<storage, array<f32>, read_write>,
  before: ptr<storage, array<f32>, read_write>,
  pressures: ptr<storage, array<f32>, read_write>,
  forces: ptr<storage, array<atomic<i32>>, read_write>,
  table: ptr<storage, array<u32>, read_write>,
  index: u32,
  range: vec2u,
  seed: u32,
) -> void {
  const DISPLACE_MAX = 64u;
  const YIELD_MAX = 0.05;
  // Most particles a column can push out in one stamp: a body placed into a full column.
  const ROOM_ENOUGH = 128u;
  if (index < MAX_BODIES * BODY_FORCE_INTS) {
    atomicStore(&(*forces)[index], 0);
  }
  let x = range.x + index;
  if (x >= range.y || x >= WORLD_SIZE) {
    return;
  }
  let h = i32(WORLD_SIZE);
  let cx = f32(x) + 0.5;

  // Nothing to do if every body here was stamped just like this last time (bodies.ts
  // keeps a body where it was stamped until it moves noticeably), unless one presses hard
  // enough that powder under it may give way.
  var changed = false;
  for (var slot = 0u; slot < MAX_BODIES && !changed; slot++) {
    let base = slot * BODY_FLOATS;
    let was = (*before)[base + 5u] != 0.0 && cx >= (*before)[base + 6u] && cx <= (*before)[base + 8u];
    let now = (*bodies)[base + 5u] != 0.0 && cx >= (*bodies)[base + 6u] && cx <= (*bodies)[base + 8u];
    if (was || now) {
      var same = was && now && (*pressures)[slot] <= MIN_BEARING;
      for (var f = 0u; f < 6u && same; f++) {
        same = (*before)[base + f] == (*bodies)[base + f];
      }
      changed = !same;
    }
  }
  if (!changed) {
    return;
  }

  // The bodies that cross this column, and the run of cells each covers in it (rows
  // spanTop to spanBottom): bodies are convex, so a column crosses one in a single run.
  // Found once here, loading each body once, so the passes below only compare rows
  // instead of testing every cell against every body. `top` to `bottom` are the rows
  // that can change: where bodies are, and where they were (their bounds then).
  var near: array<u32, MAX_BODIES>;
  var spanTop: array<i32, MAX_BODIES>;
  var spanBottom: array<i32, MAX_BODIES>;
  var count = 0u;
  var top = h;
  var bottom = -1;
  for (var slot = 0u; slot < MAX_BODIES; slot++) {
    let base = slot * BODY_FLOATS;
    if ((*before)[base + 5u] != 0.0 && cx >= (*before)[base + 6u] && cx <= (*before)[base + 8u]) {
      top = min(top, i32(floor((*before)[base + 7u])));
      bottom = max(bottom, i32(ceil((*before)[base + 9u])));
    }
    if ((*bodies)[base + 5u] == 0.0 || cx < (*bodies)[base + 6u] || cx > (*bodies)[base + 8u]) {
      continue;
    }
    let b = loadBody(bodies, slot);
    var first = h;
    var last = -1;
    for (var y = max(i32(floor(b.lo.y)), 0); y <= min(i32(ceil(b.hi.y)), h - 1); y++) {
      if (bodyContains(b, vec2f(cx, f32(y) + 0.5))) {
        first = min(first, y);
        last = y;
      } else if (last >= 0) {
        break;
      }
    }
    if (last >= 0) {
      near[count] = slot;
      spanTop[count] = first;
      spanBottom[count] = last;
      count++;
      top = min(top, first);
      bottom = max(bottom, last);
    }
  }
  top = max(top, 0);
  bottom = min(bottom, h - 1);
  if (bottom < top) {
    return;
  }

  // 1. Count the cells that will be left empty, from the top: room for displaced
  // particles, as much as could be needed.
  var room = 0u;
  for (var y = 0; y < h && room < ROOM_ENOUGH; y++) {
    let m = cellMaterial(cellOrStone(cells, table, vec2i(i32(x), y)));
    if (m == MAT_EMPTY || m == MAT_BODY) {
      var covered = false;
      for (var k = 0u; k < count && !covered; k++) {
        covered = y >= spanTop[k] && y <= spanBottom[k];
      }
      room += select(1u, 0u, covered);
    }
  }

  // Whether the cell below `bottom` is solid ground, or powder resting on it (outside the
  // grid counts as stone).
  var grounded = true;
  for (var y = bottom + 1; y < h; y++) {
    let cell = cellOrStone(cells, table, vec2i(i32(x), y));
    let m = cellMaterial(cell);
    if (((POWDER_MATERIALS >> m) & 1u) == 0u) {
      grounded = m == MAT_STONE
        || (m == MAT_BODY && (*bodies)[min(cellShade(cell), MAX_BODIES - 1u) * BODY_FLOATS + 10u] != 0.0);
      break;
    }
  }

  // 2. Bottom to top: stamp, clear, and move displaced particles (in order) into the
  // empty cells above them; above `top`, only until they are all placed.
  var queue: array<u32, DISPLACE_MAX>;
  var head = 0u;
  var queued = 0u;
  for (var y = bottom; y >= 0 && (y >= top || queued > 0u); y--) {
    let i = cellIndex(table, vec2i(i32(x), y));
    let cell = select(MAT_STONE, (*cells)[min(i, SLOT_COUNT * CHUNK_CELLS - 1u)], i != CELL_NONE);
    let m = cellMaterial(cell);
    // (Bit tests, not table lookups: this runs for every cell of the walk, serially.)
    let groundedBelow = grounded;
    let powder = ((POWDER_MATERIALS >> m) & 1u) != 0u;
    let staticBody = m == MAT_BODY && (*bodies)[min(cellShade(cell), MAX_BODIES - 1u) * BODY_FLOATS + 10u] != 0.0;
    grounded = m == MAT_STONE || staticBody || (grounded && powder);
    var cover = MAX_BODIES;
    for (var k = 0u; k < count && cover == MAX_BODIES; k++) {
      if (y >= spanTop[k] && y <= spanBottom[k]) {
        cover = near[k];
      }
    }
    var next = cell;
    if (cover != MAX_BODIES) {
      // (Static bodies push everything aside where they are placed.)
      var yields = true;
      let bearing = select(0.0, MATERIAL_BEARING[m], powder && groundedBelow);
      if (bearing > 0.0 && (*bodies)[cover * BODY_FLOATS + 10u] == 0.0) {
        let overload = clamp((*pressures)[cover] / bearing - 1.0, 0.0, 1.0);
        yields = chance16(hashPcg(worldCellId(vec2i(i32(x), y)) ^ hashPcg(seed)), u32(overload * YIELD_MAX * 65535.0));
      }
      if (m == MAT_EMPTY || m == MAT_BODY) {
        next = bodyCell(cover);
      } else if (isMovable(cell) && room > 0u && queued < DISPLACE_MAX && yields) {
        queue[(head + queued) % DISPLACE_MAX] = cell;
        queued++;
        room--;
        next = bodyCell(cover);
      }
    } else {
      if (m == MAT_BODY) {
        next = MAT_EMPTY;
      }
      if (cellMaterial(next) == MAT_EMPTY && queued > 0u) {
        next = queue[head];
        head = (head + 1u) % DISPLACE_MAX;
        queued--;
      }
    }
    if (next != cell) {
      (*cells)[i] = next;
    }
  }

  // 3. No room above: the rest go into the highest empty cells (there is room for them).
  for (var y = 0; y < h && queued > 0u; y++) {
    let i = cellIndex(table, vec2i(i32(x), y));
    if (i != CELL_NONE && cellMaterial((*cells)[i]) == MAT_EMPTY) {
      (*cells)[i] = queue[head];
      head = (head + 1u) % DISPLACE_MAX;
      queued--;
    }
  }
}
