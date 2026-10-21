// HDR → SDR conversion for iPhone footage (HEVC 10-bit, BT.2020 primaries, HLG or PQ transfer).
// Shown or encoded as-is, that signal looks washed out on an SDR canvas: wrong primaries and no tone mapping.
// The same math exists twice: GLSL for the renderers and TypeScript for unit tests. Keep them in step.
//
// Pipeline per pixel: decode transfer → linear light relative to SDR reference white (203 nits = 1.0)
// → BT.2020 → BT.709 primaries → soft-knee highlight roll-off on the brightest channel → sRGB encode.

/** 0 = SDR (pass-through), 1 = HLG, 2 = PQ. */
export type TransferCode = 0 | 1 | 2;

export function transferCode(colorSpace: { transfer?: string | null } | null | undefined): TransferCode {
  const t = colorSpace?.transfer;
  if (t === 'hlg' || t === 'arib-std-b67') return 1;
  if (t === 'pq' || t === 'smpte2084') return 2;
  return 0;
}

let rawUpload: boolean | null = null;

/**
 * Does this browser upload HDR VideoFrames to WebGL as the raw signal (Safari: we must tone-map) or convert them
 * to SDR itself (Chromium: tone-mapping again would double it)? Probed once per thread with a tiny synthetic
 * 10-bit 75%-grey HLG frame: raw reads back ≈191, a browser-converted one ≈250. If the probe can't run (e.g. the
 * browser can't build 10-bit frames), assume raw: that is what iPhone Safari showed (washed-out preview).
 */
export function hdrUploadIsRaw(): boolean {
  if (rawUpload !== null) return rawUpload;
  rawUpload = true;
  let frame: VideoFrame | null = null;
  try {
    // 10-bit like real iPhone HDR: Chromium only converts high-bit-depth HDR frames (8-bit HLG arrives raw).
    // 766/1023 ≈ 75% HLG; chroma 512 = neutral.
    frame = new VideoFrame(new Uint16Array([766, 766, 766, 766, 512, 512]), {
      format: 'I420P10' as VideoPixelFormat,
      codedWidth: 2,
      codedHeight: 2,
      timestamp: 0,
      // TS's DOM types predate the BT.2020/HLG names that browsers accept.
      colorSpace: { primaries: 'bt2020', transfer: 'hlg', matrix: 'bt2020-ncl', fullRange: true } as unknown as VideoColorSpaceInit,
    });
    const gl = new OffscreenCanvas(2, 2).getContext('webgl2');
    if (!gl) return rawUpload;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
    // A failed read leaves zeros; only a clearly brightened value means the browser converted.
    rawUpload = !((px[0] ?? 0) > 215);
  } catch {
    rawUpload = true;
  } finally {
    frame?.close();
  }
  return rawUpload;
}

/**
 * Transfer the shader should undo for this frame. Safari doesn't always label decoded frames as HDR, so the
 * track's own colour metadata (`fallback`, from the file's colr/VUI) is used when the frame says nothing.
 * Returns 0 when the browser already converts HDR on upload.
 */
export function shaderTransfer(
  colorSpace: { transfer?: string | null } | null | undefined,
  fallback: TransferCode = 0,
): TransferCode {
  const code = transferCode(colorSpace) || fallback;
  return code !== 0 && hdrUploadIsRaw() ? code : 0;
}

type ColorTrack = {
  getColorSpace(): Promise<{ transfer?: string | null }>;
  hasHighDynamicRange(): Promise<boolean>;
};

/** HDR transfer declared by a video track's metadata; HDR of unknown kind is treated as HLG (iPhone default). */
export async function trackTransfer(track: ColorTrack): Promise<TransferCode> {
  const code = transferCode(await track.getColorSpace().catch(() => null));
  if (code !== 0) return code;
  return (await track.hasHighDynamicRange().catch(() => false)) ? 1 : 0;
}

/** Peak of HLG/PQ masters relative to SDR reference white: 1000 nits / 203 nits. */
const PEAK = 1000 / 203;
/** Below this (relative to reference white) values pass unchanged; above it they roll off towards PEAK. */
const KNEE = 0.75;

