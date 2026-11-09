"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { RoundedBox, Line } from "@react-three/drei";
import { useEffect, useRef } from "react";
import { Group, MathUtils } from "three";

export type MachineMode =
  | "arena"
  | "battle"
  | "create"
  | "terminal"
  | "portfolio";

function Ring({
  radius,
  color,
  y = 0,
  tilt = 0,
}: {
  radius: number;
  color: string;
  y?: number;
  tilt?: number;
}) {
  return (
    <mesh rotation={[Math.PI / 2 + tilt, 0, 0]} position={[0, y, 0]}>
      <torusGeometry args={[radius, 0.025, 8, 96]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.55}
        metalness={0.6}
        roughness={0.3}
      />
    </mesh>
  );
}

function Token({
  color,
  x,
  side,
  reduced,
  assembly,
}: {
  color: string;
  x: number;
  side: number;
  reduced: boolean;
  assembly: boolean;
}) {
  const ref = useRef<Group>(null);
  useFrame(({ clock }, delta) => {
    if (!ref.current || reduced) return;
    ref.current.position.y =
      0.3 + Math.sin(clock.elapsedTime * 1.1 + side) * 0.12;
    ref.current.rotation.y += delta * 0.25 * side;
  });
  return (
    <group position={[x, 0.3, 0]}>
      <mesh position={[0, -0.65, 0]}>
        <cylinderGeometry args={[0.72, 0.86, 0.22, 8]} />
        <meshStandardMaterial
          color="#3d4636"
          metalness={0.65}
          roughness={0.4}
        />
      </mesh>
      <mesh position={[0, -0.52, 0]}>
        <cylinderGeometry args={[0.62, 0.62, 0.03, 48]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.35}
        />
      </mesh>
      <group ref={ref} rotation={[0.16, side * 0.3, 0]}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.57, 0.57, 0.15, 8]} />
          <meshStandardMaterial
            color={color}
            metalness={0.45}
            roughness={0.3}
          />
        </mesh>
        <mesh position={[0, 0, 0.1]}>
          <torusGeometry args={[0.42, 0.016, 8, 48]} />
          <meshStandardMaterial color="#1b2515" />
        </mesh>
        {[0, 1].map((i) => (
          <RoundedBox
            key={i}
            args={[0.12, 0.46, 0.035]}
            radius={0.015}
            position={[(i - 0.5) * 0.19, 0, 0.11]}
            rotation={[0, 0, (i === 0 ? -1 : 1) * 0.35]}
          >
            <meshStandardMaterial
              color="#1b2515"
              metalness={0.7}
              roughness={0.3}
            />
          </RoundedBox>
        ))}
        {assembly && <Ring radius={0.8} color={color} tilt={0.7} />}
      </group>
    </group>
  );
}

