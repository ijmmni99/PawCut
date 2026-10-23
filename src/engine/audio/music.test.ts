import { describe, expect, it } from 'vitest';
import { SONGS, renderSong, songBeats, songDuration } from './music';

const SR = 22_050;

describe('built-in music', () => {
  it.each(SONGS.map((s) => [s.id, s] as const))('%s renders a clean, levelled, track', (_id, song) => {
    const [l, r] = renderSong(song, SR) as [Float32Array, Float32Array];
    expect(l.length).toBe(Math.ceil(songDuration(song) * SR));
    expect(songDuration(song)).toBeGreaterThan(55);
    let peak = 0;
    let sum = 0;
    let bad = 0;
    for (const ch of [l, r]) {
      for (const v of ch) {
        if (!Number.isFinite(v)) bad++;
        peak = Math.max(peak, Math.abs(v));
        sum += v * v;
      }
    }
    expect(bad).toBe(0);
    expect(peak).toBeCloseTo(0.89, 2);
    const rmsDb = 20 * Math.log10(Math.sqrt(sum / (2 * l.length)));
    expect(rmsDb).toBeGreaterThan(-22);
    expect(rmsDb).toBeLessThan(-12);
    expect(songBeats(song)[1]).toBeCloseTo(60 / song.bpm, 6);
  });

  it('is deterministic', () => {
    const song = SONGS[0]!;
    expect(renderSong(song, SR)[0]!.slice(20_000, 20_100)).toEqual(renderSong(song, SR)[0]!.slice(20_000, 20_100));
  });
});
