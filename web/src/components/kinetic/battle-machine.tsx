"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { RoundedBox, useCursor } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CanvasTexture,
  Group,
  MathUtils,
  Vector3,
  SRGBColorSpace,
  MeshStandardMaterial,
  RingGeometry,
} from "three";
import type { Side } from "@/lib/arena/types";
import type { BattleControls } from "./battle-state";

const COLORS = { A: "#d0f570", B: "#c8a6f7" };
const X = { A: -1.5, B: 1.5 };

function TokenLabel({ symbol }: { symbol: string }) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 256;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#192313";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.font = "bold 100px sans-serif";
      context.fillText(symbol, 256, 128, 470);
    }
    const result = new CanvasTexture(canvas);
    result.colorSpace = SRGBColorSpace;
    return result;
  }, [symbol]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <mesh position={[0, 0, 0.105]}>
      <planeGeometry args={[0.65, 0.325]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} />
    </mesh>
  );
}

function Pod({
  side,
  controls,
  reduced,
}: {
  side: Side;
  controls: BattleControls;
  reduced: boolean;
}) {
  const podium = useRef<Group>(null);
  const emblem = useRef<Group>(null);
  const lid = useRef<Group>(null);
  const rim = useRef<MeshStandardMaterial>(null);
  const elapsed = useRef(0);
  const [hovered, setHovered] = useState(false);
  const canSelect =
    controls.selectable &&
    (!controls.lockedSide || controls.lockedSide === side);
  useCursor(hovered && canSelect);
  const selected = controls.selected === side;
  const winner = controls.status === "Settled" && controls.winner === side;
  const open =
    selected && ["preview", "review", "pending"].includes(controls.phase);
  const color = COLORS[side];
  useFrame((_, delta) => {
    if (!reduced) elapsed.current += Math.min(delta, 0.05);
    const blend = (current: number, target: number) =>
      reduced
        ? target
        : MathUtils.damp(current, target, 5, Math.min(delta, 0.05));
    if (podium.current)
      podium.current.position.y = blend(
        podium.current.position.y,
        winner ? 0.65 : selected ? 0.18 : hovered && canSelect ? 0.08 : 0,
      );
    if (rim.current)
      rim.current.emissiveIntensity = blend(
        rim.current.emissiveIntensity,
        winner ? 1.1 : selected ? 0.8 : hovered && canSelect ? 0.5 : 0.12,
      );
    if (lid.current)
      lid.current.rotation.x = blend(lid.current.rotation.x, open ? -1.3 : 0);
    if (emblem.current) {
      emblem.current.rotation.y = blend(
        emblem.current.rotation.y,
        selected ? 0.08 : side === "A" ? 0.4 : -0.4,
      );
      if (!reduced) {
        emblem.current.position.y =
          1.45 + Math.sin(elapsed.current * 1.6 + X[side]) * 0.08;
        emblem.current.rotation.z = Math.sin(elapsed.current * 0.8) * 0.04;
      }
    }
  });
  return (
    <group position={[X[side], 0, 0]}>
      <group
        ref={podium}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
        }}
        onPointerOut={() => setHovered(false)}
        onClick={(e) => {
          e.stopPropagation();
          if (
            controls.selectable &&
            (!controls.lockedSide || controls.lockedSide === side)
          )
            controls.onSelect(side);
        }}
      >
        <mesh position={[0, -0.04, 0]}>
          <cylinderGeometry args={[0.83, 1.02, 0.3, 8]} />
          <meshStandardMaterial color={selected ? "#526046" : "#303a30"} metalness={0.7} roughness={0.35} />
        </mesh>
        <mesh position={[0, 0.13, 0]}>
          <cylinderGeometry args={[0.79, 0.79, 0.035, 48]} />
          <meshStandardMaterial ref={rim} color={color} emissive={color} emissiveIntensity={0.12} />
        </mesh>
        <group ref={lid} position={[0, 0.15, -0.45]}>
          <mesh position={[0, 0, 0.45]}>
            <cylinderGeometry args={[0.59, 0.59, 0.035, 48]} />
            <meshStandardMaterial color={color} metalness={0.35} roughness={0.45} />
          </mesh>
        </group>
        <group ref={emblem} position={[0, 1.45, 0]}>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.62, 0.62, 0.16, 8]} />
            <meshStandardMaterial
              color={color}
              metalness={0.55}
              roughness={0.25}
            />
          </mesh>
          <mesh position={[0, 0, 0.08]}>
            <torusGeometry args={[0.46, 0.025, 8, 48]} />
            <meshStandardMaterial color="#29331f" />
          </mesh>
          <TokenLabel symbol={controls.symbols[side === "A" ? 0 : 1]} />
        </group>
        {selected && (
          <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.17, 0]}>
            <ringGeometry args={[1.05, 1.12, 64]} />
            <meshBasicMaterial color={color} transparent opacity={0.5} />
          </mesh>
        )}
      </group>
    </group>
  );
}