function Assembly({ mode, reduced }: { mode: MachineMode; reduced: boolean }) {
  const spin = useRef<Group>(null);
  const body = useRef<Group>(null);
  const centerpiece = useRef<Group>(null);
  const { pointer, invalidate } = useThree();
  useFrame(({ clock }, delta) => {
    if (reduced) return;
    if (spin.current) spin.current.rotation.y += delta * 0.09;
    if (centerpiece.current) {
      centerpiece.current.rotation.y +=
        delta * (mode === "terminal" ? 0.25 : 0.045);
      centerpiece.current.position.y = Math.sin(clock.elapsedTime * 0.9) * 0.12;
    }
    if (body.current) {
      body.current.rotation.y = MathUtils.damp(
        body.current.rotation.y,
        pointer.x * 0.12,
        3,
        delta,
      );
      body.current.position.y = Math.sin(clock.elapsedTime * 0.5) * 0.035;
    }
  });
  useEffect(() => {
    invalidate();
  }, [mode, invalidate]);
  const core = mode === "terminal";
  const vault = mode === "portfolio";
  return (
    <group ref={body} position={[0, -0.15, 0]}>
      <mesh position={[0, -0.8, 0]}>
        <cylinderGeometry args={[2.6, 2.4, 0.3, 12]} />
        <meshStandardMaterial
          color="#252e22"
          metalness={0.7}
          roughness={0.45}
        />
      </mesh>
      <mesh position={[0, -0.62, 0]}>
        <cylinderGeometry args={[2.35, 2.35, 0.08, 64]} />
        <meshStandardMaterial color="#343e2d" metalness={0.5} roughness={0.6} />
      </mesh>
      <Ring radius={2.2} color="#829854" y={-0.55} />
      <group ref={spin}>
        {Array.from({ length: 24 }, (_, i) => {
          const a = (i / 24) * Math.PI * 2;
          return (
            <mesh
              key={i}
              position={[Math.cos(a) * 2.48, -0.57, Math.sin(a) * 2.48]}
              rotation={[0, -a, 0]}
            >
              <boxGeometry args={[0.13, 0.05, 0.045]} />
              <meshStandardMaterial
                color={i % 3 === 0 ? "#d0f570" : "#687650"}
                emissive={i % 3 === 0 ? "#d0f570" : "#000000"}
                emissiveIntensity={0.5}
              />
            </mesh>
          );
        })}
        <Ring radius={2.75} color="#829854" y={-0.3} />
        <Ring radius={2.9} color="#46503d" y={-0.3} />
      </group>
      {core ? (
        <group ref={centerpiece} rotation={[0, 0, Math.PI / 4]}>
          <RoundedBox args={[1.3, 1.3, 1.3]} radius={0.16}>
            <meshStandardMaterial
              color="#b9d486"
              metalness={0.7}
              roughness={0.25}
            />
          </RoundedBox>
          <mesh position={[0, 0, 0.68]}>
            <boxGeometry args={[0.7, 0.13, 0.06]} />
            <meshStandardMaterial
              color="#172019"
              emissive="#d0f570"
              emissiveIntensity={0.2}
            />
          </mesh>
          <Ring radius={1.35} color="#d0f570" tilt={0.7} />
          <Ring radius={1.55} color="#c8a6f7" tilt={-0.7} />
        </group>
      ) : vault ? (
        <group ref={centerpiece}>
          {[-1.1, 0, 1.1].map((x, i) => (
            <group key={x} position={[x, i === 1 ? 0.12 : -0.04, 0]}>
              <RoundedBox args={[0.9, 1.3, 0.9]} radius={0.09}>
                <meshStandardMaterial
                  color={i === 1 ? "#a3b782" : "#47533d"}
                  roughness={0.35}
                  metalness={0.65}
                />
              </RoundedBox>
              <mesh position={[0, 0.08, 0.47]}>
                <torusGeometry args={[0.23, 0.035, 8, 32]} />
                <meshStandardMaterial
                  color="#d0f570"
                  metalness={0.6}
                  roughness={0.2}
                />
              </mesh>
              <mesh position={[0, -0.39, 0.46]}>
                <boxGeometry args={[0.5, 0.025, 0.035]} />
                <meshStandardMaterial
                  color="#d0f570"
                  emissive="#d0f570"
                  emissiveIntensity={0.5}
                />
              </mesh>
            </group>
          ))}
        </group>
      ) : (
        <>
          <Token
            color="#d0f570"
            x={-1.12}
            side={1}
            reduced={reduced}
            assembly={mode === "create"}
          />
          <Token
            color="#c8a6f7"
            x={1.12}
            side={-1}
            reduced={reduced}
            assembly={mode === "create"}
          />
          <Line
            points={[
              [-1.12, -0.5, 0],
              [0, -0.5, 0.8],
              [1.12, -0.5, 0],
            ]}
            color="#9aa786"
            lineWidth={1}
          />
        </>
      )}
      {Array.from({ length: 6 }, (_, i) => {
        const a = (i / 6) * Math.PI * 2;
        return (
          <group
            key={i}
            position={[Math.cos(a) * 2.05, -0.35, Math.sin(a) * 2.05]}
            rotation={[0, -a, 0]}
          >
            <RoundedBox args={[0.22, 0.4, 0.32]} radius={0.03}>
              <meshStandardMaterial
                color="#5b694c"
                metalness={0.65}
                roughness={0.4}
              />
            </RoundedBox>
            <mesh position={[0, 0.22, 0]}>
              <boxGeometry args={[0.13, 0.025, 0.2]} />
              <meshStandardMaterial
                color="#d0f570"
                emissive="#d0f570"
                emissiveIntensity={0.5}
              />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

export default function Machine({
  mode,
  reduced,
  onFailure,
}: {
  mode: MachineMode;
  reduced: boolean;
  onFailure: () => void;
}) {
  return (
    <Canvas
      camera={{ position: [5.8, 4.3, 7.2], fov: 36 }}
      dpr={[1, 1.5]}
      frameloop={reduced ? "demand" : "always"}
      gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
      onCreated={({ gl }) => {
        gl.domElement.addEventListener("webglcontextlost", onFailure, {
          once: true,
        });
      }}
      fallback={null}
    >
      <ambientLight intensity={1.4} />
      <directionalLight position={[3, 6, 5]} intensity={3} color="#f6ffe2" />
      <directionalLight position={[-4, 2, -2]} intensity={2} color="#c5b3eb" />
      <Assembly mode={mode} reduced={reduced} />
    </Canvas>
  );
}
