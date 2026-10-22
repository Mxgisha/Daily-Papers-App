/**
 * Integrity verification, tested against the real bundle artifacts.
 *
 * The point of this module is to reject corrupt or truncated downloads, so the test uses
 * the actual `dist/manifest.json` checksums rather than fixtures -- a passing test means
 * the shipped artifacts verify against the shipped manifest.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IntegrityError,
  findExpectation,
  verifyFile,
  verifySize,
  type Digest,
  type FileExpectation,
} from '../src/core/integrity';

/** The device supplies pure-JS sha256; here Node's native crypto does the same job. */
const nodeDigest: Digest = async (data) =>
  createHash('sha256').update(Buffer.from(data)).digest('hex');

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, '..', '..', 'dist');

interface Manifest {
  files: FileExpectation[];
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

let manifest: Manifest;
let vectorsBytes: ArrayBuffer;

before(() => {
  if (!existsSync(join(BUNDLE, 'manifest.json'))) {
    throw new Error(`no bundle at ${BUNDLE}; run: python3 -m bundle build --out dist`);
  }
  manifest = JSON.parse(readFileSync(join(BUNDLE, 'manifest.json'), 'utf-8')) as Manifest;
  vectorsBytes = toArrayBuffer(readFileSync(join(BUNDLE, 'vectors.bin')));
});

test('the shipped manifest lists a checksum and size for every artifact', () => {
  assert.ok(manifest.files.length >= 3, 'expected db, vectors and a delta');
  for (const f of manifest.files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/, `${f.name} has a malformed sha256`);
    assert.ok(f.bytes > 0, `${f.name} declares no size`);
  }
});

test('the real vectors.bin verifies against the real manifest', async () => {
  const expected = findExpectation(manifest.files, 'vectors.bin');
  assert.ok(expected, 'manifest has no entry for vectors.bin');
  // Should not throw.
  await verifyFile(vectorsBytes, expected, nodeDigest);
});

test('vectors.bin size matches the manifest', () => {
  const expected = findExpectation(manifest.files, 'vectors.bin');
  assert.ok(expected);
  assert.equal(vectorsBytes.byteLength, expected.bytes);
});

test('a single flipped byte is rejected', async () => {
  const expected = findExpectation(manifest.files, 'vectors.bin');
  assert.ok(expected);

  const copy = new Uint8Array(vectorsBytes.slice(0));
  // Flip a bit deep in the codes region, past the header, where corruption would silently
  // produce wrong recommendations rather than a parse error.
  const target = Math.floor(copy.length * 0.75);
  copy[target] ^= 0x01;

  await assert.rejects(
    () => verifyFile(copy.buffer as ArrayBuffer, expected, nodeDigest),
    (err: unknown) => {
      assert.ok(err instanceof IntegrityError, 'expected an IntegrityError');
      assert.equal(err.file, 'vectors.bin');
      assert.match(err.message, /checksum mismatch/);
      return true;
    },
  );
});

test('a truncated download is rejected on size before hashing', async () => {
  const expected = findExpectation(manifest.files, 'vectors.bin');
  assert.ok(expected);

  const truncated = vectorsBytes.slice(0, Math.floor(vectorsBytes.byteLength / 2));
  let hashed = false;
  const countingDigest = async (data: ArrayBuffer) => {
    hashed = true;
    return nodeDigest(data);
  };

  await assert.rejects(
    () => verifyFile(truncated, expected, countingDigest),
    (err: unknown) => {
      assert.ok(err instanceof IntegrityError);
      assert.match(err.message, /truncated or partial download/);
      return true;
    },
  );
  // Size is checked first deliberately, so a 47 MB mismatch never reaches the hash.
  assert.equal(hashed, false, 'should not hash a size-mismatched file');
});

test('verifySize accepts the right length and rejects others', () => {
  const expected = findExpectation(manifest.files, 'vectors.bin');
  assert.ok(expected);
  verifySize(vectorsBytes, expected);
  assert.throws(() => verifySize(vectorsBytes.slice(0, 10), expected), IntegrityError);
});

test('a missing manifest entry is reported rather than silently skipped', () => {
  assert.equal(findExpectation(manifest.files, 'does-not-exist.bin'), undefined);
});
