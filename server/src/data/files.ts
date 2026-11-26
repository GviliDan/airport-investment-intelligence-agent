import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { parseCsvLine } from './csv.js';

/** Repository root (the folder holding `data/`), independent of the working directory. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const PROCESSED_DIR = resolve(REPO_ROOT, 'data/processed');
export const RAW_DIR = resolve(REPO_ROOT, 'data/raw');

export async function writeGzipJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, gzipSync(JSON.stringify(value), { level: 9 }));
}

export async function readGzipJson(path: string): Promise<unknown> {
  return JSON.parse(gunzipSync(await readFile(path)).toString('utf8'));
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

const escapeCell = (v: string | number | undefined): string => {
  if (v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** Writes rows as gzipped CSV. `undefined` becomes an empty cell, which reads back as missing (never 0). */
export async function writeGzipCsv(path: string, columns: readonly string[], rows: Iterable<object>): Promise<void> {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => escapeCell((row as Record<string, string | number | undefined>)[c])).join(','));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, gzipSync(`${lines.join('\n')}\n`, { level: 9 }));
}

export async function readGzipCsv(path: string): Promise<Record<string, string>[]> {
  const [header, ...lines] = gunzipSync(await readFile(path)).toString('utf8').split('\n').filter((l) => l !== '');
  if (!header) return [];
  const cols = parseCsvLine(header);
  return lines.map((l) => {
    const cells = parseCsvLine(l);
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
  });
}
