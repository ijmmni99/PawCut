// Which codecs the engine writes. Real devices always use H.264 + AAC. Headless Chromium (CI, Playwright) has no
// proprietary codecs, so `?codec=vp9` switches every encode to VP9 + Opus for the session. Never user-facing.

export type CodecProfile = { video: 'avc' | 'vp9'; audio: 'aac' | 'opus' };

const KEY = 'pawcut.codec';

function read(): CodecProfile {
  try {
    const param = new URLSearchParams(location.search).get('codec');
    if (param) sessionStorage.setItem(KEY, param);
    if ((param ?? sessionStorage.getItem(KEY)) === 'vp9') return { video: 'vp9', audio: 'opus' };
  } catch {
    // sessionStorage unavailable: fall through to the default.
  }
  return { video: 'avc', audio: 'aac' };
}

export const codecProfile: CodecProfile = read();
