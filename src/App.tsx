import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { KeyboardControls } from '@react-three/drei'
import { Physics } from '@react-three/rapier'
import { keyMap } from './game/controls'
import { Scene } from './game/Scene'
import { useHotkeys } from './game/hotkeys'
import { Hud } from './ui/Hud'

export default function App() {
  useHotkeys()

  return (
    <KeyboardControls map={keyMap}>
      <Canvas
        orthographic
        camera={{ position: [0, 4, 100], zoom: 40, near: 0.1, far: 1000 }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <Suspense fallback={null}>
          <Physics>
            <Scene />
          </Physics>
        </Suspense>
      </Canvas>
      <Hud />
    </KeyboardControls>
  )
}
