# Game

2D side-scrolling physics sandbox built with React Three Fiber, TypeScript and Vite.

## Stack

- **three** + **@react-three/fiber**: rendering
- **@react-three/drei**: helpers (keyboard controls, grid, etc.)
- **@react-three/rapier**: physics
- **zustand**: game state shared between the scene and the UI

## Scripts

```sh
npm run dev      # start dev server
npm run build    # type-check + production build
npm run preview  # serve the production build
npm run lint     # oxlint
```

## Layout

```
src/
  App.tsx          orthographic Canvas, physics world, input, HUD overlay
  game/
    Scene.tsx      lights, background grid, click-to-spawn surface
    CameraRig.tsx  pan / zoom camera controller
    World.tsx      static level geometry
    Bodies.tsx     spawned physics bodies (locked to the XY plane) + kill zone
    controls.ts    held-key bindings (camera)
    hotkeys.ts     one-shot key actions (shape select, clear)
    store.ts       zustand sandbox state
  ui/
    Hud.tsx        DOM overlay
```

## Controls

| Input | Action |
| --- | --- |
| Left click | spawn selected shape |
| 1 / 2 / 3 | select box / ball / plank |
| WASD / arrows | pan (hold Shift for faster) |
| Right or middle drag | pan |
| Mouse wheel, Q / E | zoom (wheel zooms toward cursor) |
| C | clear all bodies |
