"use client";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, type RefObject } from "react";
import {
  Color,
  Group,
  InstancedMesh,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PCFShadowMap,
  Vector3,
} from "three";
import { Armor, Fighter, Nameplate } from "./fighters";
import {
  arenaScale,
  homeAt,
  challengeAt,
  roundAt,
  beatAt,
  clamp,
  fighterPose,
  smooth,
  type PreviewRuntime,
} from "./choreography";

type Runtime = { runtime: RefObject<PreviewRuntime> };
const PARTY = ["#fa927e", "#88d5bf", "#b8a0e6", "#f7ce69", "#86cfe0"];
function Hoop({
  r,
  y,
  color,
  width = 0.06,
}: {
  r: number;
  y: number;
  color: string;
  width?: number;
}) {
  return (
    <mesh position={[0, y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <torusGeometry args={[r, width, 8, 80]} />
      <meshStandardMaterial color={color} roughness={0.65} />
    </mesh>
  );
}

function Carnival({ runtime }: Runtime) {
  const decor = useRef<Group>(null),
    hub = useRef<Group>(null),
    ambience = useRef(0);
  useFrame((_, delta) => {
    const state = runtime.current;
    if (!state.reduced && !state.paused)
      ambience.current += Math.min(delta, 0.05);
    const t = ambience.current;
    decor.current?.children.forEach((g, i) => {
      g.position.y = Math.sin(t * 1.2 + i) * 0.13;
      g.rotation.z = Math.sin(t * 0.7 + i) * 0.025;
    });
    if (hub.current) hub.current.rotation.y = state.reduced ? 0 : t * 0.1;
  });
  const count = runtime.current.roster.length;
  return (
    <>
      <mesh position={[0, -0.55, 0]} receiveShadow castShadow>
        <cylinderGeometry args={[8.4, 8.1, 0.9, 80]} />
        <meshStandardMaterial color="#f7b7a3" roughness={0.75} />
      </mesh>
      <mesh position={[0, -0.035, 0]} receiveShadow>
        <cylinderGeometry args={[8.2, 8.2, 0.12, 80]} />
        <meshStandardMaterial color="#fff2d8" roughness={0.85} />
      </mesh>
      <Hoop r={8.2} y={0.05} color="#fffdf4" width={0.16} />
      <Hoop r={7.75} y={0.04} color="#8bcbbd" width={0.035} />
      {runtime.current.roster.map((c, i) => {
        const [x, z] = homeAt(i, count),
          a = Math.atan2(x, z);
        const [benchX, benchZ] = homeAt(i, count, 6.8);
        return (
          <group key={c.number}>
            <mesh
              rotation={[-Math.PI / 2, 0, -a + Math.PI / 2 - Math.PI / count]}
              position={[0, 0.031, 0]}
            >
              <ringGeometry
                args={[1.35, 7.65, 32, 1, 0, (Math.PI * 2) / count]}
              />
              <meshStandardMaterial
                color={PARTY[i % PARTY.length]}
                transparent
                opacity={0.2}
                depthWrite={false}
                roughness={1}
              />
            </mesh>
            <group
              position={[benchX, 0, benchZ]}
              rotation={[0, a + Math.PI, 0]}
            >
              <Armor
                at={[0, 0.28, 0]}
                size={[1.65, 0.23, 0.85]}
                color={PARTY[i % PARTY.length]}
                radius={0.1}
              />
              <Armor
                at={[0, 0.65, -0.42]}
                size={[1.65, 0.6, 0.16]}
                color="#fff7e8"
                radius={0.07}
              />
              {[-0.55, 0.55].map((s) => (
                <Armor
                  key={s}
                  at={[s, 0.1, 0]}
                  size={[0.15, 0.3, 0.65]}
                  color="#e2a974"
                  radius={0.06}
                />
              ))}
            </group>
            <group
              position={[Math.sin(a) * 7.5, 0, Math.cos(a) * 7.5]}
              rotation={[0, a + Math.PI, 0]}
            >
              <mesh position={[0, 1.1, 0]}>
                <cylinderGeometry args={[0.045, 0.06, 2.2, 10]} />
                <meshStandardMaterial color="#bd8e66" roughness={0.8} />
              </mesh>
              <Armor
                at={[0, 2.05, 0]}
                size={[1.5, 0.48, 0.13]}
                color={PARTY[i % PARTY.length]}
                radius={0.12}
              />
              <Nameplate
                text={c.name}
                color="#334458"
                position={[0, 2.05, 0.08]}
                scale={0.8}
              />
            </group>
          </group>
        );
      })}
      <group ref={hub}>
        <mesh position={[0, 0.2, 0]}>
          <cylinderGeometry args={[1.2, 1.4, 0.35, 40]} />
          <meshStandardMaterial color="#9ed9d1" roughness={0.65} />
        </mesh>
        <Hoop r={1.15} y={0.4} color="#fff9ea" width={0.09} />
        <mesh position={[0, 0.67, 0]} rotation={[0, 0, 0.15]}>
          <octahedronGeometry args={[0.4, 0]} />
          <meshStandardMaterial color="#ffc55e" roughness={0.5} />
        </mesh>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <mesh
            key={i}
            position={[
              Math.sin((i * Math.PI) / 3) * 0.8,
              0.43,
              Math.cos((i * Math.PI) / 3) * 0.8,
            ]}
          >
            <sphereGeometry args={[0.09, 10, 8]} />
            <meshStandardMaterial color={PARTY[i % 5]} />
          </mesh>
        ))}
      </group>
      <group ref={decor}>
        {Array.from({ length: 8 }, (_, i) => {
          const a = (i * Math.PI) / 4 + 0.2;
          return (
            <group key={i}>
              <group position={[Math.sin(a) * 10.5, 0, Math.cos(a) * 10.5]}>
                <mesh position={[0, 3.6, 0]} castShadow>
                  <sphereGeometry args={[0.6, 16, 12]} />
                  <meshStandardMaterial color={PARTY[i % 5]} roughness={0.45} />
                </mesh>
                <mesh position={[0, 1.85, 0]}>
                  <cylinderGeometry args={[0.016, 0.016, 2.6, 6]} />
                  <meshStandardMaterial color="#e1c49b" />
                </mesh>
                <mesh position={[0, 0.4, 0]}>
                  <cylinderGeometry args={[0.4, 0.5, 0.3, 12]} />
                  <meshStandardMaterial color="#fff4dc" />
                </mesh>
                <mesh position={[0, 3.02, 0]} rotation={[Math.PI, 0, 0]}>
                  <coneGeometry args={[0.12, 0.18, 8]} />
                  <meshStandardMaterial color={PARTY[i % 5]} />
                </mesh>
              </group>
            </group>
          );
        })}
      </group>
      {Array.from({ length: 24 }, (_, i) => {
        const a = (i * Math.PI) / 12;
        return (
          <mesh key={i} position={[Math.sin(a) * 8.1, 0.19, Math.cos(a) * 8.1]}>
            <sphereGeometry args={[0.1, 10, 6]} />
            <meshStandardMaterial color={PARTY[i % 5]} />
          </mesh>
        );
      })}
      <mesh position={[0, -1.15, 0]}>
        <cylinderGeometry args={[6.7, 6.4, 0.35, 48]} />
        <meshStandardMaterial color="#b5ddd9" roughness={0.8} />
      </mesh>
      {[
        [-14, -2, -8],
        [12, -2, -9],
        [-10, -3, 12],
      ].map((p, i) => (
        <group key={i} position={p as [number, number, number]}>
          {[-1, 0, 1].map((s) => (
            <mesh key={s} position={[s * 1.1, 0, 0]}>
              <sphereGeometry args={[1.5, 16, 10]} />
              <meshStandardMaterial color="#fffdf2" roughness={1} />
            </mesh>
          ))}
        </group>
      ))}
    </>
  );
}

