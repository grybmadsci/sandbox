import { DataTexture, MeshBasicNodeMaterial, NearestFilter, RGBAFormat, type Node } from 'three/webgpu'
import { pow, texture, vec3, vec4 } from 'three/tsl'
import { OVERVIEW_CELL, TILE_SIDE, overviewTile, sky } from './chunkData'
import { WORLD_SIZE } from './config'

const SIDE = WORLD_SIZE / OVERVIEW_CELL

/** How often the overview is uploaded at most, while chunks are being drawn into it (ms). */
const UPLOAD_EVERY = 500

const toByte = (c: number) => Math.round(Math.min(c, 1) * 255)

/**
 * A low-resolution picture of the whole world, for what the camera sees where chunks
 * aren't on the GPU: each chunk as it was last generated or saved (ChunkManager), a texel
 * per OVERVIEW_CELL x OVERVIEW_CELL cells. Colours are stored as sRGB; `material` converts
 * them as render.wgsl does.
 */
export class Overview {
  readonly texture: DataTexture
  readonly material: MeshBasicNodeMaterial
  private readonly data = new Uint8Array(SIDE * SIDE * 4)
  private changed = false
  private uploaded = 0

  constructor() {
    this.texture = new DataTexture(this.data, SIDE, SIDE, RGBAFormat)
    this.texture.magFilter = NearestFilter
    this.texture.minFilter = NearestFilter
    this.material = new MeshBasicNodeMaterial()
    this.material.colorNode = vec4(pow(texture(this.texture).rgb, vec3(2.2)), 1) as Node<'vec4'>
    this.clear()
  }

  /** Back to just sky. */
  clear() {
    for (let ty = 0; ty < SIDE; ty++) {
      const [r, g, b] = sky((SIDE - 1 - ty) * OVERVIEW_CELL).map(toByte)
      for (let tx = 0; tx < SIDE; tx++) this.data.set([r, g, b, 255], (ty * SIDE + tx) * 4)
    }
    this.changed = true
  }

  /** Draw a chunk from its cells (the first CHUNK_SIZE^2 words of its state). */
  drawChunk(cx: number, cy: number, cells: Int32Array) {
    this.drawTile(cx, cy, overviewTile(cy, cells))
  }

  /** Draw a chunk's tile (chunkData.ts overviewTile). */
  drawTile(cx: number, cy: number, tile: Uint8Array) {
    for (let y = 0; y < TILE_SIDE; y++) {
      // The texture's rows go up from the bottom of the world.
      const row = SIDE - 1 - (cy * TILE_SIDE + y)
      this.data.set(tile.subarray(y * TILE_SIDE * 4, (y + 1) * TILE_SIDE * 4), (row * SIDE + cx * TILE_SIDE) * 4)
    }
    this.changed = true
  }

  /** Upload what changed, if it's been long enough since the last upload. */
  flush(now: number) {
    if (!this.changed || now - this.uploaded < UPLOAD_EVERY) return
    this.texture.needsUpdate = true
    this.changed = false
    this.uploaded = now
  }

  dispose() {
    this.texture.dispose()
    this.material.dispose()
  }
}
