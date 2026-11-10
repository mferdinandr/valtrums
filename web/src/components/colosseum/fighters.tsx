"use client";
import { useFrame } from "@react-three/fiber";
import { RoundedBox, useCursor, useGLTF } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  AnimationMixer,
  CanvasTexture,
  Group,
  MathUtils,
  Mesh,
  SRGBColorSpace,
} from "three";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import {
  CHARACTER_ASSET_VERSION,
  beatAt,
  fighterPose,
  type PreviewRuntime,
} from "./choreography";

export function Armor({
  size,
  at = [0, 0, 0],
  color = "#526071",
  radius = 0.08,
}: {
  size: [number, number, number];
  at?: [number, number, number];
  color?: string;
  radius?: number;
}) {
  return (
    <RoundedBox
      args={size}
      radius={radius}
      smoothness={2}
      position={at}
      castShadow
      receiveShadow
    >
      <meshStandardMaterial color={color} metalness={0.65} roughness={0.35} />
    </RoundedBox>
  );
}
export function LightBar({
  at,
  size,
  color,
}: {
  at: [number, number, number];
  size: [number, number, number];
  color: string;
}) {
  return (
    <mesh position={at}>
      <boxGeometry args={size} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={1.6}
      />
    </mesh>
  );
}
export function Nameplate({
  text,
  color,
  position,
  scale = 1,
}: {
  text: string;
  color: string;
  position: [number, number, number];
  scale?: number;
}) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = color;
      const padding = 48;
      const baseSize = 148;
      ctx.font = `bold ${baseSize}px monospace`;
      const measured = ctx.measureText(text);
      const inkWidth = Math.max(
        measured.width,
        measured.actualBoundingBoxLeft + measured.actualBoundingBoxRight,
      );
      const fontSize = Math.max(
        1,
        Math.floor(
          baseSize *
            Math.min(1, (canvas.width - padding * 2) / Math.max(1, inkWidth)),
        ),
      );
      ctx.font = `bold ${fontSize}px monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      const fitted = ctx.measureText(text);
      const baseline =
        (canvas.height +
          fitted.actualBoundingBoxAscent -
          fitted.actualBoundingBoxDescent) /
        2;
      ctx.fillText(text, canvas.width / 2, baseline);
    }
    const map = new CanvasTexture(canvas);
    map.colorSpace = SRGBColorSpace;
    return map;
  }, [text, color]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <mesh position={position} scale={scale}>
      <planeGeometry args={[1.5, 0.375]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} />
    </mesh>
  );
}
export function Fighter({
  index,
  runtime,
  onSelect,
}: {
  index: number;
  runtime: RefObject<PreviewRuntime>;
  onSelect: (index: number) => void;
}) {
  return runtime.current.roster[index]!.generic ? (
    <GenericFighter index={index} runtime={runtime} onSelect={onSelect} />
  ) : (
    <ModelFighter index={index} runtime={runtime} onSelect={onSelect} />
  );
}

function GenericFighter({
  index,
  runtime,
  onSelect,
}: {
  index: number;
  runtime: RefObject<PreviewRuntime>;
  onSelect: (index: number) => void;
}) {
  const root = useRef<Group>(null),
    body = useRef<Group>(null);
  const contender = runtime.current.roster[index]!;
  useFrame(() => {
    const state = runtime.current,
      p = fighterPose(index, state);
    root.current?.position.set(p.x, 0, p.z);
    if (root.current) root.current.rotation.y = p.yaw;
    if (body.current)
      body.current.position.y = state.reduced
        ? 0
        : Math.sin(state.time * 3 + index) * 0.035 + p.strike * 0.12;
  });
  return (
    <group
      ref={root}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(index);
      }}
    >
      <group ref={body}>
        <mesh position={[0, 1.4, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <cylinderGeometry args={[0.85, 0.85, 0.35, 32]} />
          <meshStandardMaterial
            color={contender.color}
            roughness={0.45}
            metalness={0.2}
          />
        </mesh>
        <mesh position={[0, 1.4, 0.2]}>
          <torusGeometry args={[0.72, 0.055, 8, 40]} />
          <meshStandardMaterial color="#fff3db" />
        </mesh>
        <Nameplate
          text={contender.name}
          color="#fffdf3"
          position={[0, 1.4, 0.24]}
          scale={0.85}
        />
        {[-1, 1].map((s) => (
          <group key={s}>
            <Armor
              at={[s * 0.4, 0.25, 0.1]}
              size={[0.4, 0.45, 0.6]}
              color={contender.color}
            />
            <Armor
              at={[s * 0.95, 1.3, 0]}
              size={[0.3, 0.6, 0.35]}
              color="#fff3db"
            />
          </group>
        ))}
      </group>
    </group>
  );
}

function ModelFighter({
  index,
  runtime,
  onSelect,
}: {
  index: number;
  runtime: RefObject<PreviewRuntime>;
  onSelect: (index: number) => void;
}) {
  const contender = runtime.current.roster[index]!;
  const gltf = useGLTF(
    `/models/colosseum/${contender.asset}.glb?v=${CHARACTER_ASSET_VERSION}`,
  );
  const scene = useMemo(() => {
    const result = clone(gltf.scene);
    result.traverse((node) => {
      if (node instanceof Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
      }
    });
    return result;
  }, [gltf.scene]);
  const mixer = useMemo(() => new AnimationMixer(scene), [scene]);
  const actions = useMemo(
    () =>
      Object.fromEntries(
        gltf.animations.map((clip) => {
          const action = mixer.clipAction(clip);
          action.play();
          action.setEffectiveWeight(0);
          return [clip.name, action];
        }),
      ),
    [gltf.animations, mixer],
  );
  useEffect(() => {
    Object.values(actions).forEach((action) => action.play());
    return () => {
      mixer.stopAllAction();
    };
  }, [mixer, actions]);
  const root = useRef<Group>(null),
    ring = useRef<Group>(null);
  const ambience = useRef(0),
    resultTime = useRef(0),
    lastPhase = useRef(runtime.current.phase);
  const selectedBefore = useRef(runtime.current.selected),
    selectionTime = useRef(2);
  const [hover, setHover] = useState(false);
  useCursor(hover);
  const color = contender.color;
  const initial = useRef(fighterPose(index, runtime.current));
  useFrame((_, delta) => {
    const state = runtime.current,
      p = fighterPose(index, state),
      dt = Math.min(delta, 0.05);
    if (!state.paused && !state.reduced) ambience.current += dt;
    if (selectedBefore.current !== state.selected) {
      selectedBefore.current = state.selected;
      selectionTime.current = 0;
    }
    if (!state.paused) selectionTime.current += dt;
    if (lastPhase.current !== state.phase) {
      resultTime.current = 0;
      lastPhase.current = state.phase;
    }
    if ((state.phase === "result" || p.eliminated) && !state.paused)
      resultTime.current += dt;
    const beat = beatAt(state);
    let clip = "Idle",
      time = state.reduced ? 0 : ambience.current % 2;
    if (beat.fighting && !state.reduced) {
      if (beat.attacker === index) {
        clip = "Attack";
        time = beat.local;
      }
    }
    if (
      state.phase === "ready" &&
      state.selected === index &&
      selectionTime.current < 1.2 &&
      !state.reduced
    ) {
      clip = "Selected";
      time = selectionTime.current;
    }
    if (state.phase === "result" || p.eliminated) {
      clip = p.victory ? "Victory" : "Defeat";
      time = state.reduced
        ? 1
        : Math.min(resultTime.current, p.victory ? 1.99 : 0.99);
    }
    for (const [name, action] of Object.entries(actions)) {
      action.setEffectiveWeight(
        state.reduced
          ? Number(name === clip)
          : MathUtils.damp(
              action.getEffectiveWeight(),
              Number(name === clip),
              14,
              dt,
            ),
      );
      action.time = name === clip ? time : 0;
    }
    mixer.update(0);
    const tail = scene.getObjectByName("Tail");
    if (tail)
      tail.rotation.y = state.reduced
        ? 0
        : Math.sin(ambience.current * 3) * 0.18;
    const arrow = scene.getObjectByName("ReturnArrow");
    if (arrow)
      arrow.rotation.z = state.reduced
        ? 0
        : Math.sin(ambience.current * 1.5) * 0.06;
    for (let i = 0; i < 2; i++) {
      const leg = scene.getObjectByName(`Leg${i}`);
      if (leg)
        leg.rotation.x = p.eliminated
          ? -1.1
          : p.travel > 0.05 && !state.reduced
            ? Math.sin(state.time * 18 + i * Math.PI) * 0.5 * p.travel
            : 0;
    }
    if (root.current) {
      if (p.eliminated && !state.reduced) {
        root.current.position.x = MathUtils.damp(
          root.current.position.x,
          p.x,
          3,
          dt,
        );
        root.current.position.z = MathUtils.damp(
          root.current.position.z,
          p.z,
          3,
          dt,
        );
      } else root.current.position.set(p.x, 0, p.z);
      root.current.position.y = p.eliminated
        ? 0.32
        : !state.reduced &&
            state.phase === "ready" &&
            state.selected === index &&
            selectionTime.current < 0.6
          ? Math.sin((selectionTime.current / 0.6) * Math.PI) * 0.22
          : 0;
      root.current.rotation.y = MathUtils.damp(
        root.current.rotation.y,
        p.yaw,
        9,
        dt,
      );
    }
    if (ring.current)
      ring.current.scale.setScalar(
        MathUtils.damp(
          ring.current.scale.x,
          state.selected === index ? 1 : hover ? 0.96 : 0.8,
          6,
          dt,
        ),
      );
  });
  return (
    <group
      ref={root}
      position={[initial.current.x, 0, initial.current.z]}
      rotation={[0, initial.current.yaw, 0]}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
      }}
      onPointerOut={() => setHover(false)}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(index);
      }}
    >
      <group ref={ring}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.025, 0]}>
          <ringGeometry args={[1.4, 1.45, 64]} />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={hover ? 0.9 : 0.5}
          />
        </mesh>
        {[0, 1, 2].map((i) => (
          <mesh
            key={i}
            rotation={[-Math.PI / 2, 0, (i * Math.PI * 2) / 3]}
            position={[0, 0.03, 0]}
          >
            <ringGeometry args={[1.55, 1.65, 24, 1, 0, 0.3]} />
            <meshBasicMaterial color={color} />
          </mesh>
        ))}
      </group>
      <primitive object={scene} dispose={null} />
    </group>
  );
}