export const TONEMAP_GLSL = `
vec3 hlgToLinear(vec3 e) {
  const float a = 0.17883277; const float b = 0.28466892; const float c = 0.55991073;
  vec3 lo = e * e / 3.0;
  vec3 hi = (exp((e - c) / a) + b) / 12.0;
  vec3 scene = mix(lo, hi, step(vec3(0.5), e));
  // OOTF with system gamma 1.2 for a 1000-nit display, then scale so 75% HLG (203 nits) = 1.0.
  float ys = max(dot(scene, vec3(0.2627, 0.6780, 0.0593)), 1e-6);
  return scene * pow(ys, 0.2) * ${PEAK.toFixed(6)};
}
vec3 pqToLinear(vec3 e) {
  const float m1 = 0.1593017578125; const float m2 = 78.84375;
  const float c1 = 0.8359375; const float c2 = 18.8515625; const float c3 = 18.6875;
  vec3 p = pow(max(e, 0.0), vec3(1.0 / m2));
  vec3 nits = pow(max(p - c1, 0.0) / (c2 - c3 * p), vec3(1.0 / m1)) * 10000.0;
  return nits / 203.0;
}
vec3 srgbEncode(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}
vec3 toSdr(vec3 e, int transfer) {
  if (transfer == 0) return e;
  vec3 lin = transfer == 1 ? hlgToLinear(e) : pqToLinear(e);
  lin = max(mat3(1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187) * lin, 0.0);
  float m = max(max(lin.r, lin.g), lin.b);
  if (m > ${KNEE.toFixed(4)}) {
    float k = ${KNEE.toFixed(4)};
    float t = (m - k) / (${PEAK.toFixed(6)} - k);
    float rolled = k + (1.0 - k) * (1.0 - exp(-3.0 * t)) / (1.0 - exp(-3.0));
    lin *= rolled / m;
  }
  return srgbEncode(clamp(lin, 0.0, 1.0));
}
`;

// ---- TypeScript mirror (tests) ----

type RGB = [number, number, number];

function hlgToLinear(e: RGB): RGB {
  const a = 0.17883277;
  const b = 0.28466892;
  const c = 0.55991073;
  const scene = e.map((v) => (v <= 0.5 ? (v * v) / 3 : (Math.exp((v - c) / a) + b) / 12)) as RGB;
  const ys = Math.max(0.2627 * scene[0] + 0.678 * scene[1] + 0.0593 * scene[2], 1e-6);
  return scene.map((v) => v * ys ** 0.2 * PEAK) as RGB;
}

function pqToLinear(e: RGB): RGB {
  const m1 = 0.1593017578125;
  const m2 = 78.84375;
  const c1 = 0.8359375;
  const c2 = 18.8515625;
  const c3 = 18.6875;
  return e.map((v) => {
    const p = Math.max(v, 0) ** (1 / m2);
    return ((Math.max(p - c1, 0) / (c2 - c3 * p)) ** (1 / m1) * 10000) / 203;
  }) as RGB;
}

const srgbEncode = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

export function toSdr(e: RGB, transfer: TransferCode): RGB {
  if (transfer === 0) return e;
  const l = transfer === 1 ? hlgToLinear(e) : pqToLinear(e);
  let lin: RGB = [
    Math.max(1.6605 * l[0] - 0.5876 * l[1] - 0.0728 * l[2], 0),
    Math.max(-0.1246 * l[0] + 1.1329 * l[1] - 0.0083 * l[2], 0),
    Math.max(-0.0182 * l[0] - 0.1006 * l[1] + 1.1187 * l[2], 0),
  ];
  const m = Math.max(...lin);
  if (m > KNEE) {
    const t = (m - KNEE) / (PEAK - KNEE);
    const rolled = KNEE + ((1 - KNEE) * (1 - Math.exp(-3 * t))) / (1 - Math.exp(-3));
    lin = lin.map((v) => (v * rolled) / m) as RGB;
  }
  return lin.map((v) => srgbEncode(Math.min(Math.max(v, 0), 1))) as RGB;
}
