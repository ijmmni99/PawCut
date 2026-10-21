/// <reference lib="webworker" />
// Frame scalers for proxy generation: rotate + downscale a decoded frame into a small OffscreenCanvas the encoder
// reads. Which method is fastest depends on the device (GPU upload + readback vs CPU 2D vs bitmap resize), and the
// difference is large (4K frames), so `AdaptiveScaler` benchmarks them on the first frames and keeps the fastest.
import { VideoSample } from 'mediabunny';
import { TONEMAP_GLSL, shaderTransfer } from './hdr';

export type ScalerKind = 'gl' | 'bitmap' | '2d';

export type FrameScaler = {
  readonly canvas: OffscreenCanvas;
  readonly kind: ScalerKind;
  /** Draws `sample` (rotated by its own rotation) to fill the canvas. */
  draw(sample: VideoSample): void | Promise<void>;
  dispose(): void;
};

const VS = `#version 300 es
in vec2 a_pos;
uniform int u_rot;
out vec2 v_uv;
void main() {
  vec2 d = vec2(a_pos.x, 1.0 - a_pos.y);
  if (u_rot == 1) v_uv = vec2(d.y, 1.0 - d.x);
  else if (u_rot == 2) v_uv = vec2(1.0 - d.x, 1.0 - d.y);
  else if (u_rot == 3) v_uv = vec2(1.0 - d.y, d.x);
  else v_uv = d;
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform int u_transfer;
out vec4 outColor;
${TONEMAP_GLSL}
void main() { outColor = vec4(toSdr(texture(u_tex, v_uv).rgb, u_transfer), 1.0); }`;

/** Does this frame need our tone mapping (HDR, and the browser doesn't convert it)? Only WebGL can do that. */
export function isHdrSample(sample: VideoSample): boolean {
  return shaderTransfer(sample.colorSpace) !== 0;
}

/**
 * WebGL scaler. Tone-maps HDR (HLG/PQ) to SDR in the same pass. `fit: 'contain'` letterboxes into the canvas
 * (export), `'fill'` stretches to it (proxies, where the canvas already has the source aspect).
 */
function createGL(canvas: OffscreenCanvas, fit: 'fill' | 'contain' = 'fill'): FrameScaler | null {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });
  if (!gl) return null;
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) throw new Error('createShader failed');
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VS));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uRot = gl.getUniformLocation(program, 'u_rot');
  const uTransfer = gl.getUniformLocation(program, 'u_transfer');
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.viewport(0, 0, canvas.width, canvas.height);

  return {
    canvas,
    kind: 'gl',
    draw(sample) {
      const frame = sample.toVideoFrame();
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      } finally {
        frame.close();
      }
      gl.uniform1i(uRot, Math.round(sample.rotation / 90) % 4);
      gl.uniform1i(uTransfer, shaderTransfer(sample.colorSpace));
      if (fit === 'contain') {
        // displayWidth/Height already account for rotation.
        const sw = sample.displayWidth;
        const sh = sample.displayHeight;
        const scale = Math.min(canvas.width / sw, canvas.height / sh);
        const w = Math.round(sw * scale);
        const h = Math.round(sh * scale);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.viewport(Math.round((canvas.width - w) / 2), Math.round((canvas.height - h) / 2), w, h);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    dispose() {
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}

/** Hardware-assisted resize via createImageBitmap, then a cheap rotate on the already-small bitmap. */
function createBitmap(canvas: OffscreenCanvas): FrameScaler | null {
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof createImageBitmap !== 'function') return null;
  return {
    canvas,
    kind: 'bitmap',
    async draw(sample) {
      const quarter = sample.rotation % 180 !== 0;
      const rw = quarter ? canvas.height : canvas.width;
      const rh = quarter ? canvas.width : canvas.height;
      const frame = sample.toVideoFrame();
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(frame, { resizeWidth: rw, resizeHeight: rh, resizeQuality: 'low' });
      } finally {
        frame.close();
      }
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((sample.rotation * Math.PI) / 180);
      ctx.drawImage(bitmap, -rw / 2, -rh / 2);
      ctx.restore();
      bitmap.close();
    },
    dispose() {},
  };
}

function create2D(canvas: OffscreenCanvas): FrameScaler | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  return {
    canvas,
    kind: '2d',
    draw(sample) {
      sample.drawWithFit(ctx, { fit: 'fill' });
    },
    dispose() {},
  };
}

/** A WebGL scaler that letterboxes into `width`×`height` (export of HDR clips). Null if WebGL2 is unavailable. */
export function createContainScaler(width: number, height: number): FrameScaler | null {
  try {
    return createGL(new OffscreenCanvas(width, height), 'contain');
  } catch {
    return null;
  }
}

