/**
 * Parser for `vectors.bin`.
 *
 * This is a port of `read_vectors()` in bundle/builder.py, which is the authoritative
 * implementation. The two are cross-checked in tests/ against the real bundle artifacts, so
 * a drift between them fails the build rather than silently corrupting recommendations.
 *
 * Format (all little-endian):
 *
 *   magic        4 bytes    "DPV1"
 *   header_len   uint32     length of the JSON header
 *   header       JSON       encoding, count, dim, code_dtype, centered, layout
 *   ids          int64[count]     maps row -> papers.id
 *   scales       float32[count]   per-vector scale (uniformly 1.0 for binary)
 *   codes        int8|uint8[count, dim]
 *   centroid     float32[dim]     subtracted before quantization
 *
 * Vectors are mean-centered before quantization, so a plain int8 dot product against these
 * codes yields *centered* cosine directly -- no centroid arithmetic at query time, which is
 * the entire point of baking it in at build time.
 */

export const VECTOR_MAGIC = 'DPV1';
export const VECTOR_DIM = 768;

export type VectorEncoding = 'int8' | 'binary';

export interface VectorFile {
  encoding: VectorEncoding;
  count: number;
  dim: number;
  /** Row offset -> papers.id */
  ids: BigInt64Array;
  scales: Float32Array;
  /** length = count * dim, row-major */
  codes: Int8Array | Uint8Array;
  centroid: Float32Array;
}

interface Header {
  encoding: VectorEncoding;
  count: number;
  dim: number;
  code_dtype: string;
  centered?: boolean;
  layout?: string[];
}

/** Alignment-safe little-endian reads. The buffer offset is not guaranteed to be aligned. */
function readUint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

export function parseVectors(buffer: ArrayBuffer): VectorFile {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  if (bytes.length < 8) {
    throw new Error(`vectors.bin too short: ${bytes.length} bytes`);
  }

  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== VECTOR_MAGIC) {
    throw new Error(`bad magic ${JSON.stringify(magic)}, expected ${VECTOR_MAGIC}`);
  }

  const headerLen = readUint32(view, 4);
  const headerEnd = 8 + headerLen;
  if (headerEnd > bytes.length) {
    throw new Error(`header length ${headerLen} exceeds file size ${bytes.length}`);
  }

  const headerText = new TextDecoder('utf-8').decode(bytes.subarray(8, headerEnd));
  const header = JSON.parse(headerText) as Header;

  const { count, dim } = header;
  const codeBytes = header.code_dtype === 'int8' ? 1 : 1; // both are 1 byte
  const idsBytes = count * 8;
  const scalesBytes = count * 4;
  const codesBytes = count * dim * codeBytes;
  const centroidBytes = dim * 4;

  const expected =
    headerEnd + idsBytes + scalesBytes + codesBytes + centroidBytes;
  if (bytes.length < expected) {
    throw new Error(
      `truncated vectors.bin: have ${bytes.length} bytes, format needs ${expected}`,
    );
  }

  let offset = headerEnd;

  // BigInt64Array requires 8-byte alignment, so slice into a fresh buffer instead of
  // viewing a potentially unaligned offset.
  const ids = new BigInt64Array(buffer.slice(offset, offset + idsBytes));
  offset += idsBytes;

  const scales = new Float32Array(buffer.slice(offset, offset + scalesBytes));
  offset += scalesBytes;

  const codes =
    header.code_dtype === 'int8'
      ? new Int8Array(buffer.slice(offset, offset + codesBytes))
      : new Uint8Array(buffer.slice(offset, offset + codesBytes));
  offset += codesBytes;

  const centroid = new Float32Array(buffer.slice(offset, offset + centroidBytes));

  return {
    encoding: header.encoding,
    count,
    dim,
    ids,
    scales,
    codes,
    centroid,
  };
}

/**
 * Approximate centered cosine of every row against one query vector.
 *
 * Mirrors `int8_scores()` in dailypapers/quantize.py: an integer dot product rescaled by
 * the per-row scale. The accumulator is a plain number, which is exact here -- int8 codes
 * are within +/-127 and the query is within +/-1, so products stay far inside the float64
 * safe range even at 768 dimensions.
 */
export function scoreAll(
  file: VectorFile,
  query: Float32Array,
): Float32Array {
  const { codes, scales, count, dim } = file;
  if (query.length !== dim) {
    throw new Error(`query has ${query.length} dims, corpus has ${dim}`);
  }

  const out = new Float32Array(count);

  if (file.encoding === 'binary') {
    // Sign bits: agreement is a Hamming-style count, rescaled to look like a similarity.
    for (let row = 0; row < count; row++) {
      const base = row * dim;
      let agree = 0;
      for (let d = 0; d < dim; d++) {
        const bit = codes[base + d] > 0 ? 1 : -1;
        if ((bit > 0) === (query[d] > 0)) agree++;
      }
      out[row] = agree / dim;
    }
    return out;
  }

  for (let row = 0; row < count; row++) {
    const base = row * dim;
    let acc = 0;
    for (let d = 0; d < dim; d++) {
      acc += codes[base + d] * query[d];
    }
    out[row] = acc * scales[row];
  }
  return out;
}

/** Reconstruct a row as a float vector. Used for seed vectors and MMR penalties. */
export function decodeRow(file: VectorFile, row: number): Float32Array {
  const { codes, scales, dim, encoding } = file;
  const out = new Float32Array(dim);
  const base = row * dim;
  if (encoding === 'binary') {
    for (let d = 0; d < dim; d++) out[d] = codes[base + d] > 0 ? 1 : -1;
  } else {
    const scale = scales[row];
    for (let d = 0; d < dim; d++) out[d] = codes[base + d] * scale;
  }
  return out;
}

/** In-place L2 normalization; returns the same array for chaining. */
export function normalizeInPlace(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  if (norm > 1e-12) {
    for (let i = 0; i < v.length; i++) v[i] /= norm;
  }
  return v;
}
