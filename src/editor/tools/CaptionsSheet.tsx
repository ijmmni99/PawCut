// Auto captions: Whisper transcription → styled, word-timed captions. Two taps from the toolbar (Captions → Generate).
// Once captions exist: one-tap style presets, position, line length, auto-emoji, and the transcript editor
// (edit text keeping timings, split, merge, delete).
import { useEffect, useMemo, useState } from 'react';
import { formatDuration } from '../../app/share';
import { Sheet } from '../../app/ui/Sheet';
import type { CaptionLanguage } from '../../ai/captions/protocol';
import { type CaptionQuality, saveQuality, savedQuality, speechSources, transcribe } from '../../ai/captions/transcribeClient';
import { applyFixes, buildPrompt, learnFixes, rememberFixes, saveWords, savedFixes, savedWords } from '../../ai/captions/vocab';
import {
  CAPTION_PRESETS,
  CAPTION_PRESET_IDS,
  type CaptionChunk,
  captionChunks,
  defaultCaptions,
  joinWords,
  manualCaptions,
  mergeWithNext,
  removeChunk,
  setChunkText,
  splitBefore,
  tokenize,
} from '../overlay/captions';
import { FONTS, loadFont } from '../overlay/fonts';
import { CAPTIONS_ID, setCaptions } from '../overlay/textOps';
import { useEditor, usePlayback } from '../store';
import { type CaptionPreset, type Captions, newId, projectDuration } from '../timeline/model';


type Job = { stage: 'download' | 'audio' | 'transcribe'; progress: number } | null;

function stageLabel(job: NonNullable<Job>): string {
  if (job.stage === 'download') return `Downloading speech model (first time only)… ${Math.round(job.progress * 100)}%`;
  if (job.stage === 'audio') return 'Reading audio…';
  return 'Listening…';
}

/** Fast = whisper-base (~80 MB); Best = whisper-small (~250 MB, about 3× slower, much better Malay). */
function QualityToggle({ value, onPick, disabled }: { value: CaptionQuality; onPick(q: CaptionQuality): void; disabled?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-800 p-1">
      {(
        [
          ['fast', 'Fast', '80 MB'],
          ['best', 'Best quality', '250 MB · slower'],
        ] as const
      ).map(([id, label, note]) => (
        <button
          key={id}
          type="button"
          disabled={disabled}
          onClick={() => onPick(id)}
          className={`flex min-h-11 flex-col items-center justify-center rounded-lg text-xs font-semibold ${value === id ? 'bg-zinc-100 text-black' : 'text-zinc-300'}`}
        >
          {label}
          <span className={`text-[10px] font-normal ${value === id ? 'text-zinc-600' : 'text-zinc-500'}`}>{note}</span>
        </button>
      ))}
    </div>
  );
}

