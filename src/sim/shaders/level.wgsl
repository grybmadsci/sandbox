// Fills the whole grid: mode 0 clears it, mode 1 generates the starting level
// (rolling stone terrain, a few ledges, sand dunes, a lake and a U-tube). It also
// resets the air (filled with still air at ambient pressure by the next air step) and
// the pressure field. One invocation per cell.
fn fillLevel(
  cells: ptr<storage, array<u32>, read_write>,
  air: ptr<storage, array<i32>, read_write>,
  fieldA: ptr<storage, array<u32>, read_write>,
  fieldB: ptr<storage, array<u32>, read_write>,
  index: u32,
  size: vec2u,
  airSize: vec2u,
  mode: u32,
) -> void {
  if (index < airSize.x * airSize.y * 4u) {
    (*air)[index] = select(0, -1, index % 4u == AIR_VOLUME);
  }
  if (index >= size.x * size.y) {
    return;
  }
  (*fieldA)[index] = FIELD_NONE;
  (*fieldB)[index] = FIELD_NONE;
  if (mode == 0u) {
    (*cells)[index] = MAT_EMPTY;
    return;
  }

  let x = f32(index % size.x);
  let y = f32(index / size.x);
  let h = f32(size.y);
  let shade = hashPcg(index * 7919u + 17u);

  // Heights are measured in rows from the bottom.
  let up = h - y;
  let ground = h * (0.2 + 0.07 * sin(x * 0.0061) + 0.035 * sin(x * 0.0213 + 1.7) + 0.012 * sin(x * 0.09));
  let dunes = ground + h * max(0.0, 0.05 * sin(x * 0.011 + 0.4) - 0.01);

  var cell = MAT_EMPTY;
  if (up < ground) {
    cell = MAT_STONE;
  } else if (up < dunes) {
    cell = MAT_SAND;
  }

  // Floating ledges, one every 320 columns.
  let ledgeX = x % 320.0;
  let ledgeIndex = floor(x / 320.0);
  let ledgeUp = h * (0.5 + 0.12 * sin(ledgeIndex * 2.3));
  if (ledgeX > 150.0 && ledgeX < 230.0 && abs(up - ledgeUp) < 3.0) {
    cell = MAT_STONE;
  }

  // A U-tube (connected vessels), left arm filled with water: static pressure levels it out.
  let tubeLeft = 300.0;
  let tubeBottom = h * 0.6;
  if (x >= tubeLeft && x < tubeLeft + 96.0 && up >= tubeBottom && up < tubeBottom + 130.0) {
    let tx = x - tubeLeft;
    let ty = up - tubeBottom;
    let channel = ty >= 4.0 && ty < 16.0 && tx >= 4.0 && tx < 92.0;
    let leftArm = ty >= 4.0 && tx >= 4.0 && tx < 20.0;
    let rightArm = ty >= 4.0 && tx >= 76.0 && tx < 92.0;
    if ((leftArm && ty < 120.0) || (channel && tx < 76.0)) {
      cell = MAT_WATER;
    } else if (channel || leftArm || rightArm) {
      cell = MAT_EMPTY;
    } else {
      cell = MAT_STONE;
    }
  }

  // A lake that settles into the terrain.
  let lakeLeft = f32(size.x) * 0.55;
  let lakeRight = f32(size.x) * 0.7;
  if (cell == MAT_EMPTY && x > lakeLeft && x < lakeRight && up < h * 0.42) {
    cell = MAT_WATER;
  }

  (*cells)[index] = select(makeCell(cell, shade), MAT_EMPTY, cell == MAT_EMPTY);
}
