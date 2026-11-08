import { CuboidCollider, RigidBody } from '@react-three/rapier'

type Block = { position: [number, number]; size: [number, number]; rotation?: number }

const GROUND_COLOR = '#2b3447'

const blocks: Block[] = [
  { position: [0, -1], size: [200, 2] }, // ground
  { position: [-8, 3], size: [6, 0.5] },
  { position: [6, 5], size: [5, 0.5], rotation: -0.25 },
  { position: [16, 2], size: [8, 0.5], rotation: 0.3 },
  { position: [-20, 1.5], size: [1, 5] },
  { position: [24, 7], size: [4, 0.5] },
]

/** Static level geometry. Sizes are full width/height in world units. */
export function World() {
  return (
    <>
      {blocks.map(({ position: [x, y], size: [w, h], rotation = 0 }, i) => (
        <RigidBody key={i} type="fixed" colliders={false} position={[x, y, 0]} rotation={[0, 0, rotation]}>
          <CuboidCollider args={[w / 2, h / 2, 0.5]} />
          <mesh>
            <boxGeometry args={[w, h, 1]} />
            <meshStandardMaterial color={GROUND_COLOR} />
          </mesh>
        </RigidBody>
      ))}
    </>
  )
}
