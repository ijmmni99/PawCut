// The one video renderer, shared by the preview (HTMLCanvasElement) and export (OffscreenCanvas in the worker).
// Pass 1 per layer: upload the decoded frame, rotate, HDR tone-map, apply the clip's look (filter + adjust,
// sharpen, vignette) and letterbox into the frame. Pass 2 (only during a transition): blend the two layers with the
// transition shader. Without a transition the layer is drawn straight to the canvas (one pass).
import type { TransitionKind } from '../../editor/timeline/model';
import { TONEMAP_GLSL, type TransferCode, shaderTransfer } from '../media/hdr';
import type { LookParams } from './looks';
import { TRANSITION_PRELUDE, transitionSource } from './transitionShaders';

export type Layer = {
  /** A VideoFrame (or any image) in its stored orientation. */
  image: TexImageSource;
  /** Size of `image` before rotation. */
  width: number;
  height: number;
  /** Clockwise degrees to display upright. */
  rotation: number;
  /** HDR transfer from the file's metadata (frames from Safari may be unlabelled). */
  transfer: TransferCode;
  colorSpace?: { transfer?: string | null } | null;
  look: LookParams | null;
};

export type TransitionState = { kind: TransitionKind; p: number };

export type Renderer = {
  resize(width: number, height: number): void;
  render(a: Layer | null, b?: Layer | null, transition?: TransitionState | null): void;
  destroy(): void;
};

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

const LAYER_VS = `#version 300 es
in vec2 a_pos;
uniform vec4 u_rect; // x, y, w, h in clip space
uniform int u_rot;   // clockwise quarter turns applied to the source
out vec2 v_uv;       // source texture uv
out vec2 v_disp;     // 0..1 across the displayed image (for the vignette)
void main() {
  vec2 d = vec2(a_pos.x, 1.0 - a_pos.y); // display uv, y down
  v_disp = d;
  if (u_rot == 1) v_uv = vec2(d.y, 1.0 - d.x);
  else if (u_rot == 2) v_uv = vec2(1.0 - d.x, 1.0 - d.y);
  else if (u_rot == 3) v_uv = vec2(1.0 - d.y, d.x);
  else v_uv = d;
  gl_Position = vec4(u_rect.xy + a_pos * u_rect.zw, 0.0, 1.0);
}`;

/** Layer shader; with LOOK defined it also applies the filter/adjust maths (a separate program, so plain clips
 *  don't pay for it — some GPUs, and software rendering, don't skip uniform branches). */
const layerFS = (withLook: boolean) => `#version 300 es
${withLook ? '#define LOOK' : ''}
precision highp float;
in vec2 v_uv;
in vec2 v_disp;
uniform sampler2D u_tex;
uniform int u_transfer;
uniform vec2 u_texel;
uniform float u_brightness, u_exposure, u_contrast, u_highlights, u_shadows, u_saturation, u_vibrance;
uniform float u_temperature, u_tint, u_fade, u_sharpen, u_vignette, u_split, u_bw;
uniform vec3 u_splitShadow, u_splitHighlight;
out vec4 outColor;
${TONEMAP_GLSL}
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
vec3 src(vec2 uv) { return toSdr(texture(u_tex, uv).rgb, u_transfer); }
void main() {
  vec3 c = src(v_uv);
#ifdef LOOK
  {
    if (u_sharpen > 0.0) {
      vec3 n = (src(v_uv + vec2(u_texel.x, 0.0)) + src(v_uv - vec2(u_texel.x, 0.0)) +
                src(v_uv + vec2(0.0, u_texel.y)) + src(v_uv - vec2(0.0, u_texel.y))) * 0.25;
      c += (c - n) * u_sharpen * 2.0;
    }
    c *= exp2(u_exposure);
    // Brightness: a mid-tone (gamma) curve, so whites and blacks stay put.
    c = pow(max(c, 0.0), vec3(exp2(-u_brightness * 0.8)));
    c *= vec3(1.0 + 0.12 * u_temperature, 1.0 - 0.07 * u_tint, 1.0 - 0.12 * u_temperature);
    float l = clamp(dot(c, LUMA), 0.0, 1.0);
    c += u_shadows * 0.3 * (1.0 - l) * (1.0 - l) + u_highlights * 0.3 * l * l;
    c = (c - 0.5) * (1.0 + u_contrast) + 0.5;
    l = clamp(dot(c, LUMA), 0.0, 1.0);
    float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    c = mix(vec3(l), c, max(0.0, 1.0 + u_saturation + u_vibrance * (1.0 - clamp(sat, 0.0, 1.0))));
    c += ((u_splitShadow - 0.5) * (1.0 - l) + (u_splitHighlight - 0.5) * l) * u_split;
    c = mix(c, c * 0.85 + 0.1, u_fade);
    c = mix(c, vec3(dot(c, LUMA)), u_bw);
    c *= 1.0 - u_vignette * smoothstep(0.3, 0.85, length(v_disp - 0.5) * 1.3);
  }
#endif
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

const FULL_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = a_pos; gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0); }`;

