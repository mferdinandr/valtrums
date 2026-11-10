"use client";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import { useEffect, useMemo, useRef } from "react";
import {
  AnimationMixer,
  Group,
  MathUtils,
  Mesh,
  PCFShadowMap,
  RingGeometry,
  Vector3,
} from "three";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import {
  CHARACTER_ASSET_VERSION,
  CONTENDERS,
} from "@/components/colosseum/choreography";
import { Nameplate } from "@/components/colosseum/fighters";
import type { WorldProps } from "./scene";
function prepareScene(source: Group) {
  const result = clone(source);
  result.traverse((node) => {
    if (node instanceof Mesh) {
      node.castShadow = true;
      node.receiveShadow = true;
    }
  });
  return result;
}

function Mascot({
  asset,
  at,
  scale = 1,
  selected = false,
  frozen,
  onClick,
}: {
  asset: string;
  at: [number, number, number];
  scale?: number;
  selected?: boolean;
  frozen: boolean;
  onClick?: () => void;
}) {
  const gltf = useGLTF(
    `/models/colosseum/${asset}.glb?v=${CHARACTER_ASSET_VERSION}`,
  );
  const scene = useMemo(() => prepareScene(gltf.scene), [gltf.scene]),
    mixer = useMemo(() => new AnimationMixer(scene), [scene]);
  const actions = useMemo(
    () =>
      gltf.animations
        .filter((c) => c.name === "Idle" || c.name === "Selected")
        .map((c) => ({ name: c.name, action: mixer.clipAction(c) })),
    [gltf.animations, mixer],
  );
  const elapsed = useRef(0),
    salute = useRef(2),
    initialized = useRef(false);
  useEffect(() => {
    actions.forEach(({ action }) => action.play());
    return () => {
      mixer.stopAllAction();
    };
  }, [actions, mixer]);
  useEffect(() => {
    if (selected) salute.current = 0;
  }, [selected]);
  useFrame((_, delta) => {
    if (frozen && initialized.current) return;
    if (!frozen) {
      elapsed.current += Math.min(delta, 0.05);
      salute.current += Math.min(delta, 0.05);
    }
    const waving = selected && !frozen && salute.current < 1.2;
    actions.forEach(({ name, action }) => {
      const target = name === (waving ? "Selected" : "Idle") ? 1 : 0;
      action.setEffectiveWeight(
        frozen
          ? target
          : MathUtils.damp(
              action.getEffectiveWeight(),
              target,
              10,
              Math.min(delta, 0.05),
            ),
      );
      action.time =
        name === "Selected"
          ? Math.min(salute.current, 1.19)
          : frozen
            ? 0
            : elapsed.current % 2;
    });
    mixer.update(0);
    initialized.current = true;
  });
  return (
    <group
      position={at}
      scale={scale}
      rotation={[0, 0.15, 0]}
      onClick={(e) => {
        if (onClick) {
          e.stopPropagation();
          onClick();
        }
      }}
    >
      <primitive object={scene} dispose={null} />
    </group>
  );
}
function Installation(props: WorldProps) {
  const { mode, selected, frozen, battle } = props;
  const gltf = useGLTF(`/models/carnival/${mode}.glb?v=festival-2`),
    scene = useMemo(() => prepareScene(gltf.scene), [gltf.scene]);
  const elapsed = useRef(0),
    phase = useRef({ name: battle?.phase, t: 0 }),
    packets = useRef<Group>(null),
    gaze = useRef(new Vector3(0, 0.9, 0)),
    targetCamera = useRef(new Vector3()),
    timer = useRef<RingGeometry>(null);
  useEffect(() => {
    if (mode === "welcome" || mode === "arena")
      CONTENDERS.forEach((c) =>
        useGLTF.preload(
          `/models/colosseum/${c.asset}.glb?v=${CHARACTER_ASSET_VERSION}`,
        ),
      );
  }, [mode]);
  const { camera, size } = useThree();
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    if (!frozen) elapsed.current += dt;
    const bubble = scene.getObjectByName("SpeechBubble");
    if (bubble)
      bubble.position.y =
        2.65 + (frozen ? 0 : Math.sin(elapsed.current * 1.5) * 0.07);
    if (battle) {
      timer.current?.setDrawRange(
        0,
        Math.floor(Math.max(0, Math.min(1, battle.progress)) * 128) * 6,
      );
      if (phase.current.name !== battle.phase)
        phase.current = { name: battle.phase, t: 0 };
      if (!frozen) phase.current.t += dt;
      for (const side of ["A", "B"] as const) {
        const lid = scene.getObjectByName(`Vault${side}Lid`);
        if (lid) {
          const open =
            battle.selected === side &&
            ["preview", "review", "pending"].includes(battle.phase);
          lid.rotation.x = frozen
            ? open
              ? -1.2
              : 0
            : MathUtils.damp(lid.rotation.x, open ? -1.2 : 0, 6, dt);
        }
      }
      if (packets.current) {
        packets.current.visible = !["idle", "submitted"].includes(battle.phase);
        packets.current.children.forEach((coin, i) => {
          const t = phase.current.t,
            angle = (i / 10) * Math.PI * 2 + (frozen ? 0 : t * 0.6),
            p = frozen ? 1 : Math.min(1, Math.max(0, (t - i * 0.04) / 1.1)),
            success = battle.phase === "success",
            error = battle.phase === "error",
            radius = success ? 1 - p : error ? 1 + p * 0.4 : 1;
          coin.position.set(
            (battle.selected === "A" ? -1.55 : 1.55) + Math.cos(angle) * radius,
            success ? 1.5 - p * 0.7 : 1.2 + Math.sin(angle) * 0.1,
            Math.sin(angle) * radius,
          );
          coin.scale.setScalar(success || error ? 1 - p : 1);
        });
      }
    }
    const portrait = size.width < 600;
    const position =
      mode === "welcome" || mode === "arena"
        ? targetCamera.current.set(8, portrait ? 7 : 5.8, portrait ? 12 : 10)
        : targetCamera.current.set(
            portrait ? 7 : 6.5,
            portrait ? 6.5 : 5,
            portrait ? 10 : 9,
          );
    if (frozen) camera.position.copy(position);
    else camera.position.lerp(position, 1 - Math.exp(-dt * 3));
    camera.lookAt(gaze.current);
  });
  const primary = CONTENDERS[selected] ?? CONTENDERS[0]!;
  const host =
    mode === "terminal"
      ? "rebate"
      : mode === "portfolio"
        ? "oak"
        : "btcethusdt";
  return (
    <>
      <primitive object={scene} dispose={null} />
      {mode === "welcome" || mode === "arena" ? (
        <>
          <Mascot
            key={primary.asset}
            asset={primary.asset}
            at={[0, 0.3, 0.6]}
            scale={0.9}
            selected
            frozen={frozen}
            onClick={() => props.onSelect?.(selected)}
          />
          {[1, 2].map((offset, i) => {
            const index = (selected + offset) % CONTENDERS.length;
            return (
              <Mascot
                key={`guest-${i}-${index}`}
                asset={CONTENDERS[index]!.asset}
                at={[i === 0 ? -2.1 : 2.1, 0.3, 0.6]}
                scale={0.65}
                frozen={frozen}
                onClick={() => props.onSelect?.(index)}
              />
            );
          })}
          <Nameplate
            text="VALTRUM"
            color="#58617a"
            position={[0, 3, -1.3]}
            scale={1.8}
          />
        </>
      ) : mode !== "battle" ? (
        <Mascot
          asset={host}
          at={[
            mode === "portfolio" ? -1.9 : 1.7,
            0.1,
            mode === "portfolio" ? 0.8 : 0.4,
          ]}
          scale={0.7}
          frozen={frozen}
        />
      ) : (
        <>
          {(["A", "B"] as const).map((side, i) => {
            const registered = CONTENDERS.find(
              (c) => c.demoTokenId === battle?.tokenIds?.[i],
            );
            const x = side === "A" ? -1.55 : 1.55;
            return (
              <group
                key={side}
                onClick={(e) => {
                  e.stopPropagation();
                  if (
                    battle?.selectable &&
                    (!battle.lockedSide || battle.lockedSide === side)
                  )
                    battle.onSelect(side);
                }}
              >
                {registered ? (
                  <Mascot
                    asset={registered.asset}
                    at={[x, 0, -1.2]}
                    scale={0.7}
                    frozen={frozen}
                  />
                ) : (
                  <>
                    <mesh
                      position={[x, 1.85, 0]}
                      rotation={[Math.PI / 2, 0, 0]}
                    >
                      <cylinderGeometry args={[0.52, 0.52, 0.12, 24]} />
                      <meshStandardMaterial
                        color={side === "A" ? "#a5d4bc" : "#c7b5e6"}
                        roughness={0.65}
                      />
                    </mesh>
                    <Nameplate
                      text={battle?.symbols[i] ?? side}
                      color="#49626d"
                      position={[x, 1.85, 0.075]}
                      scale={0.65}
                    />
                  </>
                )}
                <mesh rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.2, 0]}>
                  <ringGeometry args={[0.9, 1, 48]} />
                  <meshBasicMaterial
                    color={side === "A" ? "#74b494" : "#b499d6"}
                    transparent
                    opacity={battle?.selected === side ? 0.9 : 0.25}
                  />
                </mesh>
              </group>
            );
          })}
          <group ref={packets}>
            {Array.from({ length: 10 }, (_, i) => (
              <mesh key={i} rotation={[Math.PI / 2, 0, 0]}>
                <cylinderGeometry args={[0.08, 0.08, 0.035, 12]} />
                <meshStandardMaterial
                  color="#f4cb71"
                  transparent
                  opacity={
                    battle?.phase === "preview" || battle?.phase === "review"
                      ? 0.5
                      : 1
                  }
                />
              </mesh>
            ))}
          </group>
          {battle?.status === "Live" && (
            <mesh
              rotation={[-Math.PI / 2, 0, -Math.PI / 2]}
              position={[0, 0.08, 0]}
            >
              <ringGeometry ref={timer} args={[3.03, 3.12, 128]} />
              <meshBasicMaterial color="#c49c52" />
            </mesh>
          )}
        </>
      )}
      <Ready onReady={props.onReady} />
    </>
  );
}
function Ready({ onReady }: { onReady: () => void }) {
  const fn = useRef(onReady);
  useEffect(() => {
    fn.current();
  }, []);
  return null;
}
export default function World(props: WorldProps) {
  return (
    <Canvas
      shadows={{ type: PCFShadowMap }}
      dpr={[1, 1.4]}
      frameloop={props.frozen ? "demand" : "always"}
      camera={{ position: [9, 8, 13], fov: 40, near: 0.1, far: 60 }}
      gl={{ alpha: true, antialias: true, powerPreference: "low-power" }}
      onCreated={({ gl }) => {
        gl.domElement.addEventListener(
          "webglcontextlost",
          (e) => {
            if (!gl.domElement.isConnected) return;
            e.preventDefault();
            props.onFailure();
          },
          { once: true },
        );
      }}
    >
      <hemisphereLight args={["#fff6e3", "#b7d6d1", 2]} />
      <ambientLight intensity={0.5} />
      <directionalLight
        position={[-4, 7, 5]}
        color="#fff3d6"
        intensity={2.4}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-6}
        shadow-camera-right={6}
        shadow-camera-top={6}
        shadow-camera-bottom={-6}
        shadow-camera-far={25}
        shadow-normalBias={0.035}
      />
      <directionalLight position={[5, 4, -3]} color="#ded2fa" intensity={0.8} />
      <Installation {...props} />
    </Canvas>
  );
}
