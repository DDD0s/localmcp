import { createGunzip } from 'node:zlib';
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

const BLOCK = 512;
const DEFAULT_MAX_UNCOMPRESSED = 40 * 1024 * 1024;
const DEFAULT_MAX_FILE = 16 * 1024 * 1024;

export interface ExtractOptions {
  maxUncompressedBytes?: number;
  maxFileBytes?: number;
}

interface Entry { name: string; type: string; data: Buffer }

/**
 * Extract a tar or gzip-compressed tar into `dest`.
 * Rejects links, absolute paths, and any path that escapes `dest`.
 * A single shared top-level directory (GitHub tag archives) is stripped.
 */
export async function extractArchive(bytes: Buffer, dest: string, options: ExtractOptions = {}): Promise<void> {
  const raw = await inflate(bytes, options.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED);
  const entries = readTar(raw, options.maxFileBytes ?? DEFAULT_MAX_FILE);
  const root = sharedRoot(entries);
  const rootDir = resolve(dest);
  await mkdir(rootDir, { recursive: true });
  let files = 0;
  for (const entry of entries) {
    const relative = root ? stripRoot(entry.name, root) : normalizeName(entry.name);
    if (relative === null) continue;
    const target = inside(rootDir, relative);
    if (entry.type === '5') {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await rejectSymlink(target);
    await writeFile(target, entry.data, { flag: 'wx', mode: 0o644 });
    files += 1;
  }
  if (!files) throw new Error('archive contained no files');
}

async function inflate(bytes: Buffer, limit: number): Promise<Buffer> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    if (bytes.length > limit) throw new Error('archive exceeds the size limit');
    return bytes;
  }
  return new Promise((resolveInflate, reject) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    let size = 0;
    gunzip.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        gunzip.destroy(new Error('archive exceeds the size limit'));
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on('error', reject);
    gunzip.on('end', () => resolveInflate(Buffer.concat(chunks)));
    gunzip.end(bytes);
  });
}

function readTar(raw: Buffer, maxFileBytes: number): Entry[] {
  const entries: Entry[] = [];
  let offset = 0;
  let pendingName: string | undefined;
  let pendingPath: string | undefined;
  while (offset + BLOCK <= raw.length) {
    const header = raw.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (header.every(byte => byte === 0)) break;
    if (checksum(header) !== octal(header, 148, 12)) throw new Error('archive header checksum is invalid');
    const type = String.fromCharCode(header[156] || 0x30);
    const size = octal(header, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > raw.length) throw new Error('archive entry size is invalid');
    if (size > maxFileBytes) throw new Error('archive entry exceeds the size limit');
    const data = raw.subarray(offset, offset + size);
    offset += size + ((BLOCK - (size % BLOCK)) % BLOCK);
    if (type === 'g') { pendingPath = undefined; continue; }
    if (type === 'x') {
      const records = parsePax(Buffer.from(data));
      if (records.path) pendingPath = records.path;
      continue;
    }
    if (type === 'L') {
      pendingName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type === '1' || type === '2' || type === 'K') throw new Error('archive contains a link');
    if (type !== '0' && type !== '5') throw new Error(`archive entry type ${type} is not allowed`);
    let name = pendingPath || pendingName || headerName(header);
    pendingPath = undefined;
    pendingName = undefined;
    name = name.replace(/\0.*$/, '');
    if (!name) throw new Error('archive entry has an empty name');
    entries.push({ name, type, data: Buffer.from(data) });
  }
  if (!entries.length) throw new Error('archive contained no files');
  return entries;
}

function headerName(header: Buffer): string {
  const name = text(header, 0, 100);
  const magic = text(header, 257, 5);
  const prefix = magic === 'ustar' ? text(header, 345, 155) : '';
  return prefix ? `${prefix}/${name}` : name;
}

function parsePax(body: Buffer): Record<string, string> {
  const text = body.toString('utf8');
  const records: Record<string, string> = {};
  let index = 0;
  while (index < text.length) {
    const space = text.indexOf(' ', index);
    if (space <= index) throw new Error('invalid pax header');
    const length = Number(text.slice(index, space));
    if (!Number.isInteger(length) || length <= 0 || index + length > text.length) throw new Error('invalid pax header');
    const record = text.slice(index, index + length);
    const equals = record.indexOf('=');
    if (equals <= 0 || !record.endsWith('\n')) throw new Error('invalid pax record');
    records[record.slice(record.indexOf(' ') + 1, equals)] = record.slice(equals + 1, -1);
    index += length;
  }
  return records;
}

function sharedRoot(entries: Entry[]): string | null {
  let root: string | null = null;
  for (const entry of entries) {
    const name = normalizeName(entry.name);
    if (name === null) return null;
    const first = name.split('/')[0];
    if (!first) return null;
    if (root === null) root = first;
    else if (root !== first) return null;
  }
  return root;
}

function stripRoot(name: string, root: string): string | null {
  const relative = normalizeName(name);
  if (relative === null) throw new Error('archive path escapes the destination');
  if (relative === root) return null;
  const prefix = `${root}/`;
  if (!relative.startsWith(prefix)) throw new Error('archive path escapes the destination');
  return relative.slice(prefix.length);
}

function normalizeName(name: string): string | null {
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error('archive path escapes the destination');
  }
  const parts = name.split('/').filter(part => part !== '' && part !== '.');
  if (parts.some(part => part === '..')) throw new Error('archive path escapes the destination');
  if (!parts.length) return null;
  return parts.join('/');
}

function inside(root: string, relative: string): string {
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) throw new Error('archive path escapes the destination');
  return target;
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('refusing to write through a symlink');
    throw new Error('archive entry already exists');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    throw error;
  }
}

function text(block: Buffer, start: number, length: number): string {
  return block.toString('utf8', start, start + length).replace(/\0.*$/, '');
}

function octal(block: Buffer, start: number, length: number): number {
  const value = text(block, start, length).trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) throw new Error('archive header is invalid');
  return parseInt(value, 8);
}

function checksum(block: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
  return sum;
}
