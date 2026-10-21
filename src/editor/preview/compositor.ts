// Draws decoded VideoFrames onto the single preview canvas. WebGL2 today (one textured quad, letterboxed to 9:16);
// filters, layers and transitions will become extra shader passes here in later phases.
// Falls back to 2D canvas when WebGL2 is unavailable.
import { TONEMAP_GLSL, shaderTransfer } from '../../engine/media/hdr';

/** A decoded frame plus the clockwise rotation (0/90/180/270) needed to display it upright. */
export type FrameSource = { frame: VideoFrame; rotation: number };

export type Compositor = {
  resize(width: number, height: number): void;
  draw(source: FrameSource | null): void;
  destroy(): void;
};

function displaySize({ frame, rotation }: FrameSource): { w: number; h: number } {
  const w = frame.displayWidth;
  const h = frame.displayHeight;
  return rotation % 180 === 0 ? { w, h } : { w: h, h: w };
}

const VS = `#version 300 es
in vec2 a_pos;
uniform vec4 u_rect; // x, y, w, h in clip space
uniform int u_rot;   // clockwise quarter turns applied to the source
out vec2 v_uv;
void main() {
  vec2 d = vec2(a_pos.x, 1.0 - a_pos.y); // display uv, y down
  if (u_rot == 1) v_uv = vec2(d.y, 1.0 - d.x);
  else if (u_rot == 2) v_uv = vec2(1.0 - d.x, 1.0 - d.y);
  else if (u_rot == 3) v_uv = vec2(1.0 - d.y, d.x);
  else v_uv = d;
  gl_Position = vec4(u_rect.xy + a_pos * u_rect.zw, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform int u_transfer;
out vec4 outColor;
${TONEMAP_GLSL}
void main() { outColor = vec4(toSdr(texture(u_tex, v_uv).rgb, u_transfer), 1.0); }`;

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

function createGL(canvas: HTMLCanvasElement): Compositor | null {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false });
  if (!gl) return null;
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uRect = gl.getUniformLocation(program, 'u_rect');
  const uRot = gl.getUniformLocation(program, 'u_rot');
  const uTransfer = gl.getUniformLocation(program, 'u_transfer');

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return {
    resize(width, height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    },
    draw(source) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!source) return;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source.frame);
      gl.uniform1i(uRot, Math.round(source.rotation / 90) % 4);
      // Originals are shown while their proxy is being built; iPhone HDR needs tone mapping to not look washed out.
      gl.uniform1i(uTransfer, shaderTransfer(source.frame.colorSpace));
      const size = displaySize(source);
      const r = containRect(size.w, size.h, canvas.width, canvas.height);
      // Pixel rect -> clip space (y up).
      gl.uniform4f(
        uRect,
        (r.x / canvas.width) * 2 - 1,
        1 - ((r.y + r.h) / canvas.height) * 2,
        (r.w / canvas.width) * 2,
        (r.h / canvas.height) * 2,
      );
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    destroy() {
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}

function create2D(canvas: HTMLCanvasElement): Compositor {
  const ctx = canvas.getContext('2d');
  return {
    resize(width, height) {
      canvas.width = width;
      canvas.height = height;
    },
    draw(source) {
      if (!ctx) return;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (!source) return;
      const size = displaySize(source);
      const r = containRect(size.w, size.h, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
      ctx.rotate((source.rotation * Math.PI) / 180);
      const [dw, dh] = source.rotation % 180 === 0 ? [r.w, r.h] : [r.h, r.w];
      ctx.drawImage(source.frame, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
    },
    destroy() {},
  };
}

export function createCompositor(canvas: HTMLCanvasElement): Compositor {
  try {
    return createGL(canvas) ?? create2D(canvas);
  } catch {
    return create2D(canvas);
  }
}
