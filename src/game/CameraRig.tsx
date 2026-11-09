import { useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { input } from './input'

const MIN_ZOOM = 0.5
const MAX_ZOOM = 40
const PAN_SPEED = 700 // screen pixels per second, so panning feels the same at any zoom
const KEY_ZOOM_RATE = 2 // zoom multiplier per second

type Props = { worldWidth: number; worldHeight: number }

/**
 * Orthographic side-scroller camera. Zoom is screen pixels per cell.
 * Pan: WASD / arrows, or drag with right/middle mouse. Zoom: wheel (toward cursor), or Q / E.
 */
export function CameraRig({ worldWidth, worldHeight }: Props) {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const viewportHeight = useThree((s) => s.size.height)

  // Start framing the full world height, at the left edge of the level.
  useEffect(() => {
    const zoom = Math.max(MIN_ZOOM, viewportHeight / worldHeight)
    camera.zoom = zoom
    camera.position.set(Math.min(worldWidth / 2, window.innerWidth / zoom / 2), worldHeight / 2, 100)
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
      camera.zoom = clampZoom(camera.zoom * Math.exp(-e.deltaY * 0.0015))
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
    const speed = ((input.fast() ? 3 : 1) * PAN_SPEED * delta) / camera.zoom
    camera.position.x += (Number(input.right()) - Number(input.left())) * speed
    camera.position.y += (Number(input.up()) - Number(input.down())) * speed

    const zoomDir = Number(input.zoomIn()) - Number(input.zoomOut())
    if (zoomDir !== 0) {
      camera.zoom = clampZoom(camera.zoom * Math.pow(KEY_ZOOM_RATE, zoomDir * delta))
      camera.updateProjectionMatrix()
    }

    // Keep at least part of the world on screen.
    camera.position.x = Math.min(worldWidth, Math.max(0, camera.position.x))
    camera.position.y = Math.min(worldHeight, Math.max(0, camera.position.y))
  })

  return null
}

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
