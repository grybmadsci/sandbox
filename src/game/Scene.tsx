import { WORLD_SIZE } from '../world/config'
import { spawnPoint } from '../world/worldgen'
import { CameraRig } from './CameraRig'
import { SandWorld } from './SandWorld'

export function Scene() {
  return (
    <>
      <color attach="background" args={['#07080c']} />
      {/* Starting a little above the ground at the spawn point, where the landmarks are. */}
      <CameraRig worldWidth={WORLD_SIZE} worldHeight={WORLD_SIZE} startX={spawnPoint.x} startY={WORLD_SIZE - spawnPoint.y + 140} />
      <SandWorld />
    </>
  )
}
