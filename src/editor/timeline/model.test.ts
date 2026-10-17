import { describe, expect, it } from 'vitest';
import {
  type Clip,
  type Project,
  clipStarts,
  createProject,
  duplicateClip,
  locate,
  moveClip,
  projectDuration,
  removeClip,
  setSpeed,
  splitAt,
  trimClip,
} from './model';

let counter = 0;
const id = () => `id${++counter}`;

function project(...clips: Array<[number, number, number?]>): Project {
  const p = createProject('t', 0);
  p.main = clips.map(([inSec, outSec, speed = 1], i): Clip => ({ id: `c${i}`, assetId: 'a', inSec, outSec, speed }));
  return p;
}

describe('timeline model', () => {
  it('computes duration with speed', () => {
    expect(projectDuration(project([0, 10], [0, 4, 2], [2, 3, 0.5]))).toBeCloseTo(10 + 2 + 2);
    expect(clipStarts(project([0, 10], [0, 4, 2], [0, 1]))).toEqual([0, 10, 12]);
  });

  it('locates clips and source time, cut belongs to the next clip', () => {
    const p = project([5, 15], [0, 4, 2]);
    expect(locate(p, 3)).toMatchObject({ index: 0, sourceSec: 8 });
    expect(locate(p, 10)).toMatchObject({ index: 1, sourceSec: 0 });
    expect(locate(p, 11)).toMatchObject({ index: 1, sourceSec: 2 });
    expect(locate(p, 99)).toMatchObject({ index: 1, sourceSec: 4 });
    expect(locate(createProject('e'), 0)).toBeNull();
  });

  it('splits at the playhead and keeps total duration', () => {
    const p = project([0, 10, 2]);
    const s = splitAt(p, 2, id);
    expect(s.main).toHaveLength(2);
    expect(s.main[0]).toMatchObject({ inSec: 0, outSec: 4, speed: 2 });
    expect(s.main[1]).toMatchObject({ inSec: 4, outSec: 10, speed: 2 });
    expect(projectDuration(s)).toBeCloseTo(projectDuration(p));
  });

  it('refuses to split right on a cut', () => {
    const p = project([0, 5], [0, 5]);
    expect(splitAt(p, 5, id)).toBe(p);
    expect(splitAt(p, 0.05, id)).toBe(p);
  });

  it('trims and clamps to asset bounds and minimum length', () => {
    const p = project([2, 8]);
    expect(trimClip(p, 'c0', 'in', -3, 10).main[0]).toMatchObject({ inSec: 0 });
    expect(trimClip(p, 'c0', 'in', 9, 10).main[0]?.inSec).toBeCloseTo(7.9);
    expect(trimClip(p, 'c0', 'out', 50, 10).main[0]).toMatchObject({ outSec: 10 });
    expect(trimClip(p, 'c0', 'out', 1, 10).main[0]?.outSec).toBeCloseTo(2.1);
  });

  it('ripple deletes and duplicates', () => {
    const p = project([0, 1], [0, 2], [0, 3]);
    expect(removeClip(p, 'c1').main.map((c) => c.id)).toEqual(['c0', 'c2']);
    const d = duplicateClip(p, 'c0', () => 'dup');
    expect(d.main.map((c) => c.id)).toEqual(['c0', 'dup', 'c1', 'c2']);
  });

  it('reorders clips', () => {
    const p = project([0, 1], [0, 2], [0, 3]);
    expect(moveClip(p, 0, 2).main.map((c) => c.id)).toEqual(['c1', 'c2', 'c0']);
    expect(moveClip(p, 2, 0).main.map((c) => c.id)).toEqual(['c2', 'c0', 'c1']);
    expect(moveClip(p, 1, 1)).toBe(p);
  });

  it('clamps speed', () => {
    const p = project([0, 1], [0, 1]);
    const s = setSpeed(p, new Set(['c0']), 10);
    expect(s.main[0]?.speed).toBe(4);
    expect(s.main[1]?.speed).toBe(1);
  });

  it('stays JSON-serializable', () => {
    const p = project([0, 1, 2]);
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
});
