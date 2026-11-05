/**
 * Project configuration. Everything a non-developer should need to change for a
 * new deployment lives in this file.
 */

/**
 * Look overrides for a model's materials.
 *
 * Useful when an export carries no material information -- converters from
 * print formats such as STL or 3MF typically emit a single white surface at
 * full roughness, which renders as flat chalk. Only the properties given here
 * are changed; a model with real materials keeps them.
 */
export interface MaterialOverride {
  /** CSS colour, e.g. '#5ad1a0'. Interpreted as sRGB. */
  color?: string;
  /** 0 = dielectric (plastic, paint), 1 = bare metal. */
  metalness?: number;
  /** 0 = mirror, 1 = fully matte. Around 0.35 reads as a satin finish. */
  roughness?: number;
  emissive?: string;
  emissiveIntensity?: number;
}

/** Which marker a model is bound to, and how it sits on that marker. */
export interface MarkerModelConfig {
  /** URL of a .glb, relative to the site base. Lazy-loaded on first lock. */
  url: string;
  /**
   * Either an explicit uniform scale, or 'fitToMarker' to scale the model so its
   * largest horizontal dimension equals `fitFraction` x the marker side. Authoring
   * models in metres and using an explicit scale of 1 is the predictable option;
   * 'fitToMarker' is the forgiving one for models of unknown size.
   */
  scale?: number | 'fitToMarker';
  /** With scale: 'fitToMarker', the fraction of the marker side to fill. */
  fitFraction?: number;
  /**
   * Offset in metres in the marker frame: +X right along the marker, +Y up away
   * from the marker surface, +Z toward the viewer-side bottom edge.
   */
  offset?: readonly [number, number, number];
  /** Extra rotation in degrees, applied in XYZ order after the marker pose. */
  rotationDeg?: readonly [number, number, number];
  /** Clip to autoplay: a name, an index, or null for none. Defaults to the first clip. */
  animation?: string | number | null;
  /** Cast a shadow onto the marker-plane shadow catcher. */
  castShadow?: boolean;
  /** Override the model's materials; see MaterialOverride. */
  material?: MaterialOverride;
}

export interface AppConfig {
  /** ArUco dictionary. Only 4x4_50 is wired up; see detect/worker.ts to add more. */
  dictionary: 'DICT_4X4_50';
  /** Printed marker side length in metres, black border included, quiet zone excluded. */
  markerSizeMeters: number;
  /** marker id -> model */
  markers: Readonly<Record<number, MarkerModelConfig>>;
  detection: {
    /** Frame width in px handed to the detector. Stepped adaptively between the bounds. */
    processingWidth: number;
    minProcessingWidth: number;
    maxProcessingWidth: number;
    /** Budget for one detect() call. Exceeding it for a while steps the width down. */
    targetDetectMs: number;
    /** Sub-pixel corner refinement. Off costs ~4% less time and visibly more jitter. */
    subPixelRefinement: boolean;
    /** OpenCV's ArUco3 fast mode. Measured as no faster on synthetic frames; off by default. */
    aruco3: boolean;
    /** Once locked, search only around the last quad, expanded by this fraction of its size. */
    roiTracking: boolean;
    roiMarginFraction: number;
    /** Force a full-frame detect every N frames even while locked, to pick up new markers. */
    fullScanInterval: number;
  };
  filter: {
    /** One Euro filter on position (metres). */
    positionMinCutoff: number;
    positionBeta: number;
    positionDerivateCutoff: number;
    /** Rotation slerp factor per 60 Hz frame, 0..1. Higher follows faster and jitters more. */
    rotationSlerp: number;
    /** Hold the last pose this long after losing the marker, before fading. */
    holdMs: number;
    fadeOutMs: number;
    fadeInMs: number;
  };
  camera: {
    idealWidth: number;
    idealHeight: number;
    /** Assumed horizontal field of view when no calibration is stored, in degrees. */
    fallbackHorizontalFovDeg: number;
  };
  render: {
    maxPixelRatio: number;
    /** Adjust exposure from mean camera luminance. */
    lightEstimation: boolean;
    exposure: number;
    shadowCatcher: boolean;
    shadowOpacity: number;
  };
}

