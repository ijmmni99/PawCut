// What to draw over the video at time t: text items and captions as pre-rasterised sprites with per-frame
// transforms (animations). Pure and DOM-free so preview (main thread) and export (worker) share it exactly.
// Coordinates are in a 1080×1920 design frame.
import {
  type Captions,
  type Project,
  type TextAnimIn,
  type TextAnimLoop,
  type TextItem,
  type TextStyle,
} from '../timeline/model';
import {
  CAPTION_MAX_W,
  CAPTION_PRESETS,
  CAPTION_X,
  CAPTION_Y,
  captionChunks,
  chunkWordTexts,
  isKeyword,
} from './captions';

export const FRAME_W = 1080;
export const FRAME_H = 1920;

export type Run = { text: string; color: string; scale: number };

/** Everything needed to rasterise one sprite. Runs are words; the rasteriser wraps them to maxWidth. */
export type SpriteSpec = { lines: Run[][]; style: TextStyle; maxWidth: number };

export type Rect = { x: number; y: number; w: number; h: number };

/** Measured by the rasteriser: sprite size, every run's box (in spec order) and each line's band. */
export type SpriteMeta = {
  w: number;
  h: number;
  runs: Rect[];
  /** Line bands top→bottom covering the sprite; `x`/`w` = the text's extent on that line; `chars` = its length. */
  lines: Array<Rect & { chars: number }>;
};

export type OverlayItem = {
  id: string;
  kind: 'text' | 'caption';
  key: string;
  start: number;
  end: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  animIn: TextAnimIn;
  animOut: TextAnimIn;
  loop: TextAnimLoop;
  /** In/out animation length, seconds. */
  animSec: number;
  /** Karaoke: highlight sprite + start time per word (same order as the base sprite's runs). */
  karaoke?: { start: number; key: string }[];
};

export type OverlayPlan = { specs: Map<string, SpriteSpec>; items: OverlayItem[] };

export type DrawOp = {
  key: string;
  /** Item id on base ops (karaoke highlight ops have none) — for hit-testing in the preview. */
  id?: string;
  cx: number;
  cy: number;
  scale: number;
  rotation: number;
  opacity: number;
  /** Typewriter: fraction of characters shown (1 = all). */
  reveal: number;
};

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + s.length.toString(36);
}

function addSpec(specs: Map<string, SpriteSpec>, spec: SpriteSpec): string {
  const key = hash(JSON.stringify(spec));
  specs.set(key, spec);
  return key;
}

const TEXT_ANIM_SEC = 0.35;
const CAPTION_ANIM_SEC = 0.16;

function textSpec(t: TextItem): SpriteSpec {
  const shown = t.style.uppercase ? t.text.toUpperCase() : t.text;
  const lines = shown.split('\n').map((line) =>
    line
      .split(/\s+/)
      .filter(Boolean)
      .map((text) => ({ text, color: t.style.color, scale: 1 })),
  );
  return { lines: lines.filter((l) => l.length > 0), style: t.style, maxWidth: FRAME_W * 0.86 };
}

function captionItems(c: Captions, specs: Map<string, SpriteSpec>): OverlayItem[] {
  const preset = CAPTION_PRESETS[c.preset];
  const style = preset.style;
  return captionChunks(c).map((ch, k) => {
    const texts = chunkWordTexts(c, ch);
    const runs = (idx: number[]) =>
      idx.map((i) => {
        const raw = c.words[i]?.text ?? '';
        const emph = preset.emphasis !== null && isKeyword(raw);
        return {
          text: texts[i - ch.first] ?? raw,
          color: emph && preset.emphasis ? preset.emphasis.color : style.color,
          scale: emph && preset.emphasis ? preset.emphasis.scale : 1,
        };
      });
    const key = addSpec(specs, { lines: ch.lines.map(runs), style, maxWidth: FRAME_W * CAPTION_MAX_W });
    let karaoke: OverlayItem['karaoke'];
    if (preset.highlight) {
      const hl = preset.highlight;
      karaoke = ch.lines.flat().map((i) => ({
        start: c.words[i]?.start ?? ch.start,
        key: addSpec(specs, {
          lines: [[{ text: texts[i - ch.first] ?? '', color: hl.color, scale: 1 }]],
          style: { ...style, box: hl.box, outline: null, shadow: false },
          maxWidth: FRAME_W,
        }),
      }));
    }
    return {
      id: `cap${k}`,
      kind: 'caption' as const,
      key,
      start: ch.start,
      end: ch.end,
      x: CAPTION_X,
      y: CAPTION_Y[c.position],
      scale: 1,
      rotation: 0,
      animIn: preset.anim,
      animOut: 'none' as const,
      loop: 'none' as const,
      animSec: CAPTION_ANIM_SEC,
      ...(karaoke ? { karaoke } : {}),
    };
  });
}

const EMPTY: TextItem[] = [];
const NO_CAPTIONS = {};
const plans = new WeakMap<object, WeakMap<object, OverlayPlan>>();

