# Marker AR

Point a phone at a printed ArUco marker and a glTF model appears anchored on it.
Everything runs on the device: no backend, no analytics, and camera frames never
leave the browser.

- **Dictionary:** ArUco `4x4_50`
- **Marker 0 → `public/models/galvok-smile.glb`** (swap in your own; a generated placeholder lives at `models/model.glb`)
- **Printed marker side:** 100 mm by default, changeable at runtime
- **Targets:** iPhone 12 or newer (Safari, including installed PWA), mid-range Android Chrome

---

## Quick start

```bash
npm install
npm run dev
```

`npm run dev` fetches OpenCV.js, copies the glTF decoders, generates the
placeholder model, and starts an HTTPS dev server on `https://localhost:5173`.

### Running it on a phone over your LAN

The camera needs a secure context, so plain `http://<your-ip>` will not work.
The dev server uses a self-signed certificate, which your phone will warn about
once:

1. `npm run dev` and note the Network URL it prints, e.g. `https://192.168.1.23:5173`.
2. Open that URL on the phone, on the same Wi-Fi.
3. Accept the certificate warning ("Advanced" → "Proceed").
4. Tap **Start camera** and allow access.

If the phone cannot reach it, the usual cause is the host firewall blocking port
5173, or the network isolating clients ("AP isolation", common on guest Wi-Fi).

---

## Printing a marker

Open `/marker.html`, choose an id and a size, and print. Then **measure the black
square with a ruler** and, if it differs, enter the measured value in the debug
panel. Print scaling is silent and a 5% error becomes a 5% error in every
distance the solver reports.

Set **Scale: 100%** in the print dialog. Not "Fit to page", not "Shrink to
printable area".

---

## Adding models and markers

Edit `src/config.ts`:

```ts
markers: {
  0: { url: 'models/model.glb', scale: 'fitToMarker', fitFraction: 0.8 },
  1: { url: 'models/robot.glb', scale: 1, offset: [0, 0, 0], animation: 'Idle' },
},
```

Drop `.glb` files in `public/models/`. Draco, meshopt and KTX2 are all supported
and lazily decoded. `scale: 1` means the model is authored in metres;
`'fitToMarker'` scales it so its widest horizontal dimension is `fitFraction` of
the marker side, which is the forgiving option for a model of unknown size.

Models are loaded only when their marker is first seen.

---

## Detector benchmark

The spec asked for a spike before committing to a detector. Here is what it found.

### The decisive result: no custom WASM build is needed

**The stock official `opencv.js` already exposes the complete ArUco and
planar-pose surface.** This contradicts most community advice, so it was verified
by loading the binary and calling it, not by grepping — the WASM is embedded as a
base64 data URI, so searching the file for `ArucoDetector` returns nothing, which
is probably why the usual answer is "build it yourself".

What is actually there:

| Needed | Present as |
| --- | --- |
| Dictionary | `cv.getPredefinedDictionary(cv.DICT_4X4_50)` |
| Detector | `cv.aruco_ArucoDetector`, `cv.aruco_DetectorParameters`, `cv.aruco_RefineParameters` |
| Sub-pixel corners | `params.cornerRefinementMethod = 1` (`CORNER_REFINE_SUBPIX`) |
| Planar pose | `cv.solvePnP` with `cv.SOLVEPNP_IPPE_SQUARE` |
| Refinement | `cv.solvePnPRefineLM` |
| Calibration | `cv.aruco_CharucoBoard`, `cv.aruco_CharucoDetector`, `cv.calibrateCameraExtended` |

The bindings are namespaced: `cv.aruco_ArucoDetector`, **not** `cv.ArucoDetector`.
`cv.cornerSubPix` is *not* exported, which is why refinement has to come from the
detector parameter. `tests/integration/opencv.test.mjs` pins all of this.

### Candidates compared

| | OpenCV.js (stock) | js-aruco2 | @techstark/opencv-js |
| --- | --- | --- | --- |
| Speed @ 640×480 | **6.7 ms** | 8.4 ms | same engine |
| Corners | float, sub-pixel | **integer only** | float |
| Pose | IPPE_SQUARE + LM refine | POSIT only | same |
| Size | 10.96 MB / **3.54 MB gz** | ~25 KB gz | 13.3 MB / 3.75 MB gz |
| Licence | **Apache-2.0** | **MIT** | Apache-2.0 |

