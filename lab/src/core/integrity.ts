/**
 * SHA-256 verification of downloaded bundle artifacts.
 *
 * The manifest has always carried a `sha256` per file, and the client never checked it.
 * `isInstalled()` only tested that files *exist*, so a truncated or corrupted download was
 * accepted as valid and then failed somewhere further away -- a decompression error or a
 * parse error with no hint about the cause.
 *
 * Kept free of React Native imports so it is unit-testable in Node.
 */

/** Hex-encoded SHA-256. Injectable so this module stays free of any crypto dependency. */
export type Digest = (data: ArrayBuffer) => Promise<string>;

export interface FileExpectation {
  name: string;
  bytes: number;
  sha256: string;
}

export class IntegrityError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(message);
    this.name = 'IntegrityError';
  }
}

/**
 * Verify one artifact against its manifest entry.
 *
 * Size is checked before hashing: it is free, and it catches the common failure --
 * a truncated download -- without hashing tens of megabytes first.
 */
export async function verifyFile(
  data: ArrayBuffer,
  expected: FileExpectation,
  digest: Digest,
): Promise<void> {
  if (data.byteLength !== expected.bytes) {
    throw new IntegrityError(
      `${expected.name}: expected ${expected.bytes} bytes, got ${data.byteLength} ` +
        '(truncated or partial download)',
      expected.name,
      String(expected.bytes),
      String(data.byteLength),
    );
  }

  const actual = await digest(data);
  if (actual.toLowerCase() !== expected.sha256.toLowerCase()) {
    throw new IntegrityError(
      `${expected.name}: checksum mismatch`,
      expected.name,
      expected.sha256,
      actual,
    );
  }
}

/**
 * Size-only check. Free, and it catches the realistic failure: an interrupted download.
 *
 * The compressed database relies on this rather than a full hash, because its zstd frame
 * carries a content checksum that the decompressor validates anyway -- hashing it in JS
 * would duplicate work the decoder already does.
 */
export function verifySize(data: ArrayBuffer, expected: FileExpectation): void {
  if (data.byteLength !== expected.bytes) {
    throw new IntegrityError(
      `${expected.name}: expected ${expected.bytes} bytes, got ${data.byteLength} ` +
        '(truncated or partial download)',
      expected.name,
      String(expected.bytes),
      String(data.byteLength),
    );
  }
}

export function findExpectation(
  files: FileExpectation[],
  name: string,
): FileExpectation | undefined {
  return files.find((f) => f.name === name);
}
