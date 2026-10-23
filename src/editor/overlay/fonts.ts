// Bundled OFL fonts (Fontsource, latin + latin-ext — covers English and Malay). Chinese and emoji fall back to the
// system fonts (PingFang / Apple Color Emoji on iPhone). Loaded on demand with the FontFace API.
import type { FontId } from '../timeline/model';
import antonExt from '@fontsource/anton/files/anton-latin-ext-400-normal.woff2?url';
import anton from '@fontsource/anton/files/anton-latin-400-normal.woff2?url';
import bangersExt from '@fontsource/bangers/files/bangers-latin-ext-400-normal.woff2?url';
import bangers from '@fontsource/bangers/files/bangers-latin-400-normal.woff2?url';
import bebasExt from '@fontsource/bebas-neue/files/bebas-neue-latin-ext-400-normal.woff2?url';
import bebas from '@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff2?url';
import montserratExt from '@fontsource/montserrat/files/montserrat-latin-ext-800-normal.woff2?url';
import montserrat from '@fontsource/montserrat/files/montserrat-latin-800-normal.woff2?url';
import nunitoExt from '@fontsource/nunito/files/nunito-latin-ext-800-normal.woff2?url';
import nunito from '@fontsource/nunito/files/nunito-latin-800-normal.woff2?url';
import poppinsExt from '@fontsource/poppins/files/poppins-latin-ext-700-normal.woff2?url';
import poppins from '@fontsource/poppins/files/poppins-latin-700-normal.woff2?url';

const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

export const FONTS: Record<FontId, { label: string; family: string; weight: number; files: [string, string] }> = {
  montserrat: { label: 'Montserrat', family: 'PawCut Montserrat', weight: 800, files: [montserrat, montserratExt] },
  poppins: { label: 'Poppins', family: 'PawCut Poppins', weight: 700, files: [poppins, poppinsExt] },
  anton: { label: 'Anton', family: 'PawCut Anton', weight: 400, files: [anton, antonExt] },
  bebas: { label: 'Bebas Neue', family: 'PawCut Bebas', weight: 400, files: [bebas, bebasExt] },
  bangers: { label: 'Bangers', family: 'PawCut Bangers', weight: 400, files: [bangers, bangersExt] },
  nunito: { label: 'Nunito', family: 'PawCut Nunito', weight: 800, files: [nunito, nunitoExt] },
};

export const FONT_IDS = Object.keys(FONTS) as FontId[];

/** CSS font shorthand for canvas: our font first, then system fallbacks for CJK and emoji. */
export function cssFont(id: FontId, px: number): string {
  const f = FONTS[id];
  return `${f.weight} ${px}px "${f.family}", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
}

const loading = new Map<FontId, Promise<void>>();

/** Loads a bundled font into document.fonts (once). */
export function loadFont(id: FontId): Promise<void> {
  let p = loading.get(id);
  if (!p) {
    const f = FONTS[id];
    p = Promise.all(
      f.files.map((url, i) => {
        const face = new FontFace(f.family, `url(${url}) format("woff2")`, {
          weight: String(f.weight),
          unicodeRange: i === 0 ? LATIN : LATIN_EXT,
        });
        document.fonts.add(face);
        return face.load();
      }),
    ).then(() => undefined);
    p.catch(() => loading.delete(id));
    loading.set(id, p);
  }
  return p;
}