**js-aruco2 was rejected on quality, not size.** Its source contains no sub-pixel
or refinement step anywhere, and measured corners came back integer-quantised
(`231.00, 156.00, 432.00, 186.00`). At a ~200 px marker that is roughly ±0.25% of
the marker side per corner per frame, feeding straight into pose as jitter. It was
also *slower* at 640 px, so there was no speed argument either.

`@techstark/opencv-js` is the same engine, larger, only pre-release tags, and its
typings do not cover ArUco — no advantage over vendoring the official file.

### Measured numbers

Desktop baseline, `npm run bench:node`. Windows, Node 24.19, stock OpenCV.js
(no SIMD, no threads), 120 frames per row of a synthetic clip that moves, tilts
and rescales the marker.

| Processing size | Sub-pixel | p50 ms | p95 ms | det/s | found | corner err px |
| --- | --- | --- | --- | --- | --- | --- |
| 320×240 | on | 6.10 | 10.54 | 134.0 | 106/120 | 0.742 |
| 320×240 | off | 6.94 | 8.48 | 131.5 | 106/120 | 0.903 |
| 480×360 | on | 13.56 | 19.03 | 67.0 | 111/120 | 0.747 |
| 480×360 | off | 12.55 | 30.04 | 62.0 | 111/120 | 0.907 |
| 640×480 | on | 19.54 | 26.38 | 46.3 | 111/120 | 0.738 |
| 640×480 | off | 20.08 | 24.54 | 46.3 | 111/120 | 0.893 |
| 960×720 | on | 43.39 | 50.15 | 21.0 | 116/120 | 0.740 |
| 960×720 | off | 43.37 | 49.85 | 21.2 | 116/120 | 0.907 |

Two things worth reading off that table:

- **Sub-pixel refinement is effectively free** (19.54 vs 20.08 ms at 640×480) and
  consistently cuts corner error from ~0.90 px to ~0.74 px. There is no trade to
  make here; it is on by default.
- The ~0.74 px floor is a systematic offset between where the synthetic renderer
  draws an edge and where OpenCV reports the corner. The *spread* across the four
  corners is under 0.05 px, which is what matters for stability.

### End-to-end, in a real browser

Headless Chromium, fake camera serving the synthetic clip, production build:

| | |
| --- | --- |
| Render rate | 17.3 fps |
| Detection | 7.00 ms median |
| Pose solve | 0.80 ms median |
| Worker total per frame | 10.60 ms median |
| Camera-to-pose latency | 54.7 ms median |
| Detection rate | 14.9 /s |
| Frames captured / dropped | 179 / 15 |
| Processing size (auto) | 320×240, from a 640×480 source |
| Frame path | `createImageBitmap` resize, `requestVideoFrameCallback` |

The frame rate here is **not** representative: headless Chromium renders WebGL
through SwiftShader on the CPU, and that is what limits it. It is included
because it shows the adaptive resolution working — detection overran its budget,
so the pipeline stepped down from 480 px to 320 px on its own.

### Bundle sizes

| | gzipped |
| --- | --- |
| Initial load (`index.html` + shell JS + CSS) | **5.5 KB** |
| AR engine incl. three.js (on Start tap) | 158 KB |
| OpenCV.js (in the worker, after Start) | 3.54 MB |
| Draco / KTX2 decoders | only if a model needs them |

Comfortably inside the 300 KB initial-JS budget.

---

## Architecture

```
main thread                              worker thread
───────────                              ─────────────
<video> (getUserMedia, playsinline)
  │ requestVideoFrameCallback
  ▼
FrameSource ──createImageBitmap(resize)──► DetectWorker
  │          (transferred, no copy)         │ opencv.js (lazy, 3.54 MB gz)
  │                                         │ ArucoDetector + CORNER_REFINE_SUBPIX
  │                                         │ solvePnP IPPE_SQUARE → solvePnPRefineLM
  │◄──────{id, corners, rvec, tvec, ms}─────┘ ROI tracking when locked
  ▼
PoseTracker (One Euro on position, slerp on rotation, hold + fade on loss)
  ▼
Renderer (three.js, transparent canvas over <video>, rAF at display rate)
```

Detection and rendering are fully decoupled. The render loop runs every frame and
advances the filters; detection runs at whatever rate the worker sustains. Exactly
one frame is in flight at a time and frames are **dropped rather than queued**, so
latency stays bounded instead of growing under load.

### Things that are easy to get wrong, and how they are handled

**The projection matrix comes from the solver's own intrinsics**, and accounts for
the `object-fit: cover` crop — only a centre crop of the camera frame is on
screen. Using a guessed FOV, or ignoring the crop, gives a model that tracks
correctly in the middle of the frame and drifts off the marker near the edges.

