// -----------------------------------------------------------------------------
// From a text a scene gives to an image the size of the display (pure):
// cleaning (bounded, only characters the font draws), word wrapping, the
// largest whole scale that fits, then the pixels in RGB.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';
import { GLYPHS, GLYPH_HEIGHT, GLYPH_WIDTH } from './font.js';

/** Typographic characters drawn as their plain form. */
const REPLACE = new Map([
  ['‘', "'"],
  ['’', "'"],
  ['‚', "'"],
  ['“', '"'],
  ['”', '"'],
  ['„', '"'],
  ['«', '"'],
  ['»', '"'],
  ['–', '-'],
  ['—', '-'],
  ['−', '-'],
  ['…', '...'],
  ['\u{a0}', ' '],
  ['\u{202f}', ' '],
  ['\u{2009}', ' '],
  ['\t', ' '],
  ['œ', 'oe'],
  ['Œ', 'OE'],
  ['æ', 'ae'],
  ['Æ', 'AE'],
  ['ß', 'ss'],
]);

/** The first character that is neither blank, control nor invisible. */
const VISIBLE =
  // eslint-disable-next-line no-control-regex
  /[^\s\u{0}-\u{1f}\u{7f}-\u{9f}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{feff}]/u;
/** Zero-width and direction marks: dropped, never drawn. */
const INVISIBLE =
  /[\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{feff}]/gu;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

/**
 * The text as the font can draw it: at most LIMITS.textChars characters and
 * LIMITS.textLines lines, control characters dropped, line breaks kept,
 * accents the font lacks removed, anything else shown as "?". Empty when
 * nothing printable is left.
 */
export function cleanDisplayText(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return '';
  }
  const all = String(value);
  // Leading blanks never count; then bounded before any work: a huge value
  // costs no more than a long one.
  const start = all.search(VISIBLE);
  if (start < 0) {
    return '';
  }
  const raw = all.slice(start, start + LIMITS.textChars * 4);
  const normalized = raw
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .replace(CONTROL, ' ')
    .normalize('NFC');
  let out = '';
  // Blanks are merged as they come: no space at the start of a line, no run
  // of spaces, at most one empty line in a row, so they never eat the budget.
  const add = (piece) => {
    for (const c of piece) {
      if (c === ' ' && (out === '' || out.endsWith(' ') || out.endsWith('\n'))) {
        continue;
      }
      if (c === '\n' && (out === '' || out.endsWith('\n\n'))) {
        continue;
      }
      if (c === '\n' && out.endsWith(' ')) {
        out = out.slice(0, -1);
      }
      out += c;
    }
  };
  for (const char of normalized) {
    if (char === '\n' || GLYPHS.has(char)) {
      add(char);
    } else if (REPLACE.has(char)) {
      add(REPLACE.get(char));
    } else {
      const base = char.normalize('NFD').replace(/[\u{300}-\u{36f}]/gu, '');
      add(base.length > 0 && [...base].every((c) => GLYPHS.has(c)) ? base : '?');
    }
    if (out.length >= LIMITS.textChars) {
      break;
    }
  }
  const lines = out
    .slice(0, LIMITS.textChars)
    .split('\n')
    .map((l) => l.trim());
  while (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.slice(0, LIMITS.textLines).join('\n');
}

/** Characters per line and lines that fit at a scale. */
const capacity = (width, height, scale, margin) => ({
  columns: Math.floor((width - 2 * margin + scale) / ((GLYPH_WIDTH + 1) * scale)),
  rows: Math.floor((height - 2 * margin + scale) / ((GLYPH_HEIGHT + 1) * scale)),
});

/** Greedy word wrap at `columns` characters; a longer word is cut. */
export function wrap(text, columns) {
  const out = [];
  if (columns < 1) {
    return out;
  }
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (let word of paragraph.split(/ +/).filter(Boolean)) {
      while (word.length > columns) {
        if (line !== '') {
          out.push(line);
          line = '';
        }
        out.push(word.slice(0, columns));
        word = word.slice(columns);
      }
      if (word === '') {
        continue;
      }
      if (line === '') {
        line = word;
      } else if (line.length + 1 + word.length <= columns) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

const SIZES = { small: 1, medium: 2, large: 3 };

/**
 * The lines and the scale: `size` 'auto' takes the largest scale (up to 12)
 * at which the whole text fits; a fixed size keeps its scale and cuts what
 * does not fit, ending with "...".
 */
export function layout(text, width, height, size = 'auto') {
  const margin = Math.max(2, Math.round(Math.min(width, height) / 40));
  const fits = (scale) => {
    const { columns, rows } = capacity(width, height, scale, margin);
    const lines = wrap(text, columns);
    return { columns, rows, lines, ok: columns >= 1 && lines.length <= rows };
  };
  let scale = SIZES[size];
  if (!scale) {
    scale = 1;
    for (let s = 12; s >= 1; s -= 1) {
      if (fits(s).ok) {
        scale = s;
        break;
      }
    }
  }
  let { columns, rows, lines } = fits(scale);
  while (scale > 1 && (columns < 1 || rows < 1)) {
    scale -= 1;
    ({ columns, rows, lines } = fits(scale));
  }
  if (lines.length > rows) {
    lines = lines.slice(0, Math.max(0, rows));
    if (lines.length) {
      const last = lines[lines.length - 1];
      lines[lines.length - 1] = `${last.slice(0, Math.max(0, columns - 3))}...`.slice(0, columns);
    }
  }
  return { lines, scale, margin };
}

/**
 * The image: `width` x `height` RGB bytes (3 per pixel), the text drawn in
 * `ink` on `paper`, centred vertically, centred or left aligned.
 */
export function renderText(text, { width, height, ink, paper, size = 'auto', align = 'center' }) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 3] = paper[0];
    pixels[i * 3 + 1] = paper[1];
    pixels[i * 3 + 2] = paper[2];
  }
  const { lines, scale, margin } = layout(text, width, height, size);
  const advance = (GLYPH_WIDTH + 1) * scale;
  const lineHeight = (GLYPH_HEIGHT + 1) * scale;
  const blockHeight = lines.length * lineHeight - scale;
  const top = Math.max(margin, Math.floor((height - blockHeight) / 2));
  lines.forEach((line, row) => {
    const chars = [...line];
    const lineWidth = chars.length * advance - scale;
    const left = align === 'left' ? margin : Math.max(margin, Math.floor((width - lineWidth) / 2));
    chars.forEach((char, column) => {
      const glyph = GLYPHS.get(char) ?? GLYPHS.get('?');
      const x0 = left + column * advance;
      const y0 = top + row * lineHeight;
      for (let gy = 0; gy < GLYPH_HEIGHT; gy += 1) {
        for (let gx = 0; gx < GLYPH_WIDTH; gx += 1) {
          if (!glyph[gy][gx]) {
            continue;
          }
          for (let dy = 0; dy < scale; dy += 1) {
            const y = y0 + gy * scale + dy;
            if (y < 0 || y >= height) {
              continue;
            }
            for (let dx = 0; dx < scale; dx += 1) {
              const x = x0 + gx * scale + dx;
              if (x < 0 || x >= width) {
                continue;
              }
              const i = (y * width + x) * 3;
              pixels[i] = ink[0];
              pixels[i + 1] = ink[1];
              pixels[i + 2] = ink[2];
            }
          }
        }
      }
    });
  });
  return { pixels, lines, scale };
}
