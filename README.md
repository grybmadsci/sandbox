# Sand

2D falling-sand physics sandbox. The cellular automaton runs entirely on the GPU in
WGSL compute shaders, wired into React Three Fiber through three.js's
`WebGPURenderer` and TSL `wgslFn()`. Rigid bodies (boxes, balls, beams) are simulated
by Rapier and coupled to the grid both ways, can be joined into assemblies (a vehicle
with a tipping bucket), and placeable objects (a mining laser) are built on them.

Requires a browser with WebGPU (recent Chrome / Edge). The WGSL kernels pass the
storage buffer by pointer, which relies on the `unrestricted_pointer_parameters`
WGSL extension.

## Stack

- **three** (`three/webgpu`, `three/tsl`) + **@react-three/fiber**: rendering and compute
- **@dimforge/rapier2d-compat**: rigid bodies. Pinned to 0.19.3: in testing, 0.20 and
  0.21 panicked inside `World.step` with a voxel collider whose voxels change between
  steps
- **zustand**: UI state shared between the scene and the HUD

## Scripts

```sh
npm run dev      # start dev server
npm run build    # type-check + production build
npm run preview  # serve the production build
npm run lint     # oxlint
```

## How it works

The grid is one storage buffer of `u32` cells (`instancedArray`): bits 0-7 are the
material id, bits 8-15 a per-grain shade that travels with the grain, bit 16 a flow
direction and bits 17-31 liquid credit (see static pressure).

Each simulation step runs two passes of a **Margolus-neighbourhood** automaton: the
grid is split into disjoint 2x2 blocks, one invocation per block, so every block can
be updated in place without races. The second pass shifts the blocks by (1, 1) so
material can cross block edges. Within a block, heavier cells fall, then slide
diagonally (as readily as each material's `slide` chance: dirt's is low, so it holds
steeper slopes than sand), then wind pushes them, and gases decay. Falling liquid skips a fall now
and then (`LIQUID_FALL_SKIP`), so falling streams don't lock into evenly spaced bands. Density decides who sinks through
whom: sand sinks in water, oil floats on it, and gases are lighter than empty space,
so they rise.

Liquids and gases then spread sideways in separate flow passes (`flow.wgsl`) over
horizontal pairs of cells. Each cell stores a flow direction, keeps moving that way,
and turns around when blocked, so pools level out quickly. Liquids flow only while
resting on something that isn't itself falling, so streams pouring over an edge don't
spray sideways; gases always drift and turn around at random, so plumes spread. Each
pass runs as three dispatches (rows modulo 3), so the rows a pair looks at below it
are never being written at the same time and runs stay deterministic.
How far each material can flow per step is its `spread` value in `materials.ts`.

### Gases

Smoke and steam are `gas` materials. Each has a `decay` chance per step: smoke settles
into soot (a light powder that floats on water), and steam condenses back into water
(rain). Each turns into exactly one cell, so no mass is lost. All tunables live in
`materials.ts`.

### Static pressure

`pressure.wgsl` runs one GPU thread per column, walking each vertical run of liquid
at once. It keeps a field per liquid cell: the *head* (row of the body's highest free
surface, passed between neighbouring columns) and the hop distance to the nearest
*sink*, a surface sitting 4+ rows below the head. Heads gain a little per column
they cross (so nearer surfaces win and stale values fade); each also carries its hop
count, which the sink test subtracts, so a long channel doesn't leave vessels uneven. Falling
water (a run whose bottom would sink into what is below it) belongs to no body, so
credit is never routed into it; credit that spills with it comes out below it as more
falling water, and credit waiting at a sink is spread down the run so a surface cell
that flows or spills away carries little of it. While a sink exists, the highest
surface gives up a cell as *credit*, which travels through the liquid to the sink and
reappears there. So connected vessels level out (water rises in a U-tube), and
cells + credit is conserved exactly (credit is never clipped). Pressure crosses one column per pass
(`PRESSURE_PASSES` in `SandSim.ts`), and goes up and down a column instantly.

### Dynamic pressure

A coarse air grid (one air cell per 4x4 sand cells, `air.wgsl`) holds air mass, wind
(staggered: one velocity per face) and each cell's open volume (how many of its sand
cells are empty or gas). Pressure is mass over volume, so a pocket that liquid or sand
squeezes gets denser, and a cell filled completely pushes its air out. Each air step
the wind on every face accelerates down the pressure difference across it, then air
moves across each face, carried by the wind and diffusing through an opening as wide
as the smaller open volume (which keeps nearly filled cells stable). `AIR_SUBSTEPS`
air steps run per simulation step.

