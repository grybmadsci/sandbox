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
material id, bits 8-15 a per-grain shade that travels with the grain.

Each simulation step runs two passes of a **Margolus-neighbourhood** automaton: the
grid is split into disjoint 2x2 blocks, one invocation per block, so every block can
be updated in place without races. The second pass shifts the blocks by (1, 1) so
material can cross block edges. Within a block, heavier movable cells fall, then slide
diagonally, and liquids spread sideways. Density decides who sinks through whom, so
sand sinks in water and oil floats on it.

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
      step.wgsl        Margolus step kernel
      paint.wgsl       brush stroke kernel
      level.wgsl       level generation / clear kernel
      render.wgsl      fragment colour function
  game/
    Scene.tsx          world size, camera, sand world
    SandWorld.tsx      runs the sim each frame, handles painting
    CameraRig.tsx      side-scroller pan / zoom camera
    input.ts           held keys + hotkeys
    store.ts           zustand state
  ui/
    Hud.tsx            material palette and help
```

## Controls

| Input | Action |
| --- | --- |
| Left drag | paint selected material |
| 1-5 / click palette | sand, water, oil, stone, eraser |
| [ / ] | brush size |
| Space | pause |
| R / C | reset level / clear everything |
| WASD / arrows, right or middle drag | pan (hold Shift for faster) |
| Mouse wheel, Q / E | zoom (wheel zooms toward cursor) |
