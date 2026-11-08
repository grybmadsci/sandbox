import { useEffect } from 'react'
import { shapes, useSandbox } from './store'

/** Discrete (non-held) key actions: shape selection and clearing. */
export function useHotkeys() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const index = Number(e.key) - 1
      if (index >= 0 && index < shapes.length) useSandbox.getState().select(shapes[index])
      if (e.code === 'KeyC') useSandbox.getState().clear()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
