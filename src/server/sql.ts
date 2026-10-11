// Schema and SQL functions. Applied idempotently on every start.

export const SCHEMA = /* sql */ `
create or replace function vin_norm(v text) returns text language sql immutable as $$
  select nullif(upper(regexp_replace(coalesce(v, ''), '[\\s-]', '', 'g')), '')
$$;

create or replace function vin_check_digit(v text) returns text language plpgsql immutable as $$
declare
  w int[] := array[8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
  s int := 0; c text; val int; r int;
begin
  if v is null or length(v) <> 17 then return null; end if;
  for i in 1..17 loop
    c := substr(v, i, 1);
    if c ~ '[0-9]' then val := c::int;
    else val := case c when 'A' then 1 when 'B' then 2 when 'C' then 3 when 'D' then 4 when 'E' then 5
      when 'F' then 6 when 'G' then 7 when 'H' then 8 when 'J' then 1 when 'K' then 2 when 'L' then 3
      when 'M' then 4 when 'N' then 5 when 'P' then 7 when 'R' then 9 when 'S' then 2 when 'T' then 3
      when 'U' then 4 when 'V' then 5 when 'W' then 6 when 'X' then 7 when 'Y' then 8 when 'Z' then 9
      else null end;
    end if;
    if val is null then return null; end if;
    s := s + val * w[i];
  end loop;
  r := s % 11;
  return case when r = 10 then 'X' else r::text end;
end $$;

create or replace function vin_check_ok(v text) returns boolean language sql immutable as $$
  select coalesce(v ~ '^[A-HJ-NPR-Z0-9]{17}$' and substr(v, 9, 1) = vin_check_digit(v), false)
$$;

-- How bad becomes good in one edit, or null. Mirrors oneEditRepair() in vin.ts.
create or replace function vin_one_edit(bad text, good text) returns jsonb language plpgsql immutable as $$
declare
  d int[] := '{}'; fixed text; pos int[] := '{}';
begin
  if bad is null or good is null or length(bad) <> 17 or length(good) <> 17 or bad = good then return null; end if;
  if bad ~ '[IOQ]' then
    fixed := translate(bad, 'IOQ', '100');
    if fixed = good then
      for i in 1..17 loop
        if substr(bad, i, 1) in ('I','O','Q') then pos := pos || i; end if;
      end loop;
      return jsonb_build_object('kind', 'io_fix', 'positions', to_jsonb(pos));
    end if;
  end if;
  for i in 1..17 loop
    if substr(bad, i, 1) <> substr(good, i, 1) then
      d := d || i;
      if array_length(d, 1) > 2 then return null; end if;
    end if;
  end loop;
  if array_length(d, 1) = 1 then
    return jsonb_build_object('kind', 'substitution', 'positions', to_jsonb(d));
  end if;
  if array_length(d, 1) = 2 and d[2] = d[1] + 1
     and substr(bad, d[1], 1) = substr(good, d[2], 1) and substr(bad, d[2], 1) = substr(good, d[1], 1) then
    return jsonb_build_object('kind', 'transposition', 'positions', to_jsonb(d));
  end if;
  return null;
end $$;

-- Lower-case words separated by single spaces, so aliases match on word boundaries.
create or replace function words(t text) returns text language sql immutable as $$
  select ' ' || trim(regexp_replace(lower(coalesce(t, '')), '[^a-z0-9]+', ' ', 'g')) || ' '
$$;

create or replace function model_key(t text) returns text language sql immutable as $$
  select nullif(upper(regexp_replace(coalesce(t, ''), '[^A-Za-z0-9]', '', 'g')), '')
$$;

create table if not exists source (
  id text primary key,
  label text not null,
  tier int not null,
  kind text not null,
  description text not null
);

create table if not exists make_alias (
  alias text primary key,
  make text not null,
  model text
);

create table if not exists trim_word (
  word text primary key
);

create table if not exists landing_file (
  id serial primary key,
  source text not null references source(id),
  drop_date date not null,
  sha256 text not null unique,
  key text not null,
  ext text not null,
  bytes int not null,
  rows int not null default 0,
  status text not null check (status in ('quarantined', 'pending_rebuild', 'loaded')),
  mapping_version int,
  drift jsonb,
  landed_at timestamptz not null default now()
);

create table if not exists column_mapping (
  source text not null references source(id),
  version int not null,
  header jsonb not null,
  columns jsonb not null,
  date_format text not null,
  approved_at timestamptz not null default now(),
  note text not null default '',
  primary key (source, version)
);

create table if not exists stg_registration (
  file_id int not null references landing_file(id),
  row_no int not null,
  vin text, model_year text, make text, model text, colour text,
  registration_date date, odometer_km text, odometer_date date, province text,
  primary key (file_id, row_no)
);

create table if not exists stg_listing (
  file_id int not null references landing_file(id),
  row_no int not null,
  listing_id text not null, seller text, title text, vin text, price_cad int, km int, listed_at date, colour text,
  primary key (file_id, row_no)
);

create table if not exists stg_module_read (
  file_id int not null references landing_file(id),
  row_no int not null,
  read_id text not null, device_id text, vin text, odometer_km int, read_at timestamptz, protocol text,
  primary key (file_id, row_no)
);

-- One row per observation, whatever the source.
create table if not exists source_record (
  record_id text primary key,
  source text not null references source(id),
  tier int not null,
  file_id int not null,
  vin_raw text,
  vin_norm text,
  vin_check_ok boolean not null,
  make_raw text,
  make text,
  model_raw text,
  model text,
  model_year int,
  colour text,
  km int,
  observed_at date,
  seller text,
  title text,
  observed_trim text,
  province text,
  registration_date date,
  payload jsonb not null
);
create index if not exists source_record_vin on source_record (vin_norm);
create index if not exists source_record_block on source_record (make, model, model_year, seller, km);

create table if not exists decoded_vin (
  vin text primary key,
  check_ok boolean not null,
  check_expected text,
  decoder_summary text,
  decoder_valid boolean not null,
  withheld_reason text,
  make text,
  model text,
  model_year int,
  facts jsonb not null
);

create table if not exists match_link (
  record_id text primary key references source_record(record_id) on delete cascade,
  vehicle_vin text not null,
  peer_record text not null,
  method text not null check (method in ('exact', 'repair', 'attribute')),
  evidence jsonb not null
);

create table if not exists match_unresolved (
  record_id text primary key references source_record(record_id) on delete cascade,
  reason text not null,
  candidates jsonb not null default '[]'
);

create table if not exists vehicle (
  vin text primary key,
  component text not null,
  record_ids text[] not null
);

create table if not exists observation (
  vin text not null,
  field text not null,
  value text,
  value_num numeric,
  norm text,
  raw text,
  source text not null,
  tier int not null,
  as_of date,
  record_id text,
  evidence jsonb,
  rollback_of jsonb
);
create index if not exists observation_vin_field on observation (vin, field);

create table if not exists rule_set (
  version int primary key,
  rules jsonb not null,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  reason text not null
);

create table if not exists decision (
  id serial primary key,
  at timestamptz not null default now(),
  field text not null,
  decision text not null check (decision in ('accepted', 'rejected')),
  rule_id text not null,
  from_version int not null,
  proposed_version int not null,
  proposed_sources jsonb not null,
  reason text not null check (length(trim(reason)) > 0),
  score_before jsonb not null,
  score_after jsonb not null,
  build_id int
);

create table if not exists build (
  id serial primary key,
  created_at timestamptz not null default now(),
  trigger text not null,
  rule_set_version int not null,
  vehicles int not null,
  added int not null,
  changed int not null,
  removed int not null,
  full_key text not null,
  full_rows int not null,
  full_sha256 text not null,
  delta_key text not null,
  delta_rows int not null,
  delta_sha256 text not null
);

create table if not exists build_vehicle (
  build_id int not null references build(id),
  vin text not null,
  sha256 text not null,
  -- json, not jsonb: keeps the field order the build file was written in.
  record json not null,
  primary key (build_id, vin)
);

create table if not exists truth_record (
  record_id text primary key,
  true_vin text not null,
  case_tag text not null
);

create table if not exists truth_vehicle (
  vin text primary key,
  attrs jsonb not null
);

create table if not exists truth_case (
  tag text primary key,
  label text not null
);
`;
