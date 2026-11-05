#!/usr/bin/env node
/**
 * Writes public/models/model.glb: a procedural placeholder.
 *
 * Generated rather than downloaded so the repo carries no third-party asset and
 * no extra licence obligation. It is deliberately a bit of everything the
 * renderer needs to exercise: two PBR materials (one metallic, one dielectric),
 * a node hierarchy, and a baked rotation animation so AnimationMixer is on a
 * real code path rather than an untested branch.
 *
 * Shape: a hovering octahedral gem spinning above a round plinth. Authored
 * roughly 1 unit wide so `scale: 'fitToMarker'` lands it sensibly, and sitting
 * on y = 0 so it rests on the marker plane.
 *
 * Replace it by dropping your own .glb in public/models/ and pointing
 * src/config.ts at it.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(root, 'public', 'models', 'model.glb');

// ---------------------------------------------------------------------------
// Geometry helpers. Flat-shaded throughout: every triangle gets its own three
// vertices, which keeps the generator simple and the facets crisp.
// ---------------------------------------------------------------------------

function makeMesh() {
  return { positions: [], normals: [], indices: [] };
}

function pushTriangle(mesh, a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  n = [n[0] / len, n[1] / len, n[2] / len];

  const base = mesh.positions.length / 3;
  for (const p of [a, b, c]) {
    mesh.positions.push(p[0], p[1], p[2]);
    mesh.normals.push(n[0], n[1], n[2]);
  }
  mesh.indices.push(base, base + 1, base + 2);
}

/** Closed cylinder with a chamfered top edge, standing on y = 0. */
function makePlinth({ radius = 0.5, height = 0.1, chamfer = 0.035, segments = 56 } = {}) {
  const mesh = makeMesh();
  const inner = radius - chamfer;
  const topY = height;
  const chamferY = height - chamfer;

  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const c0 = Math.cos(a0);
    const s0 = Math.sin(a0);
    const c1 = Math.cos(a1);
    const s1 = Math.sin(a1);

    // Outer wall, 0 -> chamferY
    pushTriangle(
      mesh,
      [radius * c0, 0, radius * s0],
      [radius * c1, 0, radius * s1],
      [radius * c1, chamferY, radius * s1],
    );
    pushTriangle(
      mesh,
      [radius * c0, 0, radius * s0],
      [radius * c1, chamferY, radius * s1],
      [radius * c0, chamferY, radius * s0],
    );

    // Chamfer ring
    pushTriangle(
      mesh,
      [radius * c0, chamferY, radius * s0],
      [radius * c1, chamferY, radius * s1],
      [inner * c1, topY, inner * s1],
    );
    pushTriangle(
      mesh,
      [radius * c0, chamferY, radius * s0],
      [inner * c1, topY, inner * s1],
      [inner * c0, topY, inner * s0],
    );

    // Top cap
    pushTriangle(mesh, [0, topY, 0], [inner * c0, topY, inner * s0], [inner * c1, topY, inner * s1]);
    // Bottom cap (reverse winding so the normal points down)
    pushTriangle(mesh, [0, 0, 0], [radius * c1, 0, radius * s1], [radius * c0, 0, radius * s0]);
  }
  return mesh;
}

/** Octahedron, elongated vertically, centred on its own origin. */
function makeGem({ rx = 0.2, ry = 0.26, rz = 0.2 } = {}) {
  const mesh = makeMesh();
  const top = [0, ry, 0];
  const bottom = [0, -ry, 0];
  const ring = [
    [rx, 0, 0],
    [0, 0, rz],
    [-rx, 0, 0],
    [0, 0, -rz],
  ];
  for (let i = 0; i < 4; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % 4];
    pushTriangle(mesh, top, a, b);
    pushTriangle(mesh, bottom, b, a);
  }
  return mesh;
}

// ---------------------------------------------------------------------------
// Buffer assembly
// ---------------------------------------------------------------------------

const chunks = [];
let offset = 0;

/** Appends a typed array to the BIN chunk, 4-byte aligned, and returns its view. */
function addView(typed) {
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  const pad = (4 - (offset % 4)) % 4;
  if (pad > 0) {
    chunks.push(new Uint8Array(pad));
    offset += pad;
  }
  const view = { byteOffset: offset, byteLength: bytes.byteLength };
  chunks.push(bytes);
  offset += bytes.byteLength;
  return view;
}

