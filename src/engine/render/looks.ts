// Filters + Adjust → shader parameters. A filter preset is a set of adjustments plus split-toning (shadow and
// highlight tints) and optional black & white; `amount` scales the preset, and the user's own sliders add on top.
import type { Adjust, FilterId, Look } from '../../editor/timeline/model';

type RGB = [number, number, number];

export type LookParams = Adjust & {
  /** Split toning: tint colours (0.5 = neutral) and strength. */
  splitShadow: RGB;
  splitHighlight: RGB;
  split: number;
  /** 0 = colour, 1 = black & white. */
  bw: number;
};

export const ADJUST_KEYS: Array<keyof Adjust> = [
  'brightness',
  'exposure',
  'contrast',
  'highlights',
  'shadows',
  'saturation',
  'vibrance',
  'temperature',
  'tint',
  'fade',
  'sharpen',
  'vignette',
];

export const ADJUST_LABELS: Record<keyof Adjust, string> = {
  brightness: 'Brightness',
  exposure: 'Exposure',
  contrast: 'Contrast',
  highlights: 'Highlights',
  shadows: 'Shadows',
  saturation: 'Saturation',
  vibrance: 'Vibrance',
  temperature: 'Warmth',
  tint: 'Tint',
  fade: 'Fade',
  sharpen: 'Sharpen',
  vignette: 'Vignette',
};

/** Sliders that only go up from 0. */
export const ADJUST_POSITIVE: ReadonlySet<keyof Adjust> = new Set(['fade', 'sharpen', 'vignette']);

type Preset = { label: string; swatch: string; adjust: Partial<Adjust>; shadow?: RGB; highlight?: RGB; split?: number; bw?: number };

const TEAL: RGB = [0.38, 0.56, 0.62];
const ORANGE: RGB = [0.68, 0.53, 0.38];

export const FILTERS: Record<FilterId, Preset> = {
  none: { label: 'None', swatch: '#3f3f46', adjust: {} },
  warm: { label: 'Warm', swatch: '#f59e0b', adjust: { temperature: 0.45, saturation: 0.1, contrast: 0.05 } },
  cool: { label: 'Cool', swatch: '#38bdf8', adjust: { temperature: -0.45, contrast: 0.05, saturation: 0.05 } },
  vivid: { label: 'Vivid', swatch: '#ec4899', adjust: { saturation: 0.3, vibrance: 0.35, contrast: 0.15 } },
  film: {
    label: 'Film',
    swatch: '#a8a29e',
    adjust: { fade: 0.25, saturation: -0.12, contrast: 0.05 },
    shadow: TEAL,
    highlight: [0.62, 0.56, 0.46],
    split: 0.35,
  },
  golden: {
    label: 'Golden',
    swatch: '#fbbf24',
    adjust: { temperature: 0.6, highlights: 0.1, saturation: 0.12, exposure: 0.05 },
    highlight: [0.7, 0.58, 0.35],
    split: 0.25,
  },
  pastel: { label: 'Pastel', swatch: '#c4b5fd', adjust: { fade: 0.3, saturation: -0.15, exposure: 0.12, contrast: -0.15, tint: 0.1 } },
  kitty: { label: 'Kitty pink', swatch: '#f9a8d4', adjust: { tint: 0.3, exposure: 0.06, fade: 0.12, saturation: 0.08 }, highlight: [0.62, 0.5, 0.56], split: 0.25 },
  tealOrange: { label: 'Teal & orange', swatch: '#14b8a6', adjust: { saturation: 0.12, contrast: 0.12 }, shadow: TEAL, highlight: ORANGE, split: 0.6 },
  retro: {
    label: 'Retro',
    swatch: '#b45309',
    adjust: { fade: 0.2, temperature: 0.3, saturation: -0.22, vignette: 0.35 },
    shadow: [0.56, 0.48, 0.42],
    split: 0.3,
  },
  dreamy: { label: 'Dreamy', swatch: '#fde68a', adjust: { exposure: 0.12, fade: 0.18, saturation: 0.05, sharpen: 0, contrast: -0.1, highlights: 0.15 } },
  bw: { label: 'B&W', swatch: '#d4d4d8', adjust: { contrast: 0.2 }, bw: 1 },
  noir: { label: 'Noir', swatch: '#18181b', adjust: { contrast: 0.45, vignette: 0.5, exposure: -0.05, shadows: -0.15 }, bw: 1 },
};

export const FILTER_IDS = Object.keys(FILTERS) as FilterId[];

const NEUTRAL: RGB = [0.5, 0.5, 0.5];

/** Combined parameters for a clip's look (null = untouched, so the shader can skip all the maths). */
export function lookParams(look: Look | undefined): LookParams | null {
  if (!look) return null;
  const preset = FILTERS[look.filter] ?? FILTERS.none;
  const k = look.filter === 'none' ? 0 : Math.min(1, Math.max(0, look.amount));
  const out = {} as LookParams;
  let any = false;
  for (const key of ADJUST_KEYS) {
    const v = (preset.adjust[key] ?? 0) * k + (look.adjust[key] ?? 0);
    out[key] = v;
    if (v !== 0) any = true;
  }
  out.splitShadow = preset.shadow ?? NEUTRAL;
  out.splitHighlight = preset.highlight ?? NEUTRAL;
  out.split = (preset.split ?? 0) * k;
  out.bw = (preset.bw ?? 0) * k;
  if (out.split !== 0 || out.bw !== 0) any = true;
  return any ? out : null;
}

export function isNeutral(look: Look | undefined): boolean {
  return lookParams(look) === null;
}
