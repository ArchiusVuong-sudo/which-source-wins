import type { FieldName } from '../shared/types';

export const FIELD_LABEL: Record<FieldName, string> = {
  make: 'Make',
  model: 'Model',
  modelYear: 'Model year',
  trim: 'Trim',
  series: 'Series',
  body: 'Body',
  drive: 'Drive',
  engine: 'Engine',
  fuel: 'Fuel',
  plant: 'Assembly plant',
  colour: 'Colour',
  odometerKm: 'Odometer',
  registeredProvince: 'Registered province',
  registrationDate: 'Registration date',
  observedTrim: 'Observed trim',
};

export const DECODED_FIELDS: FieldName[] = ['make', 'model', 'modelYear', 'trim', 'series', 'body', 'drive', 'engine', 'fuel', 'plant'];
export const OBSERVED_FIELDS: FieldName[] = ['colour', 'odometerKm', 'registeredProvince', 'registrationDate'];
