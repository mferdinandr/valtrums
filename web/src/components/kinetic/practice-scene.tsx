"use client";

import { Canvas } from "@react-three/fiber";
import { Text } from "@react-three/drei";

export const PRACTICE_TOKENS = ["CASHCAT", "BTCETHUSDT", "REBATE", "OAK", "WIF"] as const;
const COLORS = ["#d0f570", "#c8a6f7", "#7ad9dd", "#f0c778", "#f29aa6"];

export default function PracticeScene({ selected, onSelect, selectable }: { selected: number; onSelect: (index: number) => void; selectable: boolean }) {
  return (
    <div className="scene-floor relative h-[340px] sm:h-[420px]" role="group" aria-label="Five illustrative token podiums. Use the buttons below to select a tribe.">
      <Canvas camera={{ position: [0, 7, 11], fov: 43 }} dpr={[1, 1.5]} gl={{ alpha: true, antialias: true, powerPreference: "low-power" }}>
        <ambientLight intensity={1.5} />
        <directionalLight position={[3, 8, 5]} intensity={3} />
        <mesh position={[0, -0.35, 0]}><cylinderGeometry args={[4, 4.2, 0.4, 48]} /><meshStandardMaterial color="#25312d" metalness={0.6} roughness={0.45} /></mesh>
        {PRACTICE_TOKENS.map((token, index) => {
          const angle = (index / PRACTICE_TOKENS.length) * Math.PI * 2 - Math.PI / 2;
          const x = Math.cos(angle) * 2.45;
          const z = Math.sin(angle) * 2.45;
          const active = selected === index;
          return <group key={token} position={[x, active ? 0.2 : 0, z]} onClick={(event) => { event.stopPropagation(); if (selectable) onSelect(index); }}>
            <mesh><cylinderGeometry args={[0.77, 0.85, 0.3, 8]} /><meshStandardMaterial color={active ? "#5d6b48" : "#303b35"} metalness={0.65} /></mesh>
            <mesh position={[0, 0.17, 0]}><cylinderGeometry args={[0.68, 0.68, 0.04, 32]} /><meshStandardMaterial color={COLORS[index]} emissive={COLORS[index]} emissiveIntensity={active ? 0.7 : 0.2} /></mesh>
            <mesh position={[0, 0.95, 0]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[0.59, 0.59, 0.14, 32]} /><meshStandardMaterial color={COLORS[index]} metalness={0.5} roughness={0.3} /></mesh>
            <Text position={[0, 0.95, 0.09]} fontSize={token.length > 7 ? 0.13 : 0.19} maxWidth={1.05} color="#14201d" anchorX="center" anchorY="middle">{token}</Text>
          </group>;
        })}
      </Canvas>
      <span className="pointer-events-none absolute bottom-4 left-5 text-[9px] uppercase tracking-[.16em] text-mute">5 illustrative tribes · select a podium or use the buttons</span>
    </div>
  );
}