function Capsules({
  controls,
  reduced,
}: {
  controls: BattleControls;
  reduced: boolean;
}) {
  const packets = useRef<Group>(null);
  const origin = useRef(X[controls.selected]);
  const timeline = useRef({ phase: controls.phase, t: 0 });
  useFrame((_, delta) => {
    if (timeline.current.phase !== controls.phase)
      timeline.current = { phase: controls.phase, t: 0 };
    if (!reduced) timeline.current.t += Math.min(delta, 0.05);
    if (packets.current)
      packets.current.position.x = reduced
        ? X[controls.selected]
        : MathUtils.damp(
            packets.current.position.x,
            X[controls.selected],
            6,
            Math.min(delta, 0.05),
          );
    packets.current?.children.forEach((object, i) => {
      const angle = (i / 12) * Math.PI * 2;
      const t = timeline.current.t;
      const success = controls.phase === "success";
      const error = controls.phase === "error";
      const p = reduced ? 1 : Math.min(1, Math.max(0, (t - i * 0.045) / 1.2));
      const a =
        angle + (reduced ? 0 : t * (controls.phase === "pending" ? 1.8 : 0.45));
      const radius = success ? (1 - p) * 1.3 : error ? 1.3 + p * 0.6 : 1.05;
      object.position.set(
        Math.cos(a) * radius,
        success
          ? 1.7 - p * 1.15
          : 0.95 + Math.sin(a * 2) * 0.15 + (error ? -p * 0.5 : 0),
        Math.sin(a) * radius,
      );
      object.rotation.set(0, a, Math.PI / 2);
      object.scale.setScalar(success ? 1 - p : error ? 1 - p : 0.8);
    });
  });
  const visible = controls.phase !== "idle" && controls.phase !== "submitted";
  return (
    <group ref={packets} visible={visible} position={[origin.current, 0, 0]}>
      {Array.from({ length: 12 }, (_, i) => (
        <mesh key={i}>
          <cylinderGeometry args={[0.09, 0.09, 0.04, 12]} />
          <meshStandardMaterial
            color={
              controls.phase === "error" ? "#ff6f78" : COLORS[controls.selected]
            }
            emissive={COLORS[controls.selected]}
            emissiveIntensity={0.5}
            transparent
            opacity={
              controls.phase === "preview" || controls.phase === "review"
                ? 0.45
                : 1
            }
          />
        </mesh>
      ))}
    </group>
  );
}

