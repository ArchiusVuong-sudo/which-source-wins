// Seeded script that writes the synthetic sources and the truth labels into data/.
// Every person, lot, serial and reading here is made up. VIN prefixes are real manufacturer
// patterns so the offline decoder can read them; serials and check digits are synthetic.
//
//   npm run seed          writes data/sources/** and data/truth.json
//
// The output is committed, so the app and the tests never depend on running this.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidVin, oneEditRepair, withCheckDigit } from '../src/server/vin.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data');

// ---------- deterministic randomness ----------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261011);
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

// ---------- model table ----------
interface ModelSpec {
  key: string;
  prefix: string; // '?' marks the check digit
  year: number;
  make: string;
  model: string;
  regMake: string;
  regMakeV2: string;
  regModel: string;
  titleName: string;
  trueTrim: string;
  sellerHonest: string;
  sellerInflated: string;
  colours: string[];
}

const MODELS: Record<string, ModelSpec> = {
  ramClassic: { key: 'ramClassic', prefix: '1C6RR7LT?KS', year: 2019, make: 'Ram', model: '1500', regMake: 'RAM', regMakeV2: 'RAM', regModel: '1500', titleName: 'Ram 1500 Classic', trueTrim: 'Classic DS', sellerHonest: 'SLT', sellerInflated: 'Laramie', colours: ['White', 'Black', 'Red', 'Grey'] },
  ramNew: { key: 'ramNew', prefix: '1C6SRFFT?KN', year: 2019, make: 'Ram', model: '1500', regMake: 'RAM', regMakeV2: 'RAM', regModel: '1500', titleName: 'Ram 1500', trueTrim: 'Big Horn', sellerHonest: 'Big Horn', sellerInflated: 'Limited', colours: ['Blue', 'White', 'Grey'] },
  f150: { key: 'f150', prefix: '1FTEW1EP?KFA', year: 2019, make: 'Ford', model: 'F-150', regMake: 'FORD', regMakeV2: 'FORD', regModel: 'F150', titleName: 'Ford F-150', trueTrim: 'XLT', sellerHonest: 'XLT', sellerInflated: 'Platinum', colours: ['White', 'Black', 'Blue'] },
  rav4: { key: 'rav4', prefix: '2T3W1RFV?KC', year: 2019, make: 'Toyota', model: 'RAV4', regMake: 'TOYOTA', regMakeV2: 'TOYOTA', regModel: 'RAV4', titleName: 'Toyota RAV4', trueTrim: 'XLE', sellerHonest: 'XLE', sellerInflated: 'Limited', colours: ['Silver', 'White', 'Blue'] },
  corolla: { key: 'corolla', prefix: '2T1BURHE?KC', year: 2019, make: 'Toyota', model: 'Corolla', regMake: 'TOYOTA', regMakeV2: 'TOYOTA', regModel: 'COROLLA', titleName: 'Toyota Corolla', trueTrim: 'LE', sellerHonest: 'LE', sellerInflated: 'XSE', colours: ['White', 'Silver', 'Grey', 'Red'] },
  civic: { key: 'civic', prefix: '2HGFC2F5?KH', year: 2019, make: 'Honda', model: 'Civic', regMake: 'HONDA', regMakeV2: 'HONDA', regModel: 'CIVIC', titleName: 'Honda Civic', trueTrim: 'LX', sellerHonest: 'LX', sellerInflated: 'Touring', colours: ['Blue', 'White', 'Grey', 'Black'] },
  crv: { key: 'crv', prefix: '2HKRW2H5?KH', year: 2019, make: 'Honda', model: 'CR-V', regMake: 'HONDA', regMakeV2: 'HONDA', regModel: 'CR-V', titleName: 'Honda CR-V', trueTrim: 'EX', sellerHonest: 'EX', sellerInflated: 'Touring', colours: ['Silver', 'Black', 'White'] },
  silverado: { key: 'silverado', prefix: '3GCUYDED?KG', year: 2019, make: 'Chevrolet', model: 'Silverado', regMake: 'CHEVROLET', regMakeV2: 'CHEV', regModel: 'SILVERADO', titleName: 'Chevrolet Silverado', trueTrim: 'LT', sellerHonest: 'LT', sellerInflated: 'High Country', colours: ['Red', 'Black', 'White'] },
  escape: { key: 'escape', prefix: '1FMCU9HD?KUA', year: 2019, make: 'Ford', model: 'Escape', regMake: 'FORD', regMakeV2: 'FORD', regModel: 'ESCAPE', titleName: 'Ford Escape', trueTrim: 'SEL', sellerHonest: 'SEL', sellerInflated: 'Titanium', colours: ['Grey', 'White', 'Blue'] },
  rogue: { key: 'rogue', prefix: '5N1AT2MV?KC', year: 2019, make: 'Nissan', model: 'Rogue', regMake: 'NISSAN', regMakeV2: 'NISSAN', regModel: 'ROGUE', titleName: 'Nissan Rogue', trueTrim: 'SV', sellerHonest: 'SV', sellerInflated: 'SL', colours: ['Grey', 'Red', 'White'] },
  elantra: { key: 'elantra', prefix: '5NPD84LF?KH', year: 2019, make: 'Hyundai', model: 'Elantra', regMake: 'HYUNDAI', regMakeV2: 'HYUNDAI', regModel: 'ELANTRA', titleName: 'Hyundai Elantra', trueTrim: 'SEL', sellerHonest: 'SEL', sellerInflated: 'Limited', colours: ['White', 'Silver', 'Blue'] },
  caravan: { key: 'caravan', prefix: '2C4RDGCG?KR', year: 2019, make: 'Dodge', model: 'Grand Caravan', regMake: 'DODGE', regMakeV2: 'DODGE', regModel: 'GRAND CARAVAN', titleName: 'Dodge Grand Caravan', trueTrim: 'SXT', sellerHonest: 'SXT', sellerInflated: 'GT', colours: ['Grey', 'Black', 'Silver'] },
  cherokee: { key: 'cherokee', prefix: '1C4RJFBG?KC', year: 2019, make: 'Jeep', model: 'Grand Cherokee', regMake: 'JEEP', regMakeV2: 'JEEP', regModel: 'GRAND CHEROKEE', titleName: 'Jeep Grand Cherokee', trueTrim: 'Limited', sellerHonest: 'Limited', sellerInflated: 'Overland', colours: ['Black', 'Green', 'White'] },
  jetta: { key: 'jetta', prefix: '3VWC57BU?KM', year: 2019, make: 'Volkswagen', model: 'Jetta', regMake: 'VOLKSWAGEN', regMakeV2: 'VW', regModel: 'JETTA', titleName: 'Volkswagen Jetta', trueTrim: 'SE', sellerHonest: 'SE', sellerInflated: 'GLI', colours: ['White', 'Grey', 'Blue'] },
  kona: { key: 'kona', prefix: 'KM8K2CAB?PU', year: 2023, make: 'Hyundai', model: 'Kona', regMake: 'HYUNDAI', regMakeV2: 'HYUNDAI', regModel: 'KONA', titleName: 'Hyundai Kona', trueTrim: 'SE', sellerHonest: 'SE', sellerInflated: 'N Line', colours: ['Green', 'White'] },
};