**Two coordinate changes, not one** (`src/pose/poseMath.ts`). OpenCV is +Y down,
+Z forward; three.js is +Y up, camera looking down −Z. And models are authored
Y-up while the solver's marker frame has +Z out of the printed face. Composed:
`R = F · R_cv · Rx(-90)` where `F = diag(1, -1, -1)`. Unit tests assert the
determinant stays +1, so nothing is silently mirrored.

**A marker facing the camera is not `rvec = 0`.** With `rvec = 0` the marker's +Z
runs away from the camera, i.e. you are looking at its back. This matters when
synthesising test images, and the integration test guards it by checking the
winding of the projected quad.

**Planar-square pose is ambiguous near head-on**, so `PoseTracker` rejects
single-frame orientation flips — while still letting a genuinely fast rotation
through after a few frames, so a quick flick of the marker does not freeze the
model.

### Three OpenCV.js traps worth knowing

These cost real time; they are documented at the call sites.

1. **The module is a self-returning thenable.** `opencv.js` defines
   `Module.then = function(func){ ...; return Module }`. Resolving a promise with
   it — `return mod` from an `async` function, `resolve(mod)`, `await mod` — sends
   the promise resolution procedure into endless recursion. In a worker the thread
   is **killed with no error event**; in Node the process stops dead, with even
   `setTimeout` no longer firing. The module must never travel through a promise;
   assign it to a variable instead.
2. **`onRuntimeInitialized` cannot be relied on.** Set before the script loads, it
   is silently dropped; set after, it overwrites the handler opencv.js installed
   for its own binding generation. Polling for `cv.Mat` observes the result
   without interfering with either.
3. **Do not buffer the file to feed `importScripts` a blob URL.** Import the real
   URL and use a streaming `fetch` purely to count bytes for the progress bar —
   the import is then served from the cache that fetch just populated.

---

## Camera calibration (optional)

Without calibration the app assumes a 62° horizontal field of view, which is close
enough for a model to sit convincingly on a marker. Calibrating mainly improves
how well the model stays put near the frame edges.

`/calibrate.html` prints a ChArUco board, captures 8+ views, and stores per-device
intrinsics in `localStorage`, normalised by frame size so a resolution change does
not invalidate them. The board is rendered by **OpenCV's own `generateImage`**
rather than hand-drawn SVG, so the board and the detector cannot disagree.

Verified against ground truth in `tests/integration/opencv.test.mjs`: a synthetic
camera with `fx = 1000, cx = 650, cy = 355` is recovered as `fx = 1001.2,
cx = 648.9, cy = 354.8` at 0.157 px RMS.

---

## Tuning

Tap **i** in the AR view (or press `d`) for the debug overlay: fps, detection and
render times, camera-to-pose latency, marker corners, pose, jitter, and sliders
for the filter parameters. While it is open the same numbers are on
`window.markerArDebug`, which is handy from a remote console.

| Symptom | Try |
| --- | --- |
| Jitter when the marker is still | lower `pos minCutoff`, lower `rot slerp` |
| Model lags behind a moving marker | raise `pos beta`, raise `rot slerp` |
| Model blinks when detection drops | raise `hold ms` |
| Detection too slow | lower `proc width`, or turn off sub-pixel refinement |
| Model is the wrong size | measure the printed marker and set `marker mm` |

---

## Testing

```bash
npm test             # 96 unit tests + 13 integration tests
npm run test:unit    # vitest only, ~0.7 s
npm run test:integration  # against the real shipped opencv.js, ~2 s
npm run test:e2e     # Playwright, real Chromium with a fake camera
npm run bench:node   # the desktop benchmark table above
```

- **Unit** (`tests/unit`, vitest): pose math, One Euro filter, slerp, the
  tracker's hold/fade state machine and outlier rejection, intrinsics, marker SVG.
- **Integration** (`tests/integration`, `node --test`): runs against the real
  `opencv.js`. Re-derives all 50 dictionary entries from OpenCV and compares them
  to the table the marker page prints from; recovers a known pose to under 1 mm
  and 1°; recovers a known camera. It runs under `node --test` rather than Vitest
  because loading the 11 MB binary inside a Vitest worker ran for over seven
  minutes without reaching an assertion, while Node's own require path does it in
  about 250 ms.
