import { Suspense, useEffect, useState } from 'react'
import * as THREE from 'three/webgpu'
import { Canvas, extend } from '@react-three/fiber'
import { Scene } from './game/Scene'
import { useInput } from './game/input'
import { useSandbox } from './game/store'
import { Hud } from './ui/Hud'

// Use the WebGPU build of three for all JSX elements.
extend(THREE as unknown as Parameters<typeof extend>[0])

type Support = 'checking' | 'ok' | 'unsupported'

export default function App() {
  useInput()
  // WebGPURenderer would silently fall back to WebGL2, where the WGSL kernels can't run.
  const [support, setSupport] = useState<Support>(() => (navigator.gpu ? 'checking' : 'unsupported'))
  const fail = useSandbox((s) => s.fail)

  useEffect(() => {
    if (support !== 'checking') return
    navigator.gpu
      .requestAdapter()
      .then((adapter) => setSupport(adapter ? 'ok' : 'unsupported'))
      .catch(() => setSupport('unsupported'))
  }, [support])

  useEffect(() => {
    if (support === 'unsupported') fail('WebGPU is not available in this browser.')
  }, [support, fail])

  return (
    <>
      {support === 'ok' && (
        <Canvas
          orthographic
          flat
          camera={{ position: [0, 0, 100], zoom: 1, near: 0.1, far: 1000 }}
          onContextMenu={(e) => e.preventDefault()}
          gl={async (props) => {
            const renderer = new THREE.WebGPURenderer(props as THREE.WebGPURendererParameters)
            await renderer.init()
            return renderer
          }}
        >
          <Suspense fallback={null}>
            <Scene />
          </Suspense>
        </Canvas>
      )}
      <Hud />
    </>
  )
}
