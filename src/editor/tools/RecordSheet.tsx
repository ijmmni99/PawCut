import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '../../app/share';
import { Sheet } from '../../app/ui/Sheet';
import { addAudio } from '../../library/audioLibrary';
import { useEditor, usePlayback } from '../store';
import { addAudioClip } from '../timeline/audio';
import { newId } from '../timeline/model';

export type RecordControls = {
  /** Start timeline playback from the playhead (inside the record tap). */
  play(): void;
  pause(): void;
  setMuted(muted: boolean): void;
};

function pickMime(): string {
  for (const m of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

/**
 * Voiceover: records the mic while the timeline plays from the playhead, then drops the take on the Voice track at
 * the point where recording started. Video sound is muted by default so the mic doesn't pick it up.
 */
export function RecordSheet({ open, onClose, controls }: { open: boolean; onClose(): void; controls: RecordControls }) {
  const [state, setState] = useState<'asking' | 'ready' | 'recording' | 'saving' | 'error'>('asking');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [muteVideo, setMuteVideo] = useState(true);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startAt = useRef(0);
  const meter = useRef<{ ctx: AudioContext; raf: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setState('asking');
    navigator.mediaDevices
      ?.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then((s) => {
        if (!alive) {
          for (const t of s.getTracks()) t.stop();
          return;
        }
        stream.current = s;
        setState('ready');
        // Level meter.
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(s).connect(analyser);
        const data = new Float32Array(analyser.fftSize);
        const tick = () => {
          analyser.getFloatTimeDomainData(data);
          let peak = 0;
          for (const v of data) peak = Math.max(peak, Math.abs(v));
          setLevel(peak);
          if (meter.current) meter.current.raf = requestAnimationFrame(tick);
        };
        meter.current = { ctx, raf: requestAnimationFrame(tick) };
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : 'Microphone not available');
        setState('error');
      });
    return () => {
      alive = false;
      if (meter.current) {
        cancelAnimationFrame(meter.current.raf);
        void meter.current.ctx.close();
        meter.current = null;
      }
      for (const t of stream.current?.getTracks() ?? []) t.stop();
      stream.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (state !== 'recording') return;
    const started = performance.now();
    const id = window.setInterval(() => setElapsed((performance.now() - started) / 1000), 100);
    return () => window.clearInterval(id);
  }, [state]);

  const start = () => {
    const s = stream.current;
    if (!s) return;
    const mime = pickMime();
    const rec = new MediaRecorder(s, mime ? { mimeType: mime } : undefined);
    chunks.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.current.push(e.data);
    };
    rec.onstop = () => void save(rec.mimeType || mime);
    startAt.current = usePlayback.getState().time;
    controls.setMuted(muteVideo);
    controls.play();
    rec.start(250);
    recorder.current = rec;
    setElapsed(0);
    setState('recording');
  };

  const stop = () => {
    controls.pause();
    controls.setMuted(false);
    setState('saving');
    recorder.current?.stop();
  };

  const save = async (mime: string) => {
    try {
      const blob = new Blob(chunks.current, { type: mime });
      const ext = mime.includes('webm') ? 'webm' : 'm4a';
      const count = (useEditor.getState().project?.audio ?? []).filter((c) => c.track === 'voice').length + 1;
      const item = await addAudio(blob, 'voice', `Voiceover ${count}`, `voiceover.${ext}`);
      useEditor.getState().apply((p) =>
        addAudioClip(p, {
          id: newId(),
          track: 'voice',
          sourceId: item.id,
          start: startAt.current,
          inSec: 0,
          outSec: item.durationSec,
          volume: 1,
          fadeIn: 0.05,
          fadeOut: 0.1,
        }),
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  };

  return (
    <Sheet open={open} onClose={state === 'recording' ? stop : onClose} title="🎙 Voiceover" dismissible={state !== 'recording'}>
      <div className="flex flex-col items-center gap-4 pb-2">
        {state === 'error' && <p className="rounded-xl bg-red-950 p-3 text-sm text-red-300">{error}</p>}
        {state === 'asking' && <p className="text-sm text-zinc-400">Allow microphone access to record.</p>}
        <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
          <div className="h-full bg-emerald-400 transition-[width] duration-75" style={{ width: `${Math.min(100, level * 140)}%` }} />
        </div>
        <div className="font-mono text-2xl tabular-nums">{formatDuration(elapsed, true)}</div>
        <button
          type="button"
          aria-label={state === 'recording' ? 'Stop recording' : 'Start recording'}
          disabled={state !== 'ready' && state !== 'recording'}
          onClick={state === 'recording' ? stop : start}
          className="flex size-20 items-center justify-center rounded-full bg-red-600 disabled:opacity-40"
        >
          <span className={state === 'recording' ? 'size-7 rounded-md bg-white' : 'size-8 rounded-full bg-white'} />
        </button>
        <p className="text-center text-xs text-zinc-400">
          {state === 'saving'
            ? 'Saving…'
            : state === 'recording'
              ? 'Recording — the video plays so you can talk over it. Tap to stop.'
              : 'Recording starts at the playhead and lands on the Voice track.'}
        </p>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={muteVideo} onChange={(e) => setMuteVideo(e.target.checked)} className="size-5 accent-pink-500" />
          Mute the video while recording (best without headphones)
        </label>
      </div>
    </Sheet>
  );
}