function ReactorTarget({ index, runtime }: Runtime & { index: number }) {
  const top = useRef<Group>(null),
    ring = useRef<Group>(null),
    leader = useRef<Mesh>(null),
    sign = useRef<Group>(null);
  const color = PARTY[index % PARTY.length]!;
  const target = challengeAt(index, runtime.current.roster.length);
  useFrame(() => {
    const state = runtime.current,
      beat = beatAt(state);
    const age = beat.local - 1.15;
    if (leader.current) {
      leader.current.visible =
        state.chartLeader === index &&
        state.phase === "battle" &&
        beat.round.candidates.includes(index) &&
        beat.round.stage === "fighting";
      leader.current.scale.setScalar(
        state.reduced ? 1 : 1 + Math.sin(state.time * 3) * 0.06,
      );
    }
    const active = beat.fighting && beat.attacker === index && !state.reduced;
    const bounce =
      active && age >= 0 && age < 0.8
        ? Math.sin(age * 17) * Math.exp(-age * 5)
        : 0;
    if (top.current) {
      top.current.position.y = 1.25 + bounce * 0.25;
      top.current.rotation.z = bounce * 0.17;
    }
    if (ring.current) {
      ring.current.scale.setScalar(1 + Math.abs(bounce) * 0.25);
      ring.current.rotation.y = state.reduced ? 0 : state.time * 0.35;
    }
    if (sign.current) {
      sign.current.visible = active && age >= 0 && age < 0.65;
      sign.current.position.y = 2 + Math.max(0, age) * 0.5;
    }
  });
  return (
    <group position={[target.x, 0, target.z]}>
      <mesh
        ref={leader}
        visible={false}
        position={[0, 0.07, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <torusGeometry args={[0.88, 0.065, 8, 48]} />
        <meshBasicMaterial color={runtime.current.roster[index]!.color} />
      </mesh>
      <mesh position={[0, 0.18, 0]} receiveShadow castShadow>
        <cylinderGeometry args={[0.48, 0.6, 0.3, 24]} />
        <meshStandardMaterial color="#fff9ed" roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.7, 0]}>
        <cylinderGeometry args={[0.1, 0.1, 0.9, 12]} />
        <meshStandardMaterial color="#b1c9c7" roughness={0.7} />
      </mesh>
      {[0.4, 0.55, 0.7, 0.85].map((y) => (
        <Hoop key={y} r={0.18} y={y} color={color} width={0.04} />
      ))}
      <group ref={top} position={[0, 1.25, 0]}>
        <mesh castShadow>
          <sphereGeometry args={[0.42, 20, 12]} />
          <meshStandardMaterial color={color} roughness={0.55} />
        </mesh>
        <mesh position={[0, 0, 0.32]}>
          <torusGeometry args={[0.2, 0.055, 8, 24]} />
          <meshStandardMaterial color="#fffdf5" />
        </mesh>
        <mesh position={[0, 0, 0.41]}>
          <sphereGeometry args={[0.08, 12, 8]} />
          <meshStandardMaterial color="#fff9e8" />
        </mesh>
      </group>
      <group ref={ring}>
        <Hoop r={0.63} y={0.06} color={color} width={0.035} />
      </group>
      <group ref={sign} visible={false}>
        <Nameplate
          text="BOING!"
          color="#bd5473"
          position={[0, 0, 0]}
          scale={0.75}
        />
      </group>
    </group>
  );
}

