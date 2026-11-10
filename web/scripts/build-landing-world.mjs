/** Original full-bleed festival environment, authored without Blender. */
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
const palette = {
  grass: "#b9d7ad",
  hill: "#a5cba0",
  hillLight: "#c8dfb2",
  path: "#f8e6c2",
  cream: "#fff3db",
  white: "#fffdf3",
  coral: "#f4a18f",
  pink: "#edb9c5",
  mint: "#9ecfba",
  lilac: "#c5b5e2",
  blue: "#a5d6de",
  gold: "#f0c66b",
  wood: "#b99370",
  ink: "#526b78",
  leaf: "#8dbb83",
  leafLight: "#afd193",
  glass: "#b6e3e8",
};
const materials = Object.fromEntries(
  Object.entries(palette).map(([name, color]) => [
    name,
    new T.MeshStandardMaterial({
      name: `landing_${name}`,
      color,
      roughness: 0.8,
      metalness: 0.01,
    }),
  ]),
);
const root = new T.Group();
materials.glass.transparent = true;
materials.glass.opacity = 0.38;
materials.glass.depthWrite = false;
root.name = "TokenCarnivalWorld";
root.userData = {
  author: "Valtrum",
  provenance: "Original scroll-journey environment",
  generator: "web/scripts/build-landing-world.mjs",
  license: "Project-owned original geometry",
};
function group(name, at = [0, 0, 0], parent = root) {
  const g = new T.Group();
  g.name = name;
  g.position.fromArray(at);
  parent.add(g);
  return g;
}
function mesh(geometry, material, at = [0, 0, 0], parent = root) {
  const m = new T.Mesh(geometry, materials[material]);
  m.position.fromArray(at);
  parent.add(m);
  return m;
}
function box(at, size, material, parent = root, r = 0.12) {
  return mesh(
    new RoundedBoxGeometry(
      ...size,
      1,
      Math.min(r, ...size.map((s) => s * 0.35)),
    ),
    material,
    at,
    parent,
  );
}
function ball(at, size, material, parent = root) {
  return mesh(
    new T.SphereGeometry(1, 12, 8),
    material,
    at,
    parent,
  ).scale.fromArray(typeof size === "number" ? [size, size, size] : size);
}
function cylinder(at, radius, height, material, parent = root) {
  return mesh(
    new T.CylinderGeometry(radius, radius, height, 16),
    material,
    at,
    parent,
  );
}
function tube(points, radius, material, parent = root) {
  return mesh(
    new T.TubeGeometry(
      new T.CatmullRomCurve3(points.map((v) => new T.Vector3(...v))),
      16,
      radius,
      6,
    ),
    material,
    [0, 0, 0],
    parent,
  );
}
function torus(at, radius, width, material, parent = root) {
  return mesh(new T.TorusGeometry(radius, width, 6, 32), material, at, parent);
}
box([0, -0.65, -3], [70, 1, 100], "grass", root, 0.3);
const path = group("ArrivalPath");
box([0, -0.1, 14], [4.8, 0.18, 36], "path", path, 0.08);
mesh(new T.CylinderGeometry(8, 8, 0.15, 64), "path", [0, -0.08, -8], path);
box([-2, -0.08, -12], [12, 0.15, 3.8], "path", path, 0.08);
for (let i = 0; i < 18; i++)
  for (const s of [-1, 1])
    box(
      [s * 2.6, 0.02, 29 - i * 1.6],
      [0.25, 0.13, 0.5],
      i % 3 === 0 ? "cream" : "gold",
      path,
      0.04,
    );
for (const [x, z, w, h] of [
  [-16, 9, 11, 2.1],
  [16, 5, 11, 2.5],
  [-20, -17, 14, 3],
  [21, -24, 14, 4],
  [-9, -35, 20, 3],
  [10, 26, 8, 1.8],
])
  ball([x, -1, z], [w, h, w * 0.75], x < 0 ? "hill" : "hillLight");

