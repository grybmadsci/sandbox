import { useEffect, useMemo, useRef } from 'react'
import { useSandbox, type WorldInfo } from '../game/store'
import { biomeAt, biomes, surfaceHeight } from '../world/biomes'
import { WORLD_CHUNKS, WORLD_SIZE } from '../world/config'

/** Pixels across the map. */
const MAP_SIZE = 180

/** How each chunk state is shaded on the map (ChunkState order), and what it's called in the legend. */
const stateStyles = [
  { name: 'Unloaded, as generated', color: null },
  { name: 'Unloaded, kept', color: '#5aa9ff' },
  { name: 'Loaded, asleep', color: '#ffb547' },
  { name: 'Live', color: '#7dff8a' },
] as const

/** The biomes over the whole world (sky above the ground), as an image: depends only on the seed. */
function biomeImage(seed: number) {
  const image = new ImageData(MAP_SIZE, MAP_SIZE)
  const scale = WORLD_SIZE / MAP_SIZE
  for (let px = 0; px < MAP_SIZE; px++) {
    const x = (px + 0.5) * scale
    const ground = surfaceHeight(seed, x)
    for (let py = 0; py < MAP_SIZE; py++) {
      const y = (py + 0.5) * scale
      const color = WORLD_SIZE - y > ground ? [14, 17, 30] : biomeAt(seed, x, y, ground).color
      image.data.set([...color, 255], (py * MAP_SIZE + px) * 4)
    }
  }
  return image
}

/** The world map (biomes, and each chunk's state), where the camera is and what it sees, and saving and loading. */
export function WorldPanel() {
  const world = useSandbox((s) => s.world)
  const persistence = useSandbox((s) => s.persistence)
  const notice = useSandbox((s) => s.notice)
  const file = useRef<HTMLInputElement>(null)
  if (!world) return null
  const button = { font: 'inherit', color: '#fff', background: '#00000066', border: '1px solid #ffffff33', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }
  return (
    <div style={{ position: 'absolute', top: 16, right: 16, width: MAP_SIZE, fontSize: 12, lineHeight: 1.5, textShadow: '0 1px 2px #000' }}>
      <WorldMap world={world} />
      <div>
        Chunk {world.camera[0]}, {world.camera[1]} · {world.biome}
      </div>
      <div style={{ opacity: 0.7 }}>
        {world.live} live · {world.loaded} loaded · {world.stored} kept, of {WORLD_CHUNKS * WORLD_CHUNKS} chunks
        {world.dormant > 0 && ` · ${world.dormant} bodies put away`}
      </div>
      {stateStyles.map(({ name, color }) =>
        color && (
          <div key={name} style={{ opacity: 0.7, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, background: `${color}aa` }} />
            {name}
          </div>
        ),
      )}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
        <button style={button} onClick={() => persistence?.quickSave()}>Save</button>
        <button style={button} onClick={() => persistence?.quickLoad()}>Load</button>
        <button style={button} onClick={() => persistence?.exportFile()}>Export</button>
        <button style={button} onClick={() => file.current?.click()}>Import</button>
        <input
          ref={file}
          type="file"
          accept=".sandsave"
          style={{ display: 'none' }}
          onChange={(e) => {
            const chosen = e.target.files?.[0]
            if (chosen) persistence?.importFile(chosen)
            e.target.value = ''
          }}
        />
      </div>
      {notice && <div style={{ marginTop: 4 }}>{notice}</div>}
    </div>
  )
}

function WorldMap({ world }: { world: WorldInfo }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const image = useMemo(() => biomeImage(world.seed), [world.seed])
  useEffect(() => {
    const context = canvas.current?.getContext('2d')
    if (!context) return
    context.putImageData(image, 0, 0)
    const cell = MAP_SIZE / WORLD_CHUNKS
    // Chunk lines, while they're far enough apart to see.
    if (cell >= 6) {
      context.lineWidth = 1
      context.strokeStyle = '#ffffff1a'
      for (let i = 1; i < WORLD_CHUNKS; i++) {
        context.beginPath()
        context.moveTo(i * cell, 0)
        context.lineTo(i * cell, MAP_SIZE)
        context.moveTo(0, i * cell)
        context.lineTo(MAP_SIZE, i * cell)
        context.stroke()
      }
    }
    world.states.forEach((state, i) => {
      const color = stateStyles[state].color
      if (!color) return
      context.fillStyle = `${color}88`
      context.fillRect((i % WORLD_CHUNKS) * cell, Math.floor(i / WORLD_CHUNKS) * cell, cell, cell)
    })
    // What the camera sees, and its chunk.
    const [x0, y0, x1, y1] = world.view.map((v) => (v / WORLD_SIZE) * MAP_SIZE)
    context.strokeStyle = '#ffffffcc'
    context.lineWidth = 1
    context.strokeRect(x0, y0, x1 - x0, y1 - y0)
    context.fillStyle = '#fff'
    context.beginPath()
    context.arc((world.camera[0] + 0.5) * cell, (world.camera[1] + 0.5) * cell, 3, 0, Math.PI * 2)
    context.fill()
  }, [image, world])
  return (
    <canvas
      ref={canvas}
      width={MAP_SIZE}
      height={MAP_SIZE}
      title={Object.values(biomes)
        .map((b) => b.name)
        .join(', ')}
      style={{ display: 'block', borderRadius: 4, border: '1px solid #ffffff33', marginBottom: 4 }}
    />
  )
}

