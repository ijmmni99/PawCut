import { describe, expect, it } from 'vitest';
import { applyEdgeFades, renderSpeedResampled } from './resample';

const ramp = (n: number) => Float32Array.from({ length: n }, (_, i) => i);

describe('renderSpeedResampled', () => {
  it('copies 1:1 at equal rate and speed 1', () => {
    const out = [new Float32Array(4), new Float32Array(4)];
    renderSpeedResampled({ channels: [ramp(10)], sampleRate: 10, startSec: 0 }, out, 0, 4, 10, 0.2, 1);
    expect([...(out[0] as Float32Array)]).toEqual([2, 3, 4, 5]);
    expect([...(out[1] as Float32Array)]).toEqual([2, 3, 4, 5]); // mono duplicated
  });

  it('skips samples at 2x speed and interpolates at 0.5x', () => {
    const fast = [new Float32Array(3)];
    renderSpeedResampled({ channels: [ramp(10)], sampleRate: 10, startSec: 0 }, fast, 0, 3, 10, 0, 2);
    expect([...(fast[0] as Float32Array)]).toEqual([0, 2, 4]);
    const slow = [new Float32Array(3)];
    renderSpeedResampled({ channels: [ramp(10)], sampleRate: 10, startSec: 0 }, slow, 0, 3, 10, 0, 0.5);
    expect([...(slow[0] as Float32Array)]).toEqual([0, 0.5, 1]);
  });

  it('handles sample-rate conversion and source offset', () => {
    const out = [new Float32Array(2)];
    renderSpeedResampled({ channels: [ramp(10)], sampleRate: 20, startSec: 1 }, out, 1, 1, 10, 1.1, 1);
    expect([...(out[0] as Float32Array)]).toEqual([0, 2]);
  });

  it('leaves silence outside the decoded range', () => {
    const out = [new Float32Array(3)];
    renderSpeedResampled({ channels: [ramp(2)], sampleRate: 10, startSec: 0 }, out, 0, 3, 10, 0, 1);
    expect([...(out[0] as Float32Array)]).toEqual([0, 1, 0]);
  });
});

describe('applyEdgeFades', () => {
  it('fades both ends', () => {
    const ch = new Float32Array(6).fill(1);
    applyEdgeFades([ch], 0, 6, 2);
    expect([...ch]).toEqual([0, 0.5, 1, 1, 0.5, 0]);
  });
});