const gate = group("FestivalGate", [0, 0, 6]);
for (const s of [-1, 1]) {
  box([s * 5.65, 2.7, 0], [0.8, 5.4, 1], "coral", gate, 0.25);
  box([s * 5.65, 0.25, 0], [1.3, 0.5, 1.5], "cream", gate, 0.18);
  for (let i = 0; i < 5; i++)
    box(
      [s * 5.65, 0.8 + i * 0.9, 0.02],
      [0.83, 0.22, 1.03],
      "white",
      gate,
      0.04,
    );
  ball([s * 5.65, 5.6, 0], 0.55, "gold", gate);
}
box([0, 5.45, 0], [11.5, 1.15, 0.85], "lilac", gate, 0.28);
box([0, 5.45, 0.46], [8.4, 0.77, 0.1], "cream", gate, 0.04);
for (let i = 0; i < 13; i++)
  ball([(i - 6) * 0.68, 4.93, 0.4], 0.085, "gold", gate);
const left = group("GateLeft", [-5.25, 0, 0], gate),
  right = group("GateRight", [5.25, 0, 0], gate);
for (const [door, s] of [
  [left, 1],
  [right, -1],
]) {
  box([s * 2.6, 1.35, 0], [5.2, 2.6, 0.22], "mint", door, 0.2);
  box([s * 2.6, 1.35, 0.14], [4.7, 2.15, 0.08], "cream", door, 0.04);
  for (let i = 0; i < 6; i++)
    box(
      [s * (0.5 + i * 0.82), 1.35, 0.21],
      [0.11, 1.7, 0.05],
      "mint",
      door,
      0.02,
    );
  box([s * 2.6, 2.75, 0], [5.2, 0.28, 0.3], "gold", door, 0.1);
  ball([s * 4.8, 1.35, 0.28], 0.12, "coral", door);
}

function tree(x, z, scale = 1) {
  const tree = group(`Tree_${x}_${z}`, [x, 0, z]);
  tree.scale.setScalar(scale);
  cylinder([0, 1.1, 0], 0.2, 2.2, "wood", tree);
  for (const [dx, dy, dz, r] of [
    [0, 3, 0, 1.2],
    [-0.65, 2.6, 0.1, 0.9],
    [0.7, 2.7, -0.1, 0.9],
    [0.1, 3.6, -0.1, 0.85],
  ])
    ball([dx, dy, dz], r, dx > 0 ? "leafLight" : "leaf", tree);
}
for (const [x, z, s] of [
  [-8, 18, 1.25],
  [8, 19, 1.15],
  [-10, 6, 1.4],
  [10, 9, 1.25],
  [-20, -5, 1.4],
  [14, -7, 1.4],
  [-12, -18, 1.2],
  [13, -20, 1.5],
  [-5, -23, 1.15],
  [8, -28, 1.3],
  [-16, 25, 1],
  [17, 24, 1.1],
])
  tree(x, z, s);
for (let i = 0; i < 36; i++) {
  const z = 27 - i * 1.1,
    x = (i % 2 ? 1 : -1) * (3.3 + (i % 3) * 0.4);
  ball([x, 0.18, z], [0.28, 0.2, 0.25], i % 3 ? "hillLight" : "leafLight");
  if (i % 2 === 0) {
    cylinder([x, 0.35, z], 0.016, 0.4, "leaf");
    ball([x, 0.57, z], 0.09, i % 3 ? "coral" : "lilac");
    ball([x, 0.57, z + 0.07], 0.04, "gold");
  }
}

