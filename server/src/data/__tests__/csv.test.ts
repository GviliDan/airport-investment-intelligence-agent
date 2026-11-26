import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { csvRows, parseCsvLine } from '../csv.js';

describe('parseCsvLine', () => {
  it('handles quoted commas and doubled quotes', () => {
    expect(parseCsvLine('a,"Los Angeles, CA","say ""hi""",')).toEqual(['a', 'Los Angeles, CA', 'say "hi"', '']);
  });
});

describe('csvRows', () => {
  it('keys rows by header, strips a BOM and skips blank lines', async () => {
    const rows = [];
    for await (const r of csvRows(Readable.from(['﻿A,B\r\n1,"x,y"\r\n\r\n2,z\r\n']))) rows.push(r);
    expect(rows).toEqual([
      { A: '1', B: 'x,y' },
      { A: '2', B: 'z' },
    ]);
  });
  it('fills missing trailing cells with empty strings, not undefined', async () => {
    const rows = [];
    for await (const r of csvRows(Readable.from(['A,B,C\n1,2\n']))) rows.push(r);
    expect(rows[0]).toEqual({ A: '1', B: '2', C: '' });
  });
});
