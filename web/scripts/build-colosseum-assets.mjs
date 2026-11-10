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
    provenance:
      character.visualReference?.status === "listing-reviewed"
        ? "Original 3D adaptation informed by contract-matched listing artwork; not official artwork"
        : "Original unverified cosmetic interpretation",
    generator: "web/scripts/build-colosseum-assets.mjs",
    license: "Project-owned original geometry",
  };
  const palette = [
    ["#c9c9c4", "#f5f1e9"],
    ["#efb635", "#fff3cd"],
    ["#94633b", "#d8ad59"],
    ["#f0edf6", "#ffffff"],
    ["#d5a56f", "#fff0d9"],
  ][index] ?? [character.color, "#fff1d6"];
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
    leaf: material("#1b6542"),
    leafLight: material("#509947"),
    accent: material(character.color),
    hat: material("#ee90ac"),
    stripe: material("#858b88"),
    eyeBrown: material("#554742", 0.23),
    tear: material("#b5d7e0", 0.12),
    red: material("#e55242"),
    violet: material("#a829ed", 0.32),
  };
  if (index === 1) {
    mat.gold.metalness = 0.65;
    mat.gold.roughness = 0.3;
  }
  if (index === 2) {
    mat.gold.emissive.set("#a1781b");
    mat.gold.emissiveIntensity = 0.25;
  }
  if (index === 3) {
    mat.violet.emissive.set("#6912a0");
    mat.violet.emissiveIntensity = 0.35;
  }
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
    if (index !== 1) ball(g, [0, -0.45, 0.18], [0.38, 0.2, 0.47], "cream");
    legs.push(g);
    return g;
  }
  if (index >= 5) {
    // Distinct registry mascots share the existing animated pivot contract.
    const kind = character.asset;
    head.position.set(0, 2.03, 0);
    function heart(parent, at, scale = 1) {
      const g = group(parent, "HeartBadge", at);
      ball(g, [-0.09, 0.05, 0], 0.13, "pink");
      ball(g, [0.09, 0.05, 0], 0.13, "pink");
      const tip = mesh(g, new T.ConeGeometry(0.19, 0.25, 20), "pink", [0, -0.09, 0]);
      tip.rotation.z = Math.PI;
      g.scale.setScalar(scale);
    }
    for (const s of [-1, 1]) {
      arm(s, [s * 0.8, 1.4, 0]);
      const foot = leg([s * 0.38, 0.66, 0]);
      box(foot, [0, -0.45, 0.18], [0.57, 0.12, 0.75], "accent", 0.04);
      for (let j = 0; j < 3; j++)
        box(foot, [0, -0.28 + j * 0.05, 0.49], [0.24, 0.025, 0.025], "white", 0.008);
    }
    if (kind === "wallet") {
      const pocket = group(head, "StitchedWallet", [0, -0.35, 0]);
      box(pocket, [0, 0, 0], [1.65, 1.55, 0.68], "body", 0.22);
      box(pocket, [0, -0.1, 0.36], [1.48, 1.12, 0.12], "accent", 0.16);
      for (const s of [-1, 1])
        for (let j = 0; j < 9; j++)
          box(pocket, [s * 0.67, -0.53 + j * 0.12, 0.44], [0.055, 0.04, 0.025], "cream", 0.006);
      for (let j = 0; j < 3; j++) {
        box(pocket, [-0.4 + j * 0.39, 0.83 + j * 0.06, -0.08], [0.35, 0.4, 0.1], j === 1 ? "gold" : "mint", 0.05);
        box(pocket, [-0.4 + j * 0.39, 0.92 + j * 0.06, -0.015], [0.2, 0.035, 0.02], "white", 0.005);
      }
      const clasp = group(pocket, "BrassClasp", [0.7, -0.2, 0.49]);
      box(clasp, [0, 0, 0], [0.45, 0.35, 0.17], "cream", 0.08);
      ball(clasp, [0, 0, 0.11], [0.085, 0.085, 0.035], "gold");
      face(pocket, 0.13, 0.46, 0.27);
    } else if (kind === "good") {
      const sun = group(head, "SunshineRays");
      ball(sun, [0, 0, 0], [0.72, 0.72, 0.38], "gold");
      for (let j = 0; j < 12; j++) {
        const a = j * Math.PI / 6;
        const ray = box(sun, [Math.sin(a) * 0.9, Math.cos(a) * 0.9, -0.05], [0.22, 0.4, 0.2], "accent", 0.1);
        ray.rotation.z = -a;
      }
      face(sun, 0.09, 0.37, 0.25);
      ball(body, [0, 1.05, 0], [0.58, 0.55, 0.4], "cream");
      heart(body, [0, 1.12, 0.4], 0.8);
      const thumb = group(arms[1], "ThumbsUp", [0.1, -0.35, 0.15]);
      box(thumb, [0, 0.1, 0], [0.24, 0.54, 0.25], "cream", 0.1);
    } else if (kind === "ai") {
      ball(body, [0, 1.05, 0], [0.65, 0.67, 0.5], "cream");
      ball(head, [0, 0, 0], [0.78, 0.65, 0.58], "cream");
      for (const s of [-1, 1]) {
        mesh(head, new T.ConeGeometry(0.29, 0.65, 4), "body", [s * 0.52, 0.55, 0]).rotation.z = -s * 0.22;
        mesh(head, new T.ConeGeometry(0.17, 0.42, 4), "pink", [s * 0.52, 0.57, 0.12]);
        ball(head, [s * 0.2, -0.2, 0.51], [0.29, 0.2, 0.18], "white");
      }
      face(head, 0.07, 0.55, 0.27);
      ball(head, [0, -0.13, 0.71], [0.11, 0.08, 0.07], "ink");
      ring(body, [0, 1.61, 0], 0.45, 0.13, "accent").rotation.x = Math.PI / 2;
      box(body, [0.4, 1.32, 0.43], [0.3, 0.64, 0.12], "accent");
      heart(body, [0, 1.45, 0.55]);
      const tail = group(body, "CurledTail");
      tube(tail, [[0, 0.9, -0.4], [0.55, 1, -0.8], [0.8, 1.5, -0.65], [0.45, 1.65, -0.5], [0.33, 1.4, -0.5]], 0.14, "cream");
    } else {
      ball(body, [0, 1.12, 0], [0.63, 0.67, 0.47]);
      box(body, [0, 0.88, 0], [1.15, 0.18, 0.9], "ink", 0.07);
      box(body, [0, 0.89, 0.49], [0.25, 0.23, 0.1], "gold", 0.04);
      ball(head, [0, 0, -0.06], [0.8, 0.77, 0.61]);
      ball(head, [0, -0.05, 0.32], [0.59, 0.56, 0.32], "cream");
      face(head, 0.03, 0.63, 0.23);
      if (kind === "vlad") {
        const hood = group(head, "ArcherHood");
        ring(hood, [0, 0, 0.35], 0.66, 0.13, "accent").scale.set(1, 1.12, 1);
        const cap = mesh(hood, new T.ConeGeometry(0.72, 0.6, 3), "leaf", [0, 0.69, -0.05]);
        cap.rotation.z = -0.2;
        const feather = ball(hood, [0.48, 0.98, 0], [0.1, 0.42, 0.04], "gold");
        feather.rotation.z = -0.55;
        cylinder(body, [0.45, 1.45, -0.48], 0.19, 0.95, "eyeBrown").rotation.z = -0.25;
        for (let j = 0; j < 3; j++) {
          cylinder(body, [0.35 + j * 0.09, 2, -0.48], 0.02, 0.6, "gold");
          ball(body, [0.35 + j * 0.09, 2.25, -0.48], [0.06, 0.13, 0.03], "cream");
        }
        const bow = group(arms[0], "ArcherBow");
        tube(bow, [[-0.2, 0.4, 0.2], [-0.5, -0.15, 0.25], [-0.2, -0.9, 0.2]], 0.055, "eyeBrown");
        tube(bow, [[-0.2, 0.4, 0.2], [-0.12, -0.25, 0.2], [-0.2, -0.9, 0.2]], 0.012, "cream");
      } else {
        const hat = group(head, "ShowmanHat");
        cylinder(hat, [0, 0.58, 0], 0.89, 0.13, "accent");
        cylinder(hat, [0, 1.03, 0], 0.58, 0.9, "body");
        cylinder(hat, [0, 0.74, 0], 0.59, 0.2, "gold");
        cylinder(hat, [0, 1.49, 0], 0.6, 0.08, "accent");
        for (const s of [-1, 1]) {
          mesh(body, new T.ConeGeometry(0.21, 0.72, 3), "accent", [s * 0.35, 0.73, -0.4]);
          ball(body, [s * 0.17, 1.58, 0.48], [0.19, 0.12, 0.07], "gold");
        }
        ball(body, [0, 1.58, 0.55], 0.08, "pink");
        const wand = group(arms[1], "StarWand");
        cylinder(wand, [0, -0.2, 0.33], 0.045, 1.15, "ink");
        const star = new T.Shape();
        for (let j = 0; j < 10; j++) {
          const a = j * Math.PI / 5, r = j % 2 ? 0.14 : 0.3;
          const x = Math.sin(a) * r, y = Math.cos(a) * r;
          if (j === 0) star.moveTo(x, y); else star.lineTo(x, y);
        }
        star.closePath();
        mesh(wand, new T.ExtrudeGeometry(star, { depth: 0.08, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2 }), "gold", [0, 0.48, 0.3]);
      }
    }
  } else if (index === 0 || index === 4) {
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
    if (index === 0) {
      const eyes = group(head, "Eyes", [0, 0.08, 0.61]);
      for (const s of [-1, 1]) {
        ball(eyes, [s * 0.27, 0, 0], [0.23, 0.25, 0.07], "cream");
        ball(eyes, [s * 0.27, 0, 0.055], [0.19, 0.215, 0.065], "eyeBrown");
        ball(eyes, [s * 0.27, -0.01, 0.105], [0.14, 0.17, 0.025], "ink");
        ball(
          eyes,
          [s * 0.27 - 0.055, 0.085, 0.13],
          [0.055, 0.065, 0.02],
          "white",
        );
        ball(eyes, [s * 0.27 + 0.06, -0.06, 0.13], 0.025, "white");
        ball(eyes, [s * 0.4, -0.17, 0.09], [0.045, 0.065, 0.025], "tear");
        tube(
          head,
          [
            [s * 0.12, 0.31, 0.57],
            [s * 0.27, 0.36, 0.56],
            [s * 0.44, 0.29, 0.53],
          ],
          0.025,
          "stripe",
        );
      }
      tube(
        head,
        [
          [-0.12, -0.3, 0.68],
          [0, -0.27, 0.71],
          [0.12, -0.3, 0.68],
        ],
        0.018,
        "eyeBrown",
      );
    } else face(head, 0.08, 0.61, 0.27);
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
      ball(head, [-0.42, 0.34, -0.03], [0.37, 0.2, 0.58], "stripe");
      for (const s of [-1, 1])
        ball(body, [s * 0.5, 0.62, -0.08], [0.36, 0.48, 0.4], "body");
    }
  } else if (index === 1) {
    head.position.set(0, 1.7, 0);
    const coin = group(head, "GoldenCoin");
    cylinder(coin, [0, 0, 0], 1.02, 0.38, "gold").rotation.x = Math.PI / 2;
    cylinder(coin, [0, 0, 0.21], 0.91, 0.045, "body").rotation.x = Math.PI / 2;
    ring(coin, [0, 0, 0.25], 0.97, 0.055, "cream");
    ring(coin, [0, 0, -0.22], 0.97, 0.055, "gold");
    for (let i = 0; i < 32; i++) {
      const a = (i * Math.PI) / 16;
      const ridge = box(
        coin,
        [Math.cos(a) * 1.02, Math.sin(a) * 1.02, 0],
        [0.055, 0.055, 0.34],
        "cream",
        0.012,
      );
      ridge.rotation.z = a;
    }
    const glasses = group(head, "Sunglasses", [0, 0.34, 0.31]);
    for (const s of [-1, 1]) {
      box(glasses, [s * 0.4, 0, 0], [0.7, 0.39, 0.16], "ink", 0.11);
      const shine = box(
        glasses,
        [s * 0.4 - 0.12, 0.075, 0.09],
        [0.23, 0.035, 0.02],
        "white",
        0.01,
      );
      shine.rotation.z = 0.7;
      box(glasses, [s * 0.75, 0, -0.17], [0.1, 0.12, 0.38], "ink", 0.03);
    }
    box(glasses, [0, 0.04, 0], [0.19, 0.09, 0.12], "ink", 0.03);
    for (const s of [-1, 1])
      ball(head, [s * 0.46, 0.91, -0.03], [0.28, 0.12, 0.14], "ink");
    const mouthShape = new T.Shape();
    mouthShape.moveTo(-0.59, -0.16);
    mouthShape.quadraticCurveTo(0, -0.89, 0.59, -0.16);
    mouthShape.quadraticCurveTo(0, -0.24, -0.59, -0.16);
    mesh(
      head,
      new T.ExtrudeGeometry(mouthShape, {
        depth: 0.035,
        bevelEnabled: true,
        bevelSize: 0.025,
        bevelThickness: 0.015,
        bevelSegments: 2,
        steps: 1,
      }),
      "ink",
      [0, 0, 0.29],
    );
    for (let i = 0; i < 7; i++)
      box(
        head,
        [(i - 3) * 0.139, -0.27, 0.36],
        [0.124, 0.15, 0.045],
        "white",
        0.035,
      );
    ball(head, [0, -0.56, 0.35], [0.27, 0.09, 0.035], "red");
    for (const s of [-1, 1]) {
      const bicep = arm(s, [s * 1.08, 1.82, 0]);
      ball(bicep, [s * 0.1, -0.16, 0], [0.29, 0.35, 0.28], "gold");
      box(bicep, [0, -0.49, 0.14], [0.42, 0.12, 0.4], "white", 0.05);
      for (let j = 0; j < 3; j++)
        box(
          bicep,
          [(j - 1) * 0.1, -0.56, 0.39],
          [0.035, 0.13, 0.015],
          "gold",
          0.008,
        );
      const foot = leg([s * 0.44, 0.66, 0]);
      box(foot, [0, -0.58, 0.18], [0.76, 0.13, 0.96], "red", 0.06);
      box(foot, [0, -0.4, 0.04], [0.6, 0.35, 0.55], "red", 0.09);
      box(foot, [0, -0.45, 0.39], [0.58, 0.19, 0.43], "white", 0.08);
      for (let j = 0; j < 3; j++)
        box(
          foot,
          [0, -0.25 - j * 0.055, 0.3 + j * 0.06],
          [0.33, 0.035, 0.035],
          "ink",
          0.009,
        );
    }
  } else if (index === 2) {
    cylinder(body, [0, 1.15, 0], 0.46, 1.55, "body");
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
      tube(
        body,
        [
          [s * 0.1, 0.55, 0.05],
          [s * 0.18, 1.3, 0],
          [s * 0.65, 1.85, 0],
          [s * 0.88, 2.3, 0],
        ],
        0.12,
        "body",
      );
      tube(
        body,
        [
          [s * 0.05, 0.45, 0.43],
          [s * 0.16, 1.1, 0.45],
          [s * 0.42, 1.65, 0.3],
          [s * 0.75, 2, 0.23],
        ],
        0.038,
        "gold",
      );
      tube(
        body,
        [
          [s * 0.1, 0.75, 0.1],
          [s * 0.4, 0.26, 0.4],
          [s * 0.75, 0.15, 0.55],
        ],
        0.14,
        "body",
      );
      tube(
        body,
        [
          [s * 0.1, 0.75, 0.25],
          [s * 0.4, 0.35, 0.5],
          [s * 0.75, 0.23, 0.58],
        ],
        0.03,
        "gold",
      );
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
        "gold",
      );
    ball(body, [0.38, 0.9, 0.49], [0.12, 0.17, 0.05], "leafLight");
  } else {
    head.position.set(0, 1.75, 0);
    const shape = new T.Shape();
    shape.moveTo(-0.75, -0.8);
    shape.lineTo(-0.75, 0.95);
    shape.lineTo(0.12, 0.95);
    shape.quadraticCurveTo(0.9, 0.95, 0.9, 0.35);
    shape.quadraticCurveTo(0.9, -0.1, 0.4, -0.22);
    shape.lineTo(0.95, -0.9);
    shape.lineTo(0.32, -0.9);
    shape.lineTo(-0.15, -0.25);
    shape.lineTo(-0.25, -0.25);
    shape.lineTo(-0.25, -0.8);
    shape.closePath();
    const hole = new T.Path();
    hole.moveTo(-0.25, 0.3);
    hole.lineTo(0.1, 0.3);
    hole.quadraticCurveTo(0.4, 0.3, 0.4, 0.5);
    hole.quadraticCurveTo(0.4, 0.7, 0.1, 0.7);
    hole.lineTo(-0.25, 0.7);
    hole.closePath();
    shape.holes.push(hole);
    const glyph = group(head, "RebateGlyph");
    const glyphGeometry = new T.ExtrudeGeometry(shape, {
      depth: 0.38,
      bevelEnabled: true,
      bevelSize: 0.055,
      bevelThickness: 0.055,
      bevelSegments: 3,
      steps: 1,
      curveSegments: 16,
    });
    mesh(glyph, glyphGeometry, "white");
    mesh(
      glyph,
      glyphGeometry.clone(),
      "accent",
      [0, 0, -0.1],
      [1.035, 1.035, 1],
    );
    const arrow = group(head, "ReturnArrow");
    tube(
      arrow,
      [
        [0.38, -0.02, 0.28],
        [0.89, 0.25, 0.3],
        [0.79, 0.87, 0.38],
        [0.27, 1.1, 0.45],
        [-0.5, 1.1, 0.45],
      ],
      0.13,
      "violet",
    );
    const arrowhead = new T.Shape();
    arrowhead.moveTo(-0.43, 1.43);
    arrowhead.lineTo(-0.98, 1.1);
    arrowhead.lineTo(-0.43, 0.77);
    arrowhead.closePath();
    mesh(
      arrow,
      new T.ExtrudeGeometry(arrowhead, {
        depth: 0.24,
        bevelEnabled: true,
        bevelSize: 0.035,
        bevelThickness: 0.025,
        bevelSegments: 2,
        steps: 1,
      }),
      "violet",
      [0, 0, 0.33],
    );
    const eyes = group(head, "Eyes", [-0.49, -0.05, 0.46]);
    for (const s of [-1, 1]) {
      ball(eyes, [s * 0.095, 0, 0], [0.064, 0.085, 0.025], "ink");
      ball(eyes, [s * 0.095 - 0.014, 0.025, 0.023], 0.018, "white");
    }
    tube(
      head,
      [
        [-0.58, -0.2, 0.47],
        [-0.49, -0.25, 0.48],
        [-0.4, -0.2, 0.47],
      ],
      0.014,
      "accent",
    );
    for (const s of [-1, 1]) {
      const hand = arm(s, [s * 0.96, 1.6, 0.08]);
      box(hand, [0, -0.54, 0.13], [0.4, 0.14, 0.4], "violet", 0.04);
      const foot = leg([s * 0.43, 0.65, 0]);
      box(foot, [0, -0.48, 0.18], [0.7, 0.11, 0.85], "accent", 0.04);
    }
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
  const assetPath = new URL(`${character.asset}.glb`, output);
  // Archived binaries remain byte-for-byte intact; only active assets regenerate.
  if (!character.hidden) await writeFile(assetPath, Buffer.from(binary));
  const bytes = character.hidden ? (await readFile(assetPath)).byteLength : binary.byteLength;
  report.push({
    name: character.asset,
    bytes,
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
