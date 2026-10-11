// Entity resolution in SQL.
//   1. Exact: records with a valid VIN link on that VIN.
//   2. Repair: an invalid VIN links when exactly one known valid VIN is one edit away.
//   3. Blocking: a VIN-less listing links when exactly one vehicle fits make, model, year, seller and km band.
//   Two different valid VINs are never linked (cannot-link). Vehicles are the connected
//   components of the link graph, found with a recursive CTE.

import { rows, type Sql } from './db.js';
import type { VinPatternDecoder } from './decoder.js';

/** Decodes every 17-character VIN we have not decoded yet, valid or not. */
export async function decodeNewVins(sql: Sql, decoder: VinPatternDecoder): Promise<number> {
  const todo = await rows<{ vin: string }>(
    sql,
    `select distinct vin_norm as vin from source_record r
     where length(vin_norm) = 17 and not exists (select 1 from decoded_vin d where d.vin = r.vin_norm)
     order by 1`,
  );
  for (const { vin } of todo) {
    const d = await decoder.decode(vin);
    const fact = (f: string) => d.facts.find((x) => x.field === f)?.value ?? null;
    await sql.query(
      `insert into decoded_vin (vin, check_ok, check_expected, decoder_summary, decoder_valid, withheld_reason, make, model, model_year, facts)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [vin, d.checkOk, d.checkExpected, d.decoderSummary, d.decoderValid, d.withheldReason, fact('make'), fact('model'), fact('modelYear'), JSON.stringify(d.facts)],
    );
  }
  return todo.length;
}

export interface MatchStats {
  exact: number;
  repaired: number;
  blocked: number;
  unresolved: number;
  vehicles: number;
  cannotLinkViolations: number;
}

export async function runMatcher(sql: Sql, kmBand: number): Promise<MatchStats> {
  await sql.exec('delete from match_link; delete from match_unresolved; delete from vehicle;');

  // 1. Exact VIN. The peer is the first record holding the same VIN.
  await sql.exec(`
    insert into match_link (record_id, vehicle_vin, peer_record, method, evidence)
    select r.record_id, r.vin_norm,
      first_value(r.record_id) over (partition by r.vin_norm order by r.tier, r.record_id),
      'exact',
      jsonb_build_object('detail', 'exact VIN match, check digit passes')
    from source_record r
    where r.vin_check_ok;
  `);

  // 2. One-edit repair against the VINs we already trust. Abstain unless exactly one is in reach.
  await sql.exec(`
    with known as (
      select vehicle_vin as vin, min(record_id) as peer from match_link group by vehicle_vin
    ),
    bad as (
      select record_id, vin_norm from source_record where vin_norm is not null and not vin_check_ok
    ),
    cand as (
      select b.record_id, k.vin, k.peer, vin_one_edit(b.vin_norm, k.vin) as repair
      from bad b join known k on vin_one_edit(b.vin_norm, k.vin) is not null
    ),
    counted as (
      select record_id, count(*) as n, jsonb_agg(vin order by vin) as vins from cand group by record_id
    )
    insert into match_link (record_id, vehicle_vin, peer_record, method, evidence)
    select c.record_id, c.vin, c.peer, 'repair',
      jsonb_build_object('repair', c.repair || jsonb_build_object('from', b.vin_norm, 'to', c.vin))
    from cand c join counted n using (record_id) join bad b using (record_id)
    where n.n = 1;

    with known as (select distinct vehicle_vin as vin from match_link where method = 'exact'),
    bad as (
      select record_id, vin_norm from source_record r
      where vin_norm is not null and not vin_check_ok and not exists (select 1 from match_link l where l.record_id = r.record_id)
    ),
    cand as (
      select b.record_id, jsonb_agg(k.vin order by k.vin) filter (where k.vin is not null) as vins
      from bad b left join known k on vin_one_edit(b.vin_norm, k.vin) is not null
      group by b.record_id
    )
    insert into match_unresolved (record_id, reason, candidates)
    select record_id,
      case when vins is null then 'VIN fails its check digit and no known VIN is one edit away'
           else 'VIN fails its check digit and is one edit from ' || jsonb_array_length(vins) || ' known VINs, so the matcher abstains' end,
      coalesce(vins, '[]'::jsonb)
    from cand;
  `);

  // 3. Blocking for VIN-less listings: same decoded make, model and year, same seller, km within the band.
  await sql.query(
    `with vehicles as (
       select l.vehicle_vin as vin, min(l.record_id) as peer, d.make, d.model, d.model_year
       from match_link l join decoded_vin d on d.vin = l.vehicle_vin
       group by l.vehicle_vin, d.make, d.model, d.model_year
     ),
     lots as (
       select distinct l.vehicle_vin as vin, r.seller
       from match_link l join source_record r using (record_id) where r.source = 'listing'
     ),
     latest_km as (
       select distinct on (l.vehicle_vin) l.vehicle_vin as vin, r.km, r.observed_at, r.record_id
       from match_link l join source_record r using (record_id)
       where r.km is not null
       order by l.vehicle_vin, r.observed_at desc, r.tier
     ),
     vinless as (
       select * from source_record where source = 'listing' and vin_norm is null
     ),
     cand as (
       select x.record_id, v.vin, v.peer, k.km as candidate_km, k.record_id as km_record,
         x.make, x.model, x.model_year, x.seller, x.km
       from vinless x
       join vehicles v on v.make = x.make and model_key(v.model) = model_key(x.model) and v.model_year = x.model_year
       join lots s on s.vin = v.vin and s.seller = x.seller
       join latest_km k on k.vin = v.vin and abs(k.km - x.km) <= $1
     ),
     counted as (select record_id, count(*) as n from cand group by record_id)
     insert into match_link (record_id, vehicle_vin, peer_record, method, evidence)
     select c.record_id, c.vin, c.peer, 'attribute',
       jsonb_build_object('blocking', jsonb_build_object('make', c.make, 'model', c.model, 'modelYear', c.model_year,
         'seller', c.seller, 'km', c.km, 'candidateKm', c.candidate_km, 'kmBand', $1::int, 'kmRecord', c.km_record))
     from cand c join counted n using (record_id)
     where n.n = 1`,
    [kmBand],
  );
  await sql.query(
    `with vehicles as (
       select l.vehicle_vin as vin, d.make, d.model, d.model_year, d.decoder_summary
       from match_link l join decoded_vin d on d.vin = l.vehicle_vin
       group by l.vehicle_vin, d.make, d.model, d.model_year, d.decoder_summary
     ),
     lots as (
       select distinct l.vehicle_vin as vin, r.seller from match_link l join source_record r using (record_id) where r.source = 'listing'
     ),
     latest_km as (
       select distinct on (l.vehicle_vin) l.vehicle_vin as vin, r.km
       from match_link l join source_record r using (record_id) where r.km is not null
       order by l.vehicle_vin, r.observed_at desc, r.tier
     ),
     vinless as (
       select * from source_record r
       where source = 'listing' and vin_norm is null and not exists (select 1 from match_link l where l.record_id = r.record_id)
     ),
     cand as (
       select x.record_id,
         jsonb_agg(v.vin || ' (' || coalesce(v.decoder_summary, v.make || ' ' || v.model) || ', ' || to_char(k.km, 'FM999,999') || ' km)' order by v.vin)
           filter (where v.vin is not null) as vins
       from vinless x
       left join (vehicles v join lots s on s.vin = v.vin join latest_km k on k.vin = v.vin)
         on v.make = x.make and model_key(v.model) = model_key(x.model) and v.model_year = x.model_year
        and s.seller = x.seller and abs(k.km - x.km) <= $1
       group by x.record_id
     )
     insert into match_unresolved (record_id, reason, candidates)
     select record_id,
       case when vins is null then 'No VIN, and no vehicle on this lot fits make, model, year and a ' || to_char($1::int, 'FM999,999') || ' km band'
            else 'No VIN, and ' || jsonb_array_length(vins) || ' vehicles on this lot fit make, model, year and a '
              || to_char($1::int, 'FM999,999') || ' km band, so the matcher abstains' end,
       coalesce(vins, '[]'::jsonb)
     from cand`,
    [kmBand],
  );

  // Vehicles: connected components of the link graph. A component's VIN is its only valid VIN.
  await sql.exec(`
    with recursive edge as (
      select record_id as a, peer_record as b from match_link
      union select peer_record, record_id from match_link
    ),
    reach (root, node) as (
      select record_id, record_id from match_link
      union
      select r.root, e.b from reach r join edge e on e.a = r.node
    ),
    component as (
      select node as record_id, min(root) as component from reach group by node
    )
    insert into vehicle (vin, component, record_ids)
    select min(r.vin_norm) filter (where r.vin_check_ok), c.component, array_agg(c.record_id order by c.record_id)
    from component c join source_record r using (record_id)
    group by c.component;
  `);

  const [stats] = await rows<MatchStats>(
    sql,
    `select
       (select count(*)::int from match_link where method = 'exact') as exact,
       (select count(*)::int from match_link where method = 'repair') as repaired,
       (select count(*)::int from match_link where method = 'attribute') as blocked,
       (select count(*)::int from source_record r where not exists (select 1 from match_link l where l.record_id = r.record_id)) as unresolved,
       (select count(*)::int from vehicle) as vehicles,
       (${CANNOT_LINK_SQL}) as "cannotLinkViolations"`,
  );
  return stats!;
}

/** Components holding more than one distinct valid VIN. Must always be zero. */
export const CANNOT_LINK_SQL = `
  select count(*)::int from (
    select c.component from vehicle c
    cross join lateral unnest(c.record_ids) as rid
    join source_record r on r.record_id = rid and r.vin_check_ok
    group by c.component having count(distinct r.vin_norm) > 1
  ) v`;
