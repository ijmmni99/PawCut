import { describe, expect, it } from 'vitest';
import type { CaptionWord, Captions } from '../timeline/model';
import {
  activeWord,
  captionChunks,
  chunkWordTexts,
  defaultCaptions,
  emojiFor,
  isKeyword,
  joinWords,
  manualCaptions,
  mergeWithNext,
  setChunkText,
  splitBefore,
  tokenize,
} from './captions';

let n = 0;
const id = () => `w${n++}`;
function words(spec: string, start = 0, step = 0.4): CaptionWord[] {
  return spec.split(' ').map((text, i) => ({ id: id(), text, start: start + i * step, end: start + i * step + step * 0.9 }));
}
const texts = (c: Captions, k: number) => {
  const ch = captionChunks(c)[k];
  return ch ? c.words.slice(ch.first, ch.last + 1).map((w) => w.text).join(' ') : null;
};

describe('caption chunking', () => {
  it('Word Pop shows two words at a time', () => {
    const c = defaultCaptions(words('my cat loves the red ball'), 'english', 'wordPop');
    expect(captionChunks(c).map((ch) => ch.last - ch.first + 1)).toEqual([2, 2, 2]);
  });

  it('other presets fill lines up to maxChars × lines, and break on pauses and sentence ends', () => {
    const w = [...words('this is the first sentence.'), ...words('and another after', 2.2), ...words('a long pause here', 8)];
    const c = { ...defaultCaptions(w, 'english', 'boldOutline'), maxChars: 12, lines: 2 as const };
    const chunks = captionChunks(c);
    expect(chunks.map((_, k) => texts(c, k))).toEqual(['this is the first', 'sentence.', 'and another after', 'a long pause here']);
    expect(chunks[0]?.lines.length).toBe(2);
    // Captions never overlap and hold briefly through short gaps.
    for (let k = 1; k < chunks.length; k++) expect(chunks[k - 1]!.end).toBeLessThanOrEqual(chunks[k]!.start + 1e-9);
  });

  it('manual split / merge override the automatic grouping', () => {
    let c = { ...defaultCaptions(words('one two three four'), 'english', 'boldOutline'), maxChars: 30 };
    expect(captionChunks(c)).toHaveLength(1);
    c = splitBefore(c, 2);
    expect([texts(c, 0), texts(c, 1)]).toEqual(['one two', 'three four']);
    c = mergeWithNext(c, captionChunks(c), 0);
    expect(captionChunks(c)).toHaveLength(1);
  });

  it('karaoke highlights the word being spoken', () => {
    const c = defaultCaptions(words('hello there friend'), 'english', 'karaoke');
    const ch = captionChunks(c)[0]!;
    expect(activeWord(c, ch, 0.05)).toBe(0);
    expect(activeWord(c, ch, 0.5)).toBe(1);
    expect(activeWord(c, ch, 0.95)).toBe(2);
  });
});

describe('caption editing keeps timings', () => {
  it('same word count: texts change, times stay', () => {
    const c = { ...defaultCaptions(words('my kat is cute'), 'english', 'boldOutline'), maxChars: 30 };
    const next = setChunkText(c, captionChunks(c)[0]!, 'my cat is cute');
    expect(next.words.map((w) => w.text)).toEqual(['my', 'cat', 'is', 'cute']);
    expect(next.words.map((w) => w.start)).toEqual(c.words.map((w) => w.start));
  });

  it('different word count: re-spread over the same span, following captions untouched', () => {
    const c = { ...defaultCaptions([...words('hello world.'), ...words('next one', 3)], 'english', 'boldOutline'), maxChars: 30 };
    const [first] = captionChunks(c);
    const next = setChunkText(c, first!, 'hi there big world.', id);
    expect(texts(next, 0)).toBe('hi there big world.');
    expect(texts(next, 1)).toBe('next one');
    expect(next.words[0]!.start).toBeCloseTo(c.words[0]!.start);
    expect(next.words[3]!.end).toBeCloseTo(c.words[1]!.end);
  });
});

describe('words, emoji and keywords', () => {
  it('handles CJK without spaces', () => {
    expect(tokenize('我爱猫咪。')).toEqual(['我', '爱', '猫', '咪。']);
    expect(joinWords(['我', '爱', 'cats', '很', '多'])).toBe('我爱 cats 很多');
  });

  it('adds one emoji per caption and flags keywords', () => {
    expect(emojiFor('Cat!')).toBe('😺');
    expect(emojiFor('kucing')).toBe('😺');
    expect(emojiFor('table')).toBeNull();
    const c = defaultCaptions(words('cat and dog'), 'english', 'karaoke');
    expect(chunkWordTexts(c, captionChunks(c)[0]!)).toEqual(['cat 😺', 'and', 'dog']);
    expect(['FREE', 'RM50', '50%', 'adorable', 'kittens'].every(isKeyword)).toBe(true);
    expect(['the', 'and', 'because', 'cat'].map(isKeyword)).toEqual([false, false, false, true]);
  });

  it('manual captions: one caption per typed line across the span', () => {
    const c = manualCaptions('Meet Luna\nShe loves boxes', 0, 4);
    const chunks = captionChunks(c);
    expect(chunks.map((_, k) => texts(c, k))).toEqual(['Meet Luna', 'She loves boxes']);
    expect(c.words.at(-1)!.end).toBeCloseTo(4);
  });
});