function PresetChips({ value, onPick }: { value: CaptionPreset; onPick(p: CaptionPreset): void }) {
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {CAPTION_PRESET_IDS.map((id) => {
        const def = CAPTION_PRESETS[id];
        const font = FONTS[def.style.font];
        return (
          <button
            key={id}
            type="button"
            onClick={() => onPick(id)}
            className={`flex min-h-14 flex-col items-center justify-center rounded-xl px-1 ${value === id ? 'bg-zinc-100 text-black' : 'bg-zinc-800'}`}
          >
            <span
              style={{
                fontFamily: `"${font.family}"`,
                fontWeight: font.weight,
                color: id === 'keyword' ? '#eab308' : undefined,
                background: id === 'karaoke' ? '#FF2D87' : undefined,
              }}
              className="rounded px-1 text-sm leading-tight"
            >
              {def.style.uppercase ? 'AA' : 'Aa'}
            </span>
            <span className="mt-0.5 text-[10px] font-semibold">{def.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function CaptionsSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const captions = useEditor((s) => s.project?.captions ?? null);
  const [preset, setPreset] = useState<CaptionPreset>('wordPop');
  const [job, setJob] = useState<Job>(null);
  const [quality, setQuality] = useState<CaptionQuality>(savedQuality);
  const [vocab, setVocab] = useState(savedWords);
  const vocabField = (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      Words PawCut should know
      <input
        value={vocab}
        onChange={(e) => {
          setVocab(e.target.value);
          saveWords(e.target.value);
        }}
        placeholder="Names & English words you use: Jojo, Red Doll, onboard"
        aria-label="Words PawCut should know"
        className="min-h-10 rounded-lg bg-zinc-800 px-3 text-sm text-zinc-100"
      />
    </label>
  );
  const pickQuality = (q: CaptionQuality) => {
    setQuality(q);
    saveQuality(q);
  };
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');

  // Everything done in one visit is one undo step.
  useEffect(() => {
    if (!open) return;
    useEditor.getState().beginGesture();
    for (const id of ['montserrat', 'poppins', 'anton'] as const) void loadFont(id);
    return () => useEditor.getState().endGesture();
  }, [open]);

  const apply = (c: Captions | null) => useEditor.getState().apply((p) => setCaptions(p, c));

  const generate = async (keep?: Captions) => {
    const project = useEditor.getState().project;
    if (!project) return;
    setError(null);
    const sources = speechSources(project);
    if (sources.length === 0) {
      setError('No sound to listen to (clips are muted or have no audio). Type captions instead.');
      return;
    }
    setJob({ stage: 'download', progress: 0 });
    try {
      const lang: CaptionLanguage = 'malay';
      const fixes = savedFixes();
      const raw = await transcribe(sources, lang, quality, buildPrompt(vocab, fixes), (stage, progress) => setJob({ stage, progress }));
      const words = applyFixes(raw, fixes);
      if (words.length === 0) {
        setError("Couldn't hear any speech. Type captions instead.");
        return;
      }
      const base = defaultCaptions(
        words.map((w) => ({ id: newId(), ...w })),
        lang,
        keep?.preset ?? preset,
      );
      apply(keep ? { ...keep, words: base.words } : base);
      useEditor.getState().select([CAPTIONS_ID]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setJob(null);
    }
  };

  const addTyped = () => {
    const project = useEditor.getState().project;
    if (!project || !typed.trim()) return;
    apply(manualCaptions(typed, 0, projectDuration(project)));
    useEditor.getState().select([CAPTIONS_ID]);
    setTyping(false);
    setTyped('');
  };

  return (
    <Sheet open={open} onClose={onClose} title="Captions" dismissible={job === null}>
      {captions ? (
        <CaptionEditor
          captions={captions}
          onChange={apply}
          busy={job !== null}
          onRegenerate={() => void generate(captions)}
          quality={
            <>
              {vocabField}
              <QualityToggle value={quality} onPick={pickQuality} disabled={job !== null} />
            </>
          }
        />
      ) : (
        <div className="flex flex-col gap-3 pb-1">
          <PresetChips value={preset} onPick={setPreset} />
          {typing ? (
            <>
              <textarea
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                rows={4}
                placeholder={'One caption per line\nMeet Luna 😺\nShe loves boxes'}
                aria-label="Caption text"
                className="w-full rounded-xl bg-zinc-800 px-3 py-2 text-base"
              />
              <button type="button" onClick={addTyped} className="min-h-12 rounded-xl bg-pink-500 font-bold">
                Add captions
              </button>
            </>
          ) : (
            <>
              <QualityToggle value={quality} onPick={pickQuality} disabled={job !== null} />
              {vocabField}
              <button
                type="button"
                onClick={() => void generate()}
                disabled={job !== null}
                className="min-h-12 rounded-xl bg-pink-500 text-base font-bold disabled:opacity-60"
              >
                {job ? stageLabel(job) : 'Generate captions'}
              </button>
              {job && (
                <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full bg-pink-500 transition-[width]"
                    style={{ width: `${job.stage === 'download' ? job.progress * 100 : 100}%` }}
                  />
                </div>
              )}
              <button
                type="button"
                onClick={() => setTyping(true)}
                disabled={job !== null}
                className="min-h-11 rounded-xl bg-zinc-800 text-sm font-semibold disabled:opacity-40"
              >
                Type captions instead
              </button>
              <p className="text-[11px] text-zinc-500">
                Speech recognition runs on your phone. The model ({quality === 'best' ? '~250 MB' : '~80 MB'}) downloads once,
                then works offline. Use Wi-Fi and keep PawCut open the first time.
              </p>
            </>
          )}
          {error && <p className="rounded-xl bg-red-950 p-3 text-sm text-red-300">{error}</p>}
        </div>
      )}
      {captions && error && <p className="mt-2 rounded-xl bg-red-950 p-3 text-sm text-red-300">{error}</p>}
      {captions && job && <p className="mt-2 text-xs text-zinc-400">{stageLabel(job)}</p>}
    </Sheet>
  );
}

function CaptionEditor({
  captions,
  onChange,
  busy,
  onRegenerate,
  quality,
}: {
  captions: Captions;
  onChange(c: Captions | null): void;
  busy: boolean;
  onRegenerate(): void;
  /** Fast / Best toggle, shown next to Re-listen. */
  quality: React.ReactNode;
}) {
  const chunks = useMemo(() => captionChunks(captions), [captions]);
  const [splitting, setSplitting] = useState<number | null>(null);
  const set = (patch: Partial<Captions>) => onChange({ ...captions, ...patch });

  return (
    <div className="flex max-h-[60vh] flex-col gap-3 pb-1">
      <PresetChips value={captions.preset} onPick={(preset) => set({ preset })} />
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-zinc-800 p-1">
        {(['top', 'middle', 'bottom'] as const).map((pos) => (
          <button
            key={pos}
            type="button"
            onClick={() => set({ position: pos })}
            className={`min-h-9 rounded-lg text-xs font-semibold capitalize ${captions.position === pos ? 'bg-zinc-100 text-black' : 'text-zinc-300'}`}
          >
            {pos}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 text-xs">
        {([1, 2] as const).map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => set({ lines: n })}
            className={`min-h-9 rounded-lg px-3 font-semibold ${captions.lines === n ? 'bg-zinc-100 text-black' : 'bg-zinc-800'}`}
          >
            {n} line{n > 1 ? 's' : ''}
          </button>
        ))}
        <input
          type="range"
          min={8}
          max={28}
          value={captions.maxChars}
          onChange={(e) => set({ maxChars: Number(e.target.value) })}
          aria-label="Characters per line"
          className="min-w-0 flex-1 accent-pink-500"
        />
        <button
          type="button"
          onClick={() => set({ emoji: !captions.emoji })}
          className={`min-h-9 rounded-lg px-3 font-semibold ${captions.emoji ? 'bg-pink-500' : 'bg-zinc-800'}`}
        >
          😺 Emoji
        </button>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto rounded-xl bg-zinc-950/50">
        {chunks.map((ch: CaptionChunk, k) => {
          const words = captions.words.slice(ch.first, ch.last + 1);
          const text = joinWords(words.map((w) => w.text));
          return (
            <li key={`${words[0]?.id ?? k}-${text}`} className="border-b border-zinc-800 px-2 py-1.5">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => usePlayback.getState().setTime(ch.start + 0.01)}
                  className="w-12 shrink-0 text-left font-mono text-[11px] text-zinc-500"
                >
                  {formatDuration(ch.start, true)}
                </button>
                <input
                  defaultValue={text}
                  onBlur={(e) => {
                    if (e.target.value === text) return;
                    // A word-for-word fix ("ombut" → "onboard") is learned for next time and applied everywhere now.
                    const fixes = learnFixes(
                      words.map((x) => x.text),
                      tokenize(e.target.value),
                    );
                    rememberFixes(fixes);
                    const next = setChunkText(captions, ch, e.target.value);
                    onChange(Object.keys(fixes).length ? { ...next, words: applyFixes(next.words, fixes) } : next);
                  }}
                  aria-label={`Caption ${k + 1}`}
                  className="min-h-9 min-w-0 flex-1 rounded-lg bg-zinc-800 px-2 text-sm"
                />
                <button
                  type="button"
                  aria-label="Split"
                  onClick={() => setSplitting(splitting === k ? null : k)}
                  disabled={words.length < 2}
                  className="size-9 shrink-0 rounded-lg bg-zinc-800 text-sm disabled:opacity-30"
                >
                  ✂︎
                </button>
                <button
                  type="button"
                  aria-label="Merge with next"
                  onClick={() => onChange(mergeWithNext(captions, chunks, k))}
                  disabled={k === chunks.length - 1}
                  className="size-9 shrink-0 rounded-lg bg-zinc-800 text-sm disabled:opacity-30"
                >
                  ⤓
                </button>
                <button
                  type="button"
                  aria-label="Delete caption"
                  onClick={() => onChange(removeChunk(captions, ch))}
                  className="size-9 shrink-0 rounded-lg bg-zinc-800 text-sm"
                >
                  ✕
                </button>
              </div>
              {splitting === k && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  <span className="text-[11px] text-zinc-400">Start a new caption at:</span>
                  {words.slice(1).map((w, i) => (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() => {
                        onChange(splitBefore(captions, ch.first + i + 1));
                        setSplitting(null);
                      }}
                      className="min-h-8 rounded-full bg-pink-500/80 px-2.5 text-xs font-semibold"
                    >
                      {w.text}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {quality}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={onRegenerate} disabled={busy} className="min-h-11 rounded-xl bg-zinc-800 text-sm font-semibold disabled:opacity-40">
          Re-listen
        </button>
        <button
          type="button"
          onClick={() => {
            if (window.confirm('Remove all captions?')) onChange(null);
          }}
          className="min-h-11 rounded-xl bg-red-950 text-sm font-semibold text-red-300"
        >
          Remove captions
        </button>
      </div>
    </div>
  );
}
