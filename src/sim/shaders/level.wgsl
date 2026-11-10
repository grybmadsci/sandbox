// Fills the whole grid: mode 0 clears it, mode 1 generates the starting level
// (rolling stone terrain, a few ledges, sand dunes, a lake, a U-tube and a bell
// siphon). It also
// resets the air (filled with still air at ambient pressure by the next air step) and
// the pressure field. One invocation per cell.
fn fillLevel(
  cells: ptr<storage, array<u32>, read_write>,
  air: ptr<storage, array<i32>, read_write>,
  fieldA: ptr<storage, array<u32>, read_write>,
  fieldB: ptr<storage, array<u32>, read_write>,
  gauges: ptr<storage, array<i32>, read_write>,
  index: u32,
  size: vec2u,
  airSize: vec2u,
  mode: u32,
) -> void {
  if (index < airSize.x * airSize.y * 4u) {
    (*air)[index] = select(0, -1, index % 4u == AIR_VOLUME);
  }
  if (index < airSize.x * airSize.y * 8u) {
    (*gauges)[index] = 0;
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

  // A bell siphon. A reservoir pours slowly through holes in its floor into a basin.
  // In the basin a standpipe rises to a rim, under an inverted cup (the bell) whose skirt
  // stops just above the basin floor. The standpipe's lower end dips 4 rows into a wide
  // cup that spills into a catch pool. As the basin rises, the air trapped in the bell
  // is squeezed out under the standpipe's end. Once the basin overflows the rim, the
  // water pouring down the standpipe drags the rest of the bell's air out with it
  // (entrainment); the suction pulls the cup's water up the standpipe until it meets the
  // pour, and the basin, bell, standpipe and cup become one body of water. Static
  // pressure then drains the basin into the cup, the water held over the rim by suction
  // (a siphon), until air gets in under the skirt. Then the basin fills again. Walls are
  // 4 cells thick, on 4-cell boundaries, so the 4x4 air grid seals each pocket.
  // (mx, my: cells from its bottom left.)
  let siphonLeft = 560.0;
  let siphonBottom = 100.0;
  let mx = x - siphonLeft;
  let my = up - 1.0 - siphonBottom;
  if (mx >= 0.0 && mx < 224.0 && my >= 0.0 && my < 320.0) {
    cell = MAT_EMPTY;
    let catchPool = my < 4.0 || ((mx < 4.0 || mx >= 220.0) && my < 60.0);
    // The cup spills over its lower right wall at 64.
    let cup = (my >= 52.0 && my < 56.0 && mx >= 124.0 && mx < 164.0)
      || (my >= 52.0 && my < 72.0 && mx >= 124.0 && mx < 128.0)
      || (my >= 52.0 && my < 64.0 && mx >= 160.0 && mx < 164.0);
    let basin = (my >= 100.0 && my < 104.0 && mx >= 60.0 && mx < 168.0)
      || (my >= 100.0 && my < 172.0 && ((mx >= 60.0 && mx < 64.0) || (mx >= 164.0 && mx < 168.0)));
    // Bell: walls from a block above the basin floor, cap a block above the rim (144).
    let bell = (my >= 108.0 && my < 152.0 && ((mx >= 124.0 && mx < 128.0) || (mx >= 152.0 && mx < 156.0)))
      || (my >= 148.0 && my < 152.0 && mx >= 124.0 && mx < 156.0);
    let standpipe = my >= 60.0 && my < 144.0 && mx >= 132.0 && mx < 144.0;
    let bore = my >= 60.0 && my < 144.0 && mx >= 136.0 && mx < 140.0;
    // Reservoir, full of water, floor at 216-220 with three spout holes over the basin
    // (5 apart, so the stone between them is 4 thick).
    let spout = (mx == 90.0 || mx == 95.0 || mx == 100.0) && my < 220.0;
    let reservoir = (my >= 216.0 && my < 220.0 && mx >= 24.0 && mx < 196.0 && !spout)
      || (my >= 216.0 && ((mx >= 24.0 && mx < 28.0) || (mx >= 192.0 && mx < 196.0)));
    if ((catchPool || cup || basin || bell || standpipe || reservoir) && !bore) {
      cell = MAT_STONE;
    }
    // Water: the reservoir, and the cup filled to its lip (over the standpipe's end).
    if ((my >= 220.0 && my < 300.0 && mx >= 28.0 && mx < 192.0)
      || (cell == MAT_EMPTY && my >= 56.0 && my < 64.0 && mx >= 128.0 && mx < 160.0)) {
      cell = MAT_WATER;
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
