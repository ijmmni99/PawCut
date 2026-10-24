// Second set of cute built-in tracks. Each is its own composition — different genre, meter, groove, harmony and
// instruments — not a variation of one recipe. Notes are MIDI numbers (C4 = 60); times are beats.
import type { Song } from './music';

/** [beat within bar, midi note, length in beats] */
type Note = [number, number, number];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

// ---- 1. Music Box Nap — 3/4 lullaby waltz: music box melody, harp-like nylon, soft upright, a glock reply ----

const musicBoxNap: Song = {
  id: 'music-box-nap',
  title: 'Music Box Nap',
  bpm: 84,
  bars: 29,
  meter: 3,
  mood: 'Calm',
  tags: ['cute', 'chill'],
  compose(s) {
    // E♭ – Cm – A♭ – B♭ (A), then a B section that wanders through A♭ B♭ Gm Cm A♭ Fm B♭ B♭7.
    const A = { chords: [[63, 67, 70], [60, 63, 67], [56, 60, 63], [58, 62, 65]], roots: [39, 36, 44, 46] };
    const B = {
      chords: [[56, 60, 63], [58, 62, 65], [55, 58, 62], [60, 63, 67], [56, 60, 63], [53, 56, 60], [58, 62, 65], [58, 62, 68]],
      roots: [44, 46, 43, 48, 44, 41, 46, 46],
    };
    const tuneA: Note[][] = [
      [[0, 67, 1], [1, 70, 1], [2, 75, 1]],
      [[0, 74, 2], [2, 72, 1]],
      [[0, 72, 1], [1, 75, 1], [2, 79, 1]],
      [[0, 77, 2], [2, 74, 1]],
    ];
    const cadence: Note[] = [[0, 77, 1.5], [1.5, 75, 0.5], [2, 74, 1]];
    const tuneB: Note[][] = [
      [[0, 72, 3]],
      [[0, 74, 1], [1, 77, 1], [2, 74, 1]],
      [[0, 70, 3]],
      [[0, 72, 1], [1, 75, 1], [2, 79, 1]],
      [[0, 80, 2], [2, 79, 1]],
      [[0, 77, 2], [2, 75, 1]],
      [[0, 74, 3]],
      [[0, 74, 1], [1, 77, 1], [2, 80, 1]],
    ];
    for (let bar = 0; bar < 28; bar++) {
      const inB = bar >= 12 && bar < 20;
      const k = inB ? bar - 12 : bar % 4;
      const ch = (inB ? B.chords[k] : A.chords[k]) as number[];
      const root = (inB ? B.roots[k] : A.roots[k]) as number;
      const b0 = bar * 3;
      // Oom-pah-pah: bass on 1, harp chord on 2 and 3.
      if (bar >= 4) s.upright(b0, root, 1, 0.22);
      if (bar >= 2) {
        ch.forEach((m, i) => s.nylon(b0 + 1, m + 12, 0.05, (i - 1) * 0.3, i * 0.012));
        ch.forEach((m, i) => s.nylon(b0 + 2, m + 12, 0.04, (i - 1) * 0.3, i * 0.012));
      }
      const notes = inB ? (tuneB[k] as Note[]) : bar % 8 === 7 || bar === 27 ? cadence : (tuneA[k] as Note[]);
      s.phrase(bar, notes, (b, m) => s.musicBox(b, m + 12, 0.15));
      // The glock answers the music box in the last A.
      if (bar >= 20) s.phrase(bar, notes, (b, m) => s.glock(b + 1.5, m + 24, 0.035, -0.3));
      if (bar >= 12) s.pad(b0, ch, 3, 0.012, 900);
    }
    const end = 28 * 3;
    [51, 58, 63, 67, 70, 75].forEach((m, i) => s.nylon(end + i * 0.12, m + 12, 0.06, (i / 5 - 0.5) * 0.6));
    s.musicBox(end + 0.75, 87, 0.15);
    s.upright(end, 39, 3, 0.2);
  },
};

// ---- 2. Pixel Kitten — 8-bit chiptune: square lead, 32nd arps, triangle bass, noise drums, key change ----

