import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/server/csv.js';

describe('parseCsv', () => {
  it('reads quoted cells, doubled quotes and CRLF', () => {
    const t = parseCsv('a,b,c\r\n1,"x, y","say ""hi"""\r\n\r\n2,,z\n');
    expect(t.header).toEqual(['a', 'b', 'c']);
    expect(t.rows).toEqual([
      ['1', 'x, y', 'say "hi"'],
      ['2', '', 'z'],
    ]);
  });

  it('reads a last line without a newline', () => {
    expect(parseCsv('h\nv').rows).toEqual([['v']]);
  });

  it('fails on an unterminated quote', () => {
    expect(() => parseCsv('h\n"open')).toThrow(/unterminated/);
  });
});
