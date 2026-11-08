import { create } from 'zustand'

export const shapes = ['box', 'ball', 'plank'] as const
export type Shape = (typeof shapes)[number]

export type Body = {
  id: number
  shape: Shape
  position: [number, number]
  color: string
}

type SandboxState = {
  bodies: Body[]
  selected: Shape
  select: (shape: Shape) => void
  spawn: (position: [number, number]) => void
  remove: (id: number) => void
  clear: () => void
}

let nextId = 0
const randomColor = () => `hsl(${Math.floor(Math.random() * 360)}, 65%, 60%)`

export const useSandbox = create<SandboxState>((set) => ({
  bodies: [],
  selected: 'box',
  select: (selected) => set({ selected }),
  spawn: (position) =>
    set((s) => ({
      bodies: [...s.bodies, { id: nextId++, shape: s.selected, position, color: randomColor() }],
    })),
  remove: (id) => set((s) => ({ bodies: s.bodies.filter((b) => b.id !== id) })),
  clear: () => set({ bodies: [] }),
}))