const pixelKitten: Song = {
  id: 'pixel-kitten',
  title: 'Pixel Kitten',
  bpm: 150,
  bars: 38,
  mood: 'Playful',
  tags: ['cute', 'funny'],
  compose(s) {
    // E – C♯m – A – B  /  A – B – G♯m – C♯m
    const A = { chords: [[64, 68, 71], [61, 64, 68], [57, 61, 64], [59, 63, 66]], roots: [40, 37, 45, 47] };
    const B = { chords: [[57, 61, 64], [59, 63, 66], [56, 59, 63], [61, 64, 68]], roots: [45, 47, 44, 37] };
    const tuneA: Note[][] = [
      [[0, 76, 0.5], [0.5, 80, 0.5], [1, 83, 0.5], [1.5, 80, 0.5], [2, 88, 1], [3, 83, 1]],
      [[0, 85, 0.75], [0.75, 83, 0.25], [1, 80, 1], [2, 76, 0.5], [2.5, 80, 0.5], [3, 85, 1]],
      [[0, 81, 0.5], [0.5, 85, 0.5], [1, 88, 1], [2, 86, 0.5], [2.5, 85, 0.5], [3, 81, 1]],
      [[0, 83, 1.5], [1.5, 81, 0.5], [2, 80, 0.5], [2.5, 78, 0.5], [3, 75, 1]],
    ];
    const tuneB: Note[][] = [
      [[0, 85, 2], [2, 83, 1], [3, 81, 1]],
      [[0, 83, 2], [2, 85, 1], [3, 86, 1]],
      [[0, 88, 1.5], [1.5, 86, 0.5], [2, 85, 1], [3, 83, 1]],
      [[0, 80, 3], [3, 83, 1]],
    ];
    const lift: Note[] = [[0, 83, 1], [1, 86, 1], [2, 90, 2]];
    for (let bar = 0; bar < 36; bar++) {
      const inB = bar >= 12 && bar < 20;
      const up = bar >= 28 ? 2 : 0; // key change for the last chorus
      const k = bar % 4;
      const ch = ((inB ? B : A).chords[k] as number[]).map((m) => m + up);
      const root = ((inB ? B : A).roots[k] as number) + up;
      const b0 = bar * 4;
      if (bar < 4 || inB) s.chipArp(b0, [...ch, ch[0]! + 12].map((m) => m + 12), 4, bar < 4 ? 0.03 : 0.022);
      if (bar >= 4) {
        for (let i = 0; i < 8; i++) s.triBass(b0 + i / 2, root + (i % 2 ? 12 : 0), 0.45, 0.28);
        s.chipDrum(b0, 'kick', 0.5);
        s.chipDrum(b0 + 2, 'kick', 0.5);
        s.chipDrum(b0 + 1, 'snare', 0.22);
        s.chipDrum(b0 + 3, 'snare', 0.22);
        for (let i = 0; i < 8; i++) s.chipDrum(b0 + i / 2, 'hat', i % 2 ? 0.06 : 0.09);
        const notes = inB ? (bar === 19 ? lift : (tuneB[k] as Note[])) : (tuneA[k] as Note[]);
        s.phrase(bar, notes, (b, m, l) => s.chip(b, m + up, l, 0.06));
        // Echo a third below in the last chorus.
        if (bar >= 28) s.phrase(bar, notes, (b, m, l) => s.chip(b + 0.25, m + up - 4, l, 0.025, -0.35));
      }
      if (bar === 27) for (let i = 0; i < 8; i++) s.chipDrum(b0 + 2 + i / 4, 'snare', 0.12 + i * 0.02);
    }
    // Level-clear fanfare.
    const end = 36 * 4;
    [76, 80, 83, 88, 92].forEach((m, i) => s.chip(end + i * 0.25, m + 2, 0.25, 0.06));
    s.chip(end + 1.25, 90, 2, 0.07);
    s.triBass(end, 42, 2, 0.3);
    s.chipDrum(end, 'kick', 0.5);
  },
};

// ---- 3. Paw Bossa — bossa nova: nylon comping, root–fifth bass, clave rim, shaker, airy flute melody ----

