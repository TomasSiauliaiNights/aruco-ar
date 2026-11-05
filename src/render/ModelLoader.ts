/**
 * Lazy glTF loading with the three heavy decoders wired up.
 *
 * Everything in here is dynamically imported, so GLTFLoader, Draco, meshopt and
 * KTX2 stay out of the initial bundle. Nothing is fetched until a marker is
 * actually recognised, which keeps the first paint cheap -- the whole point of
 * the 300 KB initial-JS budget.
 *
 * The decoders are themselves lazy at a second level: three only fetches the
 * Draco/KTX2 WASM when a model that needs it is loaded, so an uncompressed GLB
 * costs nothing extra.
 */

import {
  AnimationMixer,
  Box3,
  Group,
  SRGBColorSpace,
  Vector3,
  type AnimationClip,
  type Mesh,
  type Object3D,
} from 'three';
import type { WebGLRenderer } from 'three';
import type { MarkerModelConfig, MaterialOverride } from '../config';

export interface LoadedModel {
  /** Anchor to place at the marker pose. The model sits inside it. */
  group: Group;
  mixer: AnimationMixer | null;
  clips: AnimationClip[];
  /** Bounding box of the raw model before scaling, in its own units. */
  sourceSize: Vector3;
  appliedScale: number;
  dispose: () => void;
}

type GltfLoaderModule = typeof import('three/examples/jsm/loaders/GLTFLoader.js');

let loaderPromise: Promise<{
  create: (renderer: WebGLRenderer) => InstanceType<GltfLoaderModule['GLTFLoader']>;
}> | null = null;

/**
 * Builds the GLTFLoader once, with decoders attached. The decoder CDN paths use
 * three's own published versions so they match the installed three exactly.
 */
function getLoaderFactory(): NonNullable<typeof loaderPromise> {
  if (loaderPromise) return loaderPromise;
  loaderPromise = (async () => {
    const [{ GLTFLoader }, { DRACOLoader }, { KTX2Loader }, meshopt] = await Promise.all([
      import('three/examples/jsm/loaders/GLTFLoader.js'),
      import('three/examples/jsm/loaders/DRACOLoader.js'),
      import('three/examples/jsm/loaders/KTX2Loader.js'),
      import('three/examples/jsm/libs/meshopt_decoder.module.js'),
    ]);

    return {
      create(renderer: WebGLRenderer) {
        const loader = new GLTFLoader();

        // Shipped with three in node_modules, so they are served from this
        // origin and work offline once the service worker has cached them.
        const draco = new DRACOLoader();
        draco.setDecoderPath(decoderUrl('draco/'));
        loader.setDRACOLoader(draco);

        const ktx2 = new KTX2Loader();
        ktx2.setTranscoderPath(decoderUrl('basis/'));
        ktx2.detectSupport(renderer);
        loader.setKTX2Loader(ktx2);

        const decoder = (meshopt as { MeshoptDecoder: unknown }).MeshoptDecoder;
        loader.setMeshoptDecoder(decoder as Parameters<typeof loader.setMeshoptDecoder>[0]);

        return loader;
      },
    };
  })();
  return loaderPromise;
}

/** Resolves a decoder directory against the site base, so it works under /<repo>/. */
function decoderUrl(sub: string): string {
  return new URL(`decoders/${sub}`, document.baseURI).href;
}

export async function loadModel(
  renderer: WebGLRenderer,
  cfg: MarkerModelConfig,
  markerSizeMeters: number,
): Promise<LoadedModel> {
  const factory = await getLoaderFactory();
  const loader = factory.create(renderer);
  const url = new URL(cfg.url, document.baseURI).href;

  const gltf = await loader.loadAsync(url);
  const model = gltf.scene;

  await repairGeometry(model);

  // Orientation first, then scale, then seating.
  //
  // The order matters. Rotating after the model has been seated spins it about
  // its own base, which pushes half of it below the marker plane -- laying a
  // standing model flat would bury it. Rotating first means the scale is
  // computed from the footprint the model will actually present, and the
  // seating correction below sees its final shape.
  if (cfg.rotationDeg) {
    model.rotation.set(
      (cfg.rotationDeg[0] * Math.PI) / 180,
      (cfg.rotationDeg[1] * Math.PI) / 180,
      (cfg.rotationDeg[2] * Math.PI) / 180,
    );
  }

  // Scale
  const box = new Box3().setFromObject(model);
  const sourceSize = box.getSize(new Vector3());
  let appliedScale = 1;

  if (cfg.scale === 'fitToMarker' || cfg.scale === undefined) {
    const fraction = cfg.fitFraction ?? 0.8;
    const widest = Math.max(sourceSize.x, sourceSize.z, 1e-6);
    appliedScale = (markerSizeMeters * fraction) / widest;
  } else {
    appliedScale = cfg.scale;
  }
  model.scale.setScalar(appliedScale);

  // Seat the model on the marker: centred horizontally, resting on the plane
  // rather than sunk through it or floating above it.
  //
  // All three axes are corrected, not just Y. Exported models very often carry
  // a translation baked into their vertices -- a model converted out of a 3MF,
  // for instance, keeps the print bed's centring offset, which here was 125 mm
  // in two axes. Left alone that renders the model beside the marker rather
  // than on it, usually off-screen, which looks like tracking having failed.
  const scaledBox = new Box3().setFromObject(model);
  const centre = scaledBox.getCenter(new Vector3());
  model.position.x -= centre.x;
  model.position.z -= centre.z;
  model.position.y -= scaledBox.min.y;

  // Applied last, so an offset is always relative to the seated position.
  if (cfg.offset) {
    model.position.x += cfg.offset[0];
    model.position.y += cfg.offset[1];
    model.position.z += cfg.offset[2];
  }

  if (cfg.material) applyMaterialOverride(model, cfg.material);

  if (cfg.castShadow !== false) {
    model.traverse((obj: Object3D) => {
      const mesh = obj as Object3D & { isMesh?: boolean };
      if (mesh.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = false;
      }
    });
  }

  const group = new Group();
  group.add(model);

  // Animation
  let mixer: AnimationMixer | null = null;
  const clips = gltf.animations ?? [];
  if (clips.length > 0 && cfg.animation !== null) {
    mixer = new AnimationMixer(model);
    const clip =
      typeof cfg.animation === 'string'
        ? clips.find((c) => c.name === cfg.animation)
        : clips[typeof cfg.animation === 'number' ? cfg.animation : 0];
    if (clip) mixer.clipAction(clip).play();
  }

  return {
    group,
    mixer,
    clips,
    sourceSize,
    appliedScale,
    dispose() {
      mixer?.stopAllAction();
      disposeTree(model);
      group.clear();
    },
  };
}

