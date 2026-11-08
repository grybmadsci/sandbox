import type { KeyboardControlsEntry } from '@react-three/drei'

export const Controls = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  zoomIn: 'zoomIn',
  zoomOut: 'zoomOut',
  fast: 'fast',
} as const

export type Control = (typeof Controls)[keyof typeof Controls]

export const keyMap: KeyboardControlsEntry<Control>[] = [
  { name: Controls.up, keys: ['ArrowUp', 'KeyW'] },
  { name: Controls.down, keys: ['ArrowDown', 'KeyS'] },
  { name: Controls.left, keys: ['ArrowLeft', 'KeyA'] },
  { name: Controls.right, keys: ['ArrowRight', 'KeyD'] },
  { name: Controls.zoomIn, keys: ['KeyE', 'Equal'] },
  { name: Controls.zoomOut, keys: ['KeyQ', 'Minus'] },
  { name: Controls.fast, keys: ['ShiftLeft', 'ShiftRight'] },
]
