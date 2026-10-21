// -----------------------------------------------------------------------------
// A baseline JPEG encoder (pure, no dependency): the format the access point
// takes on /imgupload. Three components (YCbCr), no chroma subsampling (4:4:4,
// so a red text on a black and white display keeps sharp edges), the quality
// scaled tables and the standard Huffman tables of the JPEG specification
// (ITU-T T.81, annex K). The output is bounded: past `maxBytes` the encoder
// stops and throws a RangeError, the caller then lowers the quality.
// -----------------------------------------------------------------------------

/** Zig-zag order: position in the stream -> index in the 8x8 block (row major). */
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

/** Annex K.1 quantization tables, row major. */
const LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
  92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_Q = [
  17,
  18,
  24,
  47,
  99,
  99,
  99,
  99,
  18,
  21,
  26,
  66,
  99,
  99,
  99,
  99,
  24,
  26,
  56,
  99,
  99,
  99,
  99,
  99,
  47,
  66,
  ...Array(38).fill(99),
];

/** Annex K.3 Huffman tables: code counts per length (1 to 16), then the values. */
const DC_LUMA = {
  bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
  values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const DC_CHROMA = {
  bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
  values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const AC_LUMA = {
  bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  values: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
  ],
};
const AC_CHROMA = {
  bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  values: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
    0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
    0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
    0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
    0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
    0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
    0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
  ],
};

/** The canonical codes of a table: value -> [code, length]. */
function codes({ bits, values }) {
  const out = new Map();
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let i = 0; i < bits[length - 1]; i += 1) {
      out.set(values[k], [code, length]);
      code += 1;
      k += 1;
    }
    code <<= 1;
  }
  return out;
}

const HUFFMAN = {
  dc: [codes(DC_LUMA), codes(DC_CHROMA)],
  ac: [codes(AC_LUMA), codes(AC_CHROMA)],
};

/** The quantization table of a quality (1 to 100), row major (IJG scaling). */
export function scaledTable(base, quality) {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - 2 * q;
  return base.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
}

/** DCT matrix: M[u][x] = C(u) / 2 * cos((2x + 1) u pi / 16). */
const DCT = Array.from({ length: 8 }, (_, u) =>
  Array.from(
    { length: 8 },
    (__, x) => ((u === 0 ? Math.SQRT1_2 : 1) / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16),
  ),
);

/** Forward DCT of a block (row major, values centred on 0), in place into `out`. */
function fdct(block, out, tmp) {
  for (let y = 0; y < 8; y += 1) {
    for (let u = 0; u < 8; u += 1) {
      let sum = 0;
      for (let x = 0; x < 8; x += 1) {
        sum += DCT[u][x] * block[y * 8 + x];
      }
      tmp[y * 8 + u] = sum;
    }
  }
  for (let u = 0; u < 8; u += 1) {
    for (let v = 0; v < 8; v += 1) {
      let sum = 0;
      for (let y = 0; y < 8; y += 1) {
        sum += DCT[v][y] * tmp[y * 8 + u];
      }
      out[v * 8 + u] = sum;
    }
  }
}

/** Bytes written into one buffer sized once; past its end, a RangeError. */
class Output {
  constructor(maxBytes) {
    this.buffer = Buffer.allocUnsafe(maxBytes);
    this.length = 0;
    this.bits = 0;
    this.count = 0;
  }

  byte(b) {
    if (this.length >= this.buffer.length) {
      throw new RangeError('JPEG larger than allowed');
    }
    this.buffer[this.length] = b;
    this.length += 1;
  }

  bytes(list) {
    for (const b of list) {
      this.byte(b);
    }
  }

  word(w) {
    this.byte((w >> 8) & 0xff);
    this.byte(w & 0xff);
  }

  /** Entropy-coded bits, with a 0x00 stuffed after every 0xFF. */
  put(code, length) {
    this.bits = (this.bits << length) | (code & ((1 << length) - 1));
    this.count += length;
    while (this.count >= 8) {
      const b = (this.bits >> (this.count - 8)) & 0xff;
      this.byte(b);
      if (b === 0xff) {
        this.byte(0);
      }
      this.count -= 8;
    }
    this.bits &= (1 << this.count) - 1;
  }

  flush() {
    if (this.count > 0) {
      this.put((1 << (8 - this.count)) - 1, 8 - this.count);
    }
  }
}

