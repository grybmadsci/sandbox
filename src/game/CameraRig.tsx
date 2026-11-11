import { useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { input } from './input'

const MIN_ZOOM = 0.5
const MAX_ZOOM = 40
const PAN_SPEED = 700 // screen pixels per second, so panning feels the same at any zoom
const KEY_ZOOM_RATE = 2 // zoom multiplier per second
const START_ZOOM = 2

/** The world's size, and where the camera starts (world units, y up). */
type Props = { worldWidth: number; worldHeight: number; startX: number; startY: number }

/**
 * Orthographic side-scroller camera. Zoom is screen pixels per cell.
 * Pan: WASD / arrows, or drag with right/middle mouse. Zoom: wheel (toward cursor), or Q / E.
 * The edges of the screen never go past the edges of the world.
 */
export function CameraRig({ worldWidth, worldHeight, startX, startY }: Props) {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  // Zoomed out no further than the world fills the screen (pixels across over cells across).
  const clampZoom = (zoom: number, width: number, height: number) =>
    Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, width / worldWidth, height / worldHeight, zoom))

  useEffect(() => {
    camera.zoom = START_ZOOM
    camera.position.set(startX, startY, 100)
    camera.updateProjectionMatrix()
    // Only on mount: later resizes keep the player's view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera])

  useEffect(() => {
    const el = gl.domElement
    let dragging = false

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const offsetX = e.clientX - rect.left - rect.width / 2
      const offsetY = -(e.clientY - rect.top - rect.height / 2)
      // Keep the world point under the cursor fixed while zooming.
      const worldX = camera.position.x + offsetX / camera.zoom
      const worldY = camera.position.y + offsetY / camera.zoom
      camera.zoom = clampZoom(camera.zoom * Math.exp(-e.deltaY * 0.0015), rect.width, rect.height)
      camera.updateProjectionMatrix()
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
    // (clampZoom only depends on the world's size, which doesn't change.)
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, gl])

  useFrame(({ camera, size }, delta) => {
    const speed = ((input.fast() ? 3 : 1) * PAN_SPEED * delta) / camera.zoom
    camera.position.x += (Number(input.right()) - Number(input.left())) * speed
    camera.position.y += (Number(input.up()) - Number(input.down())) * speed

    // (Also after the window is resized larger than the world allows at this zoom.)
    const zoomDir = Number(input.zoomIn()) - Number(input.zoomOut())
    const zoom = clampZoom(camera.zoom * Math.pow(KEY_ZOOM_RATE, zoomDir * delta), size.width, size.height)
    if (zoom !== camera.zoom) {
      camera.zoom = zoom
      camera.updateProjectionMatrix()
    }

    // Keep the edges of the screen inside the world.
    const halfWidth = size.width / 2 / camera.zoom
    const halfHeight = size.height / 2 / camera.zoom
    camera.position.x = Math.min(worldWidth - halfWidth, Math.max(halfWidth, camera.position.x))
    camera.position.y = Math.min(worldHeight - halfHeight, Math.max(halfHeight, camera.position.y))
  })

  return null
}
