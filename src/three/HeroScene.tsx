import { Canvas, useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { AmrModel } from './AmrModel';

function ScanRings() {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    const t = performance.now() / 1000;
    g.current?.children.forEach((m, i) => {
      const k = ((t * 0.45 + i / 3) % 1) as number;
      m.scale.setScalar(0.6 + k * 2.6);
      ((m as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.45;
    });
  });
  return (
    <group ref={g} position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      {[0, 1, 2].map((i) => (
        <mesh key={i}>
          <ringGeometry args={[0.98, 1, 96]} />
          <meshBasicMaterial color="#c9f46b" transparent opacity={0.3} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

/** Holographic space-time ribbon: the robot's reserved future, stacked in time. */
function Ribbon() {
  const cells = useMemo(() => {
    const pts: [number, number, number][] = [];
    const path = [[0, 0], [0, -1], [0, -2], [1, -2], [2, -2], [2, -3], [2, -4], [3, -4], [4, -4], [4, -5]];
    path.forEach((p, t) => pts.push([p[0] * 0.55, 0.25 + t * 0.2, p[1] * 0.55]));
    return pts;
  }, []);
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    const t = performance.now() / 1000;
    g.current?.children.forEach((m, i) => {
      const mat = (m as THREE.Mesh).material as THREE.MeshStandardMaterial;
      mat.opacity = 0.18 + 0.5 * (0.5 + 0.5 * Math.sin(t * 2 - i * 0.55)) * (1 - i / cells.length);
    });
  });
  return (
    <group ref={g} position={[0.6, 0, -0.2]}>
      {cells.map((c, i) => (
        <mesh key={i} position={c}>
          <boxGeometry args={[0.46, 0.06, 0.46]} />
          <meshStandardMaterial color="#86e7a6" emissive="#86e7a6" emissiveIntensity={0.9} transparent opacity={0.4} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

function Rig({ pointer }: { pointer: React.MutableRefObject<{ x: number; y: number }> }) {
  const g = useRef<THREE.Group>(null);
  const bot = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (!g.current) return;
    const p = pointer.current;
    g.current.rotation.y += ((p.x * 0.5 - 0.5) - g.current.rotation.y) * Math.min(1, dt * 3);
    g.current.rotation.x += ((p.y * 0.12 + 0.05) - g.current.rotation.x) * Math.min(1, dt * 3);
    if (bot.current) bot.current.position.y = 0.02 + Math.sin(performance.now() / 700) * 0.03;
  });
  return (
    <group ref={g}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[2.3, 64]} />
        <meshStandardMaterial color="#182028" metalness={0.2} roughness={0.85} transparent opacity={0.95} />
      </mesh>
      <gridHelper args={[4.4, 11, '#3a4d2a', '#26302a']} position={[0, 0.002, 0]} />
      <ScanRings />
      <Ribbon />
      <group ref={bot} scale={1.85}>
        <AmrModel accent="#c9f46b" status="#86e7a6" lidarSpeed={5} glow={1.2} />
      </group>
    </group>
  );
}

export function HeroScene({ pointer, active = true }: { pointer: React.MutableRefObject<{ x: number; y: number }>; active?: boolean }) {
  return (
    <Canvas frameloop={active ? 'always' : 'never'} shadows dpr={[1, 2]} camera={{ position: [4.4, 2.6, 5.4], fov: 32 }} gl={{ antialias: true, alpha: true }} style={{ background: 'transparent' }}>
      <ambientLight intensity={1.1} />
      <hemisphereLight args={['#e0f2fe', '#1e293b', 1.0]} />
      <directionalLight position={[4, 6, 3]} intensity={3.2} castShadow shadow-mapSize={[1024, 1024]} />
      <directionalLight position={[-4, 3, -2]} intensity={1.2} color="#c7f9cc" />
      <pointLight position={[-2, 1.5, 2]} intensity={6} color="#86e7a6" distance={8} />
      <pointLight position={[2, 0.6, -2]} intensity={4} color="#67e8f9" distance={6} />
      <group position={[0, -0.6, 0]}>
        <Rig pointer={pointer} />
      </group>
    </Canvas>
  );
}
