/**
 * Turns a stream of per-frame detections into a stable, render-rate pose.
 *
 * Three jobs:
 *
 *  - Rate decoupling. Detection lands at whatever the worker sustains (20-30 Hz
 *    on a phone). `update()` runs every rendered frame and advances the filters,
 *    so the model moves smoothly at display rate between detections rather than
 *    stepping at detection rate.
 *
 *  - Stabilisation. One Euro on position, shortest-arc slerp on rotation.
 *
 *  - Loss handling. Hold the last pose briefly, then fade out; fade back in on
 *    re-acquisition. Without the hold, a single dropped detection makes the model
 *    blink, which reads far worse than a 200 ms freeze.
 *
 * It also rejects two classes of bad measurement: poses whose reprojection error
 * is implausible, and single-frame orientation flips. The flip case is inherent
 * to planar-square pose at near-frontal view, where two solutions are nearly
 * equally consistent with the observed corners.
 */

import { OneEuroVec3 } from './oneEuro';
import { markerPoseToThree, quatAngleDeg, quatSlerp } from './poseMath';
import type { Quat, Vec3 } from './poseMath';

export type TrackPhase = 'tracking' | 'holding' | 'fading-out' | 'gone';

export interface TrackerOptions {
  positionMinCutoff: number;
  positionBeta: number;
  positionDerivateCutoff: number;
  /** Slerp fraction per 1/60 s. Scaled for the real frame time. */
  rotationSlerp: number;
  holdMs: number;
  fadeOutMs: number;
  fadeInMs: number;
  /** Reject a detection whose mean reprojection error exceeds this, in processing px. */
  maxReprojError: number;
  /** Reject a single-frame orientation jump larger than this while already tracking. */
  maxAngularJumpDeg: number;
}

export const defaultTrackerOptions: TrackerOptions = {
  positionMinCutoff: 1.2,
  positionBeta: 0.06,
  positionDerivateCutoff: 1.0,
  rotationSlerp: 0.28,
  holdMs: 220,
  fadeOutMs: 260,
  fadeInMs: 180,
  maxReprojError: 8,
  maxAngularJumpDeg: 60,
};

export interface Measurement {
  id: number;
  rvec: Vec3;
  tvec: Vec3;
  reprojError: number;
}

export interface TrackedMarker {
  id: number;
  /** Filtered pose, three.js space, metres. */
  position: Vec3;
  quaternion: Quat;
  /** 0..1, for the fade. */
  opacity: number;
  phase: TrackPhase;
  /** Unfiltered pose of the last accepted measurement, for the debug overlay. */
  rawPosition: Vec3;
  rawQuaternion: Quat;
  reprojError: number;
  /** Measurements rejected as outliers since this marker was acquired. */
  rejected: number;
}

interface Track {
  id: number;
  position: OneEuroVec3;
  filteredPosition: Vec3;
  targetPosition: Vec3;
  quaternion: Quat;
  targetQuaternion: Quat;
  rawPosition: Vec3;
  rawQuaternion: Quat;
  opacity: number;
  phase: TrackPhase;
  lastSeenMs: number;
  reprojError: number;
  rejected: number;
  consecutiveRejects: number;
  hasPose: boolean;
}

export class PoseTracker {
  private readonly tracks = new Map<number, Track>();

  constructor(private opts: TrackerOptions = defaultTrackerOptions) {}

  configure(opts: Partial<TrackerOptions>): void {
    this.opts = { ...this.opts, ...opts };
    for (const t of this.tracks.values()) {
      t.position.configure({
        minCutoff: this.opts.positionMinCutoff,
        beta: this.opts.positionBeta,
        derivateCutoff: this.opts.positionDerivateCutoff,
      });
    }
  }

  get options(): TrackerOptions {
    return this.opts;
  }

  reset(): void {
    this.tracks.clear();
  }

