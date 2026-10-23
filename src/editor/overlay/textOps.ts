// Pure edits for text overlays and captions.
import { type Captions, type Project, type TextItem, type TextStyle, newId } from '../timeline/model';

/** Selection id meaning "the captions track". */
export const CAPTIONS_ID = 'captions';
export const MIN_TEXT_SEC = 0.3;

export const DEFAULT_TEXT_STYLE: TextStyle = {
  font: 'montserrat',
  size: 84,
  color: '#ffffff',
  outline: '#000000',
  shadow: true,
  box: null,
  glow: null,
  uppercase: false,
};

export function textsOf(p: Project): TextItem[] {
  return p.texts ?? [];
}

export function newTextItem(start: number, duration: number, text = 'Your text', makeId: () => string = newId): TextItem {
  return {
    id: makeId(),
    text,
    start,
    duration,
    x: 0.5,
    y: 0.38,
    scale: 1,
    rotation: 0,
    style: DEFAULT_TEXT_STYLE,
    animIn: 'pop',
    animOut: 'fade',
    loop: 'none',
  };
}

export function addText(p: Project, t: TextItem): Project {
  return { ...p, texts: [...textsOf(p), t] };
}

export function updateText(p: Project, id: string, patch: Partial<TextItem>): Project {
  return { ...p, texts: textsOf(p).map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

export function moveText(p: Project, id: string, start: number): Project {
  return updateText(p, id, { start: Math.max(0, start) });
}

/** Moves one edge to timeline time `t`, keeping at least MIN_TEXT_SEC. */
export function trimText(p: Project, id: string, edge: 'in' | 'out', t: number): Project {
  const item = textsOf(p).find((x) => x.id === id);
  if (!item) return p;
  const end = item.start + item.duration;
  if (edge === 'in') {
    const start = Math.min(Math.max(0, t), end - MIN_TEXT_SEC);
    return updateText(p, id, { start, duration: end - start });
  }
  return updateText(p, id, { duration: Math.max(MIN_TEXT_SEC, t - item.start) });
}

export function duplicateText(p: Project, id: string, makeId: () => string = newId): Project {
  const item = textsOf(p).find((x) => x.id === id);
  if (!item) return p;
  return addText(p, { ...item, id: makeId(), start: item.start + item.duration });
}

export function setCaptions(p: Project, captions: Captions | null): Project {
  if (captions) return { ...p, captions };
  const { captions: _drop, ...rest } = p;
  return rest;
}
