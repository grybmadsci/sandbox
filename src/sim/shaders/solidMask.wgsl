// Packs the ground the rigid bodies collide with into bits for bodies.ts, which keeps a
// Rapier voxel collider in step with it: stone, and powder resting (through more
// powder) on stone or on a static body. Powder resting on a dynamic body isn't ground
// (it would hold the body down like a ceiling); its weight is a load instead
// (bodyForces.wgsl). Liquids, gases and bodies aren't ground.
//
// For the chunks bodies are near (LIST_GROUND), one invocation per column of each, walking
// it bottom to top (after looking down the powder piled under it, into the chunk below).
// Bits are column-major, chunk after chunk in the list's order: column x of the n-th is
// words (n * CHUNK_SIZE + x) * MASK_WORDS .. + MASK_WORDS - 1, bit y % 32 of word y / 32.
fn solidMask(
  cells: ptr<storage, array<u32>, read_write>,
  bodies: ptr<storage, array<f32>, read_write>,
  mask: ptr<storage, array<u32>, read_write>,
  table: ptr<storage, array<u32>, read_write>,
  index: u32,
) -> void {
  let n = index / CHUNK_SIZE;
  if (n >= listCount(table, LIST_GROUND)) {
    return;
  }
  let chunk = listEntry(table, LIST_GROUND, n);
  let page = (*table)[chunk];
  let first = chunkOrigin(chunk);
  let x = first.x + i32(index % CHUNK_SIZE);
  let column = index * MASK_WORDS;

  // Whether the cell below the chunk is ground, or powder resting on it (below the world,
  // or past a chunk with no slot or a chunk's worth of powder, counts as ground).
  var supported = true;
  for (var y = first.y + i32(CHUNK_SIZE); y < first.y + i32(CHUNK_SIZE) * 2; y++) {
    let i = cellIndex(table, vec2i(x, y));
    if (i == CELL_NONE) {
      break;
    }
    let cell = (*cells)[i];
    if (cellKind(cell) != KIND_POWDER) {
      if (cellMaterial(cell) == MAT_BODY) {
        supported = (*bodies)[min(cellShade(cell), MAX_BODIES - 1u) * BODY_FLOATS + 10u] != 0.0;
      } else {
        supported = cellKind(cell) == KIND_SOLID;
      }
      break;
    }
  }

  for (var w = i32(MASK_WORDS) - 1; w >= 0; w--) {
    var bits = 0u;
    for (var b = 31; b >= 0; b--) {
      let cell = (*cells)[slotCell(page, vec2i(x, first.y + w * 32 + b))];
      let m = cellMaterial(cell);
      var solid = false;
      if (m == MAT_BODY) {
        let slot = min(cellShade(cell), MAX_BODIES - 1u);
        supported = (*bodies)[slot * BODY_FLOATS + 10u] != 0.0;
      } else if (cellKind(cell) == KIND_SOLID) {
        solid = true;
        supported = true;
      } else if (cellKind(cell) == KIND_POWDER) {
        solid = supported;
      } else {
        supported = false;
      }
      if (solid) {
        bits |= 1u << u32(b);
      }
    }
    (*mask)[column + u32(w)] = bits;
  }
}