Air is conserved exactly: each face's flow is one integer that both neighbours
compute identically, the world edges are closed, and nothing decays (only the wind is
damped), so a sealed pocket keeps its air forever. Still air is at one atmosphere
(`AIR_AMBIENT`, about 10 m of water, taken as 1024 rows), so sealed air barely
squeezes or stretches: it pushes back hard and holds liquid up by suction. Stiff air
has to even out fast, so `AIR_SUBSTEPS` (16) cheap air substeps run per simulation
step. Liquids feel a filtered gauge pressure: a short average strips out the ringing
that moving material sets off, then an adaptive average follows small differences
slowly (so surface churn can't feed back into itself) and large ones quickly
(pumping, siphons), projecting any steady trend so it doesn't lag behind
(`AIR_GAUGE_*` in `common.wgsl`). The sink test also ignores the first few rows of
air-pressure difference between a surface and the highest one (`AIR_SINK_DEADBAND`,
carried with each head), so uneven air over one vessel can't move its liquid around. A
surface counts as free only with at least a full air cell's worth of open air around
it: an air bubble in liquid or a thin gap under stone is treated like a ceiling, since
air cells that are mostly filled give erratic pressures. Falling grains and drops drag the air toward their own
speed (entrainment), as a waterfall does.

Pressure waves are damped so they fade instead of ringing round the closed world:
bulk viscosity (`AIR_BULK`) evens out changes in compression between neighbouring
cells (measured against each cell's recent average), which damps waves but not a
steady stream such as the air flowing into a draining vessel, and flows lose a little
speed each substep (`AIR_DAMP`, always at least 1, so slow flows settle). Pressure uses a
smoothed open volume (`AIR_SOFTEN`) that follows the real one over a few steps, so a
grain moving in or out of an air cell doesn't set off a sharp pulse.

Wind pushes particles in the step kernel with a chance set by each material's `drag`
(gases follow the air, sand barely moves); liquids only feel wind beyond 2 cells per
step (`LIQUID_WIND_THRESHOLD`), so the wind a waterfall stirs up doesn't blow spray
about, while an air-brush gust still does. The Air brush pumps in air and blows wind
along the stroke. Air pressure on a liquid's free surface counts as extra liquid above
it (`AIR_ROW` pressure per row, in `common.wgsl`), pooled over the nearby open air
cells, so pumping air into a sealed arm of a U-tube pushes the liquid up the open arm.
Under strong air pressure a surface must sit further below the head to count as a
sink, so uneven pressure within one vessel doesn't move liquid around inside it.

### Thick stone

Stone has to be at least 4 cells thick: after every paint stroke and level fill,
`crumble.wgsl` turns any stone cell that no 4x4 square of stone covers into sand. Thick
walls also keep the 4x4 air grid sealed.

### Rigid bodies

Boxes, balls and beams are rigid bodies defined geometrically: every point within a
radius of the convex hull of up to 8 core points (one point is a ball, two a capsule,
four a box with rounded corners). Rapier (`bodies.ts`) simulates them in grid units
(cells, y down), and they are coupled to the grid both ways:

- **Bodies in the grid.** Before every grid step, `stamp.wgsl` writes each body into
  the grid as `BODY` cells (the shade bits hold its slot), so sand, liquids, gases and
  the air treat it as solid, and clears the cells it has left. One thread owns each
  column, so it can do that in place: particles in a body's way are pushed up the
  column into the nearest cell left empty (a body sinking through water swaps it from
  below to above, and one pushed into a pool raises its level), and a particle is only
  pushed out if it has somewhere to go, so mass is still conserved exactly. Stone is
  never overwritten. Each column is one thread walking it serially, so the walks are
  kept short: each body's run of cells in the column is found once (bodies are convex),
  only the rows where bodies are or were last stamped (the previous upload is kept for
  that) are rewritten, and the room above is only counted as far as a body could need.
  A body is also left where it was stamped until it moves a twentieth of a cell, so
  bodies at rest aren't restamped at all, and columns where nothing changed are skipped.
- **Bearing.** A body's stamp is a little bigger than its collider, so it covers the
  row of grains it rests on; pushing those aside every step would sink any body into
  sand. Instead, powder resting on solid ground (stone or static bodies, through more
  powder) bears weight up to its `bearing` strength (`materials.ts`): sand 25, dirt
  160, in cells of water's weight per cell of contact. After each Rapier step,
  `BodyWorld` measures how hard each body presses on the ground: the contact force
  against the voxel collider (which includes everything resting on the ground through
  it, like a truck's load) over the ground cells touching it. Pressed harder than the
  bearing, the stamp pushes grains aside by chance, up to 5% a step at twice the
  bearing, so a body sinks in until its contact widens enough to carry it: a truck
  settles a cell or so into sand and none into dirt, a light crate not at all. Static
  bodies still push everything aside where they're placed.
- **Riding.** Pushing up a column can't move anything sideways, so before the stamp,
  `carry.wgsl` moves what rests on a moving body (sand or liquid stacked down to one of
  its cells) along with it, a whole cell at a time as the body crosses cell boundaries,
  into empty space only: sand rides in a bucket, or on a crate. One pass marks the
  riders, the next moves each row's riders in order, so a pile moves together.
- **The grid as ground.** `solidMask.wgsl` packs the cells bodies collide with into
  bits: stone, and powder resting through more powder on stone or on a static body.
  It's read back every frame, and the changed bits update a Rapier voxel collider. A
  body's collider is its shape shrunk by 0.75 cells (`STAMP_MARGIN`), so grains
  resting against its stamped cells don't push it. Powder resting on a dynamic body
  isn't ground (it would hold the body down like a ceiling); its weight is a load
  instead.
- **Forces from the grid.** `bodyBuoyancy.wgsl` floats bodies: a body cell displaces
  liquid when the cell just past the body along its row (on the nearer side) holds
  liquid, and it is pushed up by that liquid's weight (`weight` in `materials.ts`), at
  the cell, so bodies right themselves about their centre of buoyancy. Unlike adding
  up the pressure on the faces, this also floats a body resting on the bottom, and it
  only follows the liquid actually beside each row, so the bubbles, mounds and gaps a
  moving body stirs up in the grid don't throw it about. Liquid also damps a body's
  motion in proportion to how much of it is submerged. `bodyForces.wgsl` adds the
  weight of powder piled on top of a body (up to 128 cells high). The sums are integer
  atomics, read back a frame or two late and clipped to sane accelerations.

Bodies don't feel the air: air pressure and wind on their faces mostly measured the
artifacts of the stamping itself (cells a moving body leaves start out empty of air),
and made them drift.

Bodies are drawn by the grid's colour function, at cell resolution, with a grain that
turns with them and a darker rim. Static bodies are fixed in Rapier; the starting level
has a steel ramp. Up to 64 bodies (`MAX_BODIES`), each up to 128 cells across.

### Placeable objects

Placeable objects (`objects.ts`) are static bodies with a device: the body is stamped,
collided with, drawn and erased like any other, and the device (body float 11) says what
else it does. They only go where they fit: while dragging one out, `placement.wgsl`
counts the cells under it that would block it (stone, powder, other bodies, or outside
the world; air, gases and liquids are pushed aside like for any body), and the outline
turns green or red. It is checked again on release, and not placed if blocked.

The **mining laser** fires nine parallel rays, a cell apart, from its tip
(`laser.wgsl`, every step after the stamp). A ray passes through empty space, gases,
liquids, powder and its own body, and stops at stone, another body or the edge of the
world. It bites three cells deep: the stone it stops at takes a full hit each step, and
the stone right behind it along the ray half as much per cell deeper (a half, then a
quarter); the two outermost rays do half as much as the rest. Stone decomposes after 3
seconds of full hits (each stone cell counts its damage in the bits liquids use for
credit, and darkens as it nears breaking): into sand, or two times in five into
nothing, so the sand takes up less room than the stone did. The beam shoots through
the sand it leaves, so it keeps digging, up to 600 cells.
Thin stone left behind crumbles as usual. The beams are drawn by the colour function,
from how far each ray got, narrower than the 9-cell band they cut, with sparks flying
back off where they bite (drawn procedurally, from the time and a hash). Up to 16 lasers
(`MAX_LASERS`).

### Joints and vehicles

Bodies can be joined into an assembly (`BodyWorld.addAssembly`), placed and erased as
one: revolute joints (free to turn, optionally within limits) and fixed joints (welded),
from Rapier, with parts joined not colliding with each other. A joint can have a motor:
`drive` spins a wheel at a target speed (braking when stopped), `tip` swings to an angle
and back, holding it with a stiff spring.

The **vehicle** (`vehicle.ts`) is six bodies: a chassis, two wheels on driven revolute
joints, and a bucket made of a floor plate with two walls welded to it, hinged to the
chassis at the back. It goes where it fits, like the laser. Z / X drive every vehicle
left / right; holding T tips their buckets about 115 degrees to dump out the back,
releasing it brings them back level. Sand in the bucket rides along (above) and weighs
the bucket down (`bodyForces.wgsl`). The inside of the bucket is a shelter: a body can
declare a rectangle in its own frame whose cells `shelter.wgsl` marks each step, and the
wind skips them, since the air a moving truck stirs up would otherwise blow its load
against the back wall. A heap above the rim is out in the wind.

### Determinism

All grid math is integer (16-bit fixed-point chances, fixed-point air), and every
random choice hashes a seed derived from the step count, which resets with the level.
Every kernel either owns its cells (2x2 blocks, pairs, columns) or reads one buffer and
writes another (or adds up integers atomically), so there are no races: the same inputs
replay bit for bit. Rigid bodies break this: the forces from the grid reach them a frame
or two late, so the frame rate affects where they go, and so the grid around them.
Lasers do too: two rays can race over the same stone cell.

Each `.wgsl` kernel is a single function loaded with `?raw` and wrapped with
`wgslFn()`. A shared prelude (`common.wgsl` plus WGSL constants generated from the
material table in `materials.ts`) is attached as an include via `wgsl()`. The world
is a plane whose `MeshBasicNodeMaterial.colorNode` is another `wgslFn` reading the
same buffer.

### Performance

Each `renderer.compute()` call is its own command buffer, submitted on its own, and
that costs more than most of the step's dispatches (about 0.07 ms each, measured). So a
whole step, 61 dispatches (16 air substeps of two, shelters, two Margolus passes, two
pressure passes, eight flow passes of three), plus the carry, stamp and lasers queued before
it, goes out as one call. Nothing in a step may depend on a uniform changing between
dispatches: per-pass values are baked into each node (flow's pass index and offset,
derived from the step's parity) or get their own uniforms (the Margolus, stamp and laser
seeds). Batching this way leaves results bit for bit the same as dispatching one by one.

## Layout

```
src/
  App.tsx              WebGPU check, R3F Canvas with WebGPURenderer, HUD
  sim/
    SandSim.ts         storage buffer, wgslFn kernels, compute dispatch, render material
    inspect.ts         decodes the inspect tool's readout
    materials.ts       material table (single source of truth) -> WGSL constants
    shaders/
      common.wgsl      shared helpers (prelude)
      step.wgsl        Margolus step kernel (falling, sliding, wind, gas decay)
      flow.wgsl        sideways liquid / gas flow kernel, moves pressure credit
      pressure.wgsl    static pressure (per-column kernel)
      air.wgsl         dynamic pressure (air grid step)
      blow.wgsl        air brush kernel
      paint.wgsl       brush stroke kernel
      level.wgsl       level generation / clear kernel
      crumble.wgsl     thin stone crumbles to sand
      inspect.wgsl     copies one cell's state for the inspect tool
      stamp.wgsl       stamps rigid bodies into the grid, pushing particles aside
      carry.wgsl       moves what rests on a moving body along with it
      shelter.wgsl     marks the cells inside bodies' shelters (a bucket), out of the wind
      solidMask.wgsl   packs the ground bodies collide with into bits
      bodyBuoyancy.wgsl  floats bodies on the liquid beside them
      bodyForces.wgsl  weight of powder piled on bodies
      placement.wgsl   counts what would block a placeable object
      laser.wgsl       mining laser rays: decompose stone into sand
      render.wgsl      fragment colour function (pool surface films, pressure view, bodies, laser beams)
    bodies.ts          Rapier rigid bodies, their shapes, joints, and the coupling to the grid
    objects.ts         placeable objects (mining laser)
    vehicle.ts         the vehicle assembly: chassis, driven wheels, tipping bucket
  game/
    Scene.tsx          world size, camera, sand world
    SandWorld.tsx      runs the sim each frame, handles painting
    CameraRig.tsx      side-scroller pan / zoom camera
    input.ts           held keys + hotkeys
    store.ts           zustand state
    tools.ts           brush list (materials, air, bodies, objects)
  ui/
    Hud.tsx            tool palette and help
```

## Controls

| Input | Action |
| --- | --- |
| Left drag | paint selected material; Air: hold to pump pressure, drag to blow; Vacuum: hold to take air out; the eraser also removes bodies and objects |
| 1-9, 0 / click palette | sand, water, oil, smoke, steam, stone, air, eraser, soot, vacuum |
| G / click palette | dirt: like sand, but sticky (holds steep slopes), barely blown about, and bears far more weight |
| B / O / L | place a body by dragging: a wooden box (corner to corner), a rubber ball (from its centre), a steel beam (end to end, as thick as the brush); hold Shift on release for a static box or ball, or a loose wooden beam |
| V | place a vehicle (where it fits; hold Shift on release to face it left) |
| Z / X, hold T | drive vehicles left / right; tip their buckets |
| M | place a mining laser: press where it goes, drag toward what to mine; the outline is green where it fits (air or liquid) and red where it doesn't (stone, sand, bodies) |
| I / click palette | inspect: shows the cell under the cursor (contents, liquid pressure and credit, air mass, volume, pressure and wind) |
| P | pressure view (liquid pressure on a log scale, purple to yellow, contour every 16 rows; averaged air pressure: neutral at 1 atm, red above, blue below) |
| [ / ] | brush size |
| Space | pause |
| R / C | reset level / clear everything |
| WASD / arrows, right or middle drag | pan (hold Shift for faster) |
| Mouse wheel, Q / E | zoom (wheel zooms toward cursor) |