function Engine({
  controls,
  reduced,
}: {
  controls: BattleControls;
  reduced: boolean;
}) {
  const rotor = useRef<Group>(null);
  const target = useRef(new Vector3());
  const gaze = useRef(new Vector3(0, 0.2, 0));
  const elapsed = useRef(0);
  const { camera, size, invalidate } = useThree();
  const stopped =
    controls.status === "Voided" || controls.status === "EmergencyHalted";
  useEffect(() => {
    invalidate();
  }, [controls, reduced, invalidate]);
  useFrame((_, delta) => {
    if (!reduced) elapsed.current += Math.min(delta, 0.05);
    const focus = controls.selected === "A" ? -0.65 : 0.65;
    target.current.set(
      size.width < 600 ? 5 : 5.6,
      size.width < 600 ? 7 : 5.3,
      size.width < 600 ? 12 : 8.2,
    );
    target.current.x += focus;
    if (reduced) camera.position.copy(target.current);
    else
      camera.position.lerp(
        target.current,
        1 - Math.exp(-Math.min(delta, 0.05) * 3),
      );
    gaze.current.x = reduced
      ? focus * 0.35
      : MathUtils.damp(gaze.current.x, focus * 0.35, 3, Math.min(delta, 0.05));
    camera.lookAt(gaze.current);
    if (rotor.current && !reduced && !stopped) {
      rotor.current.rotation.y +=
        Math.min(delta, 0.05) * (controls.status === "Live" ? 0.28 : 0.09);
      rotor.current.position.y = Math.sin(elapsed.current * 0.7) * 0.04;
    }
  });
  return (
    <>
      <mesh position={[0, -0.7, 0]}>
        <cylinderGeometry args={[3.3, 3.5, 0.35, 12]} />
        <meshStandardMaterial color="#273127" metalness={0.7} roughness={0.4} />
      </mesh>
      <mesh position={[0, -0.49, 0]}>
        <cylinderGeometry args={[3.15, 3.15, 0.08, 64]} />
        <meshStandardMaterial color="#303b30" metalness={0.6} roughness={0.5} />
      </mesh>
      <group ref={rotor}>
        {[2.9, 3.25, 3.5].map((r) => (
          <mesh key={r} rotation={[Math.PI / 2, 0, 0]} position={[0, -0.3, 0]}>
            <torusGeometry args={[r, 0.025, 8, 96]} />
            <meshStandardMaterial
              color={stopped ? "#92434d" : "#8fa968"}
              emissive={stopped ? "#92434d" : "#8fa968"}
              emissiveIntensity={0.45}
            />
          </mesh>
        ))}
        {Array.from({ length: 40 }, (_, i) => {
          const a = (i / 40) * Math.PI * 2;
          return (
            <mesh
              key={i}
              position={[Math.cos(a) * 3.35, -0.22, Math.sin(a) * 3.35]}
              rotation={[0, -a, 0]}
            >
              <boxGeometry args={[0.13, 0.04, 0.045]} />
              <meshStandardMaterial
                color={i % 5 === 0 ? "#d0f570" : "#4e6357"}
                emissive={i % 5 === 0 ? "#d0f570" : "#000"}
                emissiveIntensity={0.6}
              />
            </mesh>
          );
        })}
      </group>
      {controls.status === "Live" && (
        <TimerRing progress={controls.progress} reduced={reduced} />
      )}
      {Array.from({ length: 8 }, (_, i) => {
        const angle = (i / 8) * Math.PI * 2;
        return <group key={i} position={[Math.cos(angle) * 2.7, 0.1, Math.sin(angle) * 2.7]}>
          <RoundedBox args={[0.3, 1.1, 0.4]} radius={0.04}>
            <meshStandardMaterial
              color="#61705d"
              metalness={0.8}
              roughness={0.35}
            />
          </RoundedBox>
          <mesh position={[0, 0.58, 0]}>
            <boxGeometry args={[0.2, 0.04, 0.26]} />
            <meshStandardMaterial
              color={stopped ? "#ff6f78" : "#d0f570"}
              emissive={stopped ? "#ff6f78" : "#d0f570"}
              emissiveIntensity={1}
            />
          </mesh>
        </group>;
      })}
      <Pod side="A" controls={controls} reduced={reduced} />
      <Pod side="B" controls={controls} reduced={reduced} />
      <Capsules controls={controls} reduced={reduced} />
    </>
  );
}

// Keep one geometry alive. Only reveal its index range as recorded progress advances.
function TimerRing({
  progress,
  reduced,
}: {
  progress: number;
  reduced: boolean;
}) {
  const geometry = useRef<RingGeometry>(null);
  const shown = useRef(progress);
  useFrame((_, delta) => {
    shown.current = reduced
      ? progress
      : MathUtils.damp(shown.current, progress, 8, Math.min(delta, 0.05));
    geometry.current?.setDrawRange(
      0,
      Math.floor(Math.max(0, Math.min(1, shown.current)) * 256) * 6,
    );
  });
  return (
    <mesh rotation={[-Math.PI / 2, 0, -Math.PI / 2]} position={[0, -0.18, 0]}>
      <ringGeometry ref={geometry} args={[2.99, 3.1, 256]} />
      <meshStandardMaterial
        color="#f0cc86"
        emissive="#f0cc86"
        emissiveIntensity={0.7}
      />
    </mesh>
  );
}

export default function BattleMachine({
  controls,
  reduced,
  onFailure,
}: {
  controls: BattleControls;
  reduced: boolean;
  onFailure: () => void;
}) {
  return (
    <Canvas
      camera={{ position: reduced ? [5.6, 5.3, 8.2] : [9, 10, 15], fov: 43 }}
      dpr={[1, 1.5]}
      frameloop={reduced ? "demand" : "always"}
      gl={{ alpha: true, antialias: true, powerPreference: "low-power" }}
      onCreated={({ gl }) =>
        gl.domElement.addEventListener("webglcontextlost", onFailure, {
          once: true,
        })
      }
    >
      <ambientLight intensity={1.2} />
      <directionalLight position={[2, 6, 4]} intensity={3} color="#efffd2" />
      <directionalLight
        position={[-4, 3, -2]}
        intensity={2.2}
        color="#ae99ea"
      />
      <Engine controls={controls} reduced={reduced} />
    </Canvas>
  );
}
