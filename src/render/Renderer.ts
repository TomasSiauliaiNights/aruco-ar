/**
 * three.js layer: a transparent WebGL canvas over the <video>.
 *
 * The projection matrix is built directly from the solver's intrinsics rather
 * than from a guessed FOV, and it accounts for the fact that the video is shown
 * with `object-fit: cover`, so only a centre crop of the camera frame is on
 * screen. Getting either of those wrong produces a model that tracks correctly
 * in the middle of the frame and drifts off the marker toward the edges -- the
 * most common "my AR is nearly right" bug.
 *
 * Steady state allocates nothing: vectors and quaternions are reused, and the
 * per-frame work is a transform write plus a draw.
 */

import {
  ACESFilmicToneMapping,
  AmbientLight,
  DirectionalLight,
  Group,
  Mesh,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Quaternion,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Texture,
} from 'three';

export interface CameraGeometry {
  /** Native camera frame size, in pixels. */
  sourceWidth: number;
  sourceHeight: number;
  /** Intrinsics expressed in source-frame pixels. */
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  /** CSS size of the display area. */
  cssWidth: number;
  cssHeight: number;
}

export interface RendererOptions {
  maxPixelRatio: number;
  exposure: number;
  shadowCatcher: boolean;
  shadowOpacity: number;
  /** Side length of the shadow-catching plane, in metres. */
  markerSizeMeters: number;
}

const NEAR = 0.01;
const FAR = 50;

export class Renderer {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(50, 1, NEAR, FAR);
  private readonly renderer: WebGLRenderer;
  private readonly light: DirectionalLight;
  private readonly ambient: AmbientLight;
  private shadowPlane: Mesh<PlaneGeometry, ShadowMaterial> | null = null;
  private shadowAnchor: Group | null = null;
  private environment: Texture | null = null;

  /** Reused per frame. */
  private readonly tmpPos = new Vector3();
  private readonly tmpQuat = new Quaternion();
  private readonly tmpLightDir = new Vector3();

  private geometry: CameraGeometry | null = null;
  private opts: RendererOptions;
  private baseExposure: number;
  private lumaExposure = 1;

  constructor(canvas: HTMLCanvasElement, opts: RendererOptions) {
    this.opts = opts;
    this.baseExposure = opts.exposure;

    this.renderer = new WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearAlpha(0);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = opts.exposure;
    this.renderer.shadowMap.enabled = opts.shadowCatcher;
    this.renderer.shadowMap.type = PCFSoftShadowMap;

    // The pose places objects directly in camera space, so the camera sits at
    // the origin with identity orientation and never moves.
    this.camera.position.set(0, 0, 0);
    this.camera.quaternion.identity();
    this.camera.matrixAutoUpdate = true;

    this.ambient = new AmbientLight(0xffffff, 0.35);
    this.scene.add(this.ambient);

    this.light = new DirectionalLight(0xffffff, 2.1);
    this.light.castShadow = opts.shadowCatcher;
    this.configureShadowCamera(opts.markerSizeMeters);
    this.scene.add(this.light);

    if (opts.shadowCatcher) this.addShadowPlane();
  }

  /**
   * Builds a PMREM environment probe from three's procedural room scene.
   *
   * Only RoomEnvironment is dynamically imported; PMREMGenerator comes from the
   * static `three` import, because three is in this chunk either way and
   * dynamically importing it as well just produces a bundler warning.
   */
  async initEnvironment(): Promise<void> {
    if (this.environment) return;
    const { RoomEnvironment } = await import(
      'three/examples/jsm/environments/RoomEnvironment.js'
    );
    const pmrem = new PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const room = new RoomEnvironment();
    const target = pmrem.fromScene(room, 0.04);
    this.environment = target.texture;
    this.scene.environment = this.environment;
    // The source scene is only needed to bake the probe.
    room.traverse((obj) => {
      const mesh = obj as Mesh;
      mesh.geometry?.dispose?.();
    });
    pmrem.dispose();
  }

