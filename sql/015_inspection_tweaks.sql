-- Inspection tweaks: replace reasons (priced), Damaged action, blind cleat charges, safety switch notes

alter table price_items drop constraint if exists price_items_kind_check;
alter table price_items add constraint price_items_kind_check
  check (kind in ('location','device_type','action','quote','replace_reason','extra'));

insert into price_items (company_id, kind, name, sort)
select c.id, v.kind, v.name, v.sort from companies c, (values
  ('action','Damaged',5),
  ('replace_reason','Under warranty',1),('replace_reason','Broken',2),('replace_reason','Faulty',3),
  ('replace_reason','Damaged',4),('replace_reason','Expired',5),('replace_reason','Missing',6),
  ('extra','Blind cleat – installed (each)',1),('extra','Blind cleat – quote (each)',2)
) v(kind, name, sort)
on conflict do nothing;
update price_items set sort = 6 where kind = 'action' and name = 'Expired';

alter table alarm_checks add column if not exists replace_reason text;
alter table jobs add column if not exists safety_switch_notes text;
-- blind_cleats is now 'Compliant' | 'Needed' | 'Installed' (+ blind_cleats_needed = how many)

create or replace function complete_job(p_job uuid, p_items jsonb, p_outcome text, p_extra jsonb)
returns text language plpgsql security invoker set search_path = public as $$
declare j record; it jsonb; aid uuid; cert text;
begin
  select * into j from jobs where id = p_job;
  if j.id is null then raise exception 'Job not found'; end if;
  if j.locked then raise exception 'This job is already completed'; end if;
  if p_outcome not in ('compliant', 'non_compliant') then raise exception 'Outcome must be compliant or non_compliant'; end if;

  for it in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    aid := nullif(it->>'alarm_id', '')::uuid;
    if aid is null then                                  -- newly added item
      insert into alarms (company_id, property_id, location, sensor_type, power_source, manufacture_date, active)
      values (j.company_id, j.property_id, it->>'location', it->>'device_type', nullif(it->>'power_source', ''),
              nullif(it->>'manufacture_date', '')::date, coalesce(it->>'action', '') <> 'Missing')
      returning id into aid;
    else
      update alarms set
        sensor_type      = coalesce(nullif(it->>'device_type', ''), sensor_type),
        manufacture_date = coalesce(nullif(it->>'manufacture_date', '')::date, manufacture_date),
        power_source     = coalesce(nullif(it->>'power_source', ''), power_source),
        active           = coalesce(it->>'action', '') <> 'Missing'
      where id = aid and property_id = j.property_id;
    end if;
    insert into alarm_checks (company_id, job_id, alarm_id, tested_ok, cleaned, replaced_alarm, in_date, photo_path,
                              action, replace_reason, action_price, quote, quote_price)
    select j.company_id, p_job, al.id, it->>'action' in ('Serviced','Replaced','Moved'), it->>'action' in ('Serviced','Replaced','Moved'),
           it->>'action' = 'Replaced', al.expiry_date >= current_date, it->>'photo_path',
           nullif(it->>'action', ''), nullif(it->>'replace_reason', ''),
           coalesce((select price from price_items where company_id = j.company_id and kind = 'replace_reason' and name = it->>'replace_reason' and it->>'action' = 'Replaced'),
                    (select price from price_items where company_id = j.company_id and kind = 'action' and name = it->>'action')),
           nullif(it->>'quote', ''),  (select price from price_items where company_id = j.company_id and kind = 'quote' and name = it->>'quote')
    from alarms al where al.id = aid;
  end loop;

  update properties set
    ceiling_access = coalesce(nullif(p_extra->>'ceiling_access', ''), ceiling_access),
    storeys        = coalesce(nullif(p_extra->>'storeys', '')::int, storeys),
    bedrooms       = coalesce(nullif(p_extra->>'bedrooms', '')::int, bedrooms)
  where id = j.property_id;

  update jobs set status = 'completed', completed_at = now(), outcome = p_outcome,
    outcome_notes = nullif(p_extra->>'comment', ''), comment_photo = nullif(p_extra->>'comment_photo', ''),
    blind_cleats = nullif(p_extra->>'blind_cleats', ''), blind_cleats_needed = nullif(p_extra->>'blind_cleats_needed', '')::int,
    safety_switch = nullif(p_extra->>'safety_switch', ''), safety_switch_notes = nullif(p_extra->>'safety_switch_notes', '')
  where id = p_job;

  cert := 'C' || to_char(now() at time zone 'Australia/Brisbane', 'YYMMDD') || '-' || upper(left(replace(p_job::text, '-', ''), 6));
  insert into certificates (company_id, job_id, number, compliant) values (j.company_id, p_job, cert, p_outcome = 'compliant');
  return cert;
end $$;
grant execute on function complete_job(uuid, jsonb, text, jsonb) to authenticated;
