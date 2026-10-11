import { describe, expect, it } from 'vitest';
import { checkVin, describeRepair, expectedCheckDigit, isValidVin, modelYearFromVin, normalizeVin, oneEditRepair, withCheckDigit } from '../src/server/vin.js';

describe('check digit', () => {
  it('accepts the hero VIN and its X check digit', () => {
    expect(expectedCheckDigit('1C6RR7LTXKS612345')).toBe('X');
    expect(isValidVin('1C6RR7LTXKS612345')).toBe(true);
  });

  it('rejects the hero listing VIN with positions 16 and 17 swapped', () => {
    const c = checkVin('1C6RR7LTXKS612354');
    expect(c).toMatchObject({ shapeOk: true, checkOk: false, expected: '0', actual: 'X' });
  });

  it('treats I, O and Q as a bad shape that cannot be weighted', () => {
    expect(checkVin('3GCUYDED5KG2O8150')).toMatchObject({ shapeOk: false, checkOk: false });
    expect(expectedCheckDigit('3GCUYDED5KG2O8150')).toBeNull();
  });

  it('withCheckDigit always produces a passing VIN', () => {
    for (const stem of ['1FTEW1EP0KFA10041', '2T1BURHE0KC123456', 'KM8K2CAB0PU543214']) {
      expect(isValidVin(withCheckDigit(stem))).toBe(true);
    }
  });

  it('normalises case, spaces and dashes', () => {
    expect(normalizeVin(' 1c6rr7ltx-ks612345 ')).toBe('1C6RR7LTXKS612345');
    expect(normalizeVin('')).toBeNull();
    expect(normalizeVin(null)).toBeNull();
  });

  it('reads the model year from position 10', () => {
    expect(modelYearFromVin('1C6RR7LTXKS612345')).toBe(2019);
    expect(modelYearFromVin('KM8K2CAB3PU100001')).toBe(2023);
  });
});

describe('one-edit repair', () => {
  const good = '1C6RR7LTXKS612345';

  it('finds an adjacent transposition', () => {
    const r = oneEditRepair('1C6RR7LTXKS612354', good);
    expect(r).toMatchObject({ kind: 'transposition', positions: [16, 17] });
    expect(describeRepair(r!)).toBe('check-digit repair by swapping positions 16-17');
  });

  it('finds a single substitution', () => {
    expect(oneEditRepair('1C6RR7LTXKS612348', good)).toMatchObject({ kind: 'substitution', positions: [17] });
  });

  it('fixes letters typed for digits', () => {
    expect(oneEditRepair('3GCUYDED5KG2O8150', '3GCUYDED5KG208150')).toMatchObject({ kind: 'io_fix', positions: [13] });
  });

  it('refuses two edits, non-adjacent swaps and identical VINs', () => {
    expect(oneEditRepair('1C6RR7LTXKS612399', good)).toBeNull();
    expect(oneEditRepair('1C6RR7LTXKS652341', good)).toBeNull();
    expect(oneEditRepair(good, good)).toBeNull();
    expect(oneEditRepair('1C6RR7LTXKS61234', good)).toBeNull();
  });
});
