import { describe, expect, it } from 'vitest';
import type { SpeechSource, TimedWord } from './protocol';
import { cleanWords, placeWords, sourceRanges, speechRegions } from './speech';

const w = (text: string, start: number, end = start + 0.3): TimedWord => ({ text, start, end });

describe('speech helpers', () => {
  it('merges the used parts of a file with context', () => {
    expect(sourceRanges([{ inSec: 10, outSec: 12 }, { inSec: 3, outSec: 4 }, { inSec: 14, outSec: 15 }, { inSec: 40, outSec: 41 }])).toEqual([
      { from: 2, to: 5 },
      { from: 9, to: 16 },
      { from: 39, to: 42 },
    ]);
  });

  it('finds speech between quiet stretches', () => {
    const sr = 16_000;
    const audio = new Float32Array(sr * 6);
    let seed = 1;
    for (let i = 0; i < audio.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const t = i / sr;
      const noise = ((seed / 0x7fffffff) * 2 - 1) * 0.002;
      const voiced = (t > 1 && t < 2.2) || (t > 4 && t < 5) ? 0.3 * Math.sin(2 * Math.PI * 180 * t) : 0;
      audio[i] = noise + voiced;
    }
    const regions = speechRegions(audio, sr);
    expect(regions).toHaveLength(2);
    expect(regions[0]!.from).toBeGreaterThan(0.6);
    expect(regions[0]!.to).toBeLessThan(2.7);
    expect(regions[1]!.from).toBeGreaterThan(3.5);
    // Silence alone: nothing to transcribe.
    expect(speechRegions(new Float32Array(sr * 3), sr)).toEqual([]);
  });

  it('drops Whisper outro hallucinations and loops', () => {
    const words = [
      w('Hello', 0),
      w('semua,', 0.4),
      w('Terima', 1),
      w('kasih', 1.3),
      w('kerana', 1.6),
      w('menonton!', 1.9),
      w('ini', 3),
      w('Jojo', 3.3),
      w('Jojo', 3.6),
      w('dia', 4),
      w('comel', 4.3),
      w('dia', 4.6),
      w('comel', 4.9),
      w('Thanks', 6),
      w('for', 6.2),
      w('watching.', 6.4),
    ];
    expect(cleanWords(words).map((x) => x.text)).toEqual(['Hello', 'semua,', 'ini', 'Jojo', 'dia', 'comel']);
    // "terima kasih" on its own is a real phrase and stays.
    expect(cleanWords([w('Terima', 0), w('kasih', 0.3), w('Jojo', 0.6)]).map((x) => x.text)).toEqual(['Terima', 'kasih', 'Jojo']);
  });

  it('places words on every clip that shows them', () => {
    const clips: SpeechSource[] = [
      { path: 'a', inSec: 10, outSec: 12, timelineStart: 0, speed: 1 },
      { path: 'a', inSec: 11, outSec: 13, timelineStart: 5, speed: 2 },
    ];
    const placed = placeWords([w('one', 10.2, 10.6), w('two', 11.4, 11.8), w('three', 14, 14.3)], clips);
    expect(placed.map((x) => [x.text, +x.start.toFixed(2)])).toEqual([
      ['one', 0.2],
      ['two', 1.4],
      ['two', 5.2],
    ]);
  });
});
