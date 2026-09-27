import { useFrame } from '@react-three/fiber';
import { forwardRef, useMemo, useRef } from 'react';
import * as THREE from 'three';

/**
 * Procedural goods-to-person AMR: low drive unit, lift plate, bumper strip,
 * drive wheels + casters, spinning lidar head and a status light ring.
 * Unit size ≈ 1 cell (1.2 m footprint in the twin's scale).
 */
export interface AmrProps {
  accent?: string;
  status?: string; // light ring colour
  carrying?: boolean;
  lidarSpeed?: number;
  detail?: 'high' | 'low';
  glow?: number;
}

const bodyGeo = (() => {
  const s = new THREE.Shape();
  const w = 0.78;
  const r = 0.16;
  s.moveTo(-w / 2 + r, -w / 2);
  s.lineTo(w / 2 - r, -w / 2);
  s.quadraticCurveTo(w / 2, -w / 2, w / 2, -w / 2 + r);
  s.lineTo(w / 2, w / 2 - r);
  s.quadraticCurveTo(w / 2, w / 2, w / 2 - r, w / 2);
  s.lineTo(-w / 2 + r, w / 2);
  s.quadraticCurveTo(-w / 2, w / 2, -w / 2, w / 2 - r);
  s.lineTo(-w / 2, -w / 2 + r);
  s.quadraticCurveTo(-w / 2, -w / 2, -w / 2 + r, -w / 2);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.2, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 3 });
  g.rotateX(-Math.PI / 2);
  return g;
})();

export const AmrModel = forwardRef<THREE.Group, AmrProps>(function AmrModel(
  { accent = '#c9f46b', status = '#c9f46b', carrying = false, lidarSpeed = 4, detail = 'high', glow = 1 },
  ref,
) {
  const lidar = useRef<THREE.Group>(null);
  const ring = useRef<THREE.MeshStandardMaterial>(null);
  const mats = useMemo(
    () => ({
      shell: new THREE.MeshStandardMaterial({ color: '#d5dce5', metalness: 0.45, roughness: 0.32 }),
      top: new THREE.MeshStandardMaterial({ color: '#f8fafc', metalness: 0.3, roughness: 0.3 }),
      dark: new THREE.MeshStandardMaterial({ color: '#1e293b', metalness: 0.4, roughness: 0.5 }),
      rubber: new THREE.MeshStandardMaterial({ color: '#151515', roughness: 0.9 }),
      crate: new THREE.MeshStandardMaterial({ color: '#c08a4d', roughness: 0.75 }),
    }),
    [],
  );
  useFrame((_, dt) => {
    if (lidar.current) lidar.current.rotation.y += dt * lidarSpeed;
    if (ring.current) ring.current.emissiveIntensity = (1.4 + Math.sin(performance.now() / 260) * 0.35) * glow;
  });
  const high = detail === 'high';
  return (
    <group ref={ref}>
      {/* chassis */}
      <mesh geometry={bodyGeo} material={mats.shell} position={[0, 0.07, 0]} castShadow receiveShadow />
      {/* accent bumper band */}
      <mesh position={[0, 0.16, 0]}>
        <boxGeometry args={[0.86, 0.045, 0.86]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.35 * glow} metalness={0.3} roughness={0.4} />
      </mesh>
      {/* lift plate */}
      <mesh position={[0, 0.33, 0]} material={mats.top} castShadow>
        <cylinderGeometry args={[0.3, 0.32, 0.05, high ? 40 : 16]} />
      </mesh>
      {/* status light ring */}
      <mesh position={[0, 0.305, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.33, 0.018, 8, high ? 48 : 20]} />
        <meshStandardMaterial ref={ring} color={status} emissive={status} emissiveIntensity={1.5} toneMapped={false} />
      </mesh>
      {/* front sensor face */}
      <mesh position={[0, 0.17, 0.42]} material={mats.dark}>
        <boxGeometry args={[0.46, 0.09, 0.02]} />
      </mesh>
      {high && (
        <mesh position={[0, 0.17, 0.432]}>
          <boxGeometry args={[0.3, 0.02, 0.005]} />
          <meshStandardMaterial color="#67e8f9" emissive="#67e8f9" emissiveIntensity={2 * glow} toneMapped={false} />
        </mesh>
      )}
      {/* lidar head */}
      <group ref={lidar} position={[0.26, 0.4, 0.26]}>
        <mesh material={mats.dark}>
          <cylinderGeometry args={[0.07, 0.08, 0.09, high ? 20 : 10]} />
        </mesh>
        <mesh position={[0.05, 0.005, 0]}>
          <boxGeometry args={[0.03, 0.03, 0.05]} />
          <meshStandardMaterial color="#c9f46b" emissive="#c9f46b" emissiveIntensity={2.2 * glow} toneMapped={false} />
        </mesh>
      </group>
      {/* wheels */}
      {high &&
        [-1, 1].map((sx) => (
          <mesh key={sx} position={[sx * 0.4, 0.07, 0]} rotation={[0, 0, Math.PI / 2]} material={mats.rubber}>
            <cylinderGeometry args={[0.075, 0.075, 0.05, 18]} />
          </mesh>
        ))}
      {/* payload */}
      {carrying && (
        <group position={[0, 0.36, 0]}>
          <mesh position={[0, 0.17, 0]} material={mats.crate} castShadow>
            <boxGeometry args={[0.52, 0.32, 0.52]} />
          </mesh>
          <mesh position={[0, 0.17, 0]}>
            <boxGeometry args={[0.535, 0.06, 0.535]} />
            <meshStandardMaterial color="#8a5f31" roughness={0.8} />
          </mesh>
        </group>
      )}
    </group>
  );
});
