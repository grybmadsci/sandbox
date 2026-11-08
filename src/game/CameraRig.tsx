import { useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useKeyboardControls } from '@react-three/drei'
import type { Control } from './controls'

const MIN_ZOOM = 8
const MAX_ZOOM = 200
const PAN_SPEED = 600 // screen pixels per second, so panning feels the same at any zoom
const KEY_ZOOM_RATE = 2 // zoom multiplier per second

/**
 * Pan: WASD / arrows, or drag with right/middle mouse.
 * Zoom: scroll wheel (toward cursor), or Q / E.
 */
export function CameraRig() {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const [, getKeys] = useKeyboardControls<Control>()

  useEffect(() => {
    const el = gl.domElement
    let dragging = false

    const setZoom = (zoom: number) => {
      camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
      camera.updateProjectionMatrix()
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const offsetX = e.clientX - rect.left - rect.width / 2
      const offsetY = -(e.clientY - rect.top - rect.height / 2)
      // Keep the world point under the cursor fixed while zooming.
      const worldX = camera.position.x + offsetX / camera.zoom
      const worldY = camera.position.y + offsetY / camera.zoom
      setZoom(camera.zoom * Math.exp(-e.deltaY * 0.001))
      camera.position.x = worldX - offsetX / camera.zoom
      camera.position.y = worldY - offsetY / camera.zoom
    }

    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 1 || e.button === 2) {
        dragging = true
        el.setPointerCapture(e.pointerId)
      }
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return
      camera.position.x -= e.movementX / camera.zoom
      camera.position.y += e.movementY / camera.zoom
    }
    const onPointerUp = (e: PointerEvent) => {
      dragging = false
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
    }
  }, [camera, gl])

  useFrame(({ camera }, delta) => {
    const { up, down, left, right, zoomIn, zoomOut, fast } = getKeys()
    const speed = ((fast ? 3 : 1) * PAN_SPEED * delta) / camera.zoom
    camera.position.x += (Number(right) - Number(left)) * speed
    camera.position.y += (Number(up) - Number(down)) * speed

    const zoomDir = Number(zoomIn) - Number(zoomOut)
    if (zoomDir !== 0) {
      camera.zoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, camera.zoom * Math.pow(KEY_ZOOM_RATE, zoomDir * delta)),
      )
      camera.updateProjectionMatrix()
    }
  })

  return null
}