  get domElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** The raw WebGLRenderer, needed by KTX2Loader.detectSupport(). */
  get webgl(): WebGLRenderer {
    return this.renderer;
  }

  get pixelRatio(): number {
    return this.renderer.getPixelRatio();
  }

  get drawInfo(): { calls: number; triangles: number; programs: number } {
    const info = this.renderer.info;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
    };
  }

  configure(opts: Partial<RendererOptions>): void {
    this.opts = { ...this.opts, ...opts };
    if (opts.exposure !== undefined) this.baseExposure = opts.exposure;
    if (opts.shadowOpacity !== undefined && this.shadowPlane) {
      this.shadowPlane.material.opacity = opts.shadowOpacity;
    }
    if (opts.markerSizeMeters !== undefined) {
      this.configureShadowCamera(opts.markerSizeMeters);
      this.resizeShadowPlane(opts.markerSizeMeters);
    }
    if (opts.shadowCatcher !== undefined) {
      this.renderer.shadowMap.enabled = opts.shadowCatcher;
      this.light.castShadow = opts.shadowCatcher;
      if (opts.shadowCatcher && !this.shadowPlane) this.addShadowPlane();
      if (this.shadowAnchor) this.shadowAnchor.visible = opts.shadowCatcher;
    }
    this.applyExposure();
  }

  /**
   * Rebuilds the projection matrix for the current intrinsics and display size.
   *
   * `object-fit: cover` scales the video by max(cssW/srcW, cssH/srcH) and centres
   * it, so the visible region of the camera frame is
   *   visW = cssW / scale,  visH = cssH / scale
   * which is a centred sub-rectangle of the source. The frustum is built from
   * that rectangle, off-centre if the calibrated principal point is off-centre,
   * so an explicit `makePerspective` is used instead of fov + aspect.
   */
  setCameraGeometry(geom: CameraGeometry): void {
    this.geometry = geom;
    const { sourceWidth: sw, sourceHeight: sh, cssWidth: cw, cssHeight: ch } = geom;
    if (sw <= 0 || sh <= 0 || cw <= 0 || ch <= 0) return;

    const scale = Math.max(cw / sw, ch / sh);
    const visW = Math.min(sw, cw / scale);
    const visH = Math.min(sh, ch / scale);
    const x0 = (sw - visW) / 2;
    const y0 = (sh - visH) / 2;

    // Image y grows downward; three.js y grows upward, hence the sign flip.
    const left = (-NEAR * (geom.cx - x0)) / geom.fx;
    const right = (NEAR * (x0 + visW - geom.cx)) / geom.fx;
    const top = (NEAR * (geom.cy - y0)) / geom.fy;
    const bottom = (-NEAR * (y0 + visH - geom.cy)) / geom.fy;

    this.camera.projectionMatrix.makePerspective(left, right, top, bottom, NEAR, FAR);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();

    // Kept consistent for anything that reads them, but never used to rebuild
    // the matrix: updateProjectionMatrix() would overwrite the work above.
    this.camera.aspect = cw / ch;
    this.camera.fov = (2 * Math.atan(visH / 2 / geom.fy) * 180) / Math.PI;
  }

  /** Call on resize and on orientation change. */
  setSize(cssWidth: number, cssHeight: number): void {
    const dpr = Math.min(this.opts.maxPixelRatio, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(cssWidth, cssHeight, false);
    if (this.geometry) {
      this.setCameraGeometry({ ...this.geometry, cssWidth, cssHeight });
    }
  }

  /**
   * Cheap light estimate: mean frame luminance nudges exposure and ambient fill.
   * Deliberately gentle -- a dim room should look dim, so this corrects for
   * gross mismatch rather than normalising every scene to the same brightness.
   */
  setLightEstimate(meanLuma: number): void {
    const normalised = Math.min(1, Math.max(0, meanLuma / 255));
    // 0.5 luma is treated as neutral; the exponent keeps the response soft.
    this.lumaExposure = Math.pow(Math.max(0.12, normalised) / 0.5, 0.35);
    this.ambient.intensity = 0.2 + 0.45 * normalised;
    this.light.intensity = 1.2 + 1.6 * normalised;
    this.applyExposure();
  }

  private applyExposure(): void {
    this.renderer.toneMappingExposure = this.baseExposure * this.lumaExposure;
  }

  /** Places the anchor group at a marker pose and sets the shadow plane with it. */
  applyPose(
    target: Group,
    position: readonly [number, number, number],
    quaternion: readonly [number, number, number, number],
  ): void {
    this.tmpPos.set(position[0], position[1], position[2]);
    this.tmpQuat.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
    target.position.copy(this.tmpPos);
    target.quaternion.copy(this.tmpQuat);
  }

  /** Puts the shadow catcher and the shadow-casting light on a marker. */
  alignShadowTo(
    position: readonly [number, number, number],
    quaternion: readonly [number, number, number, number],
  ): void {
    if (!this.shadowAnchor) return;
    this.tmpPos.set(position[0], position[1], position[2]);
    this.tmpQuat.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
    this.shadowAnchor.position.copy(this.tmpPos);
    this.shadowAnchor.quaternion.copy(this.tmpQuat);
    this.shadowAnchor.visible = this.opts.shadowCatcher;

    // Keep the light above the marker in its own frame, so the shadow falls on
    // the plane regardless of how the marker is tilted. Reuses a preallocated
    // vector: this runs every frame.
    this.tmpLightDir.set(0.35, 1, 0.5).applyQuaternion(this.tmpQuat).normalize();
    this.light.position.copy(this.tmpPos).addScaledVector(this.tmpLightDir, 0.6);
    this.light.target.position.copy(this.tmpPos);
    this.light.target.updateMatrixWorld();
  }

  hideShadow(): void {
    if (this.shadowAnchor) this.shadowAnchor.visible = false;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.shadowPlane) {
      this.shadowPlane.geometry.dispose();
      this.shadowPlane.material.dispose();
      this.shadowPlane = null;
    }
    if (this.shadowAnchor) {
      this.scene.remove(this.shadowAnchor);
      this.shadowAnchor = null;
    }
    this.environment?.dispose();
    this.environment = null;
    this.scene.environment = null;
    this.renderer.dispose();
  }

  /**
   * An anchor Group carries the marker transform; the mesh inside it carries the
   * fixed -90 degree correction, because PlaneGeometry faces +Z while the marker
   * frame has its surface normal along +Y. Separating the two means
   * alignShadowTo can write the pose straight onto the anchor.
   */
  private addShadowPlane(): void {
    const size = this.opts.markerSizeMeters * 4;
    const mesh = new Mesh(
      new PlaneGeometry(size, size),
      new ShadowMaterial({ opacity: this.opts.shadowOpacity, transparent: true }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;

    const anchor = new Group();
    anchor.visible = false;
    anchor.add(mesh);
    this.scene.add(anchor);

    this.shadowAnchor = anchor;
    this.shadowPlane = mesh;
  }

  private resizeShadowPlane(markerSizeMeters: number): void {
    if (!this.shadowPlane) return;
    const size = markerSizeMeters * 4;
    this.shadowPlane.geometry.dispose();
    this.shadowPlane.geometry = new PlaneGeometry(size, size);
  }

  private configureShadowCamera(markerSizeMeters: number): void {
    const extent = markerSizeMeters * 2.5;
    const cam = this.light.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 0.01;
    cam.far = markerSizeMeters * 20;
    cam.updateProjectionMatrix();
    this.light.shadow.mapSize.set(1024, 1024);
    this.light.shadow.bias = -0.0008;
    this.light.shadow.normalBias = 0.01;
  }
}
