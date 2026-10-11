// Types shared by the API and the UI. The UI imports these as types only.

export const SOURCE_IDS = ['vin_pattern', 'registration', 'module_read', 'listing'] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export interface SourceInfo {
  id: SourceId;
  label: string;
  tier: number;
  kind: 'derived' | 'observed';
  description: string;
}

export const FIELD_NAMES = [
  'make',
  'model',
  'modelYear',
  'trim',
  'series',
  'body',
  'drive',
  'engine',
  'fuel',
  'plant',
  'colour',
  'odometerKm',
  'registeredProvince',
  'registrationDate',
  'observedTrim',
] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

export type FieldValue = string | number | null;

export interface AlsoReported {
  value: string | number;
  source: SourceId;
  tier: number;
  asOf: string | null;
  recordId: string | null;
  agrees: boolean;
  flag: string | null;
}

export interface PatternEvidence {
  element: string;
  rawPattern: string | null;
  positions: number[];
  options: string[] | null;
}

export interface GoldenField {
  value: FieldValue;
  source: SourceId | null;
  tier: number | null;
  asOf: string | null;
  ruleId: string;
  ruleVersion: number;
  alsoReported: AlsoReported[];
  conflict: boolean;
  reason: string;
  flags: string[];
  recordId: string | null;
  pattern: PatternEvidence | null;
}

export interface GoldenRecord {
  vin: string;
  synthetic: true;
  fields: Record<FieldName, GoldenField>;
  sourceRecords: string[];
}

export type DropStatus = 'quarantined' | 'pending_rebuild' | 'loaded';

export interface DropSummary {
  id: number;
  source: SourceId;
  dropDate: string;
  key: string;
  sha256: string;
  bytes: number;
  rows: number;
  status: DropStatus;
  mappingVersion: number | null;
  landedAt: string;
}

export type ColumnType =
  | 'vin'
  | 'year'
  | 'integer'
  | 'date'
  | 'make'
  | 'model'
  | 'colour'
  | 'province'
  | 'text';

export interface ColumnProfile {
  column: string;
  position: number;
  rows: number;
  distinct: number;
  samples: string[];
  detectedType: ColumnType;
  typeShare: number;
  checks: string[];
  dateOrder: 'YMD' | 'DMY' | 'MDY' | 'ambiguous' | null;
}

export interface MappingProposalRow {
  field: string;
  column: string | null;
  confidence: number;
  evidence: string[];
}

export interface DriftReport {
  status: 'match' | 'drift';
  expectedHeader: string[];
  foundHeader: string[];
  missing: string[];
  added: string[];
  reordered: boolean;
  profiles: ColumnProfile[];
  proposal: MappingProposalRow[];
  dateFormat: 'YYYY-MM-DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY' | null;
  dateEvidence: string;
  blocking: string[];
}

export interface ColumnMapping {
  version: number;
  source: SourceId;
  header: string[];
  columns: Record<string, string>;
  dateFormat: 'YYYY-MM-DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY';
}

export interface BuildSummary {
  id: number;
  createdAt: string;
  trigger: string;
  ruleSetVersion: number;
  vehicles: number;
  added: number;
  changed: number;
  removed: number;
  full: { key: string; rows: number; sha256: string };
  delta: { key: string; rows: number; sha256: string };
}

export interface LinkEvidence {
  method: 'exact' | 'repair' | 'attribute';
  detail: string;
  repair?: { kind: 'io_fix' | 'transposition' | 'substitution'; positions: number[]; from: string; to: string };
  blocking?: { make: string; model: string; modelYear: number; seller: string; km: number; candidateKm: number; kmBand: number };
}

export interface MatchedRecord {
  recordId: string;
  source: SourceId;
  tier: number;
  observedAt: string | null;
  vinRaw: string | null;
  vinCheck: 'pass' | 'fail' | 'missing' | 'bad_shape';
  checkExpected: string | null;
  withheldDecode: string | null;
  link: LinkEvidence;
  payload: Record<string, unknown>;
}

export interface VehicleRow {
  vin: string;
  title: string;
  trim: FieldValue;
  observedTrim: FieldValue;
  odometerKm: FieldValue;
  sources: Partial<Record<SourceId, number>>;
  conflicts: FieldName[];
  empty: FieldName[];
  flags: string[];
}

export interface UnresolvedRecord {
  recordId: string;
  source: SourceId;
  vinRaw: string | null;
  summary: string;
  reason: string;
  candidates: string[];
}

export interface VehicleDetail {
  golden: GoldenRecord;
  records: MatchedRecord[];
  buildId: number;
}

export interface FieldRule {
  id: string;
  version: number;
  kind: 'precedence' | 'latest_reading';
  sources: SourceId[];
  allowedSources: SourceId[];
  note: string;
}

export interface RuleSet {
  version: number;
  matching: { kmBand: number };
  fields: Record<FieldName, FieldRule>;
}

export interface Score {
  correct: number;
  wrong: number;
  empty: number;
  total: number;
}

export interface PreviewChange {
  vin: string;
  title: string;
  before: FieldValue;
  after: FieldValue;
  afterSource: SourceId | null;
  truth: FieldValue;
  verdict: 'correct' | 'wrong' | 'empty';
}

export interface RulePreview {
  field: FieldName;
  from: FieldRule;
  to: FieldRule;
  changes: PreviewChange[];
  before: Score;
  after: Score;
  wrongAfter: PreviewChange[];
  rolledBack: true;
}

export interface Decision {
  id: number;
  at: string;
  field: FieldName;
  decision: 'accepted' | 'rejected';
  ruleId: string;
  fromVersion: number;
  proposedVersion: number;
  proposedSources: SourceId[];
  reason: string;
  before: Score;
  after: Score;
  buildId: number | null;
}

export interface PairMetrics {
  records: number;
  truePairs: number;
  predictedPairs: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface NamedError {
  kind: 'false_merge' | 'missed_match';
  caseTag: string;
  caseLabel: string;
  pairs: number;
  explanation: string;
  records: { recordId: string; source: SourceId; vinRaw: string | null; summary: string; trueVin: string; predictedVin: string | null }[];
}

export interface QualityReport {
  pairs: PairMetrics;
  errors: NamedError[];
  cannotLinkViolations: number;
  fieldAccuracy: { field: FieldName; score: Score }[];
  buildId: number;
  note: string;
}

export interface PlanNode {
  nodeType: string;
  relation: string | null;
  index: string | null;
  actualRows: number;
  actualTotalMs: number;
  loops: number;
  sharedHit: number;
  sharedRead: number;
  detail: string | null;
  children: PlanNode[];
}

export interface ScaleRun {
  label: string;
  executionMs: number;
  planningMs: number;
  plan: PlanNode;
  resultRows: number;
}

export interface ScaleReport {
  rows: number;
  insertMs: number;
  indexMs: number;
  query: string;
  withoutIndex: ScaleRun;
  withIndex: ScaleRun;
}

export interface Summary {
  buildId: number | null;
  ruleSetVersion: number;
  vehicles: number;
  records: number;
  unresolved: number;
  quarantined: number;
  pendingRebuild: number;
}