const LOTS = {
  kingston: 'Lot 03 · Kingston, ON',
  hamilton: 'Lot 07 · Hamilton, ON',
  barrie: 'Lot 11 · Barrie, ON',
  sudbury: 'Lot 14 · Sudbury, ON',
  windsor: 'Lot 19 · Windsor, ON',
  guelph: 'Lot 22 · Guelph, ON',
  oshawa: 'Lot 25 · Oshawa, ON',
} as const;
const GENERAL_LOTS = [LOTS.kingston, LOTS.hamilton, LOTS.guelph, LOTS.oshawa];

const PROVINCE_POOL = ['ON', 'ON', 'ON', 'ON', 'ON', 'ON', 'QC', 'MB', 'NS', 'AB', 'BC'];

export const CASE_LABELS: Record<string, string> = {
  hero: 'The Ram 1500 across four sources',
  'classic-vs-new-gen': 'Classic vs new generation',
  'fleet-twins': 'Fleet twins',
  'pasted-vin': 'Pasted VIN',
  'io-typo': 'Letter O typed for zero',
  'substitution-typo': 'One mistyped character',
  'vin-less-repost': 'Repost without a VIN',
  'no-registry': 'No registry record',
  'colour-conflict': 'Registry vs listing colour',
  'new-registration': 'First registered in the October drop',
  plain: 'No planted issue',
};

