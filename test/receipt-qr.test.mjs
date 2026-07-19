import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createReceiptQr } from '../lib/receipt-qr.mjs';

test('receipt QR is a deterministic locally-generated QR matrix for the canonical receipt URL', () => {
  const url = 'https://northset-oss.github.io/verification-pilot/receipts/M-008/';
  const first = createReceiptQr(url);
  const second = createReceiptQr(url);

  assert.equal(first.version, 5);
  assert.equal(first.size, 37);
  assert.deepEqual(first.modules, second.modules);
  assert.match(first.svg, /^<svg /);
  assert.match(first.svg, /viewBox="0 0 45 45"/);
  assert.match(first.svg, /transform="translate\(4 4\)"/);
  assert.match(first.svg, /aria-label="QR code for https:\/\/northset-oss\.github\.io\/verification-pilot\/receipts\/M-008\/"/);
  const matrixDigest = createHash('sha256')
    .update(Buffer.from(first.modules.flat().map((module) => Number(module))))
    .digest('hex');
  assert.equal(matrixDigest, 'a0cf46d9b1eefdc0efecbb00210d51e3fa0360015ebacb0fb92fabc466d27937');

  // Finder patterns are required structural markers of a QR code, not decorative pixels.
  for (const [row, column] of [[0, 0], [0, 30], [30, 0]]) {
    assert.equal(first.modules[row][column], true);
    assert.equal(first.modules[row + 1][column + 1], false);
    assert.equal(first.modules[row + 3][column + 3], true);
  }
});
