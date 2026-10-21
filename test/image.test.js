// -----------------------------------------------------------------------------
// The text cleaning, the layout, the drawing and the JPEG encoder.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS } from '../src/constants.js';
import { GLYPHS, GLYPH_HEIGHT, GLYPH_WIDTH } from '../src/image/font.js';
import { encodeJpeg, scaledTable } from '../src/image/jpeg.js';
import { cleanDisplayText, layout, renderText, wrap } from '../src/image/text.js';

test('the font: every glyph is 5 x 9, printable ASCII and French letters are there', () => {
  for (const [char, rows] of GLYPHS) {
    assert.equal(rows.length, GLYPH_HEIGHT, char);
    assert.ok(
      rows.every((r) => r.length === GLYPH_WIDTH),
      char,
    );
  }
  for (let code = 32; code < 127; code += 1) {
    assert.ok(GLYPHS.has(String.fromCharCode(code)), String.fromCharCode(code));
  }
  for (const char of 'àâäéèêëîïôöùûüÿçÇñ°€') {
    assert.ok(GLYPHS.has(char), char);
  }
});

test('cleaning: control and invisible characters dropped, typography simplified, bounded', () => {
  assert.equal(cleanDisplayText('  Bonjour\r\n\u0000à\u{200b}tous\u0007 '), 'Bonjour\nàtous');
  assert.equal(cleanDisplayText('a\u{a0}b\u{202f}c'), 'a b c');
  assert.equal(cleanDisplayText('« Œuvre » – l’été…'), '" OEuvre " - l\'été...');
  assert.equal(cleanDisplayText('Ångström 😀'), 'Angström ?');
  assert.equal(cleanDisplayText('ÉCOLE'), 'ECOLE');
  assert.equal(cleanDisplayText(42), '42');
  assert.equal(cleanDisplayText(undefined), '');
  assert.equal(cleanDisplayText({ toString: () => 'x' }), '');
  assert.equal(cleanDisplayText('\n\n \u{200b}\n'), '');
  assert.equal(cleanDisplayText('x'.repeat(100_000)).length, LIMITS.textChars);
  assert.equal(cleanDisplayText('a\n'.repeat(100)).split('\n').length, LIMITS.textLines);
});

test('M5 leading blanks never eat the budget, blanks merged', () => {
  assert.equal(cleanDisplayText('\n'.repeat(1000) + 'a'), 'a');
  assert.equal(cleanDisplayText(' '.repeat(300) + 'Bonjour'), 'Bonjour');
  assert.equal(cleanDisplayText(' '.repeat(10_000_000) + 'x'), 'x');
  assert.equal(cleanDisplayText('a\n\n\n\n\nb   c'), 'a\n\nb c');
  assert.equal(cleanDisplayText(`a${'\n'.repeat(500)}${'b'.repeat(400)}`).length, LIMITS.textChars);
});

test('wrapping: words kept whole, long words cut, line breaks kept', () => {
  assert.deepEqual(wrap('le chat dort', 7), ['le chat', 'dort']);
  assert.deepEqual(wrap('anticonstitutionnel', 8), ['anticons', 'titution', 'nel']);
  assert.deepEqual(wrap('a\n\nb', 10), ['a', '', 'b']);
});

test('layout: as large as it fits, a fixed size cuts with "..."', () => {
  const short = layout('OK', 296, 128);
  assert.ok(short.scale >= 6, `scale ${short.scale}`);
  const long = layout('word '.repeat(50), 296, 128);
  assert.equal(long.scale, 1);
  const cut = layout('word '.repeat(200), 152, 152, 'large');
  assert.equal(cut.scale, 3);
  assert.ok(cut.lines.at(-1).endsWith('...'));
});

test('drawing: the ink only where the text is, inside the image', () => {
  const { pixels } = renderText('I', {
    width: 40,
    height: 30,
    ink: [255, 0, 0],
    paper: [255, 255, 255],
  });
  assert.equal(pixels.length, 40 * 30 * 3);
  let red = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    const rgb = [pixels[i], pixels[i + 1], pixels[i + 2]].join();
    assert.ok(rgb === '255,0,0' || rgb === '255,255,255', rgb);
    red += rgb === '255,0,0' ? 1 : 0;
  }
  assert.ok(red > 0);
});

test('JPEG: baseline markers, the size in the frame header, quality tables bounded', () => {
  const width = 296;
  const height = 128;
  const { pixels } = renderText('Hello', { width, height, ink: [0, 0, 0], paper: [255, 255, 255] });
  const jpeg = encodeJpeg(pixels, width, height, { quality: 95 });
  assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...jpeg.subarray(-2)], [0xff, 0xd9]);
  const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(sof > 0, 'baseline SOF0');
  assert.equal(jpeg.readUInt16BE(sof + 5), height);
  assert.equal(jpeg.readUInt16BE(sof + 7), width);
  assert.equal(jpeg[sof + 9], 3, 'three components');
  assert.ok(jpeg.length < 64 * 1024);
  for (const q of [1, 50, 100]) {
    assert.ok(scaledTable([16, 99, 255], q).every((v) => v >= 1 && v <= 255));
  }
});

test('JPEG: past the bound, a RangeError (the caller lowers the quality)', () => {
  const width = 400;
  const height = 300;
  const noise = Buffer.alloc(width * height * 3);
  let seed = 7;
  for (let i = 0; i < noise.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = seed & 0xff;
  }
  assert.throws(
    () => encodeJpeg(noise, width, height, { quality: 95, maxBytes: 10_000 }),
    RangeError,
  );
  assert.throws(() => encodeJpeg(noise, 0, height), RangeError);
  assert.throws(() => encodeJpeg(Buffer.alloc(3), 10, 10), RangeError);
});
