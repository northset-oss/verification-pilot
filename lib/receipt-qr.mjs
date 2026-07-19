const VERSION = 5;
const SIZE = VERSION * 4 + 17;
const DATA_CODEWORDS = 108;
const ERROR_CORRECTION_CODEWORDS = 26;
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

let value = 1;
for (let index = 0; index < 255; index += 1) {
  EXP[index] = value;
  LOG[value] = index;
  value <<= 1;
  if (value & 0x100) value ^= 0x11d;
}
for (let index = 255; index < EXP.length; index += 1) EXP[index] = EXP[index - 255];

function multiply(left, right) {
  if (left === 0 || right === 0) return 0;
  return EXP[LOG[left] + LOG[right]];
}

function generatorPolynomial(degree) {
  let polynomial = [1];
  for (let index = 0; index < degree; index += 1) {
    const next = new Array(polynomial.length + 1).fill(0);
    for (let coefficient = 0; coefficient < polynomial.length; coefficient += 1) {
      next[coefficient] ^= polynomial[coefficient];
      next[coefficient + 1] ^= multiply(polynomial[coefficient], EXP[index]);
    }
    polynomial = next;
  }
  return polynomial;
}

function errorCorrection(data) {
  const generator = generatorPolynomial(ERROR_CORRECTION_CODEWORDS);
  const remainder = new Array(ERROR_CORRECTION_CODEWORDS).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift();
    remainder.push(0);
    for (let index = 0; index < ERROR_CORRECTION_CODEWORDS; index += 1) {
      remainder[index] ^= multiply(generator[index + 1], factor);
    }
  }
  return remainder;
}

function appendBits(bits, valueToAppend, length) {
  for (let index = length - 1; index >= 0; index -= 1) {
    bits.push((valueToAppend >>> index) & 1);
  }
}

function makeCodewords(text) {
  const data = Buffer.from(text, 'utf8');
  if (data.length > 106) throw new RangeError('receipt URL exceeds QR version 5-L byte capacity');

  const bits = [];
  appendBits(bits, 0b0100, 4); // Byte mode.
  appendBits(bits, data.length, 8);
  for (const byte of data) appendBits(bits, byte, 8);
  appendBits(bits, 0, Math.min(4, DATA_CODEWORDS * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const result = [];
  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit += 1) byte = (byte << 1) | bits[index + bit];
    result.push(byte);
  }
  for (let pad = 0; result.length < DATA_CODEWORDS; pad += 1) result.push(pad % 2 === 0 ? 0xec : 0x11);
  return [...result, ...errorCorrection(result)];
}

function createMatrix() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
}

function setModule(modules, row, column, dark) {
  if (row >= 0 && row < SIZE && column >= 0 && column < SIZE) modules[row][column] = dark;
}

function drawFinder(modules, top, left) {
  for (let row = -1; row <= 7; row += 1) {
    for (let column = -1; column <= 7; column += 1) {
      const inFinder = row >= 0 && row <= 6 && column >= 0 && column <= 6;
      const dark = inFinder && (
        row === 0 || row === 6 || column === 0 || column === 6
        || (row >= 2 && row <= 4 && column >= 2 && column <= 4)
      );
      setModule(modules, top + row, left + column, dark);
    }
  }
}

function drawAlignment(modules, centerRow, centerColumn) {
  for (let row = -2; row <= 2; row += 1) {
    for (let column = -2; column <= 2; column += 1) {
      const distance = Math.max(Math.abs(row), Math.abs(column));
      setModule(modules, centerRow + row, centerColumn + column, distance !== 1);
    }
  }
}

function reserveFormat(modules) {
  for (let index = 0; index <= 5; index += 1) {
    setModule(modules, 8, index, false);
    setModule(modules, index, 8, false);
  }
  setModule(modules, 8, 7, false);
  setModule(modules, 8, 8, false);
  setModule(modules, 7, 8, false);
  for (let index = 9; index < 15; index += 1) setModule(modules, 14 - index, 8, false);
  for (let index = 0; index < 8; index += 1) setModule(modules, 8, SIZE - 1 - index, false);
  for (let index = 8; index < 15; index += 1) setModule(modules, SIZE - 15 + index, 8, false);
}