export const config: AppConfig = {
  dictionary: 'DICT_4X4_50',
  markerSizeMeters: 0.1,

  markers: {
    0: {
      url: 'models/galvok-smile.glb',
      scale: 'fitToMarker',
      fitFraction: 0.9,
      offset: [0, 0, 0],
      // Lays the logo flat on the marker, lettering upward. The lettering is
      // on the model's -Z face, so +90 about X is what brings it up; -90 shows
      // the blank back of the logo instead.
      rotationDeg: [90, 0, 0],
      animation: 0,
      castShadow: true,
      // The export carries no material information at all -- a single white
      // surface at full roughness -- so the look is set here rather than by
      // re-exporting from the 3D tool.
      material: { color: '#e8eaee', metalness: 0.15, roughness: 0.38 },
    },
    // Add more markers by copying the block above and changing the id and url:
    // 1: { url: 'models/other.glb', scale: 1 },
    //
    // models/model.glb is the generated placeholder (npm run assets), kept as a
    // fallback if you remove the model above.
  },

  detection: {
    processingWidth: 480,
    minProcessingWidth: 320,
    maxProcessingWidth: 640,
    targetDetectMs: 22,
    subPixelRefinement: true,
    aruco3: false,
    roiTracking: true,
    roiMarginFraction: 0.6,
    fullScanInterval: 30,
  },

  filter: {
    // One Euro, tuned for positions measured in METRES.
    //
    // The published defaults assume pixel units, where speeds run to hundreds
    // of units per second. Here a hand moves a marker at roughly 0.1-0.5 m/s,
    // so the original beta of 0.06 added about 0.02 Hz to the cutoff: One
    // Euro's speed adaptation was effectively switched off, leaving only the
    // baseline smoothing and its ~130 ms time constant. That is what made the
    // model drag behind the marker.
    //
    // Measured with a marker sliding at 0.3 m/s, detections at 15 Hz, render at
    // 60 Hz, against +/-0.4 mm of measurement noise:
    //
    //   minCutoff / beta   lag      jitter
    //   1.2 / 0.06  (old)  46.7 mm  0.076 mm
    //   2.0 / 2.5          24.8 mm  0.099 mm
    //   4.0 / 6.0   (now)  15.6 mm  0.135 mm
    //   6.0 / 10           12.7 mm  0.154 mm
    //
    // Jitter is negligible across that whole range, so the old setting was
    // paying 47 mm of lag to save 0.08 mm of wobble. About 10 mm of what is
    // left is irreducible: at 15 Hz the newest measurement is already up to
    // 66 ms old before any filtering happens.
    positionMinCutoff: 4.0,
    positionBeta: 6.0,
    positionDerivateCutoff: 1.0,
    rotationSlerp: 0.45,
    holdMs: 220,
    fadeOutMs: 260,
    fadeInMs: 180,
  },

  camera: {
    idealWidth: 1280,
    idealHeight: 720,
    fallbackHorizontalFovDeg: 62,
  },

  render: {
    maxPixelRatio: 2,
    lightEstimation: true,
    exposure: 1.05,
    shadowCatcher: true,
    shadowOpacity: 0.32,
  },
};

const MARKER_SIZE_KEY = 'aruco-ar.markerSizeMeters';

/** Marker size, overridable at runtime from the debug panel and the marker page. */
export function getMarkerSizeMeters(): number {
  try {
    const raw = localStorage.getItem(MARKER_SIZE_KEY);
    if (raw !== null) {
      const v = Number.parseFloat(raw);
      if (Number.isFinite(v) && v > 0.005 && v < 5) return v;
    }
  } catch {
    // localStorage can throw in private mode; fall through to the compiled default.
  }
  return config.markerSizeMeters;
}

export function setMarkerSizeMeters(meters: number): void {
  try {
    localStorage.setItem(MARKER_SIZE_KEY, String(meters));
  } catch {
    // Non-fatal: the value just will not persist.
  }
}

export function markerConfig(id: number): MarkerModelConfig | undefined {
  return config.markers[id];
}

export const knownMarkerIds: readonly number[] = Object.keys(config.markers).map(Number);