const plaza = group("CommunityPlaza", [0, 0, -8]);
const booths = [
  [-7, 0, "mint"],
  [-5, -6, "coral"],
  [0, -8, "lilac"],
  [5, -6, "gold"],
  [7, 0, "blue"],
];
for (const [index, [x, z, color]] of booths.entries()) {
  const booth = group(`CommunityBooth${index}`, [x, 0, z], plaza);
  booth.rotation.y = Math.atan2(-x, -z);
  box([0, 0.7, 0], [2.5, 1.35, 1.5], color, booth, 0.22);
  box([0, 1.45, 0.1], [2.8, 0.2, 1.8], "cream", booth, 0.08);
  for (const s of [-1, 1])
    box([s * 1.15, 2.4, -0.5], [0.12, 1.8, 0.12], "wood", booth, 0.04);
  box([0, 3.3, -0.3], [3, 0.3, 1.9], color, booth, 0.12);
  for (let j = 0; j < 6; j++)
    box(
      [(j - 2.5) * 0.48, 3.32, -0.3],
      [0.21, 0.32, 1.92],
      "white",
      booth,
      0.03,
    );
  box([0, 2.77, -0.46], [1.65, 0.45, 0.15], "cream", booth, 0.07);
  for (let j = 0; j < 3; j++) {
    cylinder(
      [(j - 1) * 0.58, 1.65, 0.15],
      0.16,
      0.21,
      j % 2 ? "gold" : "pink",
      booth,
    );
  }
  const target = group(`ReactorStation${index}`, [0, 0, 1.8], booth);
  cylinder([0, 0.2, 0], 0.42, 0.35, "cream", target);
  cylinder([0, 0.6, 0], 0.09, 0.6, "wood", target);
  ball([0, 1.1, 0], 0.35, color, target);
  torus([0, 1.1, 0.3], 0.16, 0.035, "white", target);
}
const fountain = group("FestivalHub", [0, 0, -8]);
cylinder([0, 0.2, 0], 1.3, 0.4, "cream", fountain);
cylinder([0, 0.45, 0], 1.1, 0.13, "mint", fountain);
const hub = group("HubTop", [0, 1.2, 0], fountain);
ball([0, 0, 0], 0.43, "gold", hub);
torus([0, 0, 0], 0.63, 0.07, "coral", hub).rotation.x = Math.PI / 2;
for (let i = 0; i < 7; i++)
  ball(
    [
      Math.sin((i * Math.PI * 2) / 7) * 0.8,
      0.6,
      Math.cos((i * Math.PI * 2) / 7) * 0.8,
    ],
    0.09,
    "white",
    fountain,
  );

const overlook = group("ArenaOverlook", [12, 0, -15]);
cylinder([0, -0.01, 0], 4.3, 0.2, "cream", overlook);
const arenaRing = torus([0, 0.12, 0], 4, 0.12, "lilac", overlook);
arenaRing.rotation.x = Math.PI / 2;
for (const [i, [x, z]] of [
  [-1.9, -0.2],
  [1.7, -0.8],
].entries()) {
  cylinder([x, 0.12, z + 1.6], 0.85, 0.15, i ? "blue" : "mint", overlook);
  const reactor = group(`OverlookReactor${i}`, [x, 0, z], overlook);
  cylinder([0, 0.2, 0], 0.65, 0.35, "lilac", reactor);
  cylinder([0, 0.65, 0], 0.12, 0.7, "wood", reactor);
  for (let j = 0; j < 4; j++) {
    const coil = torus([0, 0.4 + j * 0.12, 0], 0.19, 0.035, "gold", reactor);
    coil.rotation.x = Math.PI / 2;
  }
  const head = group(`OverlookReactorHead${i}`, [0, 0.75, 0], reactor);
  ball([0, 0.45, 0], 0.48, i ? "blue" : "mint", head);
  torus([0, 0.45, 0.43], 0.23, 0.045, "white", head);
  ball([0, 0.45, 0.48], 0.09, "gold", head);
}
for (let i = 0; i < 9; i++) {
  const a = Math.PI + (i / 8) * Math.PI;
  const x = Math.cos(a) * 3.7,
    z = Math.sin(a) * 3.7;
  cylinder([x, 0.55, z], 0.08, 1.1, "wood", overlook);
  ball([x, 1.15, z], 0.16, i % 2 ? "coral" : "gold", overlook);
}
// Connected paths and inset floor markers make this one small place to explore.
tube(
  [
    [0, -0.03, -3],
    [-5, -0.03, -3],
    [-11, -0.03, -5],
  ],
  0.9,
  "path",
).scale.y = 0.08;
tube(
  [
    [4, -0.03, -10],
    [7, -0.03, -14],
    [6, -0.03, -21],
    [1, -0.03, -22],
  ],
  0.8,
  "path",
).scale.y = 0.08;
for (const [x, z] of [
  [-8, -4],
  [8, -11],
  [6, -21],
]) {
  cylinder([x, 0.7, z], 0.09, 1.4, "wood");
  box([x, 1.3, z], [1.5, 0.42, 0.16], "cream");
  ball([x, 1.65, z], 0.12, "gold");
}

