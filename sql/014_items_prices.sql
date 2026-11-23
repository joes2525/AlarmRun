-- Inspection v2: price list, actions/quotes per item, property details, rolled-up notes

-- Editable lists: locations, device types, actions (priced), quotes (priced)
create table if not exists price_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies on delete cascade,
  kind text not null check (kind in ('location','device_type','action','quote')),
  name text not null,
  price numeric(10,2) default 0,          -- ex GST; ignored for locations and device types
  sort int default 0,
  active boolean default true,
  unique (company_id, kind, name)
);
alter table price_items enable row level security;
drop policy if exists company_isolation on price_items;
create policy company_isolation on price_items
  using (company_id in (select my_company_ids()))
  with check (company_id in (select my_company_ids()));
grant select, insert, update, delete on price_items to authenticated;

insert into price_items (company_id, kind, name, sort)
select c.id, v.kind, v.name, v.sort from companies c, (values
  ('location','Bedroom 1',1),('location','Bedroom 2',2),('location','Bedroom 3',3),('location','Bedroom 4',4),('location','Bedroom 5',5),
  ('location','Master bedroom',6),('location','Hallway',10),('location','Upstairs hallway',11),('location','Downstairs hallway',12),
  ('location','Lounge',20),('location','Kitchen',21),('location','Stairwell',22),('location','Study',23),('location','Rumpus',24),('location','Garage',25),
  ('device_type','Photoelectric',1),('device_type','Heat',2),('device_type','Ionisation',3),('device_type','Alarm controller',4),
  ('action','Serviced',1),('action','Replaced',2),('action','Moved',3),('action','Missing',4),('action','Expired',5),
  ('quote','Upgrade',1),('quote','Install new',2),('quote','Replace',3),('quote','Move',4),('quote','Remove',5)
) v(kind, name, sort)
on conflict do nothing;

-- devices can be any type now (e.g. alarm controller)
alter table alarms drop constraint if exists alarms_sensor_type_check;
alter table alarms drop constraint if exists alarms_power_source_check;

-- what happened to each item at an inspection, with prices captured for invoicing
alter table alarm_checks add column if not exists action text;
alter table alarm_checks add column if not exists action_price numeric(10,2);
alter table alarm_checks add column if not exists quote text;
alter table alarm_checks add column if not exists quote_price numeric(10,2);

-- end-of-inspection answers
alter table jobs add column if not exists blind_cleats text;          -- 'All present' | 'Needed' | 'Not applicable'
alter table jobs add column if not exists blind_cleats_needed int;
alter table jobs add column if not exists safety_switch text;         -- 'Tested OK' | 'Failed' | 'No safety switch' | 'Not tested'
alter table jobs add column if not exists comment_photo text;
alter table jobs add column if not exists outcome text;               -- 'compliant' | 'non_compliant' | 'no_access'

-- property details + notes passed to the inspector
alter table properties add column if not exists ceiling_access text;  -- 'Easy' | 'Limited' | 'None'
alter table properties add column if not exists notes text;           -- permanent property notes
alter table clients add column if not exists notes text;              -- agent comments
alter table tenancies add column if not exists notes text;            -- tenant comments

-- Finish an inspection (replaces the first version)
-- p_items: [{alarm_id|null, location, device_type, manufacture_date, power_source, action, new_location, quote, photo_path}]
-- p_extra: {blind_cleats, blind_cleats_needed, safety_switch, comment, comment_photo, ceiling_access, storeys, bedrooms}
drop function if exists complete_job(uuid, jsonb, jsonb, boolean, text);
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
        location         = case when it->>'action' = 'Moved' then coalesce(nullif(it->>'new_location', ''), location) else location end,
        active           = coalesce(it->>'action', '') <> 'Missing'
      where id = aid and property_id = j.property_id;
    end if;
    insert into alarm_checks (company_id, job_id, alarm_id, tested_ok, cleaned, replaced_alarm, in_date, photo_path,
                              action, action_price, quote, quote_price)
    select j.company_id, p_job, al.id, it->>'action' in ('Serviced','Replaced','Moved'), it->>'action' in ('Serviced','Replaced','Moved'),
           it->>'action' = 'Replaced', al.expiry_date >= current_date, it->>'photo_path',
           nullif(it->>'action', ''), (select price from price_items where company_id = j.company_id and kind = 'action' and name = it->>'action'),
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
    safety_switch = nullif(p_extra->>'safety_switch', '')
  where id = p_job;

  cert := 'C' || to_char(now() at time zone 'Australia/Brisbane', 'YYMMDD') || '-' || upper(left(replace(p_job::text, '-', ''), 6));
  insert into certificates (company_id, job_id, number, compliant) values (j.company_id, p_job, cert, p_outcome = 'compliant');
  return cert;
end $$;
grant execute on function complete_job(uuid, jsonb, text, jsonb) to authenticated;