const pawBossa: Song = {
  id: 'paw-bossa',
  title: 'Paw Bossa',
  bpm: 132,
  bars: 33,
  mood: 'Calm',
  tags: ['cute', 'chill'],
  compose(s) {
    // Fmaj7 Fmaj7 Gm7 C7 Am7 D7 Gm7 C7
    const chords = [
      [53, 57, 60, 64],
      [53, 57, 60, 64],
      [55, 58, 62, 65],
      [52, 55, 58, 64],
      [57, 60, 64, 67],
      [54, 57, 60, 62],
      [55, 58, 62, 65],
      [52, 55, 58, 61],
    ];
    const roots = [41, 41, 43, 36, 45, 38, 43, 36];
    const fifths = [48, 48, 50, 43, 52, 45, 50, 43];
    const tune: Note[][] = [
      [[0, 72, 1.5], [1.5, 69, 0.5], [2, 76, 2]],
      [[0, 74, 1], [1, 72, 1], [2, 69, 2]],
      [[0, 70, 1.5], [1.5, 74, 0.5], [2, 77, 2]],
      [[0, 76, 1], [1, 74, 1], [2, 70, 1], [3, 72, 1]],
      [[0, 72, 1.5], [1.5, 76, 0.5], [2, 79, 2]],
      [[0, 78, 1], [1, 76, 1], [2, 74, 1], [3, 72, 1]],
      [[0, 70, 1.5], [1.5, 74, 0.5], [2, 72, 1], [3, 70, 1]],
      [[0, 69, 2], [2, 67, 1], [3, 64, 1]],
    ];
    const comp = [[0, 1.5, 3], [1, 2.5, 3.5]];
    const clave = [[0, 1.5, 3], [1, 2]];
    for (let bar = 0; bar < 32; bar++) {
      const k = bar % 8;
      const ch = chords[k] as number[];
      const b0 = bar * 4;
      for (const beat of comp[bar % 2] as number[]) ch.forEach((m, i) => s.nylon(b0 + beat, m, 0.07, (i - 1.5) * 0.15, i * 0.008));
      s.upright(b0, roots[k] as number, 1.5, 0.28);
      s.upright(b0 + 1.5, fifths[k] as number, 0.5, 0.22);
      s.upright(b0 + 2, roots[k] as number, 1.5, 0.26);
      s.upright(b0 + 3.5, fifths[k] as number, 0.5, 0.22);
      for (const beat of clave[bar % 2] as number[]) s.rim(b0 + beat, 0.12);
      for (let i = 0; i < 8; i++) s.shaker(b0 + i / 2, i % 2 ? 0.045 : 0.025, 0.3);
      s.kick(b0, 0.35);
      s.kick(b0 + 2, 0.3);
      if (bar >= 8) {
        const octave = bar >= 16 && bar < 24 ? 12 : 0;
        s.phrase(bar, tune[k] as Note[], (b, m, l) => s.whistle(b, m + octave, l, bar >= 24 ? 0.07 : 0.1));
        if (octave) {
          s.phrase(bar, tune[k] as Note[], (b, m) => s.glock(b, m + 12, 0.03, -0.25));
          s.pad(b0, ch.map((m) => m + 12), 4, 0.012, 1100);
        }
      }
    }
    const end = 32 * 4;
    [41, 53, 57, 60, 64, 67].forEach((m, i) => s.nylon(end + i * 0.1, m, 0.07, (i / 5 - 0.5) * 0.5));
    s.glock(end + 0.5, 91, 0.05);
    s.upright(end, 41, 3, 0.26);
  },
};

// ---- 4. Bouncy Boba — ska: offbeat organ + guitar skanks, walking bass, brassy lead with harmony ----