// Separate, loadable installations. Named pivots survive batching for runtime motion.
const foundry = group("LivingFoundry", [-12, 0, -8]);
box([0, 0.03, 0], [8, 0.3, 6.5], "cream", foundry, 0.4);
box([0, 0.3, -0.2], [5.8, 0.35, 4.2], "lilac", foundry, 0.18);
box([0, 2, -1.6], [5.8, 3.4, 0.35], "blue", foundry, 0.25);
for (const s of [-1, 1]) {
  box([s * 2.7, 2, 0.1], [0.4, 3.5, 3.4], "mint", foundry, 0.14);
  box([s * 2.7, 0.55, 0.1], [0.7, 0.25, 3.8], "cream", foundry);
  for (let j = 0; j < 4; j++)
    box(
      [s * 2.93, 1.2 + j * 0.45, 0.7],
      [0.08, 0.13, 1.3],
      "cream",
      foundry,
      0.025,
    );
}
box([0, 4, -0.2], [6.5, 0.5, 4], "coral", foundry, 0.25);
box([0, 4.05, 1.86], [4.5, 0.7, 0.16], "cream", foundry);
box([0, 1.1, 0.45], [4.9, 0.6, 2.3], "ink", foundry, 0.12);
box([0, 1.44, 0.45], [4.7, 0.08, 2.1], "mint", foundry, 0.03);
for (let i = 0; i < 13; i++) {
  const roller = cylinder(
    [(i - 6) * 0.34, 1.45, 0.45],
    0.055,
    1.95,
    "cream",
    foundry,
  );
  roller.rotation.x = Math.PI / 2;
}
function capsule(name, at, color, parent, scale = 1) {
  const g = group(name, at, parent);
  g.scale.setScalar(scale);
  cylinder([0, 0, 0], 0.35, 0.28, color, g);
  ball([0, 0.42, 0], [0.35, 0.5, 0.35], "glass", g);
  cylinder([0, 0.9, 0], 0.26, 0.12, "cream", g);
  ball([0, 0.35, 0], 0.19, "gold", g);
  torus([0, 0.35, 0.2], 0.1, 0.025, "cream", g);
  return g;
}
capsule("FoundryCapsuleA", [-1.35, 1.7, 0.45], "coral", foundry);
capsule("FoundryCapsuleB", [1.35, 1.7, 0.45], "lilac", foundry);
const arm = group("FoundryArm", [0, 3.4, -0.8], foundry);
cylinder([0, 0, 0], 0.22, 0.45, "gold", arm);
box([0, -0.25, 0.55], [0.28, 0.3, 1.4], "cream", arm);
box([0, -0.6, 1.1], [0.55, 0.65, 0.4], "lilac", arm);
for (const s of [-1, 1])
  box([s * 0.31, -1, 1.1], [0.14, 0.55, 0.3], "gold", arm, 0.04);
const wheel = group("FoundryWheel", [2.75, 1.6, 1.8], foundry);
torus([0, 0, 0], 0.65, 0.15, "gold", wheel);
for (let i = 0; i < 8; i++) {
  const a = (i * Math.PI) / 4;
  const tooth = box(
    [Math.cos(a) * 0.8, Math.sin(a) * 0.8, 0],
    [0.3, 0.2, 0.23],
    "gold",
    wheel,
    0.04,
  );
  tooth.rotation.z = a;
}
for (const r of [0, Math.PI / 2])
  box([0, 0, 0], [1.1, 0.11, 0.13], "cream", wheel).rotation.z = r;
