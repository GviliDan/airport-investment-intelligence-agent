/**
 * Downloads one month of a BTS TranStats table through its public download form (there is no JSON API for these tables).
 *   npm run data:download -- segment 2026-08
 *   npm run data:download -- ontime  2026-08
 * Raw files go to data/raw/ (git-ignored). Existing complete files are reused, so the script is safe to re-run.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const TABLES = {
  segment: { code: 'FMG', qo: 'Nv4 Pn44vr45', label: 'T-100 Segment (All Carriers)' },
  ontime: { code: 'FGJ', qo: 'b0-gvzr', label: 'Reporting Carrier On-Time Performance' },
} as const;
type TableName = keyof typeof TABLES;

const BASE = 'https://www.transtats.bts.gov/DL_SelectFields.aspx';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const rawPath = (table: TableName, month: string): string => resolve(ROOT, 'data/raw', `${table}_${month}.zip`);

const hidden = (html: string, name: string): string => {
  const m = new RegExp(`name="${name}"[^>]*value="([^"]*)"`).exec(html);
  if (!m) throw new Error(`BTS download form changed: hidden field ${name} not found`);
  return m[1] as string;
};

/** A zip written by BTS is complete only if it ends with an end-of-central-directory record. */
async function isCompleteZip(path: string): Promise<boolean> {
  try {
    const { size } = await stat(path);
    if (size < 22) return false;
    const fh = await open(path, 'r');
    try {
      const tail = Buffer.alloc(Math.min(size, 70_000));
      await fh.read(tail, 0, tail.length, size - tail.length);
      return tail.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

async function downloadOnce(table: TableName, year: string, month: string, out: string): Promise<void> {
  const t = TABLES[table];
  const url = `${BASE}?gnoyr_VQ=${t.code}&QO_fu146_anzr=${encodeURIComponent(t.qo)}`;
  const page = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!page.ok) throw new Error(`BTS form page returned HTTP ${page.status}`);
  const cookies = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const html = await page.text();
  const body = new URLSearchParams({
    __VIEWSTATE: hidden(html, '__VIEWSTATE'),
    __VIEWSTATEGENERATOR: hidden(html, '__VIEWSTATEGENERATOR'),
    __EVENTVALIDATION: hidden(html, '__EVENTVALIDATION'),
    cboGeography: 'All',
    cboYear: year,
    cboPeriod: String(Number(month)),
    chkAllVars: 'on',
    btnDownload: 'Download',
    txtSearch: '',
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookies, referer: url },
    body,
    signal: AbortSignal.timeout(45 * 60_000),
  });
  if (!res.ok || !res.body) throw new Error(`BTS download returned HTTP ${res.status}`);
  if (!(res.headers.get('content-type') ?? '').includes('zip')) {
    throw new Error(`BTS returned ${res.headers.get('content-type')} instead of a zip (month not published yet?)`);
  }
  const tmp = `${out}.part`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
  if (!(await isCompleteZip(tmp))) throw new Error('download was truncated (no zip end record)');
  await rename(tmp, out);
}

export async function download(table: TableName, ym: string): Promise<string> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw new Error(`month must be YYYY-MM, got ${ym}`);
  const [year, month] = ym.split('-') as [string, string];
  const out = rawPath(table, ym);
  await mkdir(dirname(out), { recursive: true });
  if (await isCompleteZip(out)) {
    console.log(`${table} ${ym}: already downloaded`);
    return out;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      console.log(`${table} ${ym}: downloading (attempt ${attempt})`);
      await downloadOnce(table, year, month, out);
      console.log(`${table} ${ym}: done`);
      return out;
    } catch (err) {
      await rm(`${out}.part`, { force: true });
      console.warn(`${table} ${ym}: ${(err as Error).message}`);
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }
  throw new Error('unreachable');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [table, ...months] = process.argv.slice(2);
  if (!table || !(table in TABLES) || months.length === 0) {
    console.error('usage: npm run data:download -- <segment|ontime> <YYYY-MM> [YYYY-MM ...]');
    process.exit(2);
  }
  for (const m of months) await download(table as TableName, m);
}
