import { useEffect, useRef, useState } from 'react';
import { detectCapabilities, type Capabilities, type CodecProbe } from '../engine/capabilities';
import { readOpfsFile, startExport, type ExportHandle } from '../engine/export/exportClient';
import { ENGINE_TEST_PRESET, TIKTOK_1080P30, type SourceInfo } from '../engine/export/protocol';
import type { Asset } from '../editor/timeline/model';
import { holdWakeLock } from '../engine/wakeLock';
import { db } from '../library/db';
import { navigate } from './router';
import { Icon } from './ui/Icon';

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; progress: number; processedSec: number; elapsedMs: number }
  | { kind: 'done'; file: File; elapsedMs: number; durationSec: number }
  | { kind: 'error'; message: string; discarded: string[] };

type Probe = { source: SourceInfo; aacFallback: boolean; sink: 'opfs' | 'memory' };

type HeapSample = { usedMB: number; peakMB: number } | null;

function readHeapMB(): number | null {
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? mem.usedJSHeapSize / 1048576 : null;
}

const preset = new URLSearchParams(location.search).get('codec') === 'vp9' ? ENGINE_TEST_PRESET : TIKTOK_1080P30;

const fmtMB = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
const fmtSec = (s: number) => `${s.toFixed(1)}s`;

export function SpikeScreen() {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [input, setInput] = useState<File | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [heap, setHeap] = useState<HeapSample>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [imports, setImports] = useState<Asset[]>([]);
  const [copied, setCopied] = useState(false);
  const handle = useRef<ExportHandle | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void detectCapabilities().then(setCaps);
    void db.assets
      .toArray()
      .then((list) => setImports(list.filter((a) => a.prepStats).sort((a, b) => b.createdAt - a.createdAt).slice(0, 5)));
    void navigator.storage?.persist?.().then(setPersisted, () => setPersisted(false));
  }, []);

  useEffect(() => {
    if (phase.kind !== 'running') return;
    const id = window.setInterval(() => {
      const used = readHeapMB();
      if (used !== null) setHeap((h) => ({ usedMB: used, peakMB: Math.max(used, h?.peakMB ?? 0) }));
    }, 500);
    return () => window.clearInterval(id);
  }, [phase.kind]);

  const runExport = (file: File) => {
    setProbe(null);
    setHeap(null);
    setPhase({ kind: 'running', progress: 0, processedSec: 0, elapsedMs: 0 });
    const lock = holdWakeLock();
    handle.current = startExport(file, preset, (e) => {
      switch (e.type) {
        case 'probed':
          setProbe({ source: e.source, aacFallback: e.aacFallback, sink: e.sink });
          break;
        case 'progress':
          setPhase({ kind: 'running', progress: e.progress, processedSec: e.processedSec, elapsedMs: e.elapsedMs });
          break;
        case 'done': {
          lock.release();
          const name = `pawcut-${Date.now()}.mp4`;
          const ready = e.opfsName
            ? readOpfsFile(e.opfsName, name)
            : Promise.resolve(new File([e.buffer ?? new ArrayBuffer(0)], name, { type: 'video/mp4' }));
          void ready.then(
            (out) => setPhase({ kind: 'done', file: out, elapsedMs: e.elapsedMs, durationSec: e.outputDurationSec }),
            (err: unknown) => setPhase({ kind: 'error', message: String(err), discarded: [] }),
          );
          break;
        }
        case 'error':
          lock.release();
          setPhase({ kind: 'error', message: e.message, discarded: e.discarded });
          break;
      }
    });
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setInput(file);
    runExport(file);
  };

  const share = async (file: File) => {
    try {
      await navigator.share({ files: [file], title: 'PawCut export' });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      download(file);
    }
  };

  const download = (file: File) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const report = buildReport(caps, input, probe, phase, heap, persisted, imports);

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const running = phase.kind === 'running';
  const eta =
    running && phase.progress > 0.02 ? (phase.elapsedMs / phase.progress - phase.elapsedMs) / 1000 : null;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+16px)] pt-[calc(env(safe-area-inset-top)+12px)]">
      <header className="flex items-center justify-between">
        <h1 className="flex items-center text-xl font-extrabold tracking-tight">
          <button type="button" aria-label="Back" onClick={() => navigate({ name: 'projects' })} className="-ml-2 flex size-11 items-center justify-center">
            <Icon name="back" />
          </button>
          Diagnostics
        </h1>
        {caps && (
          <span className={`rounded-full px-2 py-1 text-xs ${caps.standalone ? 'bg-emerald-900 text-emerald-300' : 'bg-amber-900 text-amber-300'}`}>
            {caps.standalone ? 'Installed PWA' : 'Browser tab'}
          </span>
        )}
      </header>

      <section className="rounded-2xl bg-zinc-900 p-4">
        <p className="mb-3 text-sm text-zinc-400">
          Pick a ~60s iPhone video. It will be re-encoded to 1080×1920 H.264 30fps + AAC 48kHz, then you can save or share it.
        </p>
        <input ref={fileInput} type="file" accept="video/*" className="hidden" onChange={onPick} />
        <button
          type="button"
          disabled={running}
          onClick={() => fileInput.current?.click()}
          className="min-h-12 w-full rounded-xl bg-pink-500 text-base font-bold text-white active:scale-[0.98] disabled:opacity-40"
        >
          {running ? 'Exporting…' : 'Import video & export'}
        </button>

        {running && (
          <div className="mt-4">
            <div className="h-3 w-full overflow-hidden rounded-full bg-zinc-800">
              <div className="h-full bg-pink-500 transition-[width]" style={{ width: `${(phase.progress * 100).toFixed(1)}%` }} />
            </div>
            <div className="mt-2 flex justify-between text-sm text-zinc-400">
              <span>{(phase.progress * 100).toFixed(0)}% · {fmtSec(phase.elapsedMs / 1000)}</span>
              <span>{eta !== null ? `ETA ${fmtSec(eta)}` : 'Starting…'}</span>
            </div>
            <button
              type="button"
              onClick={() => handle.current?.cancel()}
              className="mt-3 min-h-11 w-full rounded-xl bg-zinc-800 text-sm font-semibold"
            >
              Cancel
            </button>
          </div>
        )}

        {phase.kind === 'done' && (
          <div className="mt-4 space-y-3">
            <div className="grid grid-cols-3 gap-2 text-center text-sm">
              <Stat label="Size" value={fmtMB(phase.file.size)} />
              <Stat label="Duration" value={fmtSec(phase.durationSec)} />
              <Stat label="Speed" value={`${(phase.elapsedMs / 1000 / phase.durationSec).toFixed(2)}× RT`} />
            </div>
            <button
              type="button"
              onClick={() => void share(phase.file)}
              className="min-h-12 w-full rounded-xl bg-emerald-500 text-base font-bold text-black active:scale-[0.98]"
            >
              Save / Share (Photos, Files, TikTok)
            </button>
            <button type="button" onClick={() => download(phase.file)} className="min-h-11 w-full rounded-xl bg-zinc-800 text-sm font-semibold">
              Download instead
            </button>
          </div>
        )}

        {phase.kind === 'error' && (
          <div className="mt-4 rounded-xl bg-red-950 p-3 text-sm text-red-300">
            <p className="font-semibold">Export failed</p>
            <p>{phase.message}</p>
            {phase.discarded.map((d) => (
              <p key={d} className="text-red-400">• {d}</p>
            ))}
          </div>
        )}
      </section>

      {imports.length > 0 && (
        <section className="rounded-2xl bg-zinc-900 p-4 text-sm">
          <h2 className="mb-2 font-bold">Recent imports</h2>
          {imports.map((a) => (
            <p key={a.id} className="py-1 text-zinc-300">
              {importLine(a)}
            </p>
          ))}
        </section>
      )}

      <section className="rounded-2xl bg-zinc-900 p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-bold">Device report</h2>
          <button type="button" onClick={() => void copyReport()} className="min-h-11 rounded-lg bg-zinc-800 px-3 text-sm font-semibold">
            {copied ? 'Copied ✓' : 'Copy report'}
          </button>
        </div>
        {caps ? <CapsView caps={caps} /> : <p className="text-sm text-zinc-500">Probing…</p>}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-zinc-800 p-2">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className="font-bold">{value}</div>
    </div>
  );
}

