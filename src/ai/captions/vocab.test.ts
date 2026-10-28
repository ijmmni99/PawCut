import { describe, expect, it } from 'vitest';
import { applyFixes, buildPrompt, learnFixes } from './vocab';

describe('caption vocabulary', () => {
  it('learns word-for-word corrections, ignoring punctuation and case changes', () => {
    expect(learnFixes(['dia', 'ombut', 'semalam.'], ['dia', 'onboard', 'semalam!'])).toEqual({ ombut: 'onboard' });
    expect(learnFixes(['Jojo'], ['jojo'])).toEqual({});
    // Different word count: nothing to learn word-for-word.
    expect(learnFixes(['redol'], ['Red', 'Doll'])).toEqual({});
  });

  it('applies corrections whole-word, keeping punctuation', () => {
    const words = [{ text: 'Ombut,' }, { text: 'kombut' }, { text: '(ombut)' }];
    expect(applyFixes(words, { ombut: 'onboard' }).map((w) => w.text)).toEqual(['onboard,', 'kombut', '(onboard)']);
  });

  it('builds the prompt from the style sentence, the user words and learned words', () => {
    const p = buildPrompt('Jojo, Red Doll\nL&B Cattery', { ombut: 'onboard', jojo: 'Jojo' });
    expect(p).toMatch(/^Okay guys, hari ini/);
    expect(p).toContain('Jojo, Red Doll, L&B Cattery, onboard.');
    expect(p.match(/Jojo/g)).toHaveLength(1);
  });
});