function create(kind: ScalerKind, width: number, height: number): FrameScaler | null {
  try {
    const canvas = new OffscreenCanvas(width, height);
    if (kind === 'gl') return createGL(canvas);
    if (kind === 'bitmap') return createBitmap(canvas);
    return create2D(canvas);
  } catch {
    return null;
  }
}

/** Frames each candidate gets during the benchmark. */
const TRIAL_FRAMES = 4;

/**
 * Renders samples into encoder-ready VideoSamples, choosing the fastest scaler for this device. The first
 * frames rotate through every candidate; each is timed including the canvas → VideoSample capture (the GPU
 * readback that makes WebGL expensive on some devices). Then the fastest is kept and the rest are released.
 */
export class AdaptiveScaler {
  private candidates: FrameScaler[];
  private readonly timings = new Map<FrameScaler, number[]>();
  private chosen: FrameScaler | null = null;
  private trial = 0;

  constructor(width: number, height: number) {
    this.candidates = (['gl', 'bitmap', '2d'] as const)
      .map((k) => create(k, width, height))
      .filter((s): s is FrameScaler => s !== null);
    if (this.candidates.length === 0) throw new Error('No way to draw video frames on this device');
    if (this.candidates.length === 1) this.chosen = this.candidates[0] as FrameScaler;
  }

  /** The scaler in use (the last one tried while still benchmarking). */
  current: FrameScaler | null = null;

  get kind(): ScalerKind {
    return (this.chosen ?? this.current ?? (this.candidates[0] as FrameScaler)).kind;
  }

  async render(sample: VideoSample, timestamp: number, duration: number): Promise<VideoSample> {
    // HDR footage must be tone-mapped, which only WebGL does: skip the benchmark.
    if (!this.chosen && isHdrSample(sample)) {
      const gl = this.candidates.find((c) => c.kind === 'gl');
      if (gl) {
        this.chosen = gl;
        for (const c of this.candidates) if (c !== gl) c.dispose();
        this.candidates = [gl];
      }
    }
    const scaler = this.chosen ?? (this.candidates[this.trial % this.candidates.length] as FrameScaler);
    this.current = scaler;
    const started = performance.now();
    let out: VideoSample;
    try {
      await scaler.draw(sample);
      out = new VideoSample(scaler.canvas, { timestamp, duration });
    } catch (err) {
      // A method this browser doesn't support (e.g. createImageBitmap on VideoFrame): drop it and use another.
      this.drop(scaler, err);
      return this.render(sample, timestamp, duration);
    }
    if (!this.chosen) {
      const list = this.timings.get(scaler) ?? [];
      list.push(performance.now() - started);
      this.timings.set(scaler, list);
      this.trial++;
      if (this.trial >= TRIAL_FRAMES * this.candidates.length) this.pick();
    }
    return out;
  }

  /** Methods that failed on this device, with why (shown in Diagnostics). */
  readonly failures: string[] = [];

  private drop(scaler: FrameScaler, err: unknown): void {
    this.failures.push(`${scaler.kind}: ${err instanceof Error ? err.message : String(err)}`);
    scaler.dispose();
    this.candidates = this.candidates.filter((c) => c !== scaler);
    this.timings.delete(scaler);
    if (this.chosen === scaler) this.chosen = null;
    if (this.candidates.length === 0) throw new Error(`Can't process video frames here (${this.failures.join('; ')})`);
    if (this.candidates.length === 1) this.chosen = this.candidates[0] as FrameScaler;
    // Restart the benchmark round-robin over what's left.
    this.trial = 0;
    for (const c of this.candidates) this.timings.delete(c);
  }

  private pick(): void {
    // Median of each candidate's trial frames (the first call of each includes warm-up).
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Infinity;
    let best = this.candidates[0] as FrameScaler;
    for (const c of this.candidates) if (median(this.timings.get(c) ?? []) < median(this.timings.get(best) ?? [])) best = c;
    this.chosen = best;
    for (const c of this.candidates) if (c !== best) c.dispose();
    this.candidates = [best];
  }

  /** Per-candidate median ms from the benchmark, for diagnostics. */
  benchmark(): Partial<Record<ScalerKind, number>> {
    const out: Partial<Record<ScalerKind, number>> = {};
    for (const [s, xs] of this.timings) out[s.kind] = Math.round([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0);
    return out;
  }

  dispose(): void {
    for (const c of this.candidates) c.dispose();
  }
}
