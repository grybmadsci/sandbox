import { BallCollider, CuboidCollider, RigidBody } from '@react-three/rapier'
import { useSandbox, type Body } from './store'

const KILL_Y = -40

export function Bodies() {
  const bodies = useSandbox((s) => s.bodies)
  const remove = useSandbox((s) => s.remove)

  return (
    <>
      {bodies.map((body) => (
        <SandboxBody key={body.id} body={body} />
      ))}

      {/* Anything falling past this sensor gets removed. */}
      <RigidBody type="fixed" colliders={false} position={[0, KILL_Y, 0]}>
        <CuboidCollider
          sensor
          args={[10000, 1, 10]}
          onIntersectionEnter={({ other }) => {
            const id = other.rigidBody?.userData as { id?: number } | undefined
            if (id?.id !== undefined) remove(id.id)
          }}
        />
      </RigidBody>
    </>
  )
}

function SandboxBody({ body }: { body: Body }) {
  const [x, y] = body.position

  return (
    <RigidBody
      colliders={false}
      position={[x, y, 0]}
      userData={{ id: body.id }}
      // Constrain to the XY plane so the 3D physics engine behaves as 2D.
      enabledTranslations={[true, true, false]}
      enabledRotations={[false, false, true]}
    >
      {body.shape === 'box' && (
        <>
          <CuboidCollider args={[0.5, 0.5, 0.5]} />
          <mesh>
            <boxGeometry />
            <meshStandardMaterial color={body.color} />
          </mesh>
        </>
      )}
      {body.shape === 'ball' && (
        <>
          <BallCollider args={[0.5]} restitution={0.5} />
          <mesh>
            <circleGeometry args={[0.5, 32]} />
            <meshStandardMaterial color={body.color} />
          </mesh>
        </>
      )}
      {body.shape === 'plank' && (
        <>
          <CuboidCollider args={[2, 0.15, 0.5]} />
          <mesh>
            <boxGeometry args={[4, 0.3, 1]} />
            <meshStandardMaterial color={body.color} />
          </mesh>
        </>
      )}
    </RigidBody>
  )
}