  /** Feed one frame's detections. `nowMs` should be the detection timestamp. */
  ingest(measurements: readonly Measurement[], nowMs: number): void {
    for (const m of measurements) {
      if (!Number.isFinite(m.tvec[2]) || m.tvec[2] <= 0) continue;
      if (m.reprojError > this.opts.maxReprojError) {
        this.noteReject(m.id);
        continue;
      }

      const pose = markerPoseToThree(m.rvec, m.tvec);
      let track = this.tracks.get(m.id);

      if (!track) {
        track = this.createTrack(m.id, pose.position, pose.quaternion);
        this.tracks.set(m.id, track);
      } else if (track.hasPose && track.phase === 'tracking') {
        const jump = quatAngleDeg(track.rawQuaternion, pose.quaternion);
        // Allow a genuine fast rotation through after a few rejections, so a real
        // quick flick of the marker is not permanently filtered out.
        if (jump > this.opts.maxAngularJumpDeg && track.consecutiveRejects < 3) {
          track.consecutiveRejects++;
          track.rejected++;
          continue;
        }
      }

      track.consecutiveRejects = 0;
      track.targetPosition = pose.position;
      track.targetQuaternion = pose.quaternion;
      track.rawPosition = pose.position;
      track.rawQuaternion = pose.quaternion;
      track.reprojError = m.reprojError;
      track.lastSeenMs = nowMs;
      track.phase = 'tracking';
      track.hasPose = true;
    }
  }

  /**
   * Advance filters and fades. Call once per rendered frame.
   * @param nowMs performance.now()
   * @param dtMs  time since the previous update
   */
  update(nowMs: number, dtMs: number): void {
    const dt = Math.min(0.25, Math.max(1 / 240, dtMs / 1000));
    const timeSec = nowMs / 1000;

    for (const [id, t] of this.tracks) {
      const sinceSeen = nowMs - t.lastSeenMs;

      if (t.phase !== 'tracking') {
        // phases are recomputed below from sinceSeen
      }

      if (sinceSeen <= this.opts.holdMs) {
        t.phase = 'tracking';
      } else if (sinceSeen <= this.opts.holdMs + this.opts.fadeOutMs) {
        t.phase = 'fading-out';
      } else {
        t.phase = 'gone';
      }

      // Position: One Euro, driven at render rate toward the latest measurement.
      t.filteredPosition = t.position.filter(t.targetPosition, timeSec);

      // Rotation: slerp a fraction per frame, compensated so the visual response
      // is frame-rate independent.
      const alpha = 1 - Math.pow(1 - clamp01(this.opts.rotationSlerp), dt * 60);
      t.quaternion = quatSlerp(t.quaternion, t.targetQuaternion, alpha);

      // Opacity
      if (t.phase === 'tracking') {
        t.opacity = this.opts.fadeInMs > 0 ? clamp01(t.opacity + (dtMs / this.opts.fadeInMs)) : 1;
      } else if (t.phase === 'fading-out') {
        t.opacity = this.opts.fadeOutMs > 0 ? clamp01(t.opacity - (dtMs / this.opts.fadeOutMs)) : 0;
      } else {
        t.opacity = 0;
      }

      if (t.phase === 'gone' && t.opacity <= 0) {
        this.tracks.delete(id);
      }
    }
  }

  /** Current state of everything still on screen (opacity > 0). */
  get visible(): TrackedMarker[] {
    const out: TrackedMarker[] = [];
    for (const t of this.tracks.values()) {
      if (t.opacity <= 0 && t.phase === 'gone') continue;
      out.push({
        id: t.id,
        position: t.filteredPosition,
        quaternion: t.quaternion,
        opacity: t.opacity,
        phase: t.phase,
        rawPosition: t.rawPosition,
        rawQuaternion: t.rawQuaternion,
        reprojError: t.reprojError,
        rejected: t.rejected,
      });
    }
    return out;
  }

  get trackedIds(): number[] {
    return [...this.tracks.keys()];
  }

  /** True while at least one marker is being actively measured. */
  get hasLock(): boolean {
    for (const t of this.tracks.values()) if (t.phase === 'tracking') return true;
    return false;
  }

  private noteReject(id: number): void {
    const t = this.tracks.get(id);
    if (t) {
      t.rejected++;
      t.consecutiveRejects++;
    }
  }

  private createTrack(id: number, position: Vec3, quaternion: Quat): Track {
    const filter = new OneEuroVec3({
      minCutoff: this.opts.positionMinCutoff,
      beta: this.opts.positionBeta,
      derivateCutoff: this.opts.positionDerivateCutoff,
    });
    return {
      id,
      position: filter,
      filteredPosition: position,
      targetPosition: position,
      quaternion,
      targetQuaternion: quaternion,
      rawPosition: position,
      rawQuaternion: quaternion,
      opacity: 0,
      phase: 'tracking',
      lastSeenMs: -Infinity,
      reprojError: 0,
      rejected: 0,
      consecutiveRejects: 0,
      hasPose: false,
    };
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