function Flag({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-zinc-300">{label}</span>
      <span className={ok ? 'text-emerald-400' : 'text-red-400'}>{ok ? '✓' : '✗'}</span>
    </div>
  );
}

function CodecList({ title, list }: { title: string; list: CodecProbe[] }) {
  return (
    <div className="mt-2">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{title}</div>
      {list.map((c) => (
        <Flag key={c.codec} label={`${c.label}${c.hw ? ' (HW)' : ''}`} ok={c.supported} />
      ))}
    </div>
  );
}

function CapsView({ caps }: { caps: Capabilities }) {
  return (
    <div className="text-sm">
      <Flag label="Cross-origin isolated" ok={caps.crossOriginIsolated} />
      <Flag label="OPFS" ok={caps.opfs} />
      <Flag label="Web Share (files)" ok={caps.shareFiles} />
      <Flag label="Wake Lock" ok={caps.wakeLock} />
      <Flag label="WebGL2" ok={caps.webgl2} />
      <Flag label="WebGPU" ok={caps.webgpu} />
      <Flag label="HDR tone-mapping by PawCut" ok={caps.hdrToneMapping} />
      <CodecList title="Video encode 1080×1920" list={caps.videoEncode} />
      <CodecList title="Video decode 4K" list={caps.videoDecode} />
      <CodecList title="Audio encode" list={caps.audioEncode} />
      <CodecList title="Audio decode" list={caps.audioDecode} />
    </div>
  );
}