function FestivalEffects({ runtime }: Runtime) {
  const orb = useRef<Mesh>(null),
    burst = useRef<InstancedMesh>(null),
    dummy = useRef(new Object3D());
  const celebration = useRef(0),
    previous = useRef(runtime.current.phase);
  useFrame((_, delta) => {
    const state = runtime.current,
      beat = beatAt(state),
      age = beat.local - 1.15;
    if (previous.current !== state.phase) {
      previous.current = state.phase;
      celebration.current = 0;
    }
    if (state.phase === "result" && !state.paused)
      celebration.current += Math.min(delta, 0.05);
    const festive =
      state.phase === "result" && celebration.current < 3 && !state.reduced;
    const active = beat.fighting && !state.reduced;
    const source = fighterPose(beat.attacker, state),
      target = beat.target;
    if (orb.current) {
      const p = clamp((beat.local - 0.65) / 0.5);
      orb.current.visible = active && source.ranged && p > 0 && p < 1;
      orb.current.position.set(
        MathUtils.lerp(source.x, target.x, p),
        1.5 + Math.sin(p * Math.PI) * 0.5,
        MathUtils.lerp(source.z, target.z, p),
      );
      (orb.current.material as MeshBasicMaterial).color.set(
        PARTY[beat.attacker % 5]!,
      );
    }
    if (burst.current) {
      burst.current.visible = festive || (active && age >= 0 && age < 0.7);
      for (let i = 0; i < 40; i++) {
        const a = i * 2.399,
          t = festive ? celebration.current : age;
        dummy.current.position.set(
          (festive ? 0 : target.x) + Math.sin(a) * (festive ? 6 : 2) * t,
          (festive ? 5 : 1.4) +
            (festive ? 1 : 2) * t -
            (festive ? 0.9 : 5) * t * t,
          (festive ? 0 : target.z) + Math.cos(a) * (festive ? 6 : 2) * t,
        );
        dummy.current.scale.setScalar(
          festive ? 0.12 : Math.max(0, 1 - age / 0.7) * 0.09,
        );
        dummy.current.rotation.set(a, t * 4, a + t);
        dummy.current.updateMatrix();
        burst.current.setMatrixAt(i, dummy.current.matrix);
      }
      burst.current.instanceMatrix.needsUpdate = true;
    }
  });
  useEffect(() => {
    if (burst.current) {
      const color = new Color();
      for (let i = 0; i < 40; i++)
        burst.current.setColorAt(i, color.set(PARTY[i % 5]!));
      if (burst.current.instanceColor)
        burst.current.instanceColor.needsUpdate = true;
    }
  }, []);
  return (
    <>
      <mesh ref={orb} visible={false}>
        <sphereGeometry args={[0.2, 16, 10]} />
        <meshBasicMaterial color="#ffb86d" />
      </mesh>
      <instancedMesh
        ref={burst}
        args={[undefined, undefined, 40]}
        frustumCulled={false}
      >
        <boxGeometry args={[1, 1, 0.25]} />
        <meshStandardMaterial roughness={0.8} />
      </instancedMesh>
    </>
  );
}