ball([0, 0, 0.1], 0.16, "coral", wheel);
box([0, 0.88, 1.7], [1.15, 0.25, 0.18], "ink", foundry, 0.04);
const ticket = group("FoundryTicket", [0, 0.86, 1.83], foundry);
box([0, -0.3, 0], [0.85, 0.75, 0.06], "white", ticket, 0.02);
for (let i = 0; i < 4; i++)
  box(
    [0, -0.08 - i * 0.14, 0.04],
    [i % 2 ? 0.4 : 0.6, 0.035, 0.02],
    "coral",
    ticket,
    0.005,
  );
for (let i = 0; i < 3; i++)
  ball([-1.5 + i * 1.5, 3.25, -1.35], 0.09, i === 0 ? "gold" : "mint", foundry);
for (const x of [-2, 2]) {
  cylinder([x, 4.6, -1.1], 0.18, 0.8, "lilac", foundry);
  torus([x, 5, -1.1], 0.22, 0.07, "cream", foundry).rotation.x = Math.PI / 2;
}

const vault = group("LivingVault", [1, 0, -25]);
box([0, 0.03, 0], [8.2, 0.3, 6], "cream", vault, 0.4);
box([0, 0.35, 0], [6.8, 0.35, 4.6], "mint", vault);
box([0, 2.8, -2], [6.6, 5, 0.35], "blue", vault, 0.25);
for (const s of [-1, 1]) {
  box([s * 3.1, 2.8, 0], [0.4, 5, 4.3], "lilac", vault, 0.15);
  box([s * 3.1, 0.65, 0], [0.7, 0.4, 4.6], "cream", vault);
}
box([0, 5.2, 0], [7.1, 0.55, 4.9], "coral", vault, 0.25);
box([0, 5.2, 2.5], [4.8, 0.75, 0.2], "cream", vault);
// Cutaway interior: positions on the left, distinct claim / withdraw drawers on the right.
box([-1.45, 2, -1.5], [2.6, 3.7, 0.2], "cream", vault);
for (let j = 0; j < 3; j++) {
  box([-1.45, 0.85 + j * 1.15, -0.8], [2.5, 0.14, 1.6], "wood", vault, 0.04);
  for (let i = 0; i < 3; i++)
    capsule(
      `PositionCapsule${j}_${i}`,
      [-2.2 + i * 0.75, 1 + j * 1.15, -0.5],
      i % 2 ? "coral" : "lilac",
      vault,
      0.5,
    );
}
for (const [name, y, color] of [
  ["VaultClaimDrawer", 1.2, "mint"],
  ["VaultWithdrawDrawer", 2.7, "lilac"],
]) {
  box([1.4, y, -0.8], [2.25, 1.2, 2], "cream", vault, 0.12);
  const drawer = group(name, [1.4, y, 0.1], vault);
  box([0, 0, 0], [2.05, 0.9, 1.5], color, drawer, 0.1);
  box([0, 0, 0.79], [1.75, 0.65, 0.08], "cream", drawer, 0.04);
  box([0, -0.12, 0.88], [0.5, 0.12, 0.15], "wood", drawer, 0.03);
  for (let i = 0; i < 3; i++)
    capsule(
      `${name}Capsule${i}`,
      [-0.6 + i * 0.6, 0.5, 0],
      color,
      drawer,
      0.35,
    );
}
const door = group("VaultDoor", [-2.9, 0, 2.05], vault);
box([2.9, 2.7, 0], [5.8, 4.9, 0.3], "mint", door, 0.3);
box([2.9, 2.7, 0.2], [5.2, 4.3, 0.1], "cream", door, 0.22);
torus([2.9, 2.8, 0.4], 0.9, 0.12, "lilac", door);
const handle = group("VaultHandle", [2.9, 2.8, 0.45], door);
for (const a of [0, Math.PI / 2])
  box([0, 0, 0], [1.3, 0.15, 0.15], "gold", handle).rotation.z = a;
ball([0, 0, 0.05], 0.2, "coral", handle);
for (const x of [0.4, 5.4])
  for (const y of [0.8, 4.6]) ball([x, y, 0.32], 0.11, "gold", door);
for (const x of [-0.7, 0, 0.7])
  box([x, 0.2, 3.1], [0.55, 0.12, 0.6], "gold", vault, 0.04);

