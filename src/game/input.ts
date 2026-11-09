import { useEffect } from 'react'
import { palette } from '../sim/materials'
import { useSandbox } from './store'

/** Currently held keys, by KeyboardEvent.code. Read every frame by the camera. */
export const heldKeys = new Set<string>()

const isHeld = (...codes: string[]) => codes.some((c) => heldKeys.has(c))

export const input = {
  up: () => isHeld('KeyW', 'ArrowUp'),
  down: () => isHeld('KeyS', 'ArrowDown'),
  left: () => isHeld('KeyA', 'ArrowLeft'),
  right: () => isHeld('KeyD', 'ArrowRight'),
  zoomIn: () => isHeld('KeyE', 'Equal'),
  zoomOut: () => isHeld('KeyQ', 'Minus'),
  fast: () => isHeld('ShiftLeft', 'ShiftRight'),
}

/** Tracks held keys and handles one-shot hotkeys. */
export function useInput() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      heldKeys.add(e.code)
      if (e.repeat) return

      const game = useSandbox.getState()
      const index = Number(e.key) - 1
      if (Number.isInteger(index) && index >= 0 && index < palette.length) game.select(palette[index])
      if (e.code === 'BracketLeft') game.resizeBrush(-1)
      if (e.code === 'BracketRight') game.resizeBrush(1)
      if (e.code === 'Space') {
        e.preventDefault()
        game.togglePause()
      }
      if (e.code === 'KeyR') game.reset()
      if (e.code === 'KeyC') game.clear()
    }
    const onKeyUp = (e: KeyboardEvent) => heldKeys.delete(e.code)
    const onBlur = () => heldKeys.clear()

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
}
