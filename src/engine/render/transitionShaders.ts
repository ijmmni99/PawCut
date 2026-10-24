// GLSL for every transition (written for PawCut in the style of gl-transitions: each defines
// `vec4 transition(vec2 uv)` using getFrom / getTo, progress `p` and frame aspect `ratio`). One program per kind,
// compiled on first use.
import type { TransitionKind } from '../../editor/timeline/model';

export const TRANSITION_PRELUDE = `
uniform sampler2D u_from;
uniform sampler2D u_to;
uniform float p;
uniform float ratio;
const float PI = 3.14159265;
vec4 getFrom(vec2 uv) { return texture(u_from, uv); }
vec4 getTo(vec2 uv) { return texture(u_to, uv); }
vec2 mirror(vec2 v) { vec2 m = mod(v, 2.0); return mix(m, 2.0 - m, step(1.0, m)); }
float easeIn(float x) { return x * x * x; }
float easeOut(float x) { return 1.0 - pow(1.0 - x, 3.0); }
float easeInOut(float x) { return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) / 2.0; }
float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
`;

const dip = (color: string) => `
vec4 transition(vec2 uv) {
  vec4 c = vec4(${color}, 1.0);
  return p < 0.5 ? mix(getFrom(uv), c, p * 2.0) : mix(c, getTo(uv), p * 2.0 - 1.0);
}`;

const whip = (dir: string) => `
vec4 transition(vec2 uv) {
  vec2 dir = ${dir};
  float k = p < 0.5 ? easeIn(p * 2.0) : -(1.0 - easeOut(p * 2.0 - 1.0));
  float blur = sin(p * PI) * 0.3;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    vec2 q = mirror(uv + dir * (k + blur * (float(i) / 11.0 - 0.5)));
    acc += p < 0.5 ? getFrom(q) : getTo(q);
  }
  return acc / 12.0;
}`;

const zoom = (outward: boolean) => `
vec4 transition(vec2 uv) {
  vec2 c = vec2(0.5);
  vec4 acc = vec4(0.0);
  if (p < 0.5) {
    float k = easeIn(p * 2.0);
    float s = ${outward ? '1.0 / (1.0 + k * 0.7)' : '1.0 + k * 1.6'};
    for (int i = 0; i < 8; i++) acc += getFrom(mirror(c + (uv - c) / (s * (1.0 + k * 0.05 * float(i)))));
  } else {
    float k = 1.0 - easeOut(p * 2.0 - 1.0);
    float s = ${outward ? '1.0 / (1.0 + k * 0.5)' : '1.0 + k * 0.8'};
    for (int i = 0; i < 8; i++) acc += getTo(mirror(c + (uv - c) / (s * (1.0 + k * 0.05 * float(i)))));
  }
  return acc / 8.0;
}`;