const board = group("EventBoard", [-4, 0, -13]);
board.rotation.y = 0.45;
for (const s of [-1, 1])
  box([s * 1.45, 1.7, -0.15], [0.2, 3.4, 0.2], "wood", board, 0.06);
box([0, 2.5, 0], [3.8, 2.7, 0.3], "coral", board, 0.3);
box([0, 2.5, 0.18], [3.35, 2.25, 0.09], "cream", board, 0.08);
for (let i = 0; i < 3; i++) {
  box(
    [0, 3.2 - i * 0.68, 0.25],
    [2.8, 0.45, 0.06],
    ["mint", "lilac", "gold"][i],
    board,
    0.08,
  );
  ball([-1.1, 3.2 - i * 0.68, 0.32], 0.08, "white", board);
}
box([0, 4, 0], [4.2, 0.35, 0.65], "lilac", board, 0.14);
ball([0, 4.35, 0], 0.22, "gold", board);
for (const [x, z] of [
  [3, -10],
  [-2, -4],
]) {
  const bench = group(`Bench_${x}`, [x, 0, z]);
  box([0, 0.45, 0], [2.2, 0.2, 0.8], "cream", bench, 0.08);
  box([0, 0.95, -0.4], [2.2, 0.65, 0.15], "mint", bench, 0.07);
  for (const s of [-1, 1])
    box([s * 0.8, 0.2, 0], [0.18, 0.4, 0.6], "wood", bench, 0.04);
}

const balloons = group("FestivalBalloons");
for (const [i, [x, y, z]] of [
  [-4, 4, 11],
  [4, 3.8, 11],
  [-9, 4, -10],
  [9, 4, -12],
  [1, 4, -20],
].entries()) {
  const cluster = group(`BalloonCluster${i}`, [x, 0, z], balloons);
  for (const s of [-1, 1]) {
    ball(
      [s * 0.3, y + s * 0.2, 0],
      [0.35, 0.46, 0.35],
      s < 0 ? "pink" : "gold",
      cluster,
    );
    tube(
      [
        [s * 0.3, y - 0.35 + s * 0.2, 0],
        [s * 0.15, 1.6, 0.05],
        [0, 0.3, 0],
      ],
      0.012,
      "wood",
      cluster,
    );
  }
  cylinder([0, 0.2, 0], 0.28, 0.2, "cream", cluster);
}
const flags = group("Bunting");
for (const [z, y] of [[6, 6.9]]) {
  tube(
    [
      [-10, y, z],
      [0, y - 1.1, z],
      [10, y, z],
    ],
    0.018,
    "wood",
    flags,
  );
  for (let i = 0; i < 17; i++) {
    const x = (i - 8) * 1.1,
      drop = 1.1 * (1 - (x / 10) ** 2);
    mesh(
      new T.ConeGeometry(0.22, 0.45, 3),
      ["coral", "mint", "lilac", "gold"][i % 4],
      [x, y - drop - 0.23, z],
      flags,
    ).rotation.z = Math.PI;
  }
}
for (const [x, y, z] of [
  [-19, 10, -20],
  [18, 11, -25],
  [0, 13, -35],
]) {
  const cloud = group(`Cloud_${x}`, [x, y, z]);
  for (const s of [-1, 0, 1])
    ball([s * 1.5, 0, 0], [1.8, 1, 1.1], "white", cloud);
}
// Merge and index static pieces per pivot. Door nodes remain independently movable.
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
  for (const [material, geos] of buckets) {
    const merged = mergeGeometries(geos);
    if (!merged) throw new Error("Invalid world mesh");
    pivot.add(new T.Mesh(mergeVertices(merged), material));
    geos.forEach((g) => g.dispose());
  }
}
// Collapse all immobile scenery by material across the world. Keep only doors,
// the hub ornament and balloon groups as independent animated installations.
root.updateMatrixWorld(true);
const staticBuckets = new Map(),
  staticMeshes = [];