// ---------- vehicles ----------
interface Vehicle {
  id: string;
  spec: ModelSpec;
  vin: string;
  colour: string;
  province: string | null;
  registrationDate: string;
  baseKm: number; // reading on 2026-01-01
  kmPerDay: number;
  caseTag: string;
  registered: 'both' | 'october' | 'none';
}

const usedSerials = new Set<string>();
function makeVin(spec: ModelSpec, serial?: string): string {
  const serialLen = 17 - spec.prefix.length;
  let s = serial;
  while (!s) {
    const cand = String(int(10 ** (serialLen - 1), 10 ** serialLen - 1));
    if (!usedSerials.has(spec.key + cand)) s = cand;
  }
  usedSerials.add(spec.key + s);
  const vin = withCheckDigit(spec.prefix.replace('?', '0') + s);
  if (vin.length !== 17 || !isValidVin(vin)) throw new Error(`bad VIN ${vin}`);
  return vin;
}

const vehicles: Vehicle[] = [];
function addVehicle(specKey: string, opts: Partial<Omit<Vehicle, 'spec' | 'vin'>> & { serial?: string } = {}): Vehicle {
  const spec = MODELS[specKey]!;
  const v: Vehicle = {
    id: `V${String(vehicles.length + 1).padStart(2, '0')}`,
    spec,
    vin: makeVin(spec, opts.serial),
    colour: opts.colour ?? pick(spec.colours),
    province: opts.province === undefined ? pick(PROVINCE_POOL) : opts.province,
    registrationDate:
      opts.registrationDate ??
      `${spec.year + int(0, 1)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`,
    baseKm: opts.baseKm ?? int(18_000, 105_000),
    kmPerDay: opts.kmPerDay ?? int(25, 60),
    caseTag: opts.caseTag ?? 'plain',
    registered: opts.registered ?? 'both',
  };
  vehicles.push(v);
  return v;
}

// Planted vehicles first.
const hero = addVehicle('ramClassic', { serial: '612345', colour: 'White', province: 'ON', registrationDate: '2019-05-14', caseTag: 'hero' });
// Readings for the two Lot 14 trucks are pinned so the module reads land at 65,400 and 63,100 km.
const lotClassic = addVehicle('ramClassic', { colour: 'Black', province: 'ON', baseKm: 54_520, kmPerDay: 40, caseTag: 'classic-vs-new-gen' });
const lotNewGen = addVehicle('ramNew', { colour: 'Blue', province: 'ON', baseKm: 53_615, kmPerDay: 35, caseTag: 'classic-vs-new-gen' });
const twinA = addVehicle('f150', { serial: '10041', colour: 'White', province: 'ON', registrationDate: '2019-03-18', caseTag: 'fleet-twins' });
const twinB = addVehicle('f150', { serial: '10042', colour: 'White', province: 'ON', registrationDate: '2019-03-18', caseTag: 'fleet-twins' });
const rav4Silver = addVehicle('rav4', { colour: 'Silver', province: 'ON', caseTag: 'pasted-vin' });
const rav4White = addVehicle('rav4', { colour: 'White', province: 'ON', caseTag: 'pasted-vin' });
const ioTypo = addVehicle('silverado', { serial: '208150', colour: 'Red', caseTag: 'io-typo' });
const subTypo = addVehicle('escape', { colour: 'Grey', caseTag: 'substitution-typo' });
const repost = addVehicle('civic', { colour: 'White', caseTag: 'vin-less-repost' });
const colourConflict = addVehicle('civic', { colour: 'Blue', caseTag: 'colour-conflict' });
const noRegKona = addVehicle('kona', { colour: 'Green', province: null, registrationDate: '2023-06-01', registered: 'none', caseTag: 'no-registry' });
const noRegRogue = addVehicle('rogue', { colour: 'Grey', province: null, registered: 'none', caseTag: 'no-registry' });
const newRegA = addVehicle('cherokee', { registered: 'october', registrationDate: '2026-09-08', caseTag: 'new-registration' });
const newRegB = addVehicle('corolla', { registered: 'october', registrationDate: '2026-09-15', caseTag: 'new-registration' });

