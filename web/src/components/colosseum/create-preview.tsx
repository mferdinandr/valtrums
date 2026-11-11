"use client";

import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Center, OrbitControls, useGLTF } from "@react-three/drei";
import { Box3, Group, Vector3 } from "three";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { CHARACTER_ASSET_VERSION, CONTENDERS } from "./choreography";

class PreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="setup-preview-fallback">Your crew is selected. The 3D preview is unavailable.</div> : this.props.children; }
}

function Mascot({ asset, animated }: { asset: string; animated: boolean }) {
  const gltf = useGLTF(`/models/colosseum/${asset}.glb?v=${CHARACTER_ASSET_VERSION}`);
  const model = useMemo(() => {
    const scene = clone(gltf.scene);
    const size = new Box3().setFromObject(scene).getSize(new Vector3());
    scene.scale.setScalar(2.5 / Math.max(size.x, size.y, size.z, 0.01));
    return scene;
  }, [gltf.scene]);
  const root = useRef<Group>(null);
  useFrame(({ clock }, delta) => {
    if (!animated || !root.current) return;
    root.current.rotation.y += Math.min(delta, 0.05) * 0.18;
    root.current.position.y = 0.05 + Math.sin(clock.elapsedTime * 1.4) * 0.03;
  });
  // Center's `top` aligns the model's bottom to y=0; `bottom` places the whole model below it.
  return <group ref={root} position={[0, 0.05, 0]}><Center top><primitive object={model} /></Center></group>;
}

export default function CreatePreview({ symbol }: { symbol?: string }) {
  const contender = CONTENDERS.find((c) => c.name === symbol || `m${c.name}` === symbol);
  const [animated, setAnimated] = useState(false);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setAnimated(!media.matches && !document.hidden);
    update(); media.addEventListener("change", update); document.addEventListener("visibilitychange", update);
    return () => { media.removeEventListener("change", update); document.removeEventListener("visibilitychange", update); };
  }, []);
  return <PreviewBoundary><div className="setup-preview-canvas" role="img" aria-label={symbol ? `${symbol} crew preview` : "Empty crew podium"}>
    <Canvas camera={{ position: [5, 3.5, 6], fov: 36 }} dpr={[1, 1.5]} frameloop={animated ? "always" : "demand"}>
      <color attach="background" args={["#cde1d6"]} />
      <ambientLight intensity={1.8} />
      <directionalLight position={[4, 8, 5]} intensity={3} />
      <directionalLight position={[-4, 3, -3]} intensity={1.2} color="#ffe8c3" />
      <group position={[0, -1, 0]}>
        <mesh position={[0, -0.2, 0]}><cylinderGeometry args={[2, 2.15, 0.4, 64]} /><meshStandardMaterial color="#faf2dc" roughness={0.8} /></mesh>
        <mesh position={[0, -0.44, 0]}><cylinderGeometry args={[2.12, 2.12, 0.1, 64]} /><meshStandardMaterial color={contender?.color ?? "#48866f"} /></mesh>
        <Suspense fallback={null}>{contender ? <Mascot key={contender.asset} asset={contender.asset} animated={animated} /> : <mesh position={[0, 0.15, 0]} rotation={[-Math.PI / 2, 0, 0]}><torusGeometry args={[0.8, 0.035, 12, 64]} /><meshStandardMaterial color="#7ca990" /></mesh>}</Suspense>
      </group>
      <OrbitControls enablePan={false} enableZoom={false} minPolarAngle={0.8} maxPolarAngle={1.5} target={[0, 0.2, 0]} />
    </Canvas>
  </div></PreviewBoundary>;
}