- **E2E** (`tests/e2e`, Playwright): Chromium with
  `--use-file-for-fake-video-capture` fed a Y4M clip of a moving marker, generated
  by the same code the benchmark uses (no ffmpeg dependency). Asserts the marker
  is detected, the pose is physically plausible, the model is actually drawn
  (draw calls and triangles > 0), the model tracks the marker's motion, detection
  stays off the main thread, a screenshot downloads, and tracking recovers after
  a loss.

---

## Deploying

A GitHub Actions workflow publishes to GitHub Pages on push to `main`. It runs the
asset step (which downloads OpenCV.js — it is not committed), type-checks, tests,
builds with `BASE_PATH` set to the repo name, and uploads.

Enable it under **Settings → Pages → Source: GitHub Actions**. HTTPS is automatic,
which the camera requires.

For any other static host, `npm run build` and serve `dist/`. Set `BASE_PATH` if
the app is not at the domain root.

---

## Licences

All dependencies are permissive and fine for a closed or commercial app.
**No LGPL or GPL anywhere.**

| | |
| --- | --- |
| OpenCV.js | Apache-2.0 (notice + licence shipped in `public/vendor/`) |
| three.js | MIT |
| Vite, vitest, plugin-basic-ssl | MIT |
| TypeScript, Playwright | Apache-2.0 |
| Placeholder model, icons, marker SVG | generated by this repo, no third-party rights |

Apache-2.0 requires shipping the licence text and attribution; `scripts/fetch-opencv.mjs`
writes both into `public/vendor/`, and they are deployed with the app.

---

## Known limitations

- **The 3.54 MB OpenCV download** is the main cost. It is fetched only after the
  user taps Start, cached by the service worker, and shown with a progress bar,
  but the first run on a slow connection is a wait. A custom Emscripten build with
  only `core`, `imgproc`, `calib3d` and `objdetect`, a separate `.wasm` (removing
  the 33% base64 inflation) and SIMD should land around 1.2–1.8 MB gz and run
  faster. That is a measured follow-up, not done here.
- **Motion blur** is the practical limit on tracking, not detector speed. A marker
  swung quickly under indoor light blurs past recognition.
- **One marker size for all markers.** Mixed sizes would need a per-id size in the
  config and a change to the worker protocol.
- **No multi-threading or SIMD** in the stock build.
- The pose is **planar-square**, so a bent or curled marker degrades it.
- Glossy or laminated markers lose detections to specular highlights.

---

## What has and has not been verified

Stated plainly, because some of it matters.

**Verified here:**

- 96 unit tests and 13 integration tests against the real shipped `opencv.js`.
- 6 end-to-end tests in real Chromium against a fake camera, on the production build.
- The desktop benchmark table, and the in-browser figures (with the SwiftShader
  caveat noted above).
- Bundle sizes, measured from the actual build output.
- Calibration accuracy against a synthetic ground-truth camera.

**NOT verified — no iPhone or Android device was available:**

- iOS Safari, at all.
- The installed iOS PWA, including **whether the camera works in standalone mode**.
- Android Chrome, at all.
- Real sustained frame rate or detection time on any phone.
- Real-world jitter with a printed marker held still. The figures the debug panel
  shows during the synthetic clip (23.4 mm, 1.74°) are for a marker in constant
  motion and are **not** the stationary-jitter number the spec asked for. That has
  to be measured on a device, with a real printed marker, held still.
- Torch and camera switching, which need real multi-camera hardware.
- Print scaling on a real printer.

The manual checklist below covers exactly those gaps.

### Manual test checklist

**iPhone, Safari**

- [ ] Open over HTTPS on the LAN; accept the certificate warning
- [ ] Tap Start; the permission prompt appears and the camera starts
- [ ] Marker is detected; model sits on it and stays put as you move around it
- [ ] Model does not drift off the marker near the frame edges
- [ ] Hold the marker still: note position and rotation jitter in the debug panel
- [ ] Cover the marker: model holds briefly, then fades — no blink
- [ ] Rotate the phone to landscape and back; tracking survives
- [ ] Screenshot button offers the share sheet and saves to Photos
- [ ] Note fps and detect ms from the debug panel

**iPhone, installed PWA** (Share → Add to Home Screen)

- [ ] Launches standalone, no browser chrome
- [ ] **The camera works in standalone mode** (historically the risky one)
- [ ] Works with the device in airplane mode after one online load

**Android, Chrome**

- [ ] All of the Safari list above
- [ ] Torch toggle appears and works
- [ ] Camera switch cycles cameras and tracking recovers
- [ ] Install prompt works; the installed app has camera access

**Printing**

- [ ] Printed at 100%, the black square measures the requested size
- [ ] The measured value is entered in the debug panel if it differs