// The rest of the fleet.
const fill: [string, number][] = [
  ['ramClassic', 1], ['ramNew', 1], ['f150', 2], ['rav4', 2], ['corolla', 3], ['civic', 3], ['crv', 4],
  ['silverado', 2], ['escape', 2], ['rogue', 2], ['elantra', 3], ['caravan', 3], ['cherokee', 2], ['jetta', 3],
];
for (const [key, n] of fill) for (let i = 0; i < n; i++) addVehicle(key);
if (vehicles.length !== 48) throw new Error(`expected 48 vehicles, got ${vehicles.length}`);

// ---------- readings ----------
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dateMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const kmAt = (v: Vehicle, d: string) => Math.round(v.baseKm + v.kmPerDay * ((dateMs(d) - T0) / DAY));
const randDate = (from: string, to: string) => iso(dateMs(from) + int(0, Math.round((dateMs(to) - dateMs(from)) / DAY)) * DAY);

// ---------- records ----------
interface TruthRecord { vin: string; caseTag: string }
const truthRecords: Record<string, TruthRecord> = {};

interface RegRow { v: Vehicle; vin: string; make: string; model: string; colour: string; odoKm: number; odoDate: string; province: string }
const regSep: RegRow[] = [];
const regOct: RegRow[] = [];

for (const v of vehicles) {
  if (v.registered === 'none') continue;
  const province = v.province!;
  if (v.registered === 'both') {
    const odoDate = v === hero ? '2026-03-02' : randDate('2026-02-01', '2026-08-15');
    regSep.push({
      v,
      vin: v === ioTypo ? v.vin.slice(0, 11) + v.vin.slice(11).replace('0', 'O') : v.vin,
      make: v.spec.regMake,
      model: v.spec.regModel,
      colour: v.colour.toUpperCase(),
      odoKm: v === hero ? 88_900 : kmAt(v, odoDate),
      odoDate,
      province,
    });
  }
  const octDate = v === hero ? '2026-09-28' : randDate('2026-09-02', '2026-09-27');
  regOct.push({
    v,
    vin: v.vin,
    make: v.spec.regMakeV2,
    model: v.spec.regModel,
    colour: v.colour.toUpperCase(),
    odoKm: v === hero ? 91_300 : kmAt(v, octDate),
    odoDate: octDate,
    province,
  });
}
// Shuffle row order per drop (the October file is not sorted like September's).
const shuffle = <T,>(xs: T[]) => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
};
shuffle(regSep);
shuffle(regOct);

const toDmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const csvCell = (s: string | number) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
const csv = (header: string[], rows: (string | number)[][]) =>
  [header.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n';

const SEP_HEADER = ['vin', 'model_year', 'make', 'model', 'colour', 'registration_date', 'odometer_km', 'odometer_date', 'province'];
const sepCsv = csv(
  SEP_HEADER,
  regSep.map((r) => [r.vin, r.v.spec.year, r.make, r.model, r.colour, r.v.registrationDate, r.odoKm, r.odoDate, r.province]),
);
regSep.forEach((r, i) => (truthRecords[`registration:2026-09-01:${i + 1}`] = { vin: r.v.vin, caseTag: r.v.caseTag }));

const OCT_HEADER = ['PROV_CD', 'VIN_NO', 'REG_DT', 'MAKE_CD', 'MODEL_DESC', 'MDL_YR', 'CLR', 'ODO_DT', 'ODO'];
const octCsv = csv(
  OCT_HEADER,
  regOct.map((r) => [r.province, r.vin, toDmy(r.v.registrationDate), r.make, r.model, r.v.spec.year, r.colour, toDmy(r.odoDate), r.odoKm]),
);
regOct.forEach((r, i) => (truthRecords[`registration:2026-10-01:${i + 1}`] = { vin: r.v.vin, caseTag: r.v.caseTag }));

// ---------- module reads ----------
interface ModuleRead { read_id: string; device_id: string; vin: string; odometer_km: number; read_at: string; protocol: string }
const reads: ModuleRead[] = [];
function addRead(v: Vehicle, date: string, km?: number) {
  const id = `M-${2001 + reads.length}`;
  reads.push({
    read_id: id,
    device_id: `dev-${String(int(100, 999))}`,
    vin: v.vin,
    odometer_km: km ?? kmAt(v, date),
    read_at: `${date}T${String(int(8, 18)).padStart(2, '0')}:${String(int(0, 59)).padStart(2, '0')}:00Z`,
    protocol: 'OBD-II mode 09 PID 02 + odometer PID',
  });
  truthRecords[`module_read:${id}`] = { vin: v.vin, caseTag: v.caseTag };
}
addRead(hero, '2026-09-20', 91_240);
addRead(lotClassic, '2026-09-30', 65_400);
addRead(lotNewGen, '2026-09-29', 63_100);
addRead(ioTypo, randDate('2026-08-20', '2026-10-03'));
addRead(noRegKona, randDate('2026-08-20', '2026-10-03'));
addRead(twinA, randDate('2026-08-20', '2026-10-03'));
addRead(twinB, randDate('2026-08-20', '2026-10-03'));
const readPool = vehicles.filter((v) => v.caseTag === 'plain' || v === subTypo || v === colourConflict);
shuffle(readPool);
for (const v of readPool.slice(0, 23)) addRead(v, randDate('2026-08-20', '2026-10-03'));

// ---------- listings ----------
interface Listing { listing_id: string; seller: string; title: string; vin: string | null; price_cad: number; km: number; listed_at: string; colour: string }
const listings: Listing[] = [];
const SUFFIXES = [' - one owner', ', clean history', ' - certified', ' - low km', ', winter tires included', ''];
let inflatedCount = 0;
function addListing(
  v: Vehicle,
  o: { seller: string; vin?: string | null; km?: number; date?: string; title?: string; colour?: string; inflated?: boolean; caseTag?: string },
) {
  const id = `L-${1001 + listings.length}`;
  const date = o.date ?? randDate('2026-09-15', '2026-10-05');
  const inflated = o.inflated ?? rand() < 0.4;
  if (inflated) inflatedCount++;
  const trim = inflated ? v.spec.sellerInflated : v.spec.sellerHonest;
  const title = o.title ?? `${v.spec.year} ${v.spec.titleName} ${trim}${pick(SUFFIXES)}`;
  listings.push({
    listing_id: id,
    seller: o.seller,
    title,
    vin: o.vin === undefined ? v.vin : o.vin,
    price_cad: Math.round((v.spec.year === 2023 ? 27_000 : 21_000) + rand() * 14_000) - (Math.round(rand() * 9) * 100),
    km: o.km ?? kmAt(v, date),
    listed_at: date,
    colour: o.colour ?? v.colour,
  });
  truthRecords[`listing:${id}`] = { vin: v.vin, caseTag: o.caseTag ?? v.caseTag };
}

// The hero: a mistyped VIN (positions 16 and 17 swapped) and a rolled-back odometer claim.
const heroListingVin = hero.vin.slice(0, 15) + hero.vin[16] + hero.vin[15];
addListing(hero, {
  seller: LOTS.hamilton,
  vin: heroListingVin,
  km: 48_000,
  date: '2026-10-02',
  title: '2019 Dodge Ram SLT 4x4 Crew Cab - ONLY 48,000 KM!',
  inflated: false,
});
// Lot 14 holds a Classic and a new-generation 1500, then posts a VIN-less 'Ram 1500 4x4'.
addListing(lotClassic, { seller: LOTS.sudbury, km: 65_200, date: '2026-09-24' });
addListing(lotNewGen, { seller: LOTS.sudbury, km: 62_900, date: '2026-09-22' });
addListing(lotNewGen, { seller: LOTS.sudbury, vin: null, km: 64_000, date: '2026-10-03', title: '2019 Ram 1500 4x4 - certified, 64,000 km', inflated: false });
// Fleet twins: the listing VIN is one edit from both trucks.
const twinListingVin = twinA.vin.slice(0, 16) + twinB.vin[16];
addListing(twinB, { seller: LOTS.guelph, vin: twinListingVin });
// Pasted VIN: the white RAV4's listing carries the silver RAV4's VIN.
addListing(rav4Silver, { seller: LOTS.windsor });
addListing(rav4White, { seller: LOTS.windsor, vin: rav4Silver.vin, colour: 'White' });
// One mistyped character.
const subPos = 16; // 0-based index, VIN position 17
const subChar = subTypo.vin[subPos] === '8' ? '3' : '8';
const subTypoVin = subTypo.vin.slice(0, subPos) + subChar + subTypo.vin.slice(subPos + 1);
addListing(subTypo, { seller: pick(GENERAL_LOTS), vin: subTypoVin });
// The same Civic posted twice on one lot, once without its VIN.
addListing(repost, { seller: LOTS.barrie, date: '2026-09-18', inflated: false });
addListing(repost, { seller: LOTS.barrie, vin: null, date: '2026-10-01', inflated: false });
// Colour conflict: registry says blue, the listing says black.
addListing(colourConflict, { seller: LOTS.oshawa, colour: 'Black', inflated: false });
// No registry record at all.
addListing(noRegKona, { seller: LOTS.kingston });
addListing(noRegRogue, { seller: LOTS.hamilton });

const listingPool = vehicles.filter((v) => v.caseTag === 'plain');
shuffle(listingPool);
for (const v of listingPool.slice(0, 25)) {
  // Keep the planted lots clean: no other Rams on Lot 14, no other Civics on Lot 11.
  addListing(v, { seller: pick(GENERAL_LOTS) });
}
listings.sort((a, b) => a.listing_id.localeCompare(b.listing_id));

// ---------- assertions on the planted cases ----------
const validVins = vehicles.map((v) => v.vin);
const inReach = (bad: string) => validVins.filter((g) => oneEditRepair(bad, g) !== null);
const expectReach = (label: string, bad: string, want: string[]) => {
  const got = inReach(bad).sort();
  if (JSON.stringify(got) !== JSON.stringify([...want].sort())) throw new Error(`${label}: in reach ${got.join(',')}`);
};
if (isValidVin(heroListingVin)) throw new Error('hero listing VIN should fail its check digit');
expectReach('hero listing', heroListingVin, [hero.vin]);
expectReach('fleet-twin listing', twinListingVin, [twinA.vin, twinB.vin]);
expectReach('substitution', subTypoVin, [subTypo.vin]);
expectReach('io typo', regSep.find((r) => r.v === ioTypo)!.vin, [ioTypo.vin]);
for (const r of [...regSep, ...regOct]) if (r.v !== ioTypo && !isValidVin(r.vin)) throw new Error(`unplanned bad registry VIN ${r.vin}`);

// ---------- write ----------
function write(rel: string, body: string) {
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}
write('sources/registration/2026-09-01.csv', sepCsv);
write('sources/registration/2026-10-01.csv', octCsv);
write('sources/listing/2026-10-05.json', JSON.stringify(listings, null, 2) + '\n');
write('sources/module_read/2026-10-04.json', JSON.stringify(reads, null, 2) + '\n');

const truth = {
  synthetic: true,
  note: 'Synthetic truth labels for the synthetic sources in this folder. Any match to a real vehicle is coincidental.',
  cases: CASE_LABELS,
  vehicles: Object.fromEntries(
    vehicles
      .slice()
      .sort((a, b) => a.vin.localeCompare(b.vin))
      .map((v) => [
        v.vin,
        {
          make: v.spec.make,
          model: v.spec.model,
          modelYear: v.spec.year,
          trim: v.spec.trueTrim,
          colour: v.colour,
          registeredProvince: v.province,
          caseTag: v.caseTag,
        },
      ]),
  ),
  records: Object.fromEntries(Object.entries(truthRecords).sort(([a], [b]) => a.localeCompare(b))),
};
write('truth.json', JSON.stringify(truth, null, 2) + '\n');

console.log(
  `vehicles ${vehicles.length}, registration ${regSep.length} + ${regOct.length}, listings ${listings.length} (${inflatedCount} inflated trims), module reads ${reads.length}`,
);
