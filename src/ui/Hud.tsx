import { materialByKey, palette } from '../sim/materials'
import { useSandbox } from '../game/store'

const toCss = ([r, g, b]: readonly number[]) => `rgb(${r * 255}, ${g * 255}, ${b * 255})`

export function Hud() {
  const selected = useSandbox((s) => s.material)
  const brushSize = useSandbox((s) => s.brushSize)
  const paused = useSandbox((s) => s.paused)
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
        {palette.map((key, i) => {
          const m = materialByKey[key]
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
                  background: m.kind === 'empty' ? 'transparent' : toCss(m.color),
                  border: m.kind === 'empty' ? '1px dashed #fff' : 'none',
                }}
              />
              {i + 1} {m.name}
            </button>
          )
        })}
      </div>
      <div style={{ marginTop: 6 }}>
        Brush: {brushSize} {paused && <strong style={{ marginLeft: 12 }}>PAUSED</strong>}
      </div>
      <div style={{ opacity: 0.6 }}>
        Left drag: paint · [ ]: brush size · Space: pause · R: reset level · C: clear
        <br />
        WASD / arrows or right-drag: pan (Shift = fast) · Wheel or Q/E: zoom
      </div>
    </div>
  )
}