function drawFunctionPatterns(modules) {
  drawFinder(modules, 0, 0);
  drawFinder(modules, 0, SIZE - 7);
  drawFinder(modules, SIZE - 7, 0);
  for (let index = 8; index < SIZE - 8; index += 1) {
    setModule(modules, 6, index, index % 2 === 0);
    setModule(modules, index, 6, index % 2 === 0);
  }
  drawAlignment(modules, 30, 30);
  reserveFormat(modules);
  setModule(modules, SIZE - 8, 8, true);
}

function placeData(modules, codewords) {
  const bits = [];
  for (const byte of codewords) appendBits(bits, byte, 8);
  let bitIndex = 0;
  let row = SIZE - 1;
  let step = -1;

  for (let column = SIZE - 1; column > 0; column -= 2) {
    if (column === 6) column -= 1;
    while (true) {
      for (let offset = 0; offset < 2; offset += 1) {
        const currentColumn = column - offset;
        if (modules[row][currentColumn] !== null) continue;
        const bit = bitIndex < bits.length ? bits[bitIndex] : 0;
        bitIndex += 1;
        // Mask 0: (row + column) mod 2 == 0. This is a valid QR mask chosen
        // deterministically, not a decorative pixel pattern.
        modules[row][currentColumn] = bit === 1 ? (row + currentColumn) % 2 !== 0 : (row + currentColumn) % 2 === 0;
      }
      row += step;
      if (row < 0 || row >= SIZE) {
        row -= step;
        step = -step;
        break;
      }
    }
  }
}

function bchRemainder(valueToEncode, polynomial) {
  let value = valueToEncode;
  const degree = Math.floor(Math.log2(polynomial));
  while (Math.floor(Math.log2(value)) >= degree) {
    value ^= polynomial << (Math.floor(Math.log2(value)) - degree);
  }
  return value;
}

function drawFormat(modules) {
  // Error-correction level L (01) and mask 0, BCH(15, 5), XOR 0x5412.
  const data = 0b01000;
  const format = ((data << 10) | bchRemainder(data << 10, 0x537)) ^ 0x5412;
  const bit = (index) => ((format >>> index) & 1) === 1;

  for (let index = 0; index <= 5; index += 1) setModule(modules, index, 8, bit(index));
  setModule(modules, 7, 8, bit(6));
  setModule(modules, 8, 8, bit(7));
  setModule(modules, 8, 7, bit(8));
  for (let index = 9; index < 15; index += 1) setModule(modules, 8, 14 - index, bit(index));
  for (let index = 0; index < 8; index += 1) setModule(modules, 8, SIZE - 1 - index, bit(index));
  for (let index = 8; index < 15; index += 1) setModule(modules, SIZE - 15 + index, 8, bit(index));
  setModule(modules, SIZE - 8, 8, true);
}

function escapeAttribute(valueToEscape) {
  return valueToEscape
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderSvg(modules, label) {
  const quietZone = 4;
  const viewSize = SIZE + quietZone * 2;
  const squares = [];
  for (let row = 0; row < SIZE; row += 1) {
    for (let column = 0; column < SIZE; column += 1) {
      if (modules[row][column]) squares.push(`M${column},${row}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" role="img" aria-label="${escapeAttribute(label)}" shape-rendering="crispEdges"><path fill="#fff" d="M0 0h${viewSize}v${viewSize}H0z"/><path fill="#111" transform="translate(${quietZone} ${quietZone})" d="${squares.join('')}"/></svg>`;
}

/**
 * Create a real, locally encoded Version 5-L QR code for a canonical receipt URL.
 * It uses QR byte mode, Reed-Solomon error correction, standard function patterns,
 * format data, and mask 0; no service or runtime dependency is involved.
 */
export function createReceiptQr(url) {
  if (typeof url !== 'string' || url.length === 0) throw new TypeError('QR URL must be a non-empty string');
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('QR URL must be HTTP(S)');

  const modules = createMatrix();
  drawFunctionPatterns(modules);
  placeData(modules, makeCodewords(url));
  drawFormat(modules);
  return {
    version: VERSION,
    size: SIZE,
    modules,
    svg: renderSvg(modules, `QR code for ${url}`),
  };
}
