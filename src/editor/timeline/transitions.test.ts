import { describe, expect, it } from 'vitest';
import { lookParams } from '../../engine/render/looks';
import { type Clip, type Project, createProject } from './model';
import { TRANSITIONS, clipWindow, cutsWithTransitions, randomHype, setTransition, sourceTime, transitionAt } from './transitions';

const clip = (id: string, inSec: number, outSec: number, extra: Partial<Clip> = {}): Clip => ({ id, assetId: 'a', inSec, outSec, speed: 1, ...extra });

function project(...main: Clip[]): Project {
  return { ...createProject('t', 0), main };
}

describe('transitions', () => {
  it('has 25+ transitions with unique ids', () => {
    expect(TRANSITIONS.length).toBeGreaterThanOrEqual(25);
    expect(new Set(TRANSITIONS.map((t) => t.id)).size).toBe(TRANSITIONS.length);
  });

  it('centres the window on the cut and clamps the length to both clips', () => {
    const p = project(clip('a', 0, 4, { transition: { kind: 'dissolve', duration: 1 } }), clip('b', 0, 0.6), clip('c', 0, 3));
    const cuts = cutsWithTransitions(p);
    expect(cuts).toEqual([{ index: 0, time: 4, kind: 'dissolve', duration: 0.6 }]);
    expect(transitionAt(cuts, 3.69)).toBeNull();
    expect(transitionAt(cuts, 3.7)?.p).toBeCloseTo(0);
    expect(transitionAt(cuts, 4)?.p).toBeCloseTo(0.5);
    expect(transitionAt(cuts, 4.3)).toBeNull();
    // Clip b is on screen from mid-transition-in, the clip after it from its own start.
    expect(clipWindow(p, cuts, 0)).toEqual({ start: 0, from: 0, to: 4.3 });
    expect(clipWindow(p, cuts, 1)).toMatchObject({ from: 3.7, to: 4.6 });
  });

  it('ignores a transition on the last clip', () => {
    const p = project(clip('a', 0, 2), clip('b', 0, 2, { transition: { kind: 'flash', duration: 0.5 } }));
    expect(cutsWithTransitions(p)).toEqual([]);
  });

  it('maps timeline time to source time, holding edge frames without spare footage', () => {
    const c = clip('a', 2, 5, { speed: 2 });
    expect(sourceTime(c, 10, 11, 20)).toBe(4);
    expect(sourceTime(c, 10, 8, 20)).toBe(0); // before the file starts
    expect(sourceTime(c, 10, 30, 20)).toBeCloseTo(20 - 1 / 30);
  });

  it('sets, clears and randomises', () => {
    let p = project(clip('a', 0, 2), clip('b', 0, 2), clip('c', 0, 2));
    p = setTransition(p, new Set(['a', 'b']), { kind: 'spin', duration: 0.4 });
    expect(p.main.map((c) => c.transition?.kind)).toEqual(['spin', 'spin', undefined]);
    p = setTransition(p, new Set(['a']), null);
    expect('transition' in (p.main[0] as Clip)).toBe(false);
    const r = randomHype(p, 0.4, 42);
    expect(r.main[0]?.transition?.kind).not.toBe(r.main[1]?.transition?.kind);
    expect(r.main[2]?.transition).toBeUndefined();
  });
});

describe('looks', () => {
  it('neutral looks are skipped; presets scale with amount; sliders add', () => {
    expect(lookParams(undefined)).toBeNull();
    expect(lookParams({ filter: 'none', amount: 1, adjust: {} })).toBeNull();
    const warm = lookParams({ filter: 'warm', amount: 0.5, adjust: { exposure: 0.2 } });
    expect(warm?.temperature).toBeCloseTo(0.225);
    expect(warm?.exposure).toBeCloseTo(0.2);
    expect(lookParams({ filter: 'bw', amount: 1, adjust: {} })?.bw).toBe(1);
  });
});
