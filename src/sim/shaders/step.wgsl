// One pass of a Margolus-neighborhood falling-sand automaton.
//
// The grid is partitioned into disjoint 2x2 blocks and each invocation owns one
// block, so it can read and write it in place with no races. Alternate passes
// shift the block grid by (1, 1) so material can cross block boundaries.
// Cells outside the grid read as stone, so nothing leaves through the edges.
// Sideways flow and static pressure are separate kernels (flow.wgsl, pressure.wgsl).
fn stepBlock(
  cells: ptr<storage, array<u32>, read_write>,
  air: ptr<storage, array<i32>, read_write>,
  shelter: ptr<storage, array<u32>, read_write>,
  index: u32,
  size: vec2u,
  airSize: vec2u,
  offset: u32,
  seed: u32,
) -> void {
  let blocks = size / 2u + 1u;
  if (index >= blocks.x * blocks.y) {
    return;
  }
  let origin = vec2i(i32(index % blocks.x), i32(index / blocks.x)) * 2 - vec2i(i32(offset));
  if (origin.x >= i32(size.x) || origin.y >= i32(size.y)) {
    return;
  }

  // 0 = top-left, 1 = top-right, 2 = bottom-left, 3 = bottom-right.
  // `var` (not `let`) so the arrays can be indexed with a loop variable everywhere.
  var p = array<vec2i, 4>(origin, origin + vec2i(1, 0), origin + vec2i(0, 1), origin + vec2i(1, 1));
  var c = array<u32, 4>(MAT_STONE, MAT_STONE, MAT_STONE, MAT_STONE);
  // Cells in a shelter (a truck's bucket, shelter.wgsl) are out of the wind, with the rest of their block.
  var sheltered = false;
  for (var i = 0u; i < 4u; i++) {
    if (inGrid(p[i], size)) {
      c[i] = (*cells)[gridIndex(p[i], size)];
      sheltered = sheltered || maskBit(shelter, p[i], size);
    }
  }
  var before = c;

  let r = hashPcg(index ^ hashPcg(seed));
  var t: u32;

  // 1. Fall straight down (gases rise: empty space sinks into them). Sinking through
  // a liquid is slowed (viscosity). Falling liquid now and then skips a fall
  // (LIQUID_FALL_SKIP), so a falling stream doesn't lock into evenly spaced bands.
  let skip = hashPcg(r + 13u);
  let skipsLeft = cellKind(c[0]) == KIND_LIQUID && chance16(skip, LIQUID_FALL_SKIP);
  let skipsRight = cellKind(c[1]) == KIND_LIQUID && chance16(skip >> 16u, LIQUID_FALL_SKIP);
  if (sinksInto(c[0], c[2]) && ((passesFreely(c[0], c[2]) && !skipsLeft) || chance16(r, 32768u))) {
    t = c[0]; c[0] = c[2]; c[2] = t;
  }
  if (sinksInto(c[1], c[3]) && ((passesFreely(c[1], c[3]) && !skipsRight) || chance16(r >> 16u, 32768u))) {
    t = c[1]; c[1] = c[3]; c[3] = t;
  }

  // 2. Slide diagonally when blocked: falling cells down, gases up, as readily as the
  // falling (or else rising) material slides. Random order avoids a left/right bias.
  let leftFirst = (r & 0x80000000u) != 0u;
  for (var i = 0u; i < 2u; i++) {
    if ((i == 0u) == leftFirst) {
      // top-left <-> bottom-right
      if (slidesDiagonally(c[0], c[3], c[2], c[1]) && chance16(hashPcg(r + 1u), slideChance(c[0], c[3]))) {
        t = c[0]; c[0] = c[3]; c[3] = t;
      }
    } else {
      // top-right <-> bottom-left
      if (slidesDiagonally(c[1], c[2], c[3], c[0]) && chance16(hashPcg(r + 2u), slideChance(c[1], c[2]))) {
        t = c[1]; c[1] = c[2]; c[2] = t;
      }
    }
  }

  // 3. Wind (dynamic pressure) pushes cells into empty space or gas, more strongly for high-drag materials.
  let a = airIndex((origin + 1) / i32(AIR_CELL), airSize);
  let wind = vec2i(airWind((*air)[a + AIR_VX]), airWind((*air)[a + AIR_VY]));
  let speed = vec2u(abs(wind));
  if (speed.x != 0u && !sheltered) {
    let right = wind.x > 0;
    for (var row = 0u; row < 4u; row += 2u) {
      let mover = select(row + 1u, row, right);
      let dest = select(row, row + 1u, right);
      if (blownInto(c[mover], c[dest], speed.x, hashPcg(r + 3u + row))) {
        t = c[mover]; c[mover] = c[dest]; c[dest] = t;
      }
    }
  }
  if (speed.y != 0u && !sheltered) {
    let down = wind.y > 0;
    for (var col = 0u; col < 2u; col++) {
      let mover = select(col + 2u, col, down);
      let dest = select(col, col + 2u, down);
      if (blownInto(c[mover], c[dest], speed.y, hashPcg(r + 7u + col))) {
        t = c[mover]; c[mover] = c[dest]; c[dest] = t;
      }
    }
  }

  // 4. Gases decay (smoke settles into soot, steam condenses into water), and turn around at
  // random so their sideways drift (flow.wgsl) spreads them out.
  for (var i = 0u; i < 4u; i++) {
    let m = cellMaterial(c[i]);
    let h = hashPcg(r + 11u + i);
    if (MATERIAL_DECAY[m] != 0u && chance16(h, MATERIAL_DECAY[m])) {
      let into = MATERIAL_DECAY_INTO[m];
      c[i] = select(makeCell(into, h >> 16u), MAT_EMPTY, into == MAT_EMPTY);
    } else if (MATERIAL_KIND[m] == KIND_GAS && chance16(h >> 16u, 16384u)) {
      c[i] = flipDirection(c[i]);
    }
  }

  for (var i = 0u; i < 4u; i++) {
    if (c[i] != before[i] && inGrid(p[i], size)) {
      (*cells)[gridIndex(p[i], size)] = c[i];
    }
  }
}