const SOURCES: Record<TransitionKind, string> = {
  dissolve: `vec4 transition(vec2 uv) { return mix(getFrom(uv), getTo(uv), p); }`,
  dipBlack: dip('vec3(0.0)'),
  dipWhite: dip('vec3(1.0)'),
  flash: `
vec4 transition(vec2 uv) {
  vec4 c = mix(getFrom(uv), getTo(uv), smoothstep(0.45, 0.55, p));
  float f = pow(1.0 - abs(p - 0.5) * 2.0, 2.0);
  return vec4(min(c.rgb + f * 1.2, 1.0), 1.0);
}`,
  slideLeft: `
vec4 transition(vec2 uv) {
  float e = easeInOut(p);
  return uv.x > 1.0 - e ? getTo(vec2(uv.x - (1.0 - e), uv.y)) : getFrom(uv);
}`,
  slideUp: `
vec4 transition(vec2 uv) {
  float e = easeInOut(p);
  return uv.y < e ? getTo(vec2(uv.x, uv.y + 1.0 - e)) : getFrom(uv);
}`,
  pushLeft: `
vec4 transition(vec2 uv) {
  float e = easeInOut(p);
  return uv.x < 1.0 - e ? getFrom(vec2(uv.x + e, uv.y)) : getTo(vec2(uv.x - (1.0 - e), uv.y));
}`,
  pushRight: `
vec4 transition(vec2 uv) {
  float e = easeInOut(p);
  return uv.x > e ? getFrom(vec2(uv.x - e, uv.y)) : getTo(vec2(uv.x + 1.0 - e, uv.y));
}`,
  wipeLeft: `
vec4 transition(vec2 uv) {
  float edge = easeInOut(p) * 1.1 - 0.05;
  return mix(getTo(uv), getFrom(uv), smoothstep(edge - 0.05, edge + 0.05, uv.x));
}`,
  wipeUp: `
vec4 transition(vec2 uv) {
  float edge = easeInOut(p) * 1.1 - 0.05;
  return mix(getTo(uv), getFrom(uv), smoothstep(edge - 0.05, edge + 0.05, uv.y));
}`,
  circle: `
vec4 transition(vec2 uv) {
  float r = length((uv - 0.5) * vec2(ratio, 1.0));
  float R = easeInOut(p) * length(vec2(ratio, 1.0)) * 0.52;
  return mix(getTo(uv), getFrom(uv), smoothstep(R - 0.02, R + 0.02, r));
}`,
  heart: `
vec4 transition(vec2 uv) {
  if (p > 0.98) return getTo(uv);
  vec2 q = (uv - vec2(0.5, 0.42)) * vec2(ratio, 1.0) / (easeIn(p) * 2.2 + 0.001);
  float x = q.x * 1.3, y = q.y * 1.3;
  float h = pow(x * x + y * y - 1.0, 3.0) - x * x * y * y * y;
  return mix(getTo(uv), getFrom(uv), smoothstep(-0.02, 0.02, h));
}`,
  luma: `
vec4 transition(vec2 uv) {
  float l = dot(getFrom(uv).rgb, vec3(0.299, 0.587, 0.114));
  float e = p * 1.2;
  return mix(getTo(uv), getFrom(uv), smoothstep(e - 0.2, e, l));
}`,
  pixelize: `
vec4 transition(vec2 uv) {
  float s = sin(p * PI);
  float cells = mix(600.0, 14.0, s);
  vec2 grid = vec2(cells * ratio, cells);
  vec2 q = (floor(uv * grid) + 0.5) / grid;
  return mix(getFrom(q), getTo(q), smoothstep(0.4, 0.6, p));
}`,
  zoomIn: zoom(false),
  zoomOut: zoom(true),
  whipLeft: whip('vec2(1.0, 0.0)'),
  whipRight: whip('vec2(-1.0, 0.0)'),
  whipUp: whip('vec2(0.0, -1.0)'),
  whipDown: whip('vec2(0.0, 1.0)'),
  spin: `
vec4 transition(vec2 uv) {
  float a = p < 0.5 ? easeIn(p * 2.0) * PI * 0.5 : -(1.0 - easeOut(p * 2.0 - 1.0)) * PI * 0.5;
  float z = 1.0 + sin(p * PI) * 0.6;
  float spread = sin(p * PI) * 0.2;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 8; i++) {
    vec2 d = rot(a + spread * (float(i) / 7.0 - 0.5)) * ((uv - 0.5) * vec2(ratio, 1.0)) * z;
    vec2 q = mirror(d / vec2(ratio, 1.0) + 0.5);
    acc += p < 0.5 ? getFrom(q) : getTo(q);
  }
  return acc / 8.0;
}`,
  glitch: `
vec4 transition(vec2 uv) {
  float s = sin(p * PI);
  float band = floor(uv.y * 24.0);
  float step20 = floor(p * 20.0);
  float shift = (rand(vec2(band, step20)) - 0.5) * 0.3 * s * step(0.55, rand(vec2(band * 1.7, step20 + 3.0)));
  vec2 q = vec2(uv.x + shift, uv.y);
  float sel = step(0.5, p + (rand(vec2(floor(p * 25.0), 3.0)) - 0.5) * 0.35 * s);
  vec2 o = vec2(0.025 * s, 0.0);
  float r = mix(getFrom(q + o).r, getTo(q + o).r, sel);
  float g = mix(getFrom(q).g, getTo(q).g, sel);
  float b = mix(getFrom(q - o).b, getTo(q - o).b, sel);
  return vec4(r, g, b, 1.0);
}`,
  rgbSplit: `
vec4 transition(vec2 uv) {
  vec2 o = vec2(sin(p * PI) * 0.05, 0.0);
  float sel = smoothstep(0.45, 0.55, p);
  float r = mix(getFrom(uv + o).r, getTo(uv + o).r, sel);
  float g = mix(getFrom(uv).g, getTo(uv).g, sel);
  float b = mix(getFrom(uv - o).b, getTo(uv - o).b, sel);
  return vec4(r, g, b, 1.0);
}`,
  shake: `
vec4 transition(vec2 uv) {
  float t = floor(p * 40.0);
  vec2 o = (vec2(rand(vec2(t, 1.0)), rand(vec2(t, 2.0))) - 0.5) * 0.08 * sin(p * PI);
  vec2 q = mirror(uv + o);
  return mix(getFrom(q), getTo(q), smoothstep(0.45, 0.55, p));
}`,
  blurZoom: `
vec4 transition(vec2 uv) {
  float st = sin(p * PI) * 0.3;
  vec4 a = vec4(0.0), b = vec4(0.0);
  for (int i = 0; i < 10; i++) {
    vec2 q = 0.5 + (uv - 0.5) * (1.0 - st * float(i) / 10.0);
    a += getFrom(q);
    b += getTo(q);
  }
  return mix(a, b, smoothstep(0.35, 0.65, p)) / 10.0;
}`,
  lightLeak: `
vec4 transition(vec2 uv) {
  vec4 c = mix(getFrom(uv), getTo(uv), smoothstep(0.3, 0.7, p));
  float s = sin(p * PI);
  float x = mix(-0.4, 1.4, p);
  float g1 = exp(-pow(length((uv - vec2(x, 0.6)) * vec2(ratio * 0.8, 1.0)), 2.0) * 6.0) * s * 1.3;
  float g2 = exp(-pow(length((uv - vec2(1.0 - x, 0.3)) * vec2(ratio, 1.0)), 2.0) * 8.0) * s * 0.7;
  vec3 leak = min(vec3(1.0, 0.55, 0.25) * g1 + vec3(1.0, 0.3, 0.5) * g2, 1.0);
  return vec4(1.0 - (1.0 - c.rgb) * (1.0 - leak), 1.0);
}`,
};

export function transitionSource(kind: TransitionKind): string {
  return SOURCES[kind] ?? SOURCES.dissolve;
}

export const TRANSITION_KINDS = Object.keys(SOURCES) as TransitionKind[];
