-- Inspectors can edit a completed inspection until the office approves it

-- issuing a certificate no longer locks the job…
create or replace function lock_job_on_cert() returns trigger language plpgsql as $$
begin
  update jobs set status = 'completed', completed_at = coalesce(completed_at, now()) where id = new.job_id;
  return new;
end $$;

-- …approving does (and un-approving unlocks)
create or replace function lock_on_approval() returns trigger language plpgsql as $$
begin
  if new.approved_at is distinct from old.approved_at then new.locked := new.approved_at is not null; end if;
  return new;
end $$;
drop trigger if exists trg_lock_on_approval on jobs;
create trigger trg_lock_on_approval before update of approved_at on jobs for each row execute function lock_on_approval();

-- unlock jobs done in this system that aren't approved yet (imported history stays locked)
update jobs set locked = false where old_id is null and approved_at is null and status = 'completed';

create or replace function complete_job(p_job uuid, p_items jsonb, p_outcome text, p_extra jsonb)
returns text language plpgsql security invoker set search_path = public as $$
declare j record; it jsonb; aid uuid; cert text;
begin
  select * into j from jobs where id = p_job;
  if j.id is null then raise exception 'Job not found'; end if;
  if j.locked or j.approved_at is not null then raise exception 'This job has been approved by the office and can no longer be changed'; end if;
  -- editing a completed (not yet approved) job: replace what was recorded before
  delete from alarm_checks where job_id = p_job;
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

  update jobs set status = 'completed', completed_at = coalesce(case when j.status = 'completed' then j.completed_at end, now()), outcome = p_outcome,
    outcome_notes = nullif(p_extra->>'comment', ''), comment_photo = nullif(p_extra->>'comment_photo', ''),
    blind_cleats = nullif(p_extra->>'blind_cleats', ''), blind_cleats_needed = nullif(p_extra->>'blind_cleats_needed', '')::int,
    safety_switch = nullif(p_extra->>'safety_switch', ''), safety_switch_notes = nullif(p_extra->>'safety_switch_notes', '')
  where id = p_job;

  select number into cert from certificates where job_id = p_job;
  if cert is null then
    cert := next_cert_number(j.company_id);
    insert into certificates (company_id, job_id, number, compliant) values (j.company_id, p_job, cert, p_outcome = 'compliant');
  else
    update certificates set compliant = p_outcome = 'compliant', issued_at = now() where job_id = p_job;
  end if;
  return cert;
end $$;
grant execute on function complete_job(uuid, jsonb, text, jsonb) to authenticated;