/** Sprites + timed items for a project's texts and captions (cached per texts/captions object). */
export function buildPlan(p: Pick<Project, 'texts' | 'captions'>): OverlayPlan {
  const texts = p.texts ?? EMPTY;
  const caps = p.captions ?? NO_CAPTIONS;
  let inner = plans.get(texts);
  if (!inner) {
    inner = new WeakMap();
    plans.set(texts, inner);
  }
  const cached = inner.get(caps);
  if (cached) return cached;
  const specs = new Map<string, SpriteSpec>();
  const items: OverlayItem[] = [];
  if (p.captions && p.captions.words.length > 0) items.push(...captionItems(p.captions, specs));
  for (const t of texts) {
    if (!t.text.trim()) continue;
    items.push({
      id: t.id,
      kind: 'text',
      key: addSpec(specs, textSpec(t)),
      start: t.start,
      end: t.start + t.duration,
      x: t.x,
      y: t.y,
      scale: t.scale,
      rotation: t.rotation,
      animIn: t.animIn,
      animOut: t.animOut,
      loop: t.loop,
      animSec: Math.min(TEXT_ANIM_SEC, t.duration / 3),
    });
  }
  const plan = { specs, items };
  inner.set(caps, plan);
  return plan;
}

// ---- animation ----

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOutCubic = (p: number) => 1 - (1 - p) ** 3;
const easeOutBack = (p: number) => {
  const c1 = 1.9;
  return 1 + (c1 + 1) * (p - 1) ** 3 + c1 * (p - 1) ** 2;
};
const easeOutBounce = (p: number) => {
  const n = 7.5625;
  const d = 2.75;
  if (p < 1 / d) return n * p * p;
  if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75;
  if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375;
  return n * (p -= 2.625 / d) * p + 0.984375;
};

type Pose = { dx: number; dy: number; scale: number; opacity: number; rotation: number; reveal: number };

/** Pose for an entrance at progress p (0 → 1). Exits play the same curve backwards (slide leaves to the right). */
function enter(anim: TextAnimIn, p: number, exit: boolean): Pose {
  const pose: Pose = { dx: 0, dy: 0, scale: 1, opacity: 1, rotation: 0, reveal: 1 };
  if (p >= 1) return pose;
  switch (anim) {
    case 'pop':
      pose.scale = 0.4 + 0.6 * (exit ? easeOutCubic(p) : easeOutBack(p));
      pose.opacity = clamp01(p * 3);
      break;
    case 'bounce':
      pose.dy = -(1 - (exit ? easeOutCubic(p) : easeOutBounce(p))) * 160;
      pose.opacity = clamp01(p * 4);
      break;
    case 'slide':
      pose.dx = (exit ? 1 : -1) * (1 - easeOutCubic(p)) * 260;
      pose.opacity = clamp01(p * 1.5);
      break;
    case 'fade':
      pose.opacity = p;
      break;
    case 'typewriter':
      pose.reveal = p;
      break;
    case 'none':
      break;
  }
  return pose;
}

function loopPose(loop: TextAnimLoop, t: number, pose: Pose): void {
  const w = 2 * Math.PI * t;
  switch (loop) {
    case 'bounce':
      pose.dy -= Math.abs(Math.sin(w * 1.2)) * 18;
      break;
    case 'pulse':
      pose.scale *= 1 + 0.06 * Math.sin(w * 1.5);
      break;
    case 'wiggle':
      pose.rotation += 4 * Math.sin(w * 2);
      break;
    case 'glow':
      pose.opacity *= 0.8 + 0.2 * Math.sin(w * 1.5);
      break;
    case 'none':
      break;
  }
}

/**
 * Draw operations for time `t`. `meta` gives measured sprites (karaoke needs word positions); missing → skipped.
 * Items in `settled` skip their in/out animation (the preview shows a text being edited at rest).
 */
export function layoutAt(
  plan: OverlayPlan,
  t: number,
  meta: (key: string) => SpriteMeta | undefined,
  settled?: ReadonlySet<string>,
): DrawOp[] {
  const ops: DrawOp[] = [];
  for (const it of plan.items) {
    if (t < it.start || t >= it.end) continue;
    const local = t - it.start;
    const remaining = it.end - t;
    const typeSec = it.animIn === 'typewriter' ? Math.min(1.5, Math.max(0.4, (it.end - it.start) / 2)) : it.animSec;
    const pose = settled?.has(it.id)
      ? enter('none', 1, false)
      : local < typeSec
        ? enter(it.animIn, local / typeSec, false)
        : remaining < it.animSec && it.animOut !== 'none'
          ? enter(it.animOut === 'typewriter' ? 'fade' : it.animOut, remaining / it.animSec, true)
          : enter('none', 1, false);
    loopPose(it.loop, local, pose);
    const scale = it.scale * pose.scale;
    const rotation = it.rotation + pose.rotation;
    const cx = it.x * FRAME_W + pose.dx;
    const cy = it.y * FRAME_H + pose.dy;
    ops.push({ key: it.key, id: it.id, cx, cy, scale, rotation, opacity: pose.opacity, reveal: pose.reveal });

    if (it.karaoke) {
      const m = meta(it.key);
      let active = -1;
      for (let i = 0; i < it.karaoke.length; i++) if ((it.karaoke[i]?.start ?? Infinity) <= t) active = i;
      const word = it.karaoke[Math.max(0, active)];
      const box = m?.runs[Math.max(0, active)];
      if (m && word && box) {
        // Word centre relative to the sprite centre, through the same scale (captions don't rotate).
        const ox = (box.x + box.w / 2 - m.w / 2) * scale;
        const oy = (box.y + box.h / 2 - m.h / 2) * scale;
        ops.push({ key: word.key, cx: cx + ox, cy: cy + oy, scale, rotation: 0, opacity: pose.opacity, reveal: 1 });
      }
    }
  }
  return ops;
}