const bouncyBoba: Song = {
  id: 'bouncy-boba',
  title: 'Bouncy Boba',
  bpm: 156,
  bars: 40,
  mood: 'Energetic',
  tags: ['cute', 'funny'],
  compose(s) {
    // B♭ E♭ F B♭  /  Gm E♭ F F
    const A = { chords: [[58, 62, 65], [55, 58, 63], [57, 60, 65], [58, 62, 65]], roots: [46, 39, 41, 46] };
    const B = { chords: [[55, 58, 62], [55, 58, 63], [57, 60, 65], [57, 60, 63]], roots: [43, 39, 41, 41] };
    const tuneA: Note[][] = [
      [[0, 70, 0.5], [0.5, 74, 0.5], [1, 77, 1], [2.5, 77, 0.5], [3, 79, 1]],
      [[0, 79, 0.5], [0.5, 77, 0.5], [1, 75, 1], [2, 79, 1.5], [3.5, 82, 0.5]],
      [[0, 81, 1], [1, 79, 0.5], [1.5, 77, 0.5], [2, 77, 1], [3, 74, 1]],
      [[0, 74, 0.5], [0.5, 77, 0.5], [1, 82, 1.5], [3, 77, 1]],
    ];
    const tuneB: Note[][] = [
      [[0, 79, 1.5], [1.5, 77, 0.5], [2, 74, 2]],
      [[0, 75, 1], [1, 77, 1], [2, 79, 2]],
      [[0, 81, 0.5], [0.5, 82, 0.5], [1, 81, 0.5], [1.5, 79, 0.5], [2, 77, 2]],
      [[0, 72, 1], [1, 74, 1], [2, 76, 1], [3, 77, 1]],
    ];
    const walk = (root: number) => [root, root + 4, root + 7, root + 9];
    for (let bar = 0; bar < 39; bar++) {
      const inB = (bar >= 12 && bar < 20) || (bar >= 28 && bar < 36);
      const k = bar % 4;
      const sec = inB ? B : A;
      const ch = sec.chords[k] as number[];
      const b0 = bar * 4;
      // Skank on every offbeat.
      for (const off of [0.5, 1.5, 2.5, 3.5]) {
        s.organ(b0 + off, ch, 0.3, 0.035);
        ch.forEach((m) => s.pluck(b0 + off, m + 12, 0.25, 0.04, 0.35, 3000));
      }
      if (bar >= 2) {
        walk(sec.roots[k] as number).forEach((m, i) => s.upright(b0 + i, m, 1, 0.3));
        s.kick(b0, 0.7);
        s.kick(b0 + 2, 0.6);
        s.snare(b0 + 1, 0.35);
        s.snare(b0 + 3, 0.35);
        for (let i = 0; i < 4; i++) s.hat(b0 + i, 0.1);
      } else {
        for (let i = 0; i < 4; i++) s.rim(b0 + i, 0.15);
      }
      if (bar >= 4 && bar < 36) {
        const notes = (inB ? tuneB : tuneA)[k] as Note[];
        s.phrase(bar, notes, (b, m, l) => s.brass(b, m, l, 0.065));
        // Second time round the horns harmonise a third below.
        if (bar >= 20) s.phrase(bar, notes, (b, m, l) => s.brass(b, m - (m % 12 === 5 || m % 12 === 10 ? 4 : 3), l, 0.035, -0.3));
      }
      if (bar === 36 || bar === 37) s.phrase(bar, tuneA[bar - 34] as Note[], (b, m, l) => s.brass(b, m, l, 0.06));
      if (bar === 11 || bar === 27) for (let i = 0; i < 4; i++) s.snare(b0 + 2 + i / 2, 0.25 + i * 0.05);
    }
    // "Ta-daa!"
    const end = 39 * 4;
    s.brass(end, 82, 0.5, 0.07);
    s.organ(end, [58, 62, 65, 70], 0.4, 0.05);
    s.brass(end + 1, 82, 2.5, 0.07);
    s.brass(end + 1, 77, 2.5, 0.04, -0.3);
    s.upright(end, 34, 2, 0.3);
    s.kick(end, 0.8);
    s.crash(end + 1, 0.2);
  },
};

// ---- 5. Kawaii Sparkle — future bass: sparkly intro, build + snare roll, supersaw drop with vocal chops ----