root.traverse((node) => {
  if (!node.isMesh) return;
  let parent = node.parent;
  while (parent && parent !== root) {
    if (
      [
        "GateLeft",
        "GateRight",
        "HubTop",
        "FestivalBalloons",
        "LivingFoundry",
        "LivingVault",
      ].includes(parent.name) ||
      parent.name.startsWith("OverlookReactorHead")
    )
      return;
    parent = parent.parent;
  }
  const g = node.geometry.clone().applyMatrix4(node.matrixWorld);
  const list = staticBuckets.get(node.material) ?? [];
  list.push(g);
  staticBuckets.set(node.material, list);
  staticMeshes.push(node);
});
staticMeshes.forEach((node) => {
  node.removeFromParent();
  node.geometry.dispose();
});
for (const [material, geos] of staticBuckets) {
  const merged = mergeGeometries(geos);
  if (!merged) throw new Error("Invalid static world batch");
  root.add(new T.Mesh(mergeVertices(merged), material));
  geos.forEach((g) => g.dispose());
}
// Export detailed zones separately, preserving world-space roots and animated pivots.
function batchZone(pivot, keep) {
  pivot.updateWorldMatrix(true, true);
  const inverse = pivot.matrixWorld.clone().invert(),
    buckets = new Map(),
    meshes = [];
  pivot.traverse((node) => {
    if (!node.isMesh) return;
    let ancestor = node.parent;
    while (ancestor && ancestor !== pivot) {
      if (keep.has(ancestor.name)) return;
      ancestor = ancestor.parent;
    }
    const geometry = node.geometry
      .clone()
      .applyMatrix4(inverse.clone().multiply(node.matrixWorld));
    const list = buckets.get(node.material) ?? [];
    list.push(geometry);
    buckets.set(node.material, list);
    meshes.push(node);
  });
  for (const node of meshes) {
    node.removeFromParent();
    node.geometry.dispose();
  }
  for (const [material, geos] of buckets) {
    const merged = mergeGeometries(geos);
    if (!merged) throw new Error("Invalid zone batch");
    pivot.add(new T.Mesh(mergeVertices(merged), material));
    geos.forEach((g) => g.dispose());
  }
}
const zones = [];
for (const [scene, asset] of [
  [foundry, "landing-foundry.glb"],
  [vault, "landing-vault.glb"],
]) {
  const pivots = new Set([
    "FoundryArm",
    "FoundryWheel",
    "FoundryCapsuleA",
    "FoundryCapsuleB",
    "FoundryTicket",
    "VaultDoor",
    "VaultHandle",
    "VaultClaimDrawer",
    "VaultWithdrawDrawer",
  ]);
  for (const name of pivots) {
    const pivot = scene.getObjectByName(name);
    if (pivot) batchZone(pivot, pivots);
  }
  batchZone(scene, pivots);
  scene.removeFromParent();
  let triangles = 0,
    meshes = 0;
  scene.traverse((n) => {
    if (n.isMesh) {
      meshes++;
      triangles +=
        (n.geometry.index?.count ?? n.geometry.attributes.position.count) / 3;
    }
  });
  const binary = await new GLTFExporter().parseAsync(scene, { binary: true });
  await writeFile(new URL(asset, output), Buffer.from(binary));
  zones.push({ asset, bytes: binary.byteLength, triangles, meshes });
}
let triangles = 0,
  meshes = 0;
root.traverse((n) => {
  if (n.isMesh) {
    meshes++;
    triangles +=
      (n.geometry.index?.count ?? n.geometry.attributes.position.count) / 3;
  }
});
const binary = await new GLTFExporter().parseAsync(root, { binary: true });
await writeFile(new URL("landing-world.glb", output), Buffer.from(binary));
const manifest = {
  asset: "landing-world.glb",
  originalAsset: true,
  bytes: binary.byteLength,
  triangles,
  meshes,
  movableNodes: [
    "GateLeft",
    "GateRight",
    "HubTop",
    "OverlookReactorHead0",
    "OverlookReactorHead1",
  ],
  zones,
};
await writeFile(
  new URL("landing-world.manifest.json", output),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(JSON.stringify(manifest, null, 2));
