"use client";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, useGLTF, useCursor } from "@react-three/drei";
import {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  AnimationMixer,
  Group,
  MathUtils,
  Mesh,
  Object3D,
  PCFShadowMap,
  Vector3,
} from "three";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { Nameplate } from "@/components/colosseum/fighters";
import {
  CHARACTER_ASSET_VERSION,
  CONTENDERS,
} from "@/components/colosseum/choreography";
import {
  ease,
  hostPosition,
  journeyFrame,
  settleProgress,
} from "./journey-path";

export interface JourneyWorldProps {
  progress: number;
  reduced: boolean;
  ambientPaused: boolean;
  active: boolean;
  selected: number;
  onSelect: (index: number) => void;
  onNavigate: (path: string) => void;
  onReady: () => void;
  onFailure: () => void;
}
function prepare(source: Group) {
  const scene = clone(source);
  scene.traverse((node) => {
    if (node instanceof Mesh) {
      node.castShadow = true;
      node.receiveShadow = true;
    }
  });
  return scene;
}

function Welcomer({
  index,
  at,
  yaw = 0,
  selected,
  paused,
  moving = false,
  travel,
  onSelect,
}: {
  index: number;
  at: [number, number, number];
  yaw?: number;
  selected: boolean;
  paused: boolean;
  moving?: boolean;
  travel?: { progress: RefObject<number> };
  onSelect: () => void;
}) {
  const gltf = useGLTF(
      `/models/colosseum/${CONTENDERS[index]!.asset}.glb?v=${CHARACTER_ASSET_VERSION}`,
    ),
    scene = useMemo(() => prepare(gltf.scene), [gltf.scene]);
  const mixer = useMemo(() => new AnimationMixer(scene), [scene]);
  const actions = useMemo(
    () =>
      gltf.animations
        .filter((c) => ["Idle", "Selected", "Walk", "Attack"].includes(c.name))
        .map((clip) => ({ name: clip.name, action: mixer.clipAction(clip) })),
    [gltf.animations, mixer],
  );
  const elapsed = useRef(0),
    wave = useRef(2),
    initialized = useRef(false),
    previousTravel = useRef<[number, number] | null>(null),
    travelHeading = useRef(yaw),
    root = useRef<Group>(null),
    initialYaw = useRef(yaw);
  const [hover, setHover] = useState(false);
  useCursor(hover);
  useEffect(() => {
    actions.forEach(({ action }) => action.play());
    return () => {
      mixer.stopAllAction();
    };
  }, [mixer, actions]);
  useEffect(() => {
    if (selected) wave.current = 0;
  }, [selected]);
  useFrame((_, delta) => {
    let facing = yaw;
    let walking = moving;
    let demonstrating = false;
    if (travel && root.current) {
      const p = travel.progress.current;
      const [x, y, z] = hostPosition(index, p);
      const previous = previousTravel.current;
      walking =
        !!previous && Math.hypot(x - previous[0], z - previous[1]) > 0.0001;
      if (walking && previous)
        travelHeading.current = Math.atan2(x - previous[0], z - previous[1]);
      previousTravel.current = [x, z];
      root.current.position.set(x, y, z);
      demonstrating = (index === 0 || index === 4) && p >= 0.62 && p < 0.735;
      facing = walking
        ? travelHeading.current
        : demonstrating
          ? Math.PI
          : index === 1 && p > 0.43
            ? -2.2
            : yaw;
    }
    if (root.current)
      root.current.rotation.y = paused
        ? facing
        : MathUtils.damp(
            root.current.rotation.y,
            root.current.rotation.y +
              Math.atan2(
                Math.sin(facing - root.current.rotation.y),
                Math.cos(facing - root.current.rotation.y),
              ),
            7,
            Math.min(delta, 0.05),
          );
    if (paused && initialized.current) return;
    const dt = Math.min(delta, 0.05);
    if (!paused) {
      elapsed.current += dt;
      wave.current += dt;
    }
    const greeting = selected && !paused && wave.current < 1.2;
    actions.forEach(({ name, action }) => {
      const weight =
        name ===
        (walking
          ? "Walk"
          : demonstrating
            ? "Attack"
            : greeting
              ? "Selected"
              : "Idle")
          ? 1
          : 0;
      action.setEffectiveWeight(
        paused
          ? weight
          : MathUtils.damp(action.getEffectiveWeight(), weight, 10, dt),
      );
      action.time =
        name === "Selected"
          ? Math.min(wave.current, 1.19)
          : elapsed.current % action.getClip().duration;
    });
    mixer.update(0);
    initialized.current = true;
    const tail = scene.getObjectByName("Tail");
    if (tail) tail.rotation.y = Math.sin(elapsed.current * 2.8) * 0.13;
    if (index === 1) {
      const glasses = scene.getObjectByName("Sunglasses");
      if (glasses) glasses.rotation.z = Math.sin(elapsed.current * 1.5) * 0.025;
    }
    if (index === 3) {
      const arrow = scene.getObjectByName("ReturnArrow");
      if (arrow) arrow.rotation.z = Math.sin(elapsed.current * 1.5) * 0.06;
    }
  });
  return (
    <group
      ref={root}
      position={at}
      rotation={[0, initialYaw.current, 0]}
      scale={0.9}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
      }}
      onPointerOut={() => setHover(false)}
    >
      <primitive object={scene} dispose={null} />
    </group>
  );
}