function CameraRig({ runtime }: Runtime) {
  const { camera, size } = useThree(),
    gaze = useRef(new Vector3(0, 1, 0)),
    target = useRef(new Vector3()),
    look = useRef(new Vector3());
  useFrame((_, delta) => {
    const state = runtime.current,
      portrait = size.width < 700,
      follow = state.camera === "follow" && state.phase !== "intro",
      p = fighterPose(state.selected, state);
    target.current.set(
      portrait ? 14 : 11.5,
      portrait ? 16.5 : 10,
      portrait ? 19 : 14.5,
    );
    look.current.set(0, 1, 0);
    if (follow) {
      const length = Math.max(0.001, Math.hypot(p.x, p.z)),
        x = -p.x / length,
        z = -p.z / length,
        d = portrait ? 11 : 8;
      target.current.set(
        p.x + x * d + z * 3,
        portrait ? 9 : 6.5,
        p.z + z * d - x * 3,
      );
      look.current.set(p.x, 1.5, p.z);
    } else {
      target.current.multiplyScalar(arenaScale(state.roster.length));
      if (state.phase === "result") {
        const winner = roundAt(state).winner;
        if (winner !== null) {
          const v = fighterPose(winner, state);
          look.current.set(v.x * 0.4, 1.1, v.z * 0.4);
        }
      }
    }
    if (state.phase === "intro")
      target.current.multiplyScalar(1 + (1 - smooth(state.time / 3)) * 0.4);
    if (state.reduced) {
      camera.position.copy(target.current);
      gaze.current.copy(look.current);
    } else {
      const p = 1 - Math.exp(-Math.min(delta, 0.05) * 3);
      camera.position.lerp(target.current, p);
      gaze.current.lerp(look.current, p);
    }
    camera.lookAt(gaze.current);
  });
  return null;
}
function Ready({ onReady }: { onReady: () => void }) {
  const fn = useRef(onReady);
  useEffect(() => {
    fn.current();
  }, []);
  return null;
}
export default function CarnivalScene({
  runtime,
  frozen,
  onSelect,
  onReady,
  onFailure,
}: Runtime & {
  frozen: boolean;
  onSelect: (index: number) => void;
  onReady: () => void;
  onFailure: () => void;
}) {
  return (
    <Canvas
      shadows={{ type: PCFShadowMap }}
      dpr={[1, 1.5]}
      frameloop={frozen ? "demand" : "always"}
      camera={{ position: [18, 16, 24], fov: 43, near: 0.1, far: 120 }}
      gl={{
        alpha: false,
        antialias: true,
        powerPreference: "high-performance",
      }}
      onCreated={({ gl }) => {
        gl.setClearColor("#c6e7eb");
        gl.domElement.addEventListener(
          "webglcontextlost",
          (e) => {
            if (!gl.domElement.isConnected) return;
            e.preventDefault();
            onFailure();
          },
          { once: true },
        );
      }}
    >
      <fog attach="fog" args={["#c6e7eb", 32, 75]} />
      <hemisphereLight args={["#fff8e7", "#b2c7ce", 2]} />
      <ambientLight intensity={0.6} />
      <directionalLight
        position={[-5, 12, 7]}
        color="#fff2d3"
        intensity={2.5}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-13}
        shadow-camera-right={13}
        shadow-camera-top={13}
        shadow-camera-bottom={-13}
        shadow-camera-far={40}
        shadow-normalBias={0.04}
      />
      <directionalLight position={[6, 8, -5]} color="#e4d6ff" intensity={1} />
      <group
        scale={[
          arenaScale(runtime.current.roster.length),
          1,
          arenaScale(runtime.current.roster.length),
        ]}
      >
        <Carnival runtime={runtime} />
      </group>
      {runtime.current.roster.map((c, index) => (
        <group key={c.number}>
          <Fighter index={index} runtime={runtime} onSelect={onSelect} />
          <ReactorTarget index={index} runtime={runtime} />
        </group>
      ))}
      <FestivalEffects runtime={runtime} />
      <CameraRig runtime={runtime} />
      <Ready onReady={onReady} />
    </Canvas>
  );
}
