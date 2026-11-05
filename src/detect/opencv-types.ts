/**
 * Hand-written types for the slice of OpenCV.js this project touches.
 *
 * The official opencv.js ships no typings, and the community ones do not cover
 * the ArUco surface at all. Rather than pull in a large partial definition set,
 * this declares exactly what is used, with the names the binding generator
 * actually emits -- note the `aruco_` prefixes, which is where most guides go
 * wrong: it is `cv.aruco_ArucoDetector`, not `cv.ArucoDetector`.
 *
 * Verified against the official build by loading it and calling every member
 * listed here.
 */

export interface CvMat {
  rows: number;
  cols: number;
  data: Uint8Array;
  data32F: Float32Array;
  data32S: Int32Array;
  data64F: Float64Array;
  delete(): void;
  roi(rect: CvRect): CvMat;
  type(): number;
  empty(): boolean;
}

export interface CvMatVector {
  size(): number;
  get(i: number): CvMat;
  push_back(mat: CvMat): void;
  delete(): void;
}

export interface CvRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CvSize {
  width: number;
  height: number;
}

export interface ArucoDictionary {
  markerSize: number;
  maxCorrectionBits: number;
  generateImageMarker(id: number, sidePixels: number, out: CvMat, borderBits: number): void;
  delete(): void;
}

/**
 * Subset of cv::aruco::DetectorParameters. All fields are plain properties on
 * the embind wrapper, so they are assigned directly.
 */
export interface ArucoDetectorParameters {
  adaptiveThreshWinSizeMin: number;
  adaptiveThreshWinSizeMax: number;
  adaptiveThreshWinSizeStep: number;
  adaptiveThreshConstant: number;
  minMarkerPerimeterRate: number;
  maxMarkerPerimeterRate: number;
  polygonalApproxAccuracyRate: number;
  minCornerDistanceRate: number;
  minDistanceToBorder: number;
  /** 0 = none, 1 = subpix, 2 = contour, 3 = apriltag. */
  cornerRefinementMethod: number;
  cornerRefinementWinSize: number;
  cornerRefinementMaxIterations: number;
  cornerRefinementMinAccuracy: number;
  markerBorderBits: number;
  errorCorrectionRate: number;
  detectInvertedMarker: boolean;
  useAruco3Detection: boolean;
  minSideLengthCanonicalImg: number;
  minMarkerLengthRatioOriginalImg: number;
  delete(): void;
}

export interface ArucoRefineParameters {
  delete(): void;
}

export interface ArucoDetector {
  detectMarkers(
    image: CvMat,
    corners: CvMatVector,
    ids: CvMat,
    rejected: CvMatVector,
  ): void;
  setDetectorParameters(params: ArucoDetectorParameters): void;
  delete(): void;
}

/** The members of the OpenCV.js module this project uses. */
export interface OpenCV {
  onRuntimeInitialized?: () => void;
  calledRun?: boolean;

  Mat: {
    new (): CvMat;
    new (rows: number, cols: number, type: number): CvMat;
    zeros(rows: number, cols: number, type: number): CvMat;
  };
  MatVector: { new (): CvMatVector };
  Rect: { new (x: number, y: number, w: number, h: number): CvRect };
  Size: { new (w: number, h: number): CvSize };

  CV_8UC1: number;
  CV_8UC4: number;
  CV_32F: number;
  CV_32FC2: number;
  CV_32FC3: number;
  CV_64F: number;

  COLOR_RGBA2GRAY: number;
  SOLVEPNP_IPPE_SQUARE: number;
  DICT_4X4_50: number;

  matFromArray(rows: number, cols: number, type: number, arr: number[]): CvMat;
  cvtColor(src: CvMat, dst: CvMat, code: number): void;

  getPredefinedDictionary(id: number): ArucoDictionary;
  aruco_ArucoDetector: {
    new (
      dict: ArucoDictionary,
      params: ArucoDetectorParameters,
      refine: ArucoRefineParameters,
    ): ArucoDetector;
  };
  aruco_DetectorParameters: { new (): ArucoDetectorParameters };
  aruco_RefineParameters: {
    new (minRepDistance: number, errorCorrectionRate: number, checkAllOrders: boolean): ArucoRefineParameters;
  };

  solvePnP(
    objectPoints: CvMat,
    imagePoints: CvMat,
    cameraMatrix: CvMat,
    distCoeffs: CvMat,
    rvec: CvMat,
    tvec: CvMat,
    useExtrinsicGuess: boolean,
    flags: number,
  ): boolean;
  solvePnPRefineLM(
    objectPoints: CvMat,
    imagePoints: CvMat,
    cameraMatrix: CvMat,
    distCoeffs: CvMat,
    rvec: CvMat,
    tvec: CvMat,
  ): void;
  projectPoints(
    objectPoints: CvMat,
    rvec: CvMat,
    tvec: CvMat,
    cameraMatrix: CvMat,
    distCoeffs: CvMat,
    imagePoints: CvMat,
  ): void;
}

/** cv::aruco::CornerRefineMethod */
export const CORNER_REFINE_NONE = 0;
export const CORNER_REFINE_SUBPIX = 1;
export const CORNER_REFINE_CONTOUR = 2;
