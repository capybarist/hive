// fp16 vector ↔ base64 codec. The vector travels INSIDE the signed Fragment
// payload as a compact base64 string (~2 KB for 768-d) instead of a raw JSON
// float array (~6 KB). fp16 is lossless enough for retrieval; LanceDB applies
// its own quantization at index time.
//
// We do the half-float conversion by hand instead of using the global
// Float16Array: that global is only unflagged on newer V8 (Node 24+; Node 22
// hides it behind --js-float16array), and relying on it silently broke the
// producer on the node:22-slim image — every encode threw at runtime. Manual
// bit-twiddling is portable across every Node we ship on. Bytes are written
// little-endian explicitly so bee and queen agree regardless of host endianness.

const _scratch = new ArrayBuffer(4);
const _f32 = new Float32Array(_scratch);
const _i32 = new Int32Array(_scratch);

/** float32 → IEEE-754 half (uint16 bits), round-to-nearest. */
function f32ToF16(val: number): number {
  _f32[0] = val;
  const x = _i32[0];
  let bits = (x >> 16) & 0x8000;            // sign
  const m = (x >> 12) & 0x07ff;             // mantissa + rounding bit
  const e = (x >> 23) & 0xff;               // biased exponent
  if (e < 103) return bits;                 // underflow → signed zero
  if (e > 142) {                            // overflow → Inf (NaN collapses to Inf)
    bits |= 0x7c00;
    return bits;
  }
  if (e < 113) {                            // subnormal half
    const mm = m | 0x0800;
    bits |= (mm >> (114 - e)) + ((mm >> (113 - e)) & 1);
    return bits;
  }
  bits |= ((e - 112) << 10) | (m >> 1);
  bits += m & 1;                            // round to nearest
  return bits & 0xffff;
}

/** IEEE-754 half (uint16 bits) → float32. */
function f16ToF32(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

export function encodeVector(vec: ArrayLike<number>): string {
  const buf = Buffer.allocUnsafe(vec.length * 2);
  for (let i = 0; i < vec.length; i++) buf.writeUInt16LE(f32ToF16(vec[i]), i * 2);
  return buf.toString('base64');
}

export function decodeVector(b64: string, dim: number): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = f16ToF32(buf.readUInt16LE(i * 2));
  return out;
}
