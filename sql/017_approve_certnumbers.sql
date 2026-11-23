-- Certificate numbers per company (AASA-00001) and an approval step on completed jobs

alter table companies add column if not exists cert_seq int not null default 0;
create or replace function next_cert_number(p_company uuid) returns text
language plpgsql security definer set search_path = public as $$
declare n int; code text;
begin
  if p_company not in (select my_company_ids()) then raise exception 'Not your company'; end if;
  update companies set cert_seq = cert_seq + 1 where id = p_company returning cert_seq, upper(coalesce(sender_code, 'C')) into n, code;
  return code || '-' || lpad(n::text, 5, '0');
end $$;

alter table jobs add column if not exists approved_at timestamptz;
alter table jobs add column if not exists approved_by uuid references auth.users;

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

  cert := next_cert_number(j.company_id);
  insert into certificates (company_id, job_id, number, compliant) values (j.company_id, p_job, cert, p_outcome = 'compliant');
  return cert;
end $$;
grant execute on function complete_job(uuid, jsonb, text, jsonb) to authenticated;

-- Completed page view now includes approval
create or replace view completed_summary with (security_invoker = on) as
select j.id, j.company_id, j.property_id, j.status, j.outcome,
       coalesce(j.completed_at, j.scheduled_start) as done_at,
       p.address_line, p.suburb, c.name as agency, i.name as inspector,
       j.blind_cleats, j.blind_cleats_needed, j.safety_switch, j.safety_switch_notes, j.outcome_notes as comment,
       cert.number as certificate, cert.compliant,
       coalesce(ch.items, 0) as items,
       ch.actions,                                     -- e.g. "Serviced ×5, Replaced (Broken) ×1"
       ch.quotes,                                      -- e.g. "Upgrade – Hallway, Replace – Bedroom 2"
       (coalesce(ch.billable, 0) > 0 or coalesce(j.blind_cleats, '') = 'Installed') as has_invoice,
       (coalesce(ch.quoted, 0) > 0 or coalesce(j.blind_cleats, '') = 'Needed') as has_quote,
       j.approved_at
from jobs j
join properties p on p.id = j.property_id
left join clients c on c.id = p.client_id
left join inspectors i on i.id = j.inspector_id
left join certificates cert on cert.job_id = j.id
left join lateral (
  select count(*) as items,
         (select string_agg(t.label || ' ×' || t.n, ', ' order by t.n desc) from (
            select coalesce(k2.action, 'No action') || case when k2.action = 'Replaced' and k2.replace_reason is not null then ' (' || k2.replace_reason || ')' else '' end as label,
                   count(*) as n
            from alarm_checks k2 where k2.job_id = j.id group by 1) t) as actions,
         (select string_agg(q.quote || ' – ' || coalesce(a2.location, '?'), ', ')
            from alarm_checks q left join alarms a2 on a2.id = q.alarm_id where q.job_id = j.id and q.quote is not null) as quotes,
         count(*) filter (where k.action = 'Replaced' and coalesce(k.replace_reason, '') <> 'Under warranty') as billable,
         count(*) filter (where k.quote is not null) as quoted
  from alarm_checks k
  where k.job_id = j.id
) ch on true
where j.status in ('completed', 'no_access')
  and j.old_id is null;          -- only jobs done in this system, not imported history
grant select on completed_summary to authenticated;