const kawaiiSparkle: Song = {
  id: 'kawaii-sparkle',
  title: 'Kawaii Sparkle',
  bpm: 150,
  bars: 38,
  mood: 'Energetic',
  tags: ['cute', 'hype'],
  compose(s) {
    // Dmaj7 – E6 – C♯m7 – F♯m9 (A major)
    const chords = [[62, 66, 69, 73], [64, 68, 71, 73], [61, 64, 68, 71], [66, 69, 73, 76]];
    const roots = [38, 40, 37, 42];
    const chop: Note[][] = [
      [[0, 81, 0.5], [0.75, 81, 0.25], [1, 83, 0.5], [1.5, 85, 1], [3, 81, 0.5]],
      [[0, 83, 0.5], [0.5, 85, 0.5], [1, 88, 1], [2.5, 85, 0.5], [3, 83, 1]],
      [[0, 80, 0.5], [0.75, 80, 0.25], [1, 81, 0.5], [1.5, 83, 1], [3, 80, 0.5]],
      [[0, 78, 1.5], [1.5, 81, 0.5], [2, 80, 1], [3, 76, 1]],
    ];
    const stabs = [0, 0.75, 1.5, 2.5, 3, 3.5];
    const isDrop = (bar: number) => (bar >= 16 && bar < 24) || (bar >= 28 && bar < 36);
    const r = rng(11);
    for (let bar = 0; bar < 36; bar++) {
      const k = bar % 4;
      const ch = chords[k] as number[];
      const b0 = bar * 4;
      const drop = isDrop(bar);
      const build = bar >= 8 && bar < 16;
      const brk = bar >= 24 && bar < 28;
      // Sparkles: random chord tones high up on the glock.
      if (!drop) for (let i = 0; i < 8; i++) if (r() < 0.6) s.glock(b0 + i / 2, (ch[Math.floor(r() * 4)] as number) + 24, 0.03, r() - 0.5);
      if (!drop) s.pad(b0, ch, 4, build ? 0.02 : 0.016, 1200 + (build ? (bar - 8) * 300 : 0));
      if (bar >= 4 && !drop) s.phrase(bar, chop[k] as Note[], (b, m, l) => s.ooh(b, m, l, brk ? 0.1 : 0.07));
      if (build) {
        s.kick(b0, 0.5);
        s.snare(b0 + 2, 0.25);
        const per = bar < 12 ? 2 : 4;
        for (let i = 0; i < 4 * per; i++) s.hat(b0 + i / per, 0.06);
        if (bar === 15) for (let i = 0; i < 16; i++) s.snare(b0 + i / 4, 0.1 + i * 0.02);
      }
      if (bar === 14) s.riser(b0, 8, 0.25);
      if (drop) {
        for (const st of stabs) s.supersaw(b0 + st, ch, 0.6, 0.026);
        s.bass(b0, roots[k] as number, 2.5, 0.38);
        s.bass(b0 + 2.5, roots[k] as number, 1.5, 0.32);
        // Half-time drums with trap hats and a roll every other bar.
        s.kick(b0, 1);
        s.kick(b0 + 2.5, 0.8);
        s.clap(b0 + 2, 0.5);
        s.snare(b0 + 2, 0.3);
        const roll = bar % 2 === 1;
        for (let i = 0; i < 8; i++) s.hat(b0 + i / 2, i % 2 ? 0.07 : 0.1);
        if (roll) for (let i = 0; i < 8; i++) s.hat(b0 + 3 + i / 8, 0.05 + i * 0.005);
        s.phrase(bar, chop[k] as Note[], (b, m, l) => s.ooh(b, m + 12, l, 0.07, 0.15));
        if (bar === 16 || bar === 28) s.crash(b0, 0.25);
      }
      if (brk && bar === 27) s.riser(b0, 4, 0.2);
    }
    s.pump(16 * 4, 24 * 4, 0.8);
    s.pump(28 * 4, 36 * 4, 0.8);
    const end = 36 * 4;
    s.supersaw(end, [57, 61, 64, 69], 3, 0.03, 2500);
    s.glock(end, 93, 0.06);
    s.glock(end + 0.5, 97, 0.05);
    s.bass(end, 33, 2, 0.35);
    s.kick(end, 1);
    s.crash(end, 0.25);
  },
};

// ---- 6. Toe Beans Swing — small-band swing: walking upright, brushes + ride, Charleston piano, vibes head ----

