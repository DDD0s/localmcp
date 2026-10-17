// MCP-only relay framing. Never accepts a destination URL from the edge.
// Default chunk size matches the original public relay. Larger chunks and gzip
// are used only after a self-hosted relay advertises protocol 2.
export const MAX_BYTES = 8 * 1024 * 1024;
export const CHUNK_SIZE = 24000;
export const NEGOTIATED_CHUNK_SIZE = 120000;
const COMPRESS_MIN = 4096;

export interface Frame { id: string; index: number; total: number; data: string; enc?: 'gzip' }
export type Assembled = { value: unknown } | { gzip: string };

export interface FrameOptions { chunkSize?: number; compress?: boolean }

export function frames(id: string, value: unknown, chunkSize = CHUNK_SIZE): string[] {
  const data = JSON.stringify(value);
  if (new TextEncoder().encode(data).length > MAX_BYTES) throw new Error('Relay payload exceeds 8 MiB');
  return pack(id, data, normalizeChunk(chunkSize));
}

export async function buildFrames(id: string, value: unknown, options: FrameOptions = {}): Promise<string[]> {
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length > MAX_BYTES) throw new Error('Relay payload exceeds 8 MiB');
  let data = json;
  let enc: 'gzip' | undefined;
  if (options.compress && json.length >= COMPRESS_MIN) {
    const encoded = bytesToBase64(await gzipText(json));
    // Compare the base64 form, which is what actually goes on the WebSocket.
    if (encoded.length + 32 < json.length) {
      data = encoded;
      enc = 'gzip';
    }
  }
  return pack(id, data, normalizeChunk(options.chunkSize ?? CHUNK_SIZE), enc);
}

export function parseFrame(raw: string): Frame {
  if (raw.length > 400000) throw new Error('Oversized frame');
  const f = JSON.parse(raw) as Frame;
  if (!f || typeof f.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(f.id) || !Number.isInteger(f.index) || !Number.isInteger(f.total) || f.total < 1 || f.total > 512 || f.index < 0 || f.index >= f.total || typeof f.data !== 'string' || f.data.length > NEGOTIATED_CHUNK_SIZE || (f.enc !== undefined && f.enc !== 'gzip')) throw new Error('Invalid relay frame');
  return f;
}

export async function gunzipJson(payload: string): Promise<unknown> {
  const text = await gunzipText(base64ToBytes(payload));
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('Relay payload exceeds 8 MiB');
  return JSON.parse(text);
}

export class Assembly {
  private parts: string[] = [];
  private total = 0;
  private bytes = 0;
  private enc?: 'gzip';

  push(frame: Frame): Assembled | undefined {
    if (frame.index !== this.parts.length || (this.total && this.total !== frame.total)) throw new Error('Out-of-order relay frame');
    if (this.parts.length === 0) this.enc = frame.enc;
    else if (this.enc !== frame.enc) throw new Error('Inconsistent relay frame encoding');
    this.total = frame.total;
    this.bytes += new TextEncoder().encode(frame.data).length;
    if (this.bytes > MAX_BYTES) throw new Error('Relay payload exceeds 8 MiB');
    this.parts.push(frame.data);
    if (this.parts.length !== this.total) return undefined;
    const joined = this.parts.join('');
    if (this.enc === 'gzip') return { gzip: joined };
    return { value: JSON.parse(joined) };
  }
}

function normalizeChunk(chunkSize: number): number {
  if (!Number.isInteger(chunkSize) || chunkSize < 1024 || chunkSize > NEGOTIATED_CHUNK_SIZE) return CHUNK_SIZE;
  return chunkSize;
}

function pack(id: string, data: string, chunkSize: number, enc?: 'gzip'): string[] {
  const total = Math.max(1, Math.ceil(data.length / chunkSize));
  if (total > 512) throw new Error('Relay payload exceeds frame count');
  return Array.from({ length: total }, (_, index) => JSON.stringify({
    id, index, total, ...(enc ? { enc } : {}), data: data.slice(index * chunkSize, (index + 1) * chunkSize),
  }));
}

async function gzipText(text: string): Promise<Uint8Array> {
  return pipeBytes(new CompressionStream('gzip'), new TextEncoder().encode(text), MAX_BYTES);
}

async function gunzipText(bytes: Uint8Array): Promise<string> {
  const inflated = await pipeBytes(new DecompressionStream('gzip'), bytes, MAX_BYTES);
  return new TextDecoder().decode(inflated);
}

async function pipeBytes(stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> }, input: Uint8Array, limit: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reading = (async () => {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('Relay payload exceeds 8 MiB'); }
      chunks.push(part.value);
    }
  })();
  await writer.write(Uint8Array.from(input));
  await writer.close();
  await reading;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
