# Sand

2D falling-sand physics sandbox. The cellular automaton runs entirely on the GPU in
WGSL compute shaders, wired into React Three Fiber through three.js's
`WebGPURenderer` and TSL `wgslFn()`.

Requires a browser with WebGPU (recent Chrome / Edge). The WGSL kernels pass the
storage buffer by pointer, which relies on the `unrestricted_pointer_parameters`
WGSL extension.

## Stack

- **three** (`three/webgpu`, `three/tsl`) + **@react-three/fiber**: rendering and compute
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
diagonally, then wind pushes them, and gases decay. Density decides who sinks through
whom: sand sinks in water, oil floats on it, and gases are lighter than empty space,
so they rise.

Liquids and gases then spread sideways in separate flow passes (`flow.wgsl`) over
horizontal pairs of cells. Each cell stores a flow direction, keeps moving that way,
and turns around when blocked, so pools level out quickly. Liquids flow only while
resting on something; gases always drift and turn around at random, so plumes spread.
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
*sink*, a surface sitting 3+ rows below the head. While a sink exists, the highest
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
damped), so a sealed pocket keeps its air forever. Still air is kept soft
(`AIR_AMBIENT`, one row of liquid) so grains moving through it and vessels filling or
draining make almost no pressure; pumped air is far denser.

Wind pushes particles in the step kernel with a chance set by each material's `drag`
(gases follow the air, sand barely moves). The Air brush pumps in air and blows wind
along the stroke. Air pressure on a liquid's free surface counts as extra liquid above
it (`AIR_ROW` pressure per row, in `common.wgsl`), pooled over the nearby open air
cells, so pumping air into a sealed arm of a U-tube pushes the liquid up the open arm.
Under strong air pressure a surface must sit further below the head to count as a
sink, so uneven pressure within one vessel doesn't move liquid around inside it.

### Determinism

All simulation math is integer (16-bit fixed-point chances, fixed-point air), and
every random choice hashes a seed derived from the step count, which resets with the
level. Every kernel either owns its cells (2x2 blocks, pairs, columns) or reads one
buffer and writes another, so there are no races: the same inputs replay bit for bit.

Each `.wgsl` kernel is a single function loaded with `?raw` and wrapped with
`wgslFn()`. A shared prelude (`common.wgsl` plus WGSL constants generated from the
material table in `materials.ts`) is attached as an include via `wgsl()`. The world
is a plane whose `MeshBasicNodeMaterial.colorNode` is another `wgslFn` reading the
same buffer.

## Layout

```
src/
  App.tsx              WebGPU check, R3F Canvas with WebGPURenderer, HUD
  sim/
    SandSim.ts         storage buffer, wgslFn kernels, compute dispatch, render material
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
      render.wgsl      fragment colour function (and pressure view)
  game/
    Scene.tsx          world size, camera, sand world
    SandWorld.tsx      runs the sim each frame, handles painting
    CameraRig.tsx      side-scroller pan / zoom camera
    input.ts           held keys + hotkeys
    store.ts           zustand state
    tools.ts           brush list (materials + air)
  ui/
    Hud.tsx            tool palette and help
```

## Controls

| Input | Action |
| --- | --- |
| Left drag | paint selected material; Air: hold to pump pressure, drag to blow |
| 1-9 / click palette | sand, water, oil, smoke, steam, stone, air, eraser, soot |
| P | pressure view (liquid pressure as heat, air pressure red / blue) |
| [ / ] | brush size |
| Space | pause |
| R / C | reset level / clear everything |
| WASD / arrows, right or middle drag | pan (hold Shift for faster) |
| Mouse wheel, Q / E | zoom (wheel zooms toward cursor) |