function importLine(a: Asset): string {
  const p = a.prepStats;
  if (!p) return a.name;
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  return `${a.name} · ${a.width}×${a.height} · ${fmtSec(a.durationSec)} → copy ${sec(p.copyMs)}, proxy ${sec(p.totalMs)} (decode ${sec(p.decodeMs)}, scale[${p.scaler}] ${sec(p.drawMs)}, encode ${sec(p.encodeMs)}, ${p.kept}/${p.frames} frames)${p.bench ? ` bench ${JSON.stringify(p.bench)}ms/frame` : ''}`;
}

function buildReport(
  caps: Capabilities | null,
  input: File | null,
  probe: Probe | null,
  phase: Phase,
  heap: HeapSample,
  persisted: boolean | null,
  imports: Asset[],
): string {
  const lines: string[] = ['PawCut Phase 0 report', `Date: ${new Date().toISOString()}`];
  if (caps) {
    const yn = (b: boolean) => (b ? 'yes' : 'no');
    const codecs = (list: CodecProbe[]) =>
      list.map((c) => `  ${c.label} [${c.codec}]: ${yn(c.supported)}${c.hw ? ' HW' : ''}`).join('\n');
    lines.push(
      `UA: ${caps.userAgent}`,
      `Standalone PWA: ${yn(caps.standalone)} | COI: ${yn(caps.crossOriginIsolated)} | cores: ${caps.hardwareConcurrency} | deviceMemory: ${caps.deviceMemoryGB ?? 'n/a'}`,
      `WebCodecs VD/VE/AD/AE: ${yn(caps.webCodecs.videoDecoder)}/${yn(caps.webCodecs.videoEncoder)}/${yn(caps.webCodecs.audioDecoder)}/${yn(caps.webCodecs.audioEncoder)}`,
      `OPFS: ${yn(caps.opfs)} | Share files: ${yn(caps.shareFiles)} | WakeLock: ${yn(caps.wakeLock)} | WebGL2: ${yn(caps.webgl2)} | WebGPU: ${yn(caps.webgpu)} | persist(): ${persisted ?? 'n/a'} | HDR tone-map: ${yn(caps.hdrToneMapping)}`,
      'Video encode:',
      codecs(caps.videoEncode),
      'Video decode:',
      codecs(caps.videoDecode),
      'Audio encode:',
      codecs(caps.audioEncode),
      'Audio decode:',
      codecs(caps.audioDecode),
    );
  }
  if (input) lines.push(`Input: ${input.name} ${fmtMB(input.size)} ${input.type}`);
  if (probe) {
    const v = probe.source.video;
    const a = probe.source.audio;
    lines.push(
      `Source: ${probe.source.container}, ${fmtSec(probe.source.durationSec)}`,
      v ? `  video ${v.codec} coded ${v.codedWidth}x${v.codedHeight} display ${v.displayWidth}x${v.displayHeight} rot ${v.rotation} HDR ${v.hdr}` : '  no video',
      a ? `  audio ${a.codec} ${a.sampleRate}Hz ${a.channels}ch` : '  no audio',
      `AAC WASM fallback: ${probe.aacFallback} | sink: ${probe.sink}`,
    );
  }
  if (phase.kind === 'done') {
    lines.push(
      `Result: ${fmtMB(phase.file.size)}, ${fmtSec(phase.durationSec)}, took ${fmtSec(phase.elapsedMs / 1000)} = ${(phase.elapsedMs / 1000 / phase.durationSec).toFixed(2)}x realtime`,
    );
  } else if (phase.kind === 'error') {
    lines.push(`Error: ${phase.message}`, ...phase.discarded.map((d) => `  ${d}`));
  } else if (phase.kind === 'running') {
    lines.push(`Running: ${(phase.progress * 100).toFixed(0)}%`);
  }
  if (heap) lines.push(`JS heap peak: ${heap.peakMB.toFixed(0)} MB`);
  if (imports.length) lines.push('Recent imports:', ...imports.map((a) => `  ${importLine(a)}`));
  return lines.join('\n');
}