function EventSigns({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [hover, setHover] = useState(false);
  useCursor(hover);
  return (
    <group position={[-4, 0, -13]} rotation={[0, 0.45, 0]}>
      <Nameplate
        text="WHAT'S NEXT?"
        color="#7e5d70"
        position={[0, 4, 0.36]}
        scale={1.7}
      />
      {[
        ["BATTLES", "/arena"],
        ["CREATE BATTLE", "/battles/new"],
        ["PORTFOLIO", "/portfolio"],
      ].map(([label, path], i) => (
        <group
          key={path}
          position={[0, 3.2 - i * 0.68, 0.31]}
          onClick={(e) => {
            e.stopPropagation();
            onNavigate(path!);
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            setHover(true);
          }}
          onPointerOut={() => setHover(false)}
        >
          <mesh>
            <planeGeometry args={[2.8, 0.45]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
          <Nameplate
            text={label!}
            color="#536a77"
            position={[0, 0, 0.015]}
            scale={0.95}
          />
        </group>
      ))}
    </group>
  );
}

function ZoneLoading({ vault }: { vault: boolean }) {
  return (
    <group position={vault ? [1, 0, -25] : [-12, 0, -8]}>
      <mesh position={[0, 0.1, 0]}>
        <boxGeometry args={[7, 0.2, 5]} />
        <meshStandardMaterial color="#fff3db" />
      </mesh>
      <Html
        position={[0, 2, 0]}
        center
        style={{
          pointerEvents: "none",
          whiteSpace: "nowrap",
          fontSize: 11,
          color: "#46526b",
          background: "#fffaf0",
          padding: "8px 12px",
          borderRadius: 12,
        }}
      >
        Preparing {vault ? "Vault" : "Create Battle"} details…
      </Html>
    </group>
  );
}

function DetailedZone({
  vault,
  progress,
  time,
  onNavigate,
}: {
  vault: boolean;
  progress: RefObject<number>;
  time: RefObject<number>;
  onNavigate: (path: string) => void;
}) {
  const asset = vault ? "landing-vault" : "landing-foundry";
  const gltf = useGLTF(`/models/carnival/${asset}.glb?v=town-1`);
  const scene = useMemo(() => prepare(gltf.scene), [gltf.scene]);
  const { invalidate } = useThree();
  const labels = useRef<Group>(null);
  const [hover, setHover] = useState(false);
  useCursor(hover);
  useEffect(() => {
    invalidate();
  }, [invalidate, scene]);
  useFrame(() => {
    const p = progress.current,
      t = time.current;
    if (vault) {
      const open = ease((p - 0.735) / 0.045);
      const door = scene.getObjectByName("VaultDoor");
      if (door) door.rotation.y = -open * 1.65;
      const handle = scene.getObjectByName("VaultHandle");
      if (handle) handle.rotation.z = (-open * Math.PI) / 2;
      for (const [name, start, amount] of [
        ["VaultClaimDrawer", 0.78, 0.65],
        ["VaultWithdrawDrawer", 0.815, 0.85],
      ] as const) {
        const drawer = scene.getObjectByName(name);
        if (drawer)
          drawer.position.z = 0.1 + amount * ease((p - start) / 0.025);
      }
      if (labels.current) {
        labels.current.children[0]!.position.z =
          0.65 * ease((p - 0.78) / 0.025);
        labels.current.children[1]!.position.z =
          0.85 * ease((p - 0.815) / 0.025);
      }
    } else {
      const operation = ease((p - 0.405) / 0.045);
      const wheel = scene.getObjectByName("FoundryWheel");
      if (wheel) wheel.rotation.z = -t * 0.65;
      const arm = scene.getObjectByName("FoundryArm");
      if (arm) {
        arm.rotation.y = Math.sin(t * 0.8) * 0.22;
        arm.position.y = 3.4 - Math.sin(t * 1.6) ** 2 * 0.25;
      }
      for (const [name, side] of [
        ["FoundryCapsuleA", -1],
        ["FoundryCapsuleB", 1],
      ] as const) {
        const capsule = scene.getObjectByName(name);
        if (capsule) {
          capsule.position.x = side * (1.35 - operation * 0.65);
          capsule.position.y = 1.7 + Math.sin(t * 1.3 + side) * 0.035;
        }
      }
      const ticket = scene.getObjectByName("FoundryTicket");
      if (ticket) ticket.scale.y = 0.3 + operation * 0.7;
    }
  });
  return (
    <>
      <primitive object={scene} dispose={null} />
      <group
        position={vault ? [1, 5.2, -22.38] : [-12, 4.05, -6.04]}
        onClick={(e) => {
          e.stopPropagation();
          onNavigate(vault ? "/portfolio" : "/battles/new");
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHover(true);
        }}
        onPointerOut={() => setHover(false)}
      >
        <Nameplate
          text={vault ? "YOUR PORTFOLIO" : "CREATE BATTLE"}
          color="#526b78"
          position={[0, 0, 0.02]}
          scale={2.2}
        />
        <mesh>
          <planeGeometry args={[4.4, 0.65]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </group>
      {vault && (
        <group ref={labels} position={[2.4, 0, -24.02]}>
          <group>
            <Nameplate
              text="CLAIM"
              color="#526b78"
              position={[0, 1.3, 0]}
              scale={0.8}
            />
          </group>
          <group>
            <Nameplate
              text="WITHDRAW"
              color="#526b78"
              position={[0, 2.8, 0]}
              scale={0.8}
            />
          </group>
        </group>
      )}
    </>
  );
}

function Environment(props: JourneyWorldProps) {
  const gltf = useGLTF("/models/carnival/landing-world.glb?v=town-1"),
    scene = useMemo(() => prepare(gltf.scene), [gltf.scene]);
  const { camera, size, invalidate } = useThree(),
    elapsed = useRef(0),
    progress = useRef(props.progress),
    look = useRef(new Vector3());
  const [foundrySeen, setFoundrySeen] = useState(props.progress > 0.16),
    [vaultSeen, setVaultSeen] = useState(props.progress > 0.53);
  useEffect(() => {
    if (props.progress > 0.16 || props.reduced) setFoundrySeen(true);
    if (props.progress > 0.53 || props.reduced) setVaultSeen(true);
  }, [props.progress, props.reduced]);
  useEffect(() => {
    invalidate();
  }, [props.progress, props.reduced, props.selected, invalidate]);
  useFrame((_, delta) => {
    progress.current = props.reduced
      ? 0.32
      : !props.active
        ? props.progress
        : settleProgress(progress.current, props.progress, delta);
    if (
      props.ambientPaused &&
      !props.reduced &&
      props.active &&
      progress.current !== props.progress
    )
      invalidate();
    const frame = journeyFrame(
      progress.current,
      size.width < 700,
      props.reduced,
    );
    // Native scroll sets the destination; a short bounded damping removes wheel steps.
    camera.position.fromArray(frame.camera);
    look.current.fromArray(frame.look);
    camera.lookAt(look.current);
    const left = scene.getObjectByName("GateLeft"),
      right = scene.getObjectByName("GateRight");
    if (left) left.rotation.y = frame.gateOpen * 1.5;
    if (right) right.rotation.y = -frame.gateOpen * 1.5;
    if (!props.reduced && !props.ambientPaused && props.active)
      elapsed.current += Math.min(delta, 0.05);
    const hub = scene.getObjectByName("HubTop");
    if (hub) hub.rotation.y = elapsed.current * 0.22;
    const balloons = scene.getObjectByName("FestivalBalloons");
    balloons?.children.forEach((node, i) => {
      node.position.y = Math.sin(elapsed.current * 1.2 + i) * 0.1;
    });
    for (let i = 0; i < 2; i++) {
      const head = scene.getObjectByName(`OverlookReactorHead${i}`);
      if (head) {
        const demonstration =
          progress.current >= 0.62 &&
          progress.current < 0.735 &&
          !props.reduced;
        head.rotation.x = demonstration
          ? Math.sin(elapsed.current * 4 + i) * 0.2
          : 0;
      }
    }
  });
  const paused = props.reduced || props.ambientPaused || !props.active;
  return (
    <>
      <primitive object={scene} dispose={null} />
      {foundrySeen && (
        <Suspense fallback={<ZoneLoading vault={false} />}>
          <DetailedZone
            vault={false}
            progress={progress}
            time={elapsed}
            onNavigate={props.onNavigate}
          />
        </Suspense>
      )}
      {vaultSeen && (
        <Suspense fallback={<ZoneLoading vault />}>
          <DetailedZone
            vault
            progress={progress}
            time={elapsed}
            onNavigate={props.onNavigate}
          />
        </Suspense>
      )}
      <Nameplate
        text="VALTRUM"
        color="#8e687d"
        position={[0, 5.45, 6.5]}
        scale={4}
      />
      <Welcomer
        index={0}
        travel={{ progress }}
        at={[-3.6, 0, 9.6]}
        yaw={0.35}
        selected={props.selected === 0}
        paused={paused}
        onSelect={() => props.onSelect(0)}
      />
      <Welcomer
        index={4}
        travel={{ progress }}
        at={[3.7, 0, 8.6]}
        yaw={-0.35}
        selected={props.selected === 4}
        paused={paused}
        onSelect={() => props.onSelect(4)}
      />
      <Welcomer
        index={1}
        travel={{ progress }}
        at={[-5.2, 0, -5.9]}
        yaw={0.65}
        selected={props.selected === 1}
        paused={paused}
        onSelect={() => props.onSelect(1)}
      />
      <Welcomer
        index={2}
        at={[3.1, 0, -7]}
        yaw={-0.5}
        selected={props.selected === 2}
        paused={paused}
        onSelect={() => props.onSelect(2)}
      />
      <Welcomer
        index={3}
        travel={{ progress }}
        at={[-2, 0, -10.4]}
        yaw={0.3}
        selected={props.selected === 3}
        paused={paused}
        onSelect={() => props.onSelect(3)}
      />
      {CONTENDERS.map((c, i) => {
        const at: [number, number, number][] = [
          [-7, 2.77, -8],
          [-5, 2.77, -14],
          [0, 2.77, -16],
          [5, 2.77, -14],
          [7, 2.77, -8],
        ];
        return (
          <group
            key={c.asset}
            position={at[i]}
            rotation={[0, Math.atan2(-at[i]![0], -at[i]![2] - 8), 0]}
          >
            <Nameplate
              text={c.name}
              color="#64746d"
              position={[0, 0, 0.1]}
              scale={0.8}
            />
          </group>
        );
      })}
      <EventSigns onNavigate={props.onNavigate} />
      <Ready onReady={props.onReady} />
    </>
  );
}
function Ready({ onReady }: { onReady: () => void }) {
  const ready = useRef(onReady);
  useEffect(() => {
    ready.current();
  }, []);
  return null;
}
export default function JourneyWorld(props: JourneyWorldProps) {
  const sunTarget = useMemo(() => {
    const target = new Object3D();
    target.position.set(0, 0, -10);
    return target;
  }, []);
  return (
    <Canvas
      dpr={[1, 1.3]}
      shadows={{ type: PCFShadowMap }}
      frameloop={
        props.reduced || props.ambientPaused || !props.active
          ? "demand"
          : "always"
      }
      camera={{ position: [0, 15, 38], fov: 46, near: 0.1, far: 150 }}
      gl={{ alpha: false, antialias: true, powerPreference: "low-power" }}
      onCreated={({ gl }) => {
        gl.setClearColor("#d4eae7");
        gl.domElement.addEventListener(
          "webglcontextlost",
          (event) => {
            if (!gl.domElement.isConnected) return;
            event.preventDefault();
            props.onFailure();
          },
          { once: true },
        );
      }}
    >
      <fog attach="fog" args={["#d4eae7", 50, 110]} />
      <hemisphereLight args={["#fff5df", "#b4ceb7", 1.8]} />
      <ambientLight intensity={0.55} />
      <primitive object={sunTarget} />
      <directionalLight
        position={[-12, 20, 16]}
        color="#fff0cc"
        intensity={2.2}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-32}
        shadow-camera-right={32}
        shadow-camera-top={32}
        shadow-camera-bottom={-32}
        target={sunTarget}
        shadow-camera-far={70}
        shadow-normalBias={0.04}
      />
      <directionalLight
        position={[12, 10, -15]}
        color="#e8dfff"
        intensity={0.7}
      />
      <Environment {...props} />
    </Canvas>
  );
}
