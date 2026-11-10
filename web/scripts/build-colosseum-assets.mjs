/** Original Token Carnival toy mascots. node web/scripts/build-colosseum-assets.mjs */
import * as T from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import {
  mergeGeometries,
  mergeVertices,
} from "three/addons/utils/BufferGeometryUtils.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((result) => {
      this.result = result;
      this.onloadend?.();
    });
  }
};
const output = new URL("../public/models/colosseum/", import.meta.url);
await mkdir(output, { recursive: true });
const registry = JSON.parse(
  await readFile(
    new URL("../src/components/colosseum/characters.json", import.meta.url),
    "utf8",
  ),
);
const report = [];
for (const [index, character] of registry.characters.entries()) {
  const root = new T.Group();
  root.name = character.asset;
  root.userData = {
    author: "Valtrum",
    tokenIdentity: character,
    provenance: "Original Token Carnival toy mascot",
    generator: "web/scripts/build-colosseum-assets.mjs",
    license: "Project-owned original geometry",
  };
  const palette = [
    ["#f6ca78", "#fff0cb"],
    ["#b8a3f1", "#e9e0ff"],
    ["#b47c58", "#f3c99b"],
    ["#ffac95", "#ffe6bf"],
    ["#d5a56f", "#fff0d9"],
  ][index];
  const material = (color, roughness = 0.6) =>
    new T.MeshStandardMaterial({ color, roughness, metalness: 0.03 });
  const mat = {
    body: material(palette[0]),
    cream: material(palette[1]),
    ink: material("#32344f"),
    white: material("#fffdf5"),
    pink: material("#f48fa2"),
    gold: material("#f8c94e"),
    mint: material("#86d4b4"),
    leaf: material("#7ab963"),
    leafLight: material("#b7df88"),
    accent: material(character.color),
    hat: material("#ee90ac"),
  };
  Object.entries(mat).forEach(
    ([name, m]) => (m.name = `${character.asset}_${name}`),
  );
  function group(parent, name, at = [0, 0, 0]) {
    const g = new T.Group();
    g.name = name;
    g.position.fromArray(at);
    parent.add(g);
    return g;
  }
  function mesh(p, geometry, m, at = [0, 0, 0], scale = [1, 1, 1]) {
    const result = new T.Mesh(geometry, mat[m]);
    result.position.fromArray(at);
    result.scale.fromArray(scale);
    p.add(result);
    return result;
  }
  function ball(p, at, size, m = "body") {
    return mesh(
      p,
      new T.SphereGeometry(1, 20, 12),
      m,
      at,
      typeof size === "number" ? [size, size, size] : size,
    );
  }
  function box(p, at, size, m = "body", radius = 0.16) {
    return mesh(
      p,
      new RoundedBoxGeometry(
        ...size,
        2,
        Math.min(radius, ...size.map((n) => n * 0.4)),
      ),
      m,
      at,
    );
  }
  function cylinder(p, at, radius, height, m = "cream") {
    return mesh(p, new T.CylinderGeometry(radius, radius, height, 24), m, at);
  }
  function tube(p, points, radius, m) {
    return mesh(
      p,
      new T.TubeGeometry(
        new T.CatmullRomCurve3(points.map((v) => new T.Vector3(...v))),
        16,
        radius,
        8,
      ),
      m,
    );
  }
  function ring(p, at, radius, width, m) {
    return mesh(p, new T.TorusGeometry(radius, width, 8, 40), m, at);
  }
  function face(parent, y, z, spread = 0.25) {
    const eyes = group(parent, "Eyes", [0, y, z]);
    for (const s of [-1, 1]) {
      ball(eyes, [s * spread, 0, 0], [0.2, 0.24, 0.09], "white");
      ball(eyes, [s * spread, 0.005, 0.09], [0.083, 0.115, 0.035], "ink");
      ball(eyes, [s * spread - 0.025, 0.045, 0.125], 0.028, "white");
      ball(
        parent,
        [s * (spread + 0.16), y - 0.18, z - 0.02],
        [0.12, 0.065, 0.035],
        "pink",
      );
    }
    tube(
      parent,
      [
        [-0.17, y - 0.24, z + 0.01],
        [0, y - 0.31, z + 0.045],
        [0.17, y - 0.24, z + 0.01],
      ],
      0.025,
      "ink",
    );
    return eyes;
  }
  const body = group(root, "Body"),
    head = group(body, "Head");
  const arms = [],
    legs = [];
  function arm(s, at = [s * 0.91, 1.38, 0]) {
    const g = group(body, s < 0 ? "ArmL" : "ArmR", at);
    ball(g, [0, -0.2, 0], [0.21, 0.43, 0.24]);
    ball(g, [0, -0.56, 0.1], [0.32, 0.27, 0.3], "cream");
    arms.push(g);
    return g;
  }
  function leg(at) {
    const g = group(body, `Leg${legs.length}`, at);
    box(g, [0, -0.18, 0.05], [0.32, 0.5, 0.38], "body");
    ball(g, [0, -0.45, 0.18], [0.38, 0.2, 0.47], "cream");
    legs.push(g);
    return g;
  }
  if (index === 0 || index === 4) {
    ball(body, [0, 1.13, 0], [0.83, 0.85, 0.64]);
    ball(body, [0, 1.14, 0.5], [0.58, 0.61, 0.23], "cream");
    head.position.set(0, 2.12, 0.04);
    ball(head, [0, 0, 0], [0.82, 0.7, 0.65]);
    for (const s of [-1, 1]) {
      const ear = mesh(head, new T.ConeGeometry(0.26, 0.52, 12), "body", [
        s * 0.52,
        0.55,
        0,
      ]);
      ear.rotation.z = -s * 0.2;
      mesh(head, new T.ConeGeometry(0.13, 0.3, 12), "pink", [
        s * 0.52,
        0.56,
        0.15,
      ]).rotation.z = -s * 0.2;
      ball(
        head,
        [s * 0.19, -0.19, 0.56],
        [index === 4 ? 0.25 : 0.2, 0.17, index === 4 ? 0.29 : 0.16],
        "cream",
      );
      if (index === 0)
        for (let k = 0; k < 3; k++)
          tube(
            head,
            [
              [s * 0.32, -0.16 + k * 0.065, 0.63],
              [s * 0.65, -0.2 + k * 0.1, 0.65],
            ],
            0.014,
            "ink",
          );
      arm(s);
      leg([s * 0.44, 0.65, 0]);
      for (let j = 0; j < 3; j++)
        ball(
          arms.at(-1),
          [(j - 1) * 0.14, -0.58, 0.36],
          [0.045, 0.055, 0.025],
          "pink",
        );
    }
    face(head, 0.08, 0.61, 0.27);
    ball(
      head,
      [0, -0.13, index === 4 ? 0.85 : 0.73],
      [0.09, 0.065, 0.055],
      "pink",
    );
    const tail = group(body, "Tail");
    tube(
      tail,
      [
        [0, 0.9, -0.5],
        [0.4, 1, -0.9],
        [0.85, 1.35, -0.8],
        [0.7, 1.7, -0.65],
      ],
      0.12,
      "body",
    );
    ball(tail, [0.7, 1.7, -0.65], 0.13, "cream");
    if (index === 4) {
      cylinder(head, [0, 0.49, -0.02], 0.76, 0.18, "hat");
      mesh(
        head,
        new T.SphereGeometry(0.65, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        "hat",
        [0, 0.55, -0.02],
        [1, 0.85, 1],
      );
      for (let k = 0; k < 20; k++) {
        const a = (k * Math.PI) / 10;
        ball(
          head,
          [Math.cos(a) * 0.73, 0.49, Math.sin(a) * 0.73 - 0.02],
          [0.025, 0.1, 0.025],
          "cream",
        );
      }
      ball(head, [0, 1.16, -0.02], 0.14, "cream");
    } else {
      const badge = cylinder(body, [0, 1.15, 0.76], 0.17, 0.06, "gold");
      badge.rotation.x = Math.PI / 2;
      box(body, [0, 1.15, 0.8], [0.035, 0.2, 0.02], "cream");
    }
  } else if (index === 1) {
    box(body, [0, 1.1, 0], [1.35, 0.9, 1.25], "body", 0.3);
    head.position.set(0, 1.7, 0.3);
    box(head, [0, 0, 0], [1.2, 0.64, 0.8], "cream", 0.25);
    face(head, 0.04, 0.42, 0.27);
    for (const s of [-1, 1])
      for (const z of [-1, 1]) leg([s * 0.67, 0.65, z * 0.43]);
    for (let k = 0; k < 3; k++) {
      const capsule = group(body, `Capsule${k}`, [(k - 1) * 0.48, 2.08, -0.28]);
      ball(
        capsule,
        [0, 0, 0],
        [0.22, 0.44, 0.24],
        ["gold", "mint", "accent"][k],
      );
      ring(capsule, [0, 0, 0.22], 0.12, 0.025, "white");
    }
    const tool = group(body, "Weapon", [0.66, 1.1, 0.5]);
    cylinder(tool, [0, 0, 0.45], 0.09, 0.8, "cream").rotation.x = Math.PI / 2;
    ball(tool, [0, 0, 0.92], [0.28, 0.28, 0.35], "accent");
    ring(tool, [0, 0, 0.92], 0.31, 0.055, "white");
    for (const s of [-1, 1]) ball(body, [s * 0.75, 1.28, -0.1], 0.17, "gold");
  } else if (index === 2) {
    box(body, [0, 1.12, 0], [1.15, 1.55, 0.9], "body", 0.3);
    head.position.set(0, 1.9, 0);
    for (const [x, y, z, s] of [
      [0, 0.6, 0, 0.7],
      [-0.55, 0.45, 0, 0.55],
      [0.55, 0.5, 0, 0.6],
      [-0.24, 0.9, -0.2, 0.5],
      [0.38, 0.9, -0.1, 0.45],
    ])
      ball(head, [x, y, z], s, x < 0 ? "leaf" : "leafLight");
    face(body, 1.5, 0.49, 0.25);
    for (const s of [-1, 1]) {
      arm(s, [s * 0.7, 1.4, 0]);
      ball(arms.at(-1), [0, -0.55, 0.14], [0.37, 0.28, 0.22], "leaf");
      leg([s * 0.4, 0.65, 0]);
    }
    for (let k = 0; k < 3; k++)
      tube(
        body,
        [
          [0.1 * (k - 1), 0.6, 0.48],
          [0.14 * (k - 1), 1.0, 0.5],
          [0.1 * (k - 1), 1.18, 0.49],
        ],
        0.018,
        "cream",
      );
    ball(body, [0.38, 0.9, 0.49], [0.12, 0.17, 0.05], "leafLight");
  } else {
    box(body, [0, 1.24, 0], [1.5, 1.2, 1.05], "body", 0.25);
    box(body, [0, 1.65, 0.56], [1.16, 0.48, 0.1], "cream");
    head.position.set(0, 1.65, 0.64);
    face(head, 0.01, 0.01, 0.27);
    box(body, [0, 0.92, 0.56], [1.05, 0.19, 0.16], "cream");
    for (let k = 0; k < 5; k++)
      ball(body, [(k - 2) * 0.17, 0.94, 0.67], 0.055, k % 2 ? "mint" : "gold");
    const scarf = group(body, "Receipt");
    box(scarf, [0.48, 0.7, 0.62], [0.36, 0.8, 0.05], "white", 0.02);
    for (let k = 0; k < 5; k++)
      box(
        scarf,
        [0.48, 0.45 + k * 0.12, 0.66],
        [0.23, 0.018, 0.02],
        "accent",
        0.003,
      );
    for (const s of [-1, 1]) {
      arm(s);
      leg([s * 0.42, 0.65, 0]);
    }
    const orbit = group(body, "Orbit", [0, 1.6, -0.6]);
    ring(orbit, [0, 0, 0], 0.78, 0.07, "gold");
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3;
      const coin = cylinder(
        orbit,
        [Math.cos(a) * 0.82, Math.sin(a) * 0.82, 0],
        0.14,
        0.08,
        "gold",
      );
      coin.rotation.x = Math.PI / 2;
    }
    box(body, [0, 1.95, -0.15], [0.8, 0.4, 0.7], "cream");
  }
  function rotation(node, frames) {
    return new T.QuaternionKeyframeTrack(
      `${node.name}.quaternion`,
      frames.map((f) => f[0]),
      frames.flatMap((f) =>
        new T.Quaternion().setFromEuler(new T.Euler(...f.slice(1))).toArray(),
      ),
    );
  }
  function position(node, frames) {
    return new T.VectorKeyframeTrack(
      `${node.name}.position`,
      frames.map((f) => f[0]),
      frames.flatMap((f) => f.slice(1)),
    );
  }
  const idle = [
    position(body, [
      [0, 0, 0, 0],
      [1, 0, 0.07, 0],
      [2, 0, 0, 0],
    ]),
    rotation(head, [
      [0, 0, -0.05, 0],
      [1, 0, 0.05, 0.04],
      [2, 0, -0.05, 0],
    ]),
  ];
  const eyes = root.getObjectByName("Eyes");
  if (eyes)
    idle.push(
      new T.VectorKeyframeTrack(
        "Eyes.scale",
        [0, 1.6, 1.67, 1.74, 2],
        [1, 1, 1, 1, 1, 1, 1, 0.12, 1, 1, 1, 1, 1, 1, 1],
      ),
    );
  const attack = [
    rotation(body, [
      [0, 0, 0, 0],
      [0.6, -0.16, 0, -0.08],
      [1.15, 0.23, 0, 0.08],
      [1.8, 0, 0, 0],
      [2.4, 0, 0, 0],
    ]),
  ];
  arms.forEach((arm, i) =>
    attack.push(
      rotation(arm, [
        [0, 0, 0, 0],
        [0.6, 0.65, 0, 0],
        [1.15, -1.6, 0, i ? -0.2 : 0.2],
        [1.8, 0, 0, 0],
        [2.4, 0, 0, 0],
      ]),
    ),
  );
  const weapon = root.getObjectByName("Weapon");
  if (weapon)
    attack.push(
      position(weapon, [
        [0, 0.66, 1.1, 0.5],
        [0.6, 0.66, 1.1, 0.3],
        [1.15, 0.66, 1.1, 1.05],
        [1.8, 0.66, 1.1, 0.5],
        [2.4, 0.66, 1.1, 0.5],
      ]),
    );
  const victory = [
    position(body, [
      [0, 0, 0, 0],
      [0.4, 0, 0.35, 0],
      [0.8, 0, 0, 0],
      [1.2, 0, 0.2, 0],
      [2, 0, 0, 0],
    ]),
  ];
  arms.forEach((arm) =>
    victory.push(
      rotation(arm, [
        [0, 0, 0, 0],
        [0.4, -2.2, 0, -0.15],
        [1, -2.5, 0, 0.15],
        [2, -2.2, 0, -0.15],
      ]),
    ),
  );
  const selected = [
    rotation(head, [
      [0, 0, 0, 0],
      [0.3, 0, 0.25, -0.12],
      [0.7, 0, -0.15, 0.1],
      [1.2, 0, 0, 0],
    ]),
  ];
  if (arms[1])
    selected.push(
      rotation(arms[1], [
        [0, 0, 0, 0],
        [0.3, -2.2, 0, 0.2],
        [0.6, -2.2, 0, -0.3],
        [0.9, -2.2, 0, 0.2],
        [1.2, 0, 0, 0],
      ]),
    );
  const clips = [
    new T.AnimationClip("Idle", 2, idle),
    new T.AnimationClip("Attack", 2.4, attack),
    new T.AnimationClip("Selected", 1.2, selected),
    new T.AnimationClip("Victory", 2, victory),
    new T.AnimationClip("Defeat", 1, [
      position(body, [
        [0, 0, 0, 0],
        [1, 0, -0.24, 0],
      ]),
      rotation(head, [
        [0, 0, 0, 0],
        [1, 0, 0, 0.14],
      ]),
    ]),
    new T.AnimationClip("Hit", 0.7, [
      rotation(body, [
        [0, 0, 0, 0],
        [0.2, -0.12, 0, 0],
        [0.7, 0, 0, 0],
      ]),
    ]),
  ];
  if (legs.length)
    clips.push(
      new T.AnimationClip(
        "Walk",
        0.6,
        legs.map((leg, i) =>
          rotation(leg, [
            [0, i % 2 ? 0.4 : -0.4, 0, 0],
            [0.3, i % 2 ? -0.4 : 0.4, 0, 0],
            [0.6, i % 2 ? 0.4 : -0.4, 0, 0],
          ]),
        ),
      ),
    );
  // Retain animated groups and merge static pieces sharing a material per pivot.
  const pivots = [];
  root.traverse((n) => {
    if (n.isGroup) pivots.push(n);
  });
  for (const pivot of pivots) {
    const buckets = new Map();
    for (const child of [...pivot.children])
      if (child.isMesh) {
        child.updateMatrix();
        const geometry = (
          child.geometry.index
            ? child.geometry.toNonIndexed()
            : child.geometry.clone()
        ).applyMatrix4(child.matrix);
        const list = buckets.get(child.material) ?? [];
        list.push(geometry);
        buckets.set(child.material, list);
        pivot.remove(child);
        child.geometry.dispose();
      }
    for (const [material, geometries] of buckets) {
      const geometry = mergeGeometries(geometries);
      if (!geometry) throw new Error("Incompatible mesh batch");
      pivot.add(new T.Mesh(mergeVertices(geometry), material));
      geometries.forEach((g) => g.dispose());
    }
  }
  root.updateMatrixWorld(true);
  let triangles = 0,
    meshes = 0;
  root.traverse((n) => {
    if (n.isMesh) {
      meshes++;
      triangles +=
        (n.geometry.index?.count ?? n.geometry.attributes.position.count) / 3;
    }
  });
  const binary = await new GLTFExporter().parseAsync(root, {
    binary: true,
    animations: clips,
  });
  await writeFile(
    new URL(`${character.asset}.glb`, output),
    Buffer.from(binary),
  );
  report.push({
    name: character.asset,
    bytes: binary.byteLength,
    triangles,
    meshes,
    animations: clips.map((c) => c.name),
  });
}
await writeFile(
  new URL("manifest.json", output),
  JSON.stringify(
    {
      generator: "Three.js GLTFExporter",
      direction: "Token Carnival × Toybox",
      originalAssets: true,
      models: report,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(report, null, 2));
