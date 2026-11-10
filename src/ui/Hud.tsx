import { materialByKey } from '../sim/materials'
import { useSandbox } from '../game/store'
import { toolKey, toolName, tools, type Tool } from '../game/tools'
import type { Inspection } from '../sim/inspect'

const toCss = ([r, g, b]: readonly number[]) => `rgb(${r * 255}, ${g * 255}, ${b * 255})`

/** Palette swatch: the material color, a dashed box for the eraser, a ring for air, a dashed ring for the vacuum. */
const swatchStyle = (tool: Tool) => {
  if (tool === 'AIR') return { borderRadius: 5, border: '2px solid #9fd3ff' }
  if (tool === 'VACUUM') return { borderRadius: 5, border: '2px dashed #9fd3ff' }
  if (tool === 'INSPECT') return { borderRadius: 5, border: '2px solid #fff' }
  const m = materialByKey[tool]
  if (m.kind === 'empty') return { border: '1px dashed #fff' }
  return { background: toCss(m.color) }
}

export function Hud() {
  const selected = useSandbox((s) => s.tool)
  const brushSize = useSandbox((s) => s.brushSize)
  const paused = useSandbox((s) => s.paused)
  const pressureView = useSandbox((s) => s.pressureView)
  const error = useSandbox((s) => s.error)
  const inspection = useSandbox((s) => s.inspection)
  const select = useSandbox((s) => s.select)

  if (error) {
    return (
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 24 }}>
        <div style={{ maxWidth: 420, textAlign: 'center', lineHeight: 1.5 }}>
          <strong>{error}</strong>
          <div style={{ opacity: 0.7, marginTop: 8 }}>
            Try a recent Chrome or Edge, or another browser with WebGPU enabled.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 16,
        left: 16,
        pointerEvents: 'none',
        fontSize: 14,
        lineHeight: 1.6,
        textShadow: '0 1px 2px #000',
      }}
    >
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', pointerEvents: 'auto' }}>
        {tools.map((key, i) => {
          const active = key === selected
          return (
            <button
              key={key}
              onClick={() => select(key)}
              style={{
                font: 'inherit',
                color: '#fff',
                background: active ? '#ffffff22' : '#00000066',
                border: `1px solid ${active ? '#fff' : '#ffffff33'}`,
                borderRadius: 6,
                padding: '4px 10px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  boxSizing: 'border-box',
                  ...swatchStyle(key),
                }}
              />
              {toolKey(key, i)} {toolName(key)}
            </button>
          )
        })}
      </div>
      <div style={{ marginTop: 6 }}>
        Brush: {brushSize} {pressureView && <strong style={{ marginLeft: 12 }}>PRESSURE VIEW</strong>}
        {paused && <strong style={{ marginLeft: 12 }}>PAUSED</strong>}
      </div>
      <div style={{ opacity: 0.6 }}>
        Left drag: paint (Air: hold to pump pressure, drag to blow; Vacuum: hold to take air out) · [ ]: brush size
        <br />
        P: pressure view · Space: pause · R: reset level · C: clear
        <br />
        WASD / arrows or right-drag: pan (Shift = fast) · Wheel or Q/E: zoom · I: inspect
      </div>
      {selected === 'INSPECT' && <InspectPanel inspection={inspection} />}
    </div>
  )
}

const fixed = (n: number, digits = 1) => n.toFixed(digits)

/** The inspect tool's readout for the cell under the cursor. */
function InspectPanel({ inspection: i }: { inspection: Inspection | null }) {
  const rows: [string, string][] = []
  if (i) {
    rows.push(['Cell', `${i.x}, ${i.y}`])
    // The empty material is named for its tool (Eraser); here it is just empty space.
    const name = i.material.kind === 'empty' ? 'Empty' : i.material.name
    rows.push(['Contents', `${name} (${i.material.kind}, density ${i.material.density})`])
    if (i.material.kind === 'liquid' || i.material.kind === 'gas') rows.push(['Flowing', i.direction])
    if (i.material.kind === 'liquid') {
      rows.push(['Mass in transit', `${i.credit} cell${i.credit === 1 ? '' : 's'} of credit`])
      rows.push([
        'Liquid pressure',
        i.liquid
          ? `${fixed(i.liquid.pressure)} rows (highest surface row ${fixed(i.liquid.head)}, sink ${i.liquid.sinkDistance ?? 'none'} cols away)`
          : 'none (falling, or no free surface reachable)',
      ])
    }
    if (i.air) {
      rows.push(['Air mass', `${fixed(i.air.mass, 3)} cells at 1 atm`])
      rows.push(['Air volume', `${i.air.open} of 16 open (smoothed ${fixed(i.air.smoothedOpen, 2)})`])
      rows.push([
        'Air pressure',
        i.air.open > 0
          ? `${fixed(i.air.atmospheres, 3)} atm (${fixed(i.air.gaugeRows)} rows), felt ${fixed(i.air.feltRows)} rows`
          : 'none (no open space)',
      ])
      rows.push(['Wind', `${fixed(i.air.wind[0], 2)}, ${fixed(i.air.wind[1], 2)} cells/step`])
    }
  }
  return (
    <div
      style={{
        marginTop: 8,
        padding: '6px 10px',
        background: 'rgba(0, 0, 0, 0.55)',
        borderRadius: 6,
        display: 'inline-grid',
        gridTemplateColumns: 'auto auto',
        columnGap: 12,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {i ? (
        rows.map(([label, value]) => [
          <span key={`${label}-l`} style={{ opacity: 0.6 }}>
            {label}
          </span>,
          <span key={`${label}-v`}>{value}</span>,
        ])
      ) : (
        <span>Hover over the world to inspect a cell.</span>
      )}
    </div>
  )
}