/**
 * Applies a material override from the config.
 *
 * Exporters that carry no material information give everything a default white
 * surface at full roughness, which renders as flat chalk with no response to
 * the environment light at all. Rather than send someone back to their 3D tool
 * to re-export, the look can be set from config.ts.
 *
 * Only the named properties are touched, so a model that does ship proper
 * materials and textures keeps them unless explicitly overridden.
 */
function applyMaterialOverride(root: Object3D, override: MaterialOverride): void {
  root.traverse((obj) => {
    const mesh = obj as Mesh & { isMesh?: boolean };
    if (!mesh.isMesh || !mesh.material) return;

    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const m = material as unknown as {
        color?: { setStyle: (s: string, cs?: string) => void };
        metalness?: number;
        roughness?: number;
        emissive?: { setStyle: (s: string, cs?: string) => void };
        emissiveIntensity?: number;
        needsUpdate?: boolean;
      };
      // setStyle with SRGBColorSpace: a hex written by a human is sRGB, and
      // three.js works in linear space internally.
      if (override.color && m.color) m.color.setStyle(override.color, SRGBColorSpace);
      if (override.metalness !== undefined) m.metalness = override.metalness;
      if (override.roughness !== undefined) m.roughness = override.roughness;
      if (override.emissive && m.emissive) m.emissive.setStyle(override.emissive, SRGBColorSpace);
      if (override.emissiveIntensity !== undefined) m.emissiveIntensity = override.emissiveIntensity;
      m.needsUpdate = true;
    }
  });
}

/**
 * Fills in what an exporter left out.
 *
 * Normals are the common omission: a glTF converted from a mesh format that has
 * no concept of them (STL, 3MF, OBJ without `vn`) arrives with position data
 * only, and three.js falls back to flat shading -- so every triangle of a dense
 * mesh is visible as a facet.
 *
 * `toCreasedNormals` is used rather than `computeVertexNormals` because the
 * latter averages across every shared vertex, which rounds off the hard edges a
 * logo or a mechanical part depends on. Creased normals smooth only across
 * faces that meet gently and keep genuine edges sharp.
 *
 * Imported lazily: a model that already has normals never pays for it.
 */
async function repairGeometry(root: Object3D, creaseAngleDeg = 35): Promise<void> {
  const needsNormals: Mesh[] = [];
  root.traverse((obj) => {
    const mesh = obj as Mesh & { isMesh?: boolean };
    if (mesh.isMesh && mesh.geometry && !mesh.geometry.getAttribute('normal')) {
      needsNormals.push(mesh);
    }
  });
  if (needsNormals.length === 0) return;

  const { toCreasedNormals } = await import('three/examples/jsm/utils/BufferGeometryUtils.js');
  const angle = (creaseAngleDeg * Math.PI) / 180;

  for (const mesh of needsNormals) {
    const original = mesh.geometry;
    mesh.geometry = toCreasedNormals(original, angle);
    original.dispose();
    // The exporter set flatShading because there were no normals to shade with.
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const m = material as { flatShading?: boolean; needsUpdate?: boolean };
      if (m.flatShading) {
        m.flatShading = false;
        m.needsUpdate = true;
      }
    }
  }
}

/** Releases every GPU resource under an object. */
export function disposeTree(root: Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as Object3D & {
      geometry?: { dispose?: () => void };
      material?: unknown;
    };
    mesh.geometry?.dispose?.();
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const m of material) disposeMaterial(m);
    } else if (material) {
      disposeMaterial(material);
    }
  });
}

function disposeMaterial(material: unknown): void {
  const m = material as Record<string, unknown> & { dispose?: () => void };
  for (const key of Object.keys(m)) {
    const value = m[key] as { isTexture?: boolean; dispose?: () => void } | undefined;
    if (value && typeof value === 'object' && value.isTexture) value.dispose?.();
  }
  m.dispose?.();
}
