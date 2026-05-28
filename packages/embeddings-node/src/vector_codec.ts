// fp16 vector ↔ base64 codec. The vector travels INSIDE the signed Fragment
// payload as a compact base64 string (~2 KB for 768-d) instead of a raw JSON
// float array (~6 KB). fp16 is lossless enough for retrieval; LanceDB applies
// its own quantization at index time.

// Node 22+/24 expose Float16Array on the global. Guard for older runtimes.
const F16: undefined | (new (x: number | ArrayBufferLike | number[]) => { buffer: ArrayBuffer }) =
  (globalThis as any).Float16Array;

export function encodeVector(vec: ArrayLike<number>): string {
  if (!F16) throw new Error('Float16Array unavailable — need Node 22+ for fp16 vector encoding');
  const f16 = new (F16 as any)(vec.length);
  for (let i = 0; i < vec.length; i++) f16[i] = vec[i];
  return Buffer.from(f16.buffer).toString('base64');
}

export function decodeVector(b64: string, dim: number): Float32Array {
  if (!F16) throw new Error('Float16Array unavailable — need Node 22+');
  const buf = Buffer.from(b64, 'base64');
  const f16 = new (F16 as any)(buf.buffer, buf.byteOffset, dim);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = f16[i];
  return out;
}
