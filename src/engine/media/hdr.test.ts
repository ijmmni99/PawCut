import { describe, expect, it } from 'vitest';
import { toSdr, transferCode } from './hdr';

describe('HDR → SDR', () => {
  it('detects transfer functions', () => {
    expect(transferCode({ transfer: 'hlg' })).toBe(1);
    expect(transferCode({ transfer: 'pq' })).toBe(2);
    expect(transferCode({ transfer: 'bt709' })).toBe(0);
    expect(transferCode(null)).toBe(0);
  });

  it('passes SDR through untouched', () => {
    expect(toSdr([0.2, 0.5, 0.9], 0)).toEqual([0.2, 0.5, 0.9]);
  });

  it('maps HLG reference white (75%) to near-white and black to black', () => {
    const white = toSdr([0.75, 0.75, 0.75], 1);
    for (const c of white) expect(c).toBeGreaterThan(0.9);
    expect(toSdr([0, 0, 0], 1)).toEqual([0, 0, 0]);
  });

  it('maps PQ 203 nits to near-white and never exceeds 1', () => {
    // PQ code value for 203 nits ≈ 0.58
    for (const c of toSdr([0.58, 0.58, 0.58], 2)) expect(c).toBeGreaterThan(0.9);
    for (const c of toSdr([1, 1, 1], 2)) expect(c).toBeLessThanOrEqual(1);
  });

  it('restores saturation lost by reading BT.2020 as BT.709', () => {
    // A muted HLG red should come out more saturated (larger channel spread) than the raw signal.
    const raw: [number, number, number] = [0.6, 0.35, 0.3];
    const out = toSdr(raw, 1);
    expect(out[0] - out[2]).toBeGreaterThan(raw[0] - raw[2]);
  });

  it('keeps mid-greys mid-grey (no blown-out picture)', () => {
    const mid = toSdr([0.5, 0.5, 0.5], 1)[0];
    expect(mid).toBeGreaterThan(0.45);
    expect(mid).toBeLessThan(0.85);
  });
});
