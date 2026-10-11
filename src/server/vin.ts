// VIN helpers: normalisation, the ISO 3779 / 49 CFR 565 check digit, and one-edit repair.
// The same logic exists as SQL functions (see sql.ts); a test keeps the two in step.

const TRANSLIT: Readonly<Record<string, number>> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2] as const;

export const VIN_SHAPE = /^[A-HJ-NPR-Z0-9]{17}$/;

export function normalizeVin(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const v = raw.toUpperCase().replace(/[\s-]/g, '');
  return v.length > 0 ? v : null;
}

/** Expected check digit for a 17-character VIN, or null when a character cannot be weighted. */
export function expectedCheckDigit(vin: string): string | null {
  if (vin.length !== 17) return null;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = vin[i]!;
    const value = /[0-9]/.test(c) ? Number(c) : TRANSLIT[c];
    if (value === undefined) return null;
    sum += value * WEIGHTS[i]!;
  }
  const r = sum % 11;
  return r === 10 ? 'X' : String(r);
}

export interface VinCheck {
  shapeOk: boolean;
  checkOk: boolean;
  expected: string | null;
  actual: string | null;
}

export function checkVin(vin: string | null): VinCheck {
  if (!vin) return { shapeOk: false, checkOk: false, expected: null, actual: null };
  const shapeOk = VIN_SHAPE.test(vin);
  const expected = expectedCheckDigit(vin);
  const actual = vin.length >= 9 ? vin[8]! : null;
  return { shapeOk, checkOk: shapeOk && expected !== null && expected === actual, expected, actual };
}

export function isValidVin(vin: string | null): boolean {
  return checkVin(vin).checkOk;
}

/** Recomputes position 9 so the VIN passes its check digit. Used by the seed script. */
export function withCheckDigit(vin: string): string {
  const base = vin.slice(0, 8) + '0' + vin.slice(9);
  const cd = expectedCheckDigit(base);
  if (cd === null) throw new Error(`cannot weight ${vin}`);
  return base.slice(0, 8) + cd + base.slice(9);
}

export type RepairKind = 'io_fix' | 'transposition' | 'substitution';

export interface Repair {
  kind: RepairKind;
  /** 1-based VIN positions touched by the repair. */
  positions: number[];
  from: string;
  to: string;
}

const IOQ: Readonly<Record<string, string>> = { I: '1', O: '0', Q: '0' };

/**
 * Returns how `bad` becomes `good` in one edit, or null.
 * One edit is: replacing every I, O or Q with 1, 0, 0; swapping two adjacent characters;
 * or replacing one character.
 */
export function oneEditRepair(bad: string, good: string): Repair | null {
  if (bad.length !== 17 || good.length !== 17 || bad === good) return null;

  if (/[IOQ]/.test(bad)) {
    const fixed = bad.replace(/[IOQ]/g, (c) => IOQ[c]!);
    if (fixed === good) {
      const positions = [...bad].flatMap((c, i) => (c in IOQ ? [i + 1] : []));
      return { kind: 'io_fix', positions, from: bad, to: good };
    }
  }

  const diff: number[] = [];
  for (let i = 0; i < 17; i++) {
    if (bad[i] !== good[i]) {
      diff.push(i);
      if (diff.length > 2) return null;
    }
  }
  if (diff.length === 1) {
    return { kind: 'substitution', positions: [diff[0]! + 1], from: bad, to: good };
  }
  if (diff.length === 2) {
    const [a, b] = diff as [number, number];
    if (b === a + 1 && bad[a] === good[b] && bad[b] === good[a]) {
      return { kind: 'transposition', positions: [a + 1, b + 1], from: bad, to: good };
    }
  }
  return null;
}

export function describeRepair(r: Repair): string {
  switch (r.kind) {
    case 'io_fix':
      return `letter typed for a digit at position ${r.positions.join(', ')} (I/O/Q are never used in a VIN)`;
    case 'transposition':
      return `check-digit repair by swapping positions ${r.positions[0]}-${r.positions[1]}`;
    case 'substitution':
      return `check-digit repair by replacing position ${r.positions[0]} (${r.from[r.positions[0]! - 1]} to ${r.to[r.positions[0]! - 1]})`;
  }
}

/** Model year from VIN position 10 for the 2010-2039 cycle. */
export function modelYearFromVin(vin: string): number | null {
  const code = vin[9];
  if (!code) return null;
  const cycle = 'ABCDEFGHJKLMNPRSTVWXY123456789';
  const idx = cycle.indexOf(code);
  return idx < 0 ? null : 2010 + idx;
}
