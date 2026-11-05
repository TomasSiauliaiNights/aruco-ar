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

import { AnimationMixer, Box3, Group, Vector3, type AnimationClip, type Object3D } from 'three';
import type { WebGLRenderer } from 'three';
import type { MarkerModelConfig } from '../config';

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

  // Sit the model on the marker plane rather than through it: shift so its
  // lowest point is at y = 0 in the anchor frame.
  const scaledBox = new Box3().setFromObject(model);
  model.position.y -= scaledBox.min.y;

  if (cfg.offset) {
    model.position.x += cfg.offset[0];
    model.position.y += cfg.offset[1];
    model.position.z += cfg.offset[2];
  }
  if (cfg.rotationDeg) {
    model.rotation.set(
      (cfg.rotationDeg[0] * Math.PI) / 180,
      (cfg.rotationDeg[1] * Math.PI) / 180,
      (cfg.rotationDeg[2] * Math.PI) / 180,
    );
  }

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
