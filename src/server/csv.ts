// Small RFC 4180 CSV reader: quoted cells, doubled quotes, CRLF or LF line ends.

export interface CsvTable {
  header: string[];
  rows: string[][];
}

export function parseCsv(text: string): CsvTable {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"' && cell === '') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((v) => v !== '')) records.push(row);
      row = [];
    } else cell += c;
  }
  if (quoted) throw new Error('unterminated quoted cell');
  if (cell !== '' || row.length) {
    row.push(cell);
    if (row.some((v) => v !== '')) records.push(row);
  }
  const [header = [], ...rows] = records;
  return { header: header.map((h) => h.trim()), rows };
}