function minMax(values, components) {
  const min = new Array(components).fill(Infinity);
  const max = new Array(components).fill(-Infinity);
  for (let i = 0; i < values.length; i += components) {
    for (let c = 0; c < components; c++) {
      const v = values[i + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  return { min, max };
}

const bufferViews = [];
const accessors = [];

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;

function addAccessor(typed, type, componentType, { withBounds = false, target } = {}) {
  const view = addView(typed);
  const viewIndex = bufferViews.length;
  bufferViews.push({
    buffer: 0,
    byteOffset: view.byteOffset,
    byteLength: view.byteLength,
    ...(target !== undefined ? { target } : {}),
  });

  const components = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
  const accessor = {
    bufferView: viewIndex,
    componentType,
    count: typed.length / components,
    type,
  };
  if (withBounds) {
    const { min, max } = minMax(Array.from(typed), components);
    accessor.min = min;
    accessor.max = max;
  }
  accessors.push(accessor);
  return accessors.length - 1;
}

function addGeometry(mesh) {
  const positions = new Float32Array(mesh.positions);
  const normals = new Float32Array(mesh.normals);
  const useInt = mesh.indices.length > 0 && Math.max(...mesh.indices) > 65535;
  const indices = useInt ? new Uint32Array(mesh.indices) : new Uint16Array(mesh.indices);

  return {
    position: addAccessor(positions, 'VEC3', FLOAT, { withBounds: true, target: 34962 }),
    normal: addAccessor(normals, 'VEC3', FLOAT, { target: 34962 }),
    indices: addAccessor(indices, 'SCALAR', useInt ? UNSIGNED_INT : UNSIGNED_SHORT, {
      target: 34963,
    }),
  };
}

const plinth = addGeometry(makePlinth());
const gem = addGeometry(makeGem());

// Animation: the gem spins about Y and bobs. Rotation is stored as quaternions,
// translation as vec3; 17 keys over 4 s reads as smooth with LINEAR sampling.
const KEYS = 17;
const DURATION = 4;
const times = new Float32Array(KEYS);
const rotations = new Float32Array(KEYS * 4);
const translations = new Float32Array(KEYS * 3);
const GEM_Y = 0.42;

for (let i = 0; i < KEYS; i++) {
  const t = (i / (KEYS - 1)) * DURATION;
  times[i] = t;
  const angle = (t / DURATION) * Math.PI * 2;
  // Quaternion for a rotation of `angle` about +Y.
  rotations[i * 4 + 0] = 0;
  rotations[i * 4 + 1] = Math.sin(angle / 2);
  rotations[i * 4 + 2] = 0;
  rotations[i * 4 + 3] = Math.cos(angle / 2);

  translations[i * 3 + 0] = 0;
  translations[i * 3 + 1] = GEM_Y + 0.035 * Math.sin((t / DURATION) * Math.PI * 4);
  translations[i * 3 + 2] = 0;
}

const timeAccessor = addAccessor(times, 'SCALAR', FLOAT, { withBounds: true });
const rotAccessor = addAccessor(rotations, 'VEC4', FLOAT);
const transAccessor = addAccessor(translations, 'VEC3', FLOAT);

// ---------------------------------------------------------------------------
// glTF document
// ---------------------------------------------------------------------------

const gltf = {
  asset: {
    version: '2.0',
    generator: 'aruco-ar scripts/make-placeholder-glb.mjs',
    copyright: 'Procedurally generated placeholder. No rights reserved.',
  },
  scene: 0,
  scenes: [{ name: 'Placeholder', nodes: [0] }],
  nodes: [
    { name: 'Root', children: [1, 2] },
    { name: 'Plinth', mesh: 0 },
    { name: 'Gem', mesh: 1, translation: [0, GEM_Y, 0] },
  ],
  meshes: [
    {
      name: 'PlinthMesh',
      primitives: [
        {
          attributes: { POSITION: plinth.position, NORMAL: plinth.normal },
          indices: plinth.indices,
          material: 0,
        },
      ],
    },
    {
      name: 'GemMesh',
      primitives: [
        {
          attributes: { POSITION: gem.position, NORMAL: gem.normal },
          indices: gem.indices,
          material: 1,
        },
      ],
    },
  ],
  materials: [
    {
      name: 'PlinthMaterial',
      pbrMetallicRoughness: {
        baseColorFactor: [0.82, 0.84, 0.87, 1],
        metallicFactor: 0.05,
        roughnessFactor: 0.55,
      },
    },
    {
      name: 'GemMaterial',
      pbrMetallicRoughness: {
        baseColorFactor: [0.21, 0.76, 0.58, 1],
        metallicFactor: 0.9,
        roughnessFactor: 0.18,
      },
      emissiveFactor: [0.02, 0.09, 0.06],
    },
  ],
  animations: [
    {
      name: 'Spin',
      samplers: [
        { input: timeAccessor, interpolation: 'LINEAR', output: rotAccessor },
        { input: timeAccessor, interpolation: 'LINEAR', output: transAccessor },
      ],
      channels: [
        { sampler: 0, target: { node: 2, path: 'rotation' } },
        { sampler: 1, target: { node: 2, path: 'translation' } },
      ],
    },
  ],
  accessors,
  bufferViews,
  buffers: [{ byteLength: 0 }],
};

// Assemble BIN
const binLengthUnpadded = offset;
const binPad = (4 - (binLengthUnpadded % 4)) % 4;
const binLength = binLengthUnpadded + binPad;
gltf.buffers[0].byteLength = binLength;

const jsonText = JSON.stringify(gltf);
const jsonBytes = Buffer.from(jsonText, 'utf8');
const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
const jsonLength = jsonBytes.length + jsonPad;

const total = 12 + 8 + jsonLength + 8 + binLength;
const out = Buffer.alloc(total);
let p = 0;

out.write('glTF', p, 'ascii');
p += 4;
out.writeUInt32LE(2, p);
p += 4;
out.writeUInt32LE(total, p);
p += 4;

out.writeUInt32LE(jsonLength, p);
p += 4;
out.writeUInt32LE(0x4e4f534a, p); // 'JSON'
p += 4;
jsonBytes.copy(out, p);
p += jsonBytes.length;
out.fill(0x20, p, p + jsonPad); // JSON chunk pads with spaces
p += jsonPad;

out.writeUInt32LE(binLength, p);
p += 4;
out.writeUInt32LE(0x004e4942, p); // 'BIN\0'
p += 4;
for (const chunk of chunks) {
  out.set(chunk, p);
  p += chunk.byteLength;
}
// Remaining bytes are already zero from Buffer.alloc.

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, out);

console.log(`wrote ${outPath.replace(root, '.')}  ${out.length} bytes`);
console.log(
  `  meshes: 2, materials: 2, animations: 1 (${DURATION}s), triangles: ${
    (plinth.indices !== undefined ? accessors[plinth.indices].count : 0) / 3 +
    accessors[gem.indices].count / 3
  }`,
);
