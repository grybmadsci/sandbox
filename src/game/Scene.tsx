import { CameraRig } from './CameraRig'
import { SandWorld } from './SandWorld'

const WORLD_WIDTH = 2048
const WORLD_HEIGHT = 512

export function Scene() {
  return (
    <>
      <color attach="background" args={['#07080c']} />
      <CameraRig worldWidth={WORLD_WIDTH} worldHeight={WORLD_HEIGHT} />
      <SandWorld width={WORLD_WIDTH} height={WORLD_HEIGHT} />
    </>
  )
}
