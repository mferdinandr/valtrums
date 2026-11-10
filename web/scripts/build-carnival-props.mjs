/** Original site installations. Run: node web/scripts/build-carnival-props.mjs */
import * as T from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import {
  mergeGeometries,
  mergeVertices,
} from "three/addons/utils/BufferGeometryUtils.js";
import { mkdir, writeFile } from "node:fs/promises";
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((result) => {
      this.result = result;
      this.onloadend?.();
    });
  }
};
const output = new URL("../public/models/carnival/", import.meta.url);
await mkdir(output, { recursive: true });
const colors = {
  cream: "#fff2d5",
  white: "#fffdf6",
  mint: "#a0d5c0",
  coral: "#f3a18e",
  lilac: "#c4b3e4",
  blue: "#9dcfdd",
  gold: "#f4ca6d",
  ink: "#506479",
  wood: "#d1a27a",
};
const manifest = [];
for (const mode of [
  "welcome",
  "arena",
  "create",
  "terminal",
  "portfolio",
  "battle",
]) {
  const root = new T.Group();
  root.name = `carnival_${mode}`;
  root.userData = {
    author: "Valtrum",
    direction: "Token Carnival × Toybox",
    provenance: "Original procedural installation",
    generator: "web/scripts/build-carnival-props.mjs",
  };
  const materials = Object.fromEntries(
    Object.entries(colors).map(([key, color]) => [
      key,
      new T.MeshStandardMaterial({
        name: `carnival_${key}`,
        color,
        roughness: 0.65,
        metalness: 0.02,
      }),
    ]),
  );
  function group(name, at = [0, 0, 0], parent = root) {
    const g = new T.Group();
    g.name = name;
    g.position.fromArray(at);
    parent.add(g);
    return g;
  }
  function mesh(geometry, key, at = [0, 0, 0], parent = root) {
    const m = new T.Mesh(geometry, materials[key]);
    m.position.fromArray(at);
    parent.add(m);
    return m;
  }
  function box(size, at, key = "cream", parent = root, r = 0.15) {
    return mesh(
      new RoundedBoxGeometry(
        ...size,
        2,
        Math.min(r, ...size.map((s) => s * 0.4)),
      ),
      key,
      at,
      parent,
    );
  }
  function ball(radius, at, key = "white", parent = root) {
    return mesh(new T.SphereGeometry(radius, 16, 10), key, at, parent);
  }
  function cylinder(radius, height, at, key = "cream", parent = root) {
    return mesh(
      new T.CylinderGeometry(radius, radius, height, 32),
      key,
      at,
      parent,
    );
  }
  function torus(radius, width, at, key = "white", parent = root) {
    return mesh(new T.TorusGeometry(radius, width, 8, 48), key, at, parent);
  }
  function coin(at, r = 0.2, parent = root) {
    const c = cylinder(r, 0.08, at, "gold", parent);
    c.rotation.x = Math.PI / 2;
    torus(r * 0.65, 0.02, [at[0], at[1], at[2] + 0.05], "white", parent);
  }
  function balloon(at, key) {
    ball(0.35, at, key).scale.y = 1.2;
    const stem = cylinder(0.012, 1.2, [at[0], at[1] - 0.95, at[2]], "wood");
    mesh(new T.ConeGeometry(0.07, 0.1, 8), key, [
      at[0],
      at[1] - 0.43,
      at[2],
    ]).rotation.x = Math.PI;
    return stem;
  }
  const base = group("Island");
  cylinder(
    mode === "welcome" || mode === "arena" ? 4.5 : 3.5,
    0.3,
    [0, -0.2, 0],
    "mint",
    base,
  );
  cylinder(
    mode === "welcome" || mode === "arena" ? 4.4 : 3.4,
    0.12,
    [0, 0, 0],
    "cream",
    base,
  );
  torus(
    mode === "welcome" || mode === "arena" ? 4.4 : 3.4,
    0.08,
    [0, 0.04, 0],
    "white",
    base,
  ).rotation.x = Math.PI / 2;
  if (mode === "welcome" || mode === "arena") {
    const arch = group("WelcomeArch", [0, 0, -1.6]);
    for (const s of [-1, 1]) {
      box([0.42, 3, 0.5], [s * 2.45, 1.5, 0], "coral", arch);
      for (let i = 0; i < 5; i++)
        box([0.44, 0.2, 0.52], [s * 2.45, 0.35 + i * 0.55, 0], "white", arch);
      ball(0.28, [s * 2.45, 3, 0], "gold", arch);
    }
    box([4.8, 0.8, 0.45], [0, 3, 0], "lilac", arch, 0.3);
    box([3.8, 0.5, 0.06], [0, 3, 0.26], "cream", arch);
    for (let i = 0; i < 7; i++)
      ball(0.065, [(i - 3) * 0.48, 2.72, 0.3], "gold", arch);
    for (const x of [-2.1, 0, 2.1]) {
      cylinder(0.85, 0.23, [x, 0.17, 0.6], x === 0 ? "coral" : "blue");
      torus(0.72, 0.035, [x, 0.3, 0.6], "white").rotation.x = Math.PI / 2;
    }
    balloon([-3.3, 2.8, -0.5], "lilac");
    balloon([3.3, 2.5, -0.7], "coral");
    const booth = group("TicketBooth", [-3, 0, 1]);
    box([1, 1.1, 0.8], [0, 0.7, 0], "mint", booth);
    box([1.2, 0.2, 1], [0, 1.3, 0], "white", booth);
    box([0.15, 1, 0.15], [-0.45, 1.8, -0.25], "wood", booth);
    box([0.15, 1, 0.15], [0.45, 1.8, -0.25], "wood", booth);
    box([1.2, 0.22, 0.8], [0, 2.3, -0.2], "gold", booth);
    box([0.4, 0.2, 0.04], [0, 0.8, 0.43], "cream", booth);
  }
  if (mode === "create") {
    const table = group("Workshop");
    box([3.5, 0.28, 1.7], [-0.3, 1, 0], "coral", table);
    for (const x of [-1.65, 1.05])
      for (const z of [-0.6, 0.6])
        box([0.23, 0.95, 0.23], [x, 0.45, z], "wood", table);
    for (const x of [-1.2, 0.55]) {
      cylinder(0.55, 0.1, [x, 1.2, 0], "cream", table);
      torus(0.44, 0.035, [x, 1.27, 0], "mint", table).rotation.x = Math.PI / 2;
      ball(0.12, [x, 1.4, 0], "lilac", table);
    }
    const arm = group("AssemblyArm", [-1.8, 1.15, -0.7]);
    box([0.2, 1.05, 0.2], [0, 0.5, 0], "blue", arm);
    box([1.1, 0.18, 0.2], [0.45, 1, 0], "blue", arm);
    ball(0.16, [0.9, 1, 0], "gold", arm);
    box([0.14, 0.4, 0.14], [0.9, 0.75, 0], "cream", arm);
    box([1.2, 1.2, 0.3], [-0.3, 2, -0.85], "mint");
    for (let i = 0; i < 3; i++)
      ball(0.12, [-0.65 + i * 0.35, 2.1, -0.65], ["coral", "gold", "lilac"][i]);
    const tool = group("ToyWrench", [0.8, 1.25, 0.5]);
    box([0.1, 0.04, 0.5], [0, 0, 0], "lilac", tool);
    torus(0.12, 0.04, [0, 0.02, 0.3], "lilac", tool).rotation.x = Math.PI / 2;
  }
  if (mode === "arena") {
    const schedule = group("ScheduleBoard", [3, 0, 1.1]);
    box([1.15, 1.6, 0.15], [0, 1.15, 0], "lilac", schedule);
    box([0.9, 1.35, 0.04], [0, 1.15, 0.1], "cream", schedule);
    for (let i = 0; i < 3; i++) {
      box(
        [0.65, 0.17, 0.03],
        [0, 1.6 - i * 0.4, 0.14],
        ["mint", "coral", "gold"][i],
        schedule,
      );
      ball(0.045, [-0.23, 1.6 - i * 0.4, 0.18], "white", schedule);
    }
    for (const s of [-1, 1])
      box([0.12, 0.4, 0.12], [s * 0.38, 0.2, 0], "wood", schedule);
  }
  if (mode === "terminal") {
    const desk = group("CommandDesk");
    box([2.5, 0.28, 1.4], [-0.5, 0.8, 0], "lilac", desk);
    box([2, 0.8, 1], [-0.5, 0.35, 0], "blue", desk);
    box([1.8, 1.2, 0.35], [-0.5, 1.65, -0.4], "coral", desk);
    box([1.5, 0.9, 0.07], [-0.5, 1.65, -0.19], "cream", desk);
    for (const s of [-1, 1]) {
      ball(0.11, [-0.5 + s * 0.3, 1.75, -0.12], "ink", desk);
      ball(0.035, [-0.53 + s * 0.3, 1.79, -0.01], "white", desk);
    }
    box([0.38, 0.07, 0.03], [-0.5, 1.4, -0.1], "mint", desk);
    for (let i = 0; i < 6; i++)
      box(
        [0.16, 0.06, 0.14],
        [-1.05 + i * 0.22, 1, 0.35],
        i % 2 ? "gold" : "mint",
        desk,
        0.04,
      );
    cylinder(0.04, 0.35, [0.55, 1.2, 0.2], "wood", desk);
    ball(0.15, [0.55, 1.4, 0.2], "coral", desk);
    const bubble = group("SpeechBubble", [0.8, 2.65, -0.5]);
    box([1.05, 0.5, 0.22], [0, 0, 0], "white", bubble);
    for (let i = 0; i < 3; i++)
      ball(0.055, [(i - 1) * 0.2, 0, 0.15], "lilac", bubble);
    mesh(
      new T.ConeGeometry(0.12, 0.22, 3),
      "white",
      [-0.25, -0.3, 0],
      bubble,
    ).rotation.z = Math.PI;
  }
  function vault(name, x, color) {
    const v = group(name, [x, 0, 0]);
    box([1.5, 1, 0.95], [0, 0.6, 0], color, v, 0.22);
    box([1.2, 0.65, 0.06], [0, 0.63, 0.5], "cream", v);
    for (const s of [-1, 1]) ball(0.055, [s * 0.47, 0.65, 0.55], "gold", v);
    const hinge = group(`${name}Lid`, [0, 1.12, -0.5], v);
    box([1.6, 0.22, 1.05], [0, 0, 0.5], "white", hinge, 0.1);
    torus(0.18, 0.04, [0, 0.65, 0.57], "gold", v);
    box([0.04, 0.22, 0.03], [0, 0.65, 0.61], "wood", v);
    return hinge;
  }
  if (mode === "portfolio") {
    const lid = vault("PersonalVault", -0.4, "mint");
    lid.rotation.x = -0.65;
    for (let i = 0; i < 5; i++)
      coin([-0.9 + i * 0.25, 1.35 + (i % 2) * 0.15, 0.1], 0.16);
    box([0.55, 0.5, 0.15], [0.7, 0.45, 0.8], "coral");
    box([0.4, 0.07, 0.02], [0.7, 0.48, 0.89], "cream");
    for (let i = 0; i < 3; i++) {
      const s = group(`Shelf${i}`, [1.35, 0.3 + i * 0.65, -0.65]);
      box([0.8, 0.1, 0.6], [0, 0, 0], "wood", s);
      ball(0.18, [0, 0.22, 0], ["gold", "coral", "mint"][i], s);
    }
  }
  if (mode === "battle") {
    vault("VaultA", -1.55, "mint");
    vault("VaultB", 1.55, "lilac");
    for (const x of [-1.55, 1.55]) cylinder(0.95, 0.14, [x, 0.12, 0], "white");
    balloon([0, 2, -1.2], "gold");
  }
  root.updateMatrixWorld(true);
  const pivots = [];
  root.traverse((n) => {
    if (n.isGroup) pivots.push(n);
  });
  for (const pivot of pivots) {
    const buckets = new Map();
    for (const child of [...pivot.children])
      if (child.isMesh) {
        child.updateMatrix();
        const g = (
          child.geometry.index
            ? child.geometry.toNonIndexed()
            : child.geometry.clone()
        ).applyMatrix4(child.matrix);
        const list = buckets.get(child.material) ?? [];
        list.push(g);
        buckets.set(child.material, list);
        pivot.remove(child);
        child.geometry.dispose();
      }
    for (const [m, geos] of buckets) {
      const geo = mergeGeometries(geos);
      if (!geo) throw new Error("Invalid geometry");
      pivot.add(new T.Mesh(mergeVertices(geo), m));
      geos.forEach((g) => g.dispose());
    }
  }
  let triangles = 0;
  root.traverse((n) => {
    if (n.isMesh)
      triangles +=
        (n.geometry.index?.count ?? n.geometry.attributes.position.count) / 3;
  });
  const binary = await new GLTFExporter().parseAsync(root, { binary: true });
  await writeFile(new URL(`${mode}.glb`, output), Buffer.from(binary));
  manifest.push({ mode, bytes: binary.byteLength, triangles });
}
await writeFile(
  new URL("manifest.json", output),
  JSON.stringify({ originalAssets: true, models: manifest }, null, 2) + "\n",
);
console.log(JSON.stringify(manifest, null, 2));