const toeBeansSwing: Song = {
  id: 'toe-beans-swing',
  title: 'Toe Beans Swing',
  bpm: 126,
  bars: 33,
  mood: 'Playful',
  tags: ['cute', 'funny'],
  compose(s) {
    // Gmaj7 Em7 Am7 D7 Bm7 E7 Am7 D7 — swung eighths (the "and" lands two-thirds through the beat).
    const SW = 2 / 3;
    const voicings = [[59, 62, 66], [59, 62, 67], [60, 64, 67], [60, 64, 66], [62, 66, 69], [62, 66, 68], [60, 64, 67], [60, 64, 66]];
    const walks = [
      [43, 47, 50, 51],
      [52, 50, 47, 44],
      [45, 48, 52, 49],
      [50, 54, 57, 46],
      [47, 50, 54, 51],
      [52, 56, 59, 46],
      [45, 48, 52, 49],
      [50, 54, 45, 42],
    ];
    const head: Note[][] = [
      [[0, 71, SW], [SW, 74, 1 - SW], [1, 78, 1], [2, 79, SW], [2 + SW, 78, 1 - SW], [3, 74, 1]],
      [[0, 76, 1 + SW], [1 + SW, 74, 1 - SW], [2, 71, 2]],
      [[0, 72, SW], [SW, 76, 1 - SW], [1, 79, 1], [2, 81, SW], [2 + SW, 79, 1 - SW], [3, 76, 1]],
      [[0, 78, 1], [1, 76, SW], [1 + SW, 74, 1 - SW], [2, 72, 2]],
      [[0, 74, SW], [SW, 78, 1 - SW], [1, 81, 1], [2, 83, 1], [3, 81, 1]],
      [[0, 80, 1 + SW], [1 + SW, 78, 1 - SW], [2, 76, 2]],
      [[0, 76, SW], [SW, 79, 1 - SW], [1, 84, 1], [2, 83, SW], [2 + SW, 81, 1 - SW], [3, 79, 1]],
      [[0, 78, 1], [1, 72, SW], [1 + SW, 74, 1 - SW], [2, 74, 1], [3, 78, 1]],
    ];
    const scale = [67, 69, 71, 74, 76, 79, 81, 83];
    const r = rng(5);
    for (let bar = 0; bar < 32; bar++) {
      // Intro = the last four bars of the form.
      const k = bar < 4 ? bar + 4 : (bar - 4) % 8;
      const b0 = bar * 4;
      (walks[k] as number[]).forEach((m, i) => s.upright(b0 + i, m, 1, 0.3));
      // Charleston comping.
      s.keys(b0, voicings[k] as number[], 1, 0.06);
      s.keys(b0 + 1 + SW, voicings[k] as number[], 0.5, 0.05);
      // Ride: ding, ding-a, ding, ding-a; brushes on 2 and 4; feathered kick.
      for (const beat of [0, 1, 1 + SW, 2, 3, 3 + SW]) s.ride(b0 + beat, beat % 1 ? 0.04 : 0.06);
      s.brush(b0 + 1, 0.08);
      s.brush(b0 + 3, 0.08);
      s.brush(b0, 0.04, true);
      s.brush(b0 + 2, 0.04, true);
      for (let i = 0; i < 4; i++) s.kick(b0 + i, 0.18);
      const headBar = (bar >= 4 && bar < 12) || (bar >= 20 && bar < 28);
      if (headBar) {
        s.phrase(bar, head[k] as Note[], (b, m, l) => s.vibes(b, m, l, 0.14));
        if (bar >= 20) s.phrase(bar, head[k] as Note[], (b, m) => s.marimba(b, m - 12, 0.08, -0.3));
      } else if (bar >= 12 && bar < 20) {
        // A little toy-piano solo over the changes.
        for (let e = 0; e < 8; e++) {
          if (r() < 0.55) {
            const beat = Math.floor(e / 2) + (e % 2 ? SW : 0);
            s.toyPiano(b0 + beat, scale[Math.floor(r() * scale.length)] as number, 0.6, 0.09, 0.2);
          }
        }
      } else if (bar >= 28) {
        // Tag: the last phrase again, softer.
        s.phrase(bar, head[k] as Note[], (b, m, l) => s.vibes(b, m, l, 0.1));
      }
    }
    // Shave-and-a-haircut… two bits!
    const end = 32 * 4;
    s.vibes(end, 79, 1, 0.13);
    s.keys(end, [59, 62, 66, 69], 2, 0.06);
    s.upright(end, 43, 1, 0.3);
    s.vibes(end + 2, 74, 0.5, 0.12);
    s.vibes(end + 3, 79, 1, 0.14);
    s.upright(end + 3, 43, 1, 0.3);
    s.kick(end + 3, 0.4);
    s.ride(end + 3, 0.1);
  },
};

export const CUTE_SONGS: Song[] = [musicBoxNap, pixelKitten, pawBossa, bouncyBoba, kawaiiSparkle, toeBeansSwing];
