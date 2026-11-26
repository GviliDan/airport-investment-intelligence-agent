import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInflateRaw } from 'node:zlib';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

/** Splits one CSV line. Handles quoted fields, doubled quotes and commas inside quotes. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Yields each data row as an object keyed by the header row. Streams, so memory stays flat for 200 MB files. */
export async function* csvRows(input: Readable): AsyncGenerator<Record<string, string>> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header: string[] | undefined;
  for await (const raw of lines) {
    const line = raw.replace(/^﻿/, '');
    if (line === '') continue;
    const cells = parseCsvLine(line);
    if (!header) {
      header = cells;
      continue;
    }
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      row[h] = cells[i] ?? '';
    });
    yield row;
  }
}

/**
 * Streams the first file inside a zip without unpacking it to disk. BTS zips hold exactly one CSV, so the local
 * header is enough: skip it and inflate the deflate stream that follows.
 */
export async function openFirstZipEntry(path: string): Promise<Readable> {
  const fh = await open(path, 'r');
  try {
    const head = Buffer.alloc(30);
    await fh.read(head, 0, 30, 0);
    if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`${path} is not a zip file`);
    const method = head.readUInt16LE(8);
    if (method !== 8) throw new Error(`unsupported zip compression method ${method}`);
    const start = 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    return createReadStream(path, { start }).pipe(createInflateRaw());
  } finally {
    await fh.close();
  }
}
