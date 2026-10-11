// Reference vocabularies: make and model aliases, trim words sellers use, colours and provinces.
// The alias table is loaded into Postgres (make_alias) and drives title parsing in SQL.

export interface Alias {
  /** Lower-case words, separated by single spaces, matched on word boundaries. */
  alias: string;
  make: string;
  model: string | null;
}

export const ALIASES: readonly Alias[] = [
  { alias: 'dodge ram', make: 'Ram', model: null },
  { alias: 'ram 1500', make: 'Ram', model: '1500' },
  { alias: 'ram', make: 'Ram', model: null },
  { alias: 'ford f 150', make: 'Ford', model: 'F-150' },
  { alias: 'f 150', make: 'Ford', model: 'F-150' },
  { alias: 'f150', make: 'Ford', model: 'F-150' },
  { alias: 'ford escape', make: 'Ford', model: 'Escape' },
  { alias: 'escape', make: 'Ford', model: 'Escape' },
  { alias: 'ford', make: 'Ford', model: null },
  { alias: 'toyota rav4', make: 'Toyota', model: 'RAV4' },
  { alias: 'rav4', make: 'Toyota', model: 'RAV4' },
  { alias: 'toyota corolla', make: 'Toyota', model: 'Corolla' },
  { alias: 'corolla', make: 'Toyota', model: 'Corolla' },
  { alias: 'toyota', make: 'Toyota', model: null },
  { alias: 'honda civic', make: 'Honda', model: 'Civic' },
  { alias: 'civic', make: 'Honda', model: 'Civic' },
  { alias: 'honda cr v', make: 'Honda', model: 'CR-V' },
  { alias: 'cr v', make: 'Honda', model: 'CR-V' },
  { alias: 'crv', make: 'Honda', model: 'CR-V' },
  { alias: 'honda', make: 'Honda', model: null },
  { alias: 'chevrolet silverado', make: 'Chevrolet', model: 'Silverado' },
  { alias: 'chevy silverado', make: 'Chevrolet', model: 'Silverado' },
  { alias: 'silverado', make: 'Chevrolet', model: 'Silverado' },
  { alias: 'chevrolet', make: 'Chevrolet', model: null },
  { alias: 'chevy', make: 'Chevrolet', model: null },
  { alias: 'chev', make: 'Chevrolet', model: null },
  { alias: 'nissan rogue', make: 'Nissan', model: 'Rogue' },
  { alias: 'rogue', make: 'Nissan', model: 'Rogue' },
  { alias: 'nissan', make: 'Nissan', model: null },
  { alias: 'hyundai elantra', make: 'Hyundai', model: 'Elantra' },
  { alias: 'elantra', make: 'Hyundai', model: 'Elantra' },
  { alias: 'hyundai kona', make: 'Hyundai', model: 'Kona' },
  { alias: 'kona', make: 'Hyundai', model: 'Kona' },
  { alias: 'hyundai', make: 'Hyundai', model: null },
  { alias: 'dodge grand caravan', make: 'Dodge', model: 'Grand Caravan' },
  { alias: 'grand caravan', make: 'Dodge', model: 'Grand Caravan' },
  { alias: 'dodge', make: 'Dodge', model: null },
  { alias: 'jeep grand cherokee', make: 'Jeep', model: 'Grand Cherokee' },
  { alias: 'grand cherokee', make: 'Jeep', model: 'Grand Cherokee' },
  { alias: 'jeep', make: 'Jeep', model: null },
  { alias: 'volkswagen jetta', make: 'Volkswagen', model: 'Jetta' },
  { alias: 'vw jetta', make: 'Volkswagen', model: 'Jetta' },
  { alias: 'jetta', make: 'Volkswagen', model: 'Jetta' },
  { alias: 'volkswagen', make: 'Volkswagen', model: null },
  { alias: 'vw', make: 'Volkswagen', model: null },
];

/** Trim words sellers put in listing titles. Longest match wins. */
export const TRIM_WORDS: readonly string[] = [
  'SLT', 'Big Horn', 'Laramie', 'Limited', 'Rebel', 'XLT', 'Lariat', 'Platinum', 'King Ranch',
  'LE', 'XLE', 'XSE', 'SE', 'Trail', 'LX', 'EX', 'EX-L', 'Sport', 'Touring',
  'LT', 'LTZ', 'High Country', 'RST', 'SEL', 'Titanium', 'SV', 'SL', 'Preferred',
  'Value Edition', 'SXT', 'GT', 'Overland', 'Summit', 'Highline', 'Comfortline', 'GLI',
  'N Line', 'Ultimate', 'Essential',
];

export const COLOURS: readonly string[] = ['White', 'Black', 'Silver', 'Grey', 'Blue', 'Red', 'Green', 'Brown'];

export const PROVINCES: readonly string[] = ['ON', 'QC', 'BC', 'AB', 'MB', 'SK', 'NS', 'NB', 'NL', 'PE', 'YT', 'NT', 'NU'];

/** Upper-case letters and digits only, the key two model spellings are compared on. */
export function modelKey(model: string | null | undefined): string | null {
  if (!model) return null;
  const k = model.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return k.length ? k : null;
}

export function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
