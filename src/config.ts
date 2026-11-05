/**
 * Project configuration. Everything a non-developer should need to change for a
 * new deployment lives in this file.
 */

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
      url: 'models/model.glb',
      scale: 'fitToMarker',
      fitFraction: 0.8,
      offset: [0, 0, 0],
      rotationDeg: [0, 0, 0],
      animation: 0,
      castShadow: true,
    },
    // Add more markers by copying the block above and changing the id and url:
    // 1: { url: 'models/other.glb', scale: 1 },
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
    positionMinCutoff: 1.2,
    positionBeta: 0.06,
    positionDerivateCutoff: 1.0,
    rotationSlerp: 0.28,
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
