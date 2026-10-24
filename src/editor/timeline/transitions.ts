// Transitions between main-track clips: catalogue + timing. A transition is stored on the outgoing clip and centred
// on the cut, so the timeline length never changes; during the window the outgoing clip keeps playing past its out
// point (using spare source footage when there is some, else holding its last frame) while the incoming clip starts
// early (likewise). Shared by preview and export.
import { type Clip, type ClipTransition, type Project, type TransitionKind, clipDuration, clipStarts } from './model';

export type TransitionDef = { id: TransitionKind; label: string; icon: string; group: 'hype' | 'classic' };

export const TRANSITIONS: TransitionDef[] = [
  { id: 'zoomIn', label: 'Zoom punch', icon: '🔍', group: 'hype' },
  { id: 'zoomOut', label: 'Zoom out', icon: '🔭', group: 'hype' },
  { id: 'whipLeft', label: 'Whip ←', icon: '💨', group: 'hype' },
  { id: 'whipRight', label: 'Whip →', icon: '💨', group: 'hype' },
  { id: 'whipUp', label: 'Whip ↑', icon: '💨', group: 'hype' },
  { id: 'whipDown', label: 'Whip ↓', icon: '💨', group: 'hype' },
  { id: 'spin', label: 'Spin', icon: '🌀', group: 'hype' },
  { id: 'glitch', label: 'Glitch', icon: '📺', group: 'hype' },
  { id: 'rgbSplit', label: 'RGB split', icon: '🌈', group: 'hype' },
  { id: 'flash', label: 'Flash', icon: '⚡️', group: 'hype' },
  { id: 'shake', label: 'Shake', icon: '📳', group: 'hype' },
  { id: 'blurZoom', label: 'Blur zoom', icon: '🌪️', group: 'hype' },
  { id: 'lightLeak', label: 'Light leak', icon: '🌅', group: 'hype' },
  { id: 'dissolve', label: 'Dissolve', icon: '◐', group: 'classic' },
  { id: 'dipBlack', label: 'Dip black', icon: '⬛️', group: 'classic' },
  { id: 'dipWhite', label: 'Dip white', icon: '⬜️', group: 'classic' },
  { id: 'slideLeft', label: 'Slide', icon: '⬅️', group: 'classic' },
  { id: 'slideUp', label: 'Slide up', icon: '⬆️', group: 'classic' },
  { id: 'pushLeft', label: 'Push ←', icon: '⏪', group: 'classic' },
  { id: 'pushRight', label: 'Push →', icon: '⏩', group: 'classic' },
  { id: 'wipeLeft', label: 'Wipe', icon: '▶️', group: 'classic' },
  { id: 'wipeUp', label: 'Wipe up', icon: '🔼', group: 'classic' },
  { id: 'circle', label: 'Circle', icon: '⭕️', group: 'classic' },
  { id: 'heart', label: 'Heart', icon: '💗', group: 'classic' },
  { id: 'luma', label: 'Luma fade', icon: '🌗', group: 'classic' },
  { id: 'pixelize', label: 'Pixels', icon: '👾', group: 'classic' },
];

export const DEFAULT_TRANSITION_SEC = 0.5;
export const MIN_TRANSITION_SEC = 0.2;
export const MAX_TRANSITION_SEC = 1.5;

/** A cut with an active transition. `duration` is clamped so it fits inside both neighbouring clips. */
export type Cut = { index: number; time: number; kind: TransitionKind; duration: number };

export function cutsWithTransitions(p: Project): Cut[] {
  const starts = clipStarts(p);
  const out: Cut[] = [];
  for (let i = 0; i < p.main.length - 1; i++) {
    const clip = p.main[i] as Clip;
    const next = p.main[i + 1] as Clip;
    const tr = clip.transition;
    if (!tr) continue;
    const duration = Math.min(tr.duration, clipDuration(clip), clipDuration(next));
    if (duration < 0.05) continue;
    out.push({ index: i, time: (starts[i + 1] as number), kind: tr.kind, duration });
  }
  return out;
}

/** The transition being played at timeline time `t`: outgoing clip index, kind and progress 0..1. */
export function transitionAt(cuts: readonly Cut[], t: number): (Cut & { p: number }) | null {
  for (const c of cuts) {
    const t0 = c.time - c.duration / 2;
    if (t >= t0 && t < c.time + c.duration / 2) return { ...c, p: (t - t0) / c.duration };
  }
  return null;
}

/**
 * The timeline span in which clip `i` is on screen, including the halves of its transitions: [from, to).
 * Source time at timeline t is inSec + (t − start) × speed, clamped to the asset (see sourceTime).
 */
export function clipWindow(p: Project, cuts: readonly Cut[], i: number): { from: number; to: number; start: number } {
  const starts = clipStarts(p);
  const start = starts[i] ?? 0;
  const clip = p.main[i] as Clip;
  const before = cuts.find((c) => c.index === i - 1);
  const after = cuts.find((c) => c.index === i);
  return {
    start,
    from: start - (before ? before.duration / 2 : 0),
    to: start + clipDuration(clip) + (after ? after.duration / 2 : 0),
  };
}

/** Source time of clip at timeline time t, clamped into the file (edge frames hold when there's no spare footage). */
export function sourceTime(clip: Clip, start: number, t: number, assetDuration: number): number {
  const s = clip.inSec + (t - start) * clip.speed;
  return Math.min(Math.max(s, 0), Math.max(0, assetDuration - 1 / 30));
}

// ---- edits ----

export function setTransition(p: Project, clipIds: ReadonlySet<string>, tr: ClipTransition | null): Project {
  return {
    ...p,
    main: p.main.map((c) => {
      if (!clipIds.has(c.id)) return c;
      if (tr) return { ...c, transition: tr };
      const { transition: _drop, ...rest } = c;
      return rest;
    }),
  };
}

const HYPE = TRANSITIONS.filter((t) => t.group === 'hype').map((t) => t.id);

/** A different hype transition on every cut ("Random hype"). Deterministic per seed. */
export function randomHype(p: Project, duration: number, seed = Date.now()): Project {
  let s = seed >>> 0;
  let prev: TransitionKind | null = null;
  return {
    ...p,
    main: p.main.map((c, i) => {
      if (i === p.main.length - 1) return c;
      s = (s * 1664525 + 1013904223) >>> 0;
      let kind = HYPE[s % HYPE.length] as TransitionKind;
      if (kind === prev) kind = HYPE[(s + 1) % HYPE.length] as TransitionKind;
      prev = kind;
      return { ...c, transition: { kind, duration } };
    }),
  };
}
