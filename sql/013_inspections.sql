-- Inspector app: complete a job in one call, photos storage

alter table jobs add column if not exists outcome_notes text;
alter table alarms add column if not exists interconnected boolean;

-- Finish an inspection: new alarms, replacements, checks, job completed, certificate issued (locks the job)
-- p_checks:     [{alarm_id, tested_ok, cleaned, battery_replaced, replaced, new_manufacture_date, new_sensor_type, new_power_source, interconnected, photo_path, notes}]
-- p_new_alarms: [{location, storey, sensor_type, power_source, manufacture_date, interconnected, photo_path}]
create or replace function complete_job(p_job uuid, p_checks jsonb, p_new_alarms jsonb, p_compliant boolean, p_notes text)
returns text language plpgsql security invoker set search_path = public as $$
declare j record; c jsonb; a jsonb; new_id uuid; cert text;
begin
  select * into j from jobs where id = p_job;              -- RLS: only your company's jobs are visible
  if j.id is null then raise exception 'Job not found'; end if;
  if j.locked then raise exception 'This job is already completed'; end if;

  for a in select * from jsonb_array_elements(coalesce(p_new_alarms, '[]')) loop
    insert into alarms (company_id, property_id, location, storey, sensor_type, power_source, manufacture_date, interconnected, as3786_compliant)
    values (j.company_id, j.property_id, a->>'location', coalesce((a->>'storey')::int, 1), a->>'sensor_type', a->>'power_source',
            nullif(a->>'manufacture_date', '')::date, (a->>'interconnected')::boolean, true)
    returning id into new_id;
    insert into alarm_checks (company_id, job_id, alarm_id, tested_ok, cleaned, replaced_alarm, in_date, photo_path, notes)
    values (j.company_id, p_job, new_id, true, true, false, true, a->>'photo_path', 'New alarm installed');
  end loop;

  for c in select * from jsonb_array_elements(coalesce(p_checks, '[]')) loop
    if (c->>'replaced')::boolean then
      update alarms set manufacture_date = nullif(c->>'new_manufacture_date', '')::date,
        sensor_type = coalesce(nullif(c->>'new_sensor_type', ''), sensor_type),
        power_source = coalesce(nullif(c->>'new_power_source', ''), power_source)
      where id = (c->>'alarm_id')::uuid and property_id = j.property_id;
    end if;
    if c ? 'interconnected' then
      update alarms set interconnected = (c->>'interconnected')::boolean where id = (c->>'alarm_id')::uuid and property_id = j.property_id;
    end if;
    insert into alarm_checks (company_id, job_id, alarm_id, tested_ok, cleaned, battery_replaced, replaced_alarm, in_date, photo_path, notes)
    select j.company_id, p_job, al.id, (c->>'tested_ok')::boolean, (c->>'cleaned')::boolean, (c->>'battery_replaced')::boolean,
           coalesce((c->>'replaced')::boolean, false), al.expiry_date >= current_date, c->>'photo_path', c->>'notes'
    from alarms al where al.id = (c->>'alarm_id')::uuid and al.property_id = j.property_id;
  end loop;

  update jobs set status = 'completed', completed_at = now(), outcome_notes = p_notes where id = p_job;

  cert := 'C' || to_char(now() at time zone 'Australia/Brisbane', 'YYMMDD') || '-' || upper(left(replace(p_job::text, '-', ''), 6));
  insert into certificates (company_id, job_id, number, compliant) values (j.company_id, p_job, cert, p_compliant);
  return cert;
end $$;
grant execute on function complete_job(uuid, jsonb, jsonb, boolean, text) to authenticated;

-- Photos: private bucket, files stored under <company_id>/...
insert into storage.buckets (id, name, public) values ('photos', 'photos', false) on conflict do nothing;
drop policy if exists "company photos read" on storage.objects;
drop policy if exists "company photos write" on storage.objects;
create policy "company photos read" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] in (select my_company_ids()::text));
create policy "company photos write" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] in (select my_company_ids()::text));
