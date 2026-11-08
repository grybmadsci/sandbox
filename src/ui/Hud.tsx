import { shapes, useSandbox } from '../game/store'

export function Hud() {
  const selected = useSandbox((s) => s.selected)
  const count = useSandbox((s) => s.bodies.length)

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
      <div>
        {shapes.map((shape, i) => (
          <span key={shape} style={{ marginRight: 12, opacity: shape === selected ? 1 : 0.45 }}>
            [{i + 1}] {shape}
          </span>
        ))}
      </div>
      <div>Bodies: {count}</div>
      <div style={{ opacity: 0.6 }}>
        Left click: spawn · Right/middle drag or WASD: pan (Shift = fast)
        <br />
        Wheel or Q/E: zoom · C: clear
      </div>
    </div>
  )
}