const transitionFS = (kind: TransitionKind) => `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
${TRANSITION_PRELUDE}
${transitionSource(kind)}
void main() { outColor = transition(v_uv); }`;

/** Letterboxed destination rect for a source of size sw×sh inside dw×dh. */
export function containRect(sw: number, sh: number, dw: number, dh: number): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(dw / sw, dh / sh);
  const w = sw * scale;
  const h = sh * scale;
  return { x: (dw - w) / 2, y: (dh - h) / 2, w, h };
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader failed');
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader error');
  return shader;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(program, 0, 'a_pos');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link error');
  return program;
}

type Target = { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number };

const LOOK_UNIFORMS = [
  'brightness',
  'exposure',
  'contrast',
  'highlights',
  'shadows',
  'saturation',
  'vibrance',
  'temperature',
  'tint',
  'fade',
  'sharpen',
  'vignette',
  'split',
  'bw',
] as const;

export function createRenderer(canvas: AnyCanvas): Renderer | null {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null;
  if (!gl) return null;

  type LayerProgram = {
    program: WebGLProgram;
    rect: WebGLUniformLocation | null;
    rot: WebGLUniformLocation | null;
    tex: WebGLUniformLocation | null;
    transfer: WebGLUniformLocation | null;
    texel: WebGLUniformLocation | null;
    splitShadow: WebGLUniformLocation | null;
    splitHighlight: WebGLUniformLocation | null;
    params: Record<(typeof LOOK_UNIFORMS)[number], WebGLUniformLocation | null>;
  };
  const makeLayerProgram = (withLook: boolean): LayerProgram => {
    const program = link(gl, LAYER_VS, layerFS(withLook));
    const u = (name: string) => gl.getUniformLocation(program, name);
    return {
      program,
      rect: u('u_rect'),
      rot: u('u_rot'),
      tex: u('u_tex'),
      transfer: u('u_transfer'),
      texel: u('u_texel'),
      splitShadow: u('u_splitShadow'),
      splitHighlight: u('u_splitHighlight'),
      params: Object.fromEntries(LOOK_UNIFORMS.map((k) => [k, u(`u_${k}`)])) as LayerProgram['params'],
    };
  };
  const plainProgram = makeLayerProgram(false);
  let lookProgram: LayerProgram | null = null;

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const newTexture = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const sources = [newTexture(), newTexture()];
  const targets: Array<Target | null> = [null, null];
  const transitionPrograms = new Map<TransitionKind, { program: WebGLProgram; p: WebGLUniformLocation | null; ratio: WebGLUniformLocation | null }>();

  const target = (i: 0 | 1): Target => {
    const w = canvas.width;
    const h = canvas.height;
    const t = targets[i];
    if (t && t.w === w && t.h === h) return t;
    if (t) {
      gl.deleteFramebuffer(t.fb);
      gl.deleteTexture(t.tex);
    }
    const tex = newTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const made = { fb, tex, w, h };
    targets[i] = made;
    return made;
  };

  const drawLayer = (layer: Layer | null, slot: 0 | 1, fb: WebGLFramebuffer | null) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!layer) return;
    const look = layer.look;
    if (look) lookProgram ??= makeLayerProgram(true);
    const lu = look ? (lookProgram as LayerProgram) : plainProgram;
    gl.useProgram(lu.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sources[slot] as WebGLTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layer.image);
    gl.uniform1i(lu.tex, 0);
    const quarter = Math.round(layer.rotation / 90) % 4;
    gl.uniform1i(lu.rot, quarter);
    gl.uniform1i(lu.transfer, shaderTransfer(layer.colorSpace, layer.transfer));
    if (look) {
      gl.uniform2f(lu.texel, 1 / Math.max(1, layer.width), 1 / Math.max(1, layer.height));
      for (const k of LOOK_UNIFORMS) gl.uniform1f(lu.params[k], look[k]);
      gl.uniform3f(lu.splitShadow, ...look.splitShadow);
      gl.uniform3f(lu.splitHighlight, ...look.splitHighlight);
    }
    const [dw, dh] = quarter % 2 === 0 ? [layer.width, layer.height] : [layer.height, layer.width];
    const r = containRect(dw, dh, canvas.width, canvas.height);
    gl.uniform4f(
      lu.rect,
      (r.x / canvas.width) * 2 - 1,
      1 - ((r.y + r.h) / canvas.height) * 2,
      (r.w / canvas.width) * 2,
      (r.h / canvas.height) * 2,
    );
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  const transitionProgram = (kind: TransitionKind) => {
    let entry = transitionPrograms.get(kind);
    if (!entry) {
      const program = link(gl, FULL_VS, transitionFS(kind));
      gl.useProgram(program);
      gl.uniform1i(gl.getUniformLocation(program, 'u_from'), 0);
      gl.uniform1i(gl.getUniformLocation(program, 'u_to'), 1);
      entry = { program, p: gl.getUniformLocation(program, 'p'), ratio: gl.getUniformLocation(program, 'ratio') };
      transitionPrograms.set(kind, entry);
    }
    return entry;
  };

  return {
    resize(width, height) {
      canvas.width = width;
      canvas.height = height;
    },
    render(a, b, transition) {
      if (!transition || !b) {
        drawLayer(a, 0, null);
        return;
      }
      const ta = target(0);
      const tb = target(1);
      drawLayer(a, 0, ta.fb);
      drawLayer(b, 1, tb.fb);
      const prog = transitionProgram(transition.kind);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(prog.program);
      gl.uniform1f(prog.p, Math.min(1, Math.max(0, transition.p)));
      gl.uniform1f(prog.ratio, canvas.width / Math.max(1, canvas.height));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, ta.tex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, tb.tex);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.activeTexture(gl.TEXTURE0);
    },
    destroy() {
      for (const t of targets) {
        if (!t) continue;
        gl.deleteFramebuffer(t.fb);
        gl.deleteTexture(t.tex);
      }
      for (const t of sources) gl.deleteTexture(t);
      for (const { program } of transitionPrograms.values()) gl.deleteProgram(program);
      gl.deleteProgram(plainProgram.program);
      if (lookProgram) gl.deleteProgram(lookProgram.program);
      gl.deleteBuffer(quad);
    },
  };
}

/** Compiles every transition up front (tests, and to surface GLSL errors early). Returns kinds that failed. */
export function checkTransitions(canvas: AnyCanvas, kinds: readonly TransitionKind[]): string[] {
  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
  if (!gl) return ['no webgl2'];
  const failed: string[] = [];
  for (const kind of kinds) {
    try {
      gl.deleteProgram(link(gl, FULL_VS, transitionFS(kind)));
    } catch (err) {
      failed.push(`${kind}: ${String(err)}`);
    }
  }
  for (const withLook of [false, true]) {
    try {
      gl.deleteProgram(link(gl, LAYER_VS, layerFS(withLook)));
    } catch (err) {
      failed.push(`layer${withLook ? '+look' : ''}: ${String(err)}`);
    }
  }
  return failed;
}
