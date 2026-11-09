"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import { Group, MathUtils } from "three";
import { Pause, Play } from "lucide-react";
import { RoundedBox, Text } from "@react-three/drei";

export const PRACTICE_TOKENS = ["CASHCAT", "BTCETHUSDT", "REBATE", "OAK", "WIF"] as const;
const COLORS = ["#d0f570", "#c8a6f7", "#7ad9dd", "#f0c778", "#f29aa6"];

function Motion({ children, paused, kind, index = 0 }: { children: React.ReactNode; paused: boolean; kind: "body" | "ring" | "coin"; index?: number }) {
  const ref = useRef<Group>(null);
  useFrame(({ clock, pointer }, delta) => {
    if (!ref.current || paused) return;
    if (kind === "ring") ref.current.rotation.y += Math.min(delta, 0.05) * 0.09;
    if (kind === "body") {
      ref.current.rotation.y = MathUtils.damp(ref.current.rotation.y, pointer.x * 0.1, 3, delta);
      ref.current.position.y = Math.sin(clock.elapsedTime * 0.5) * 0.035;
    }
    if (kind === "coin") {
      ref.current.position.y = Math.sin(clock.elapsedTime * 1.1 + index) * 0.1;
      ref.current.rotation.y = Math.sin(clock.elapsedTime * 0.65 + index) * 0.3;
    }
  });
  return <group ref={ref}>{children}</group>;
}

export default function PracticeScene({ selected, onSelect, selectable }: { selected: number; onSelect: (index: number) => void; selectable: boolean }) {
  const [reduced, setReduced] = useState(true);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(true);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false));
    if (host.current) observer.observe(host.current);
    return () => { media.removeEventListener("change", update); observer.disconnect(); };
  }, []);
  const motionStopped = reduced || paused || !visible;
  return (
    <div ref={host} className="scene-floor relative h-[340px] sm:h-[420px]" role="group" aria-label="Five illustrative token podiums. Use the buttons below to select a tribe.">
      <Canvas camera={{ position: [8.8, 6.5, 11], fov: 36 }} dpr={[1, 1.5]} gl={{ alpha: true, antialias: true, powerPreference: "low-power" }}>
        <ambientLight intensity={1.4} />
        <directionalLight position={[3, 6, 5]} intensity={3} color="#f6ffe2" />
        <directionalLight position={[-4, 2, -2]} intensity={2} color="#c5b3eb" />
        <Motion kind="body" paused={motionStopped}>
        <mesh position={[0, -0.45, 0]}><cylinderGeometry args={[4, 3.75, 0.4, 12]} /><meshStandardMaterial color="#252e22" metalness={0.7} roughness={0.45} /></mesh>
        <mesh position={[0, -0.23, 0]}><cylinderGeometry args={[3.7, 3.7, 0.08, 64]} /><meshStandardMaterial color="#343e2d" metalness={0.5} roughness={0.6} /></mesh>
        <Motion kind="ring" paused={motionStopped}>
        {[3.5, 4.15, 4.35].map((radius) => <mesh key={radius} rotation={[Math.PI / 2, 0, 0]} position={[0, -0.12, 0]}><torusGeometry args={[radius, 0.035, 8, 96]} /><meshStandardMaterial color="#829854" emissive="#829854" emissiveIntensity={0.4} metalness={0.6} /></mesh>)}
        {Array.from({ length: 24 }, (_, index) => { const angle = index * Math.PI / 12; return <mesh key={index} position={[Math.cos(angle) * 3.93, -0.1, Math.sin(angle) * 3.93]} rotation={[0, -angle, 0]}><boxGeometry args={[0.17, 0.06, 0.06]} /><meshStandardMaterial color={index % 3 === 0 ? "#d0f570" : "#687650"} /></mesh>; })}
        </Motion>
        {Array.from({ length: 8 }, (_, index) => { const angle = (index + 0.5) * Math.PI / 4; return <group key={index} position={[Math.cos(angle) * 3.25, 0.08, Math.sin(angle) * 3.25]} rotation={[0, -angle, 0]}><RoundedBox args={[0.25, 0.43, 0.32]} radius={0.03}><meshStandardMaterial color="#5b694c" metalness={0.65} roughness={0.4} /></RoundedBox><mesh position={[0, 0.23, 0]}><boxGeometry args={[0.15, 0.03, 0.2]} /><meshStandardMaterial color="#d0f570" emissive="#d0f570" emissiveIntensity={0.5} /></mesh></group>; })}
        {PRACTICE_TOKENS.map((token, index) => {
          const angle = (index / PRACTICE_TOKENS.length) * Math.PI * 2 - Math.PI / 2;
          const x = Math.cos(angle) * 2.45;
          const z = Math.sin(angle) * 2.45;
          const active = selected === index;
          return <group key={token} position={[x, active ? 0.2 : 0, z]} onClick={(event) => { event.stopPropagation(); if (selectable) onSelect(index); }}>
            <mesh><cylinderGeometry args={[0.77, 0.85, 0.3, 8]} /><meshStandardMaterial color={active ? "#5d6b48" : "#303b35"} metalness={0.65} /></mesh>
            <mesh position={[0, 0.17, 0]}><cylinderGeometry args={[0.68, 0.68, 0.04, 32]} /><meshStandardMaterial color={COLORS[index]} emissive={COLORS[index]} emissiveIntensity={active ? 0.7 : 0.2} /></mesh>
            <Motion kind="coin" index={index} paused={motionStopped}>
            <mesh position={[0, 0.95, 0]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[0.59, 0.59, 0.15, 8]} /><meshStandardMaterial color={COLORS[index]} metalness={0.45} roughness={0.3} /></mesh>
            <mesh position={[0, 0.95, 0.09]}><torusGeometry args={[0.45, 0.018, 8, 48]} /><meshStandardMaterial color="#1b2515" /></mesh>
            <Text position={[0, 0.95, 0.1]} fontSize={token.length > 7 ? 0.13 : 0.19} maxWidth={1.05} color="#14201d" anchorX="center" anchorY="middle">{token}</Text>
            </Motion>
          </group>;
        })}
        </Motion>
      </Canvas>
      {!reduced && <button type="button" onClick={() => setPaused((value) => !value)} aria-label={paused ? "Resume 3D animation" : "Pause 3D animation"} aria-pressed={paused} className="absolute bottom-2 right-4 grid h-10 w-10 place-items-center rounded-full border border-edge bg-void/60 text-mute hover:text-neon-green">{paused ? <Play size={13} /> : <Pause size={13} />}</button>}
      <span className="pointer-events-none absolute bottom-4 left-5 text-[9px] uppercase tracking-[.16em] text-mute">5 illustrative tribes · select a podium or use the buttons</span>
    </div>
  );
}