const category = (v) => {
  let a = Math.abs(v);
  let n = 0;
  while (a > 0) {
    n += 1;
    a >>= 1;
  }
  return n;
};
const magnitude = (v, n) => (v >= 0 ? v : v + (1 << n) - 1);

function huffmanSegment(out, tableClass, id, table) {
  out.word(0xffc4);
  out.word(2 + 1 + 16 + table.values.length);
  out.byte((tableClass << 4) | id);
  out.bytes(table.bits);
  out.bytes(table.values);
}

/**
 * Encodes `width` x `height` RGB bytes (3 per pixel, row major) as a baseline
 * JPEG; returns the bytes. Throws a RangeError past `maxBytes`.
 */
export function encodeJpeg(rgb, width, height, { quality = 95, maxBytes = 512 * 1024 } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError('Bad image size');
  }
  if (width > 65535 || height > 65535 || rgb.length < width * height * 3) {
    throw new RangeError('Bad image size');
  }
  const tables = [scaledTable(LUMA_Q, quality), scaledTable(CHROMA_Q, quality)];
  const out = new Output(maxBytes);
  out.word(0xffd8);
  // JFIF APP0.
  out.word(0xffe0);
  out.word(16);
  out.bytes([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  // Quantization tables, in zig-zag order.
  for (const [id, table] of tables.entries()) {
    out.word(0xffdb);
    out.word(67);
    out.byte(id);
    for (let k = 0; k < 64; k += 1) {
      out.byte(table[ZIGZAG[k]]);
    }
  }
  // Start of frame: baseline, 8 bits, three components 1x1.
  out.word(0xffc0);
  out.word(17);
  out.byte(8);
  out.word(height);
  out.word(width);
  out.byte(3);
  out.bytes([1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  huffmanSegment(out, 0, 0, DC_LUMA);
  huffmanSegment(out, 1, 0, AC_LUMA);
  huffmanSegment(out, 0, 1, DC_CHROMA);
  huffmanSegment(out, 1, 1, AC_CHROMA);
  // Start of scan.
  out.word(0xffda);
  out.word(12);
  out.byte(3);
  out.bytes([1, 0x00, 2, 0x11, 3, 0x11]);
  out.bytes([0, 63, 0]);

  const blocks = [new Float64Array(64), new Float64Array(64), new Float64Array(64)];
  const coefficients = new Float64Array(64);
  const tmp = new Float64Array(64);
  const previousDc = [0, 0, 0];
  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      for (let y = 0; y < 8; y += 1) {
        // Past the edge, the last row and column repeat.
        const sy = Math.min(height - 1, by + y);
        for (let x = 0; x < 8; x += 1) {
          const sx = Math.min(width - 1, bx + x);
          const i = (sy * width + sx) * 3;
          const r = rgb[i];
          const g = rgb[i + 1];
          const b = rgb[i + 2];
          blocks[0][y * 8 + x] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
          blocks[1][y * 8 + x] = -0.168736 * r - 0.331264 * g + 0.5 * b;
          blocks[2][y * 8 + x] = 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }
      for (let c = 0; c < 3; c += 1) {
        const t = c === 0 ? 0 : 1;
        fdct(blocks[c], coefficients, tmp);
        const q = tables[t];
        // DC.
        const dc = Math.round(coefficients[0] / q[0]);
        const diff = dc - previousDc[c];
        previousDc[c] = dc;
        const dcCat = category(diff);
        const [dcCode, dcLength] = HUFFMAN.dc[t].get(dcCat);
        out.put(dcCode, dcLength);
        if (dcCat) {
          out.put(magnitude(diff, dcCat), dcCat);
        }
        // AC, in zig-zag order, with runs of zeros.
        let run = 0;
        for (let k = 1; k < 64; k += 1) {
          const index = ZIGZAG[k];
          const v = Math.round(coefficients[index] / q[index]);
          if (v === 0) {
            run += 1;
            continue;
          }
          while (run > 15) {
            const [zrl, zrlLength] = HUFFMAN.ac[t].get(0xf0);
            out.put(zrl, zrlLength);
            run -= 16;
          }
          const cat = category(v);
          const [code, length] = HUFFMAN.ac[t].get((run << 4) | cat);
          out.put(code, length);
          out.put(magnitude(v, cat), cat);
          run = 0;
        }
        if (run > 0) {
          const [eob, eobLength] = HUFFMAN.ac[t].get(0x00);
          out.put(eob, eobLength);
        }
      }
    }
  }
  out.flush();
  out.word(0xffd9);
  return Buffer.from(out.buffer.subarray(0, out.length));
}
