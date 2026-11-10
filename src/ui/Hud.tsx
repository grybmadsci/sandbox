import { materialByKey } from '../sim/materials'
import { useSandbox } from '../game/store'
import { toolName, tools, type Tool } from '../game/tools'

const toCss = ([r, g, b]: readonly number[]) => `rgb(${r * 255}, ${g * 255}, ${b * 255})`

/** Palette swatch: the material color, a dashed box for the eraser, a ring for air. */
const swatchStyle = (tool: Tool) => {
  if (tool === 'AIR') return { borderRadius: 5, border: '2px solid #9fd3ff' }
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
              {i + 1} {toolName(key)}
            </button>
          )
        })}
      </div>
      <div style={{ marginTop: 6 }}>
        Brush: {brushSize} {pressureView && <strong style={{ marginLeft: 12 }}>PRESSURE VIEW</strong>}
        {paused && <strong style={{ marginLeft: 12 }}>PAUSED</strong>}
      </div>
      <div style={{ opacity: 0.6 }}>
        Left drag: paint (Air: hold to pump pressure, drag to blow) · [ ]: brush size
        <br />
        P: pressure view · Space: pause · R: reset level · C: clear
        <br />
        WASD / arrows or right-drag: pan (Shift = fast) · Wheel or Q/E: zoom
      </div>
    </div>
  )
}
