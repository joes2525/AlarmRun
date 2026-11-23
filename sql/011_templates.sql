-- Editable message templates with {Placeholders}
create table if not exists templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies on delete cascade,
  kind text not null,
  channel text not null default 'email',
  name text not null,
  subject text,
  body text not null,
  updated_at timestamptz default now(),
  unique (company_id, kind, channel)
);
alter table templates enable row level security;
drop policy if exists company_isolation on templates;
create policy company_isolation on templates
  using (company_id in (select my_company_ids()))
  with check (company_id in (select my_company_ids()));
grant select, insert, update, delete on templates to authenticated;

-- swap {Placeholder} for its value
create or replace function fill_template(txt text, vars jsonb) returns text
language plpgsql immutable as $$
declare k text;
begin
  for k in select jsonb_object_keys(vars) loop
    txt := replace(txt, '{' || k || '}', coalesce(vars ->> k, ''));
  end loop;
  return txt;
end $$;

-- starter templates for every company
insert into templates (company_id, kind, name, subject, body)
select c.id, v.kind, v.name, v.subject, v.body from companies c,
(values
 ('entry_notice', 'Entry notice',
  'Entry notice – smoke alarm inspection at {Address} on {Visit date}',
  E'Hi {Tenant greeting},\n\nThis is notice that {Company} will attend {Address}, {Suburb} on {Visit date} between 8am and 4pm to test and service the smoke alarms, as required under Queensland law.\n\nYou do not need to be home. If you have pets or access instructions, please reply to this email.\n\nInspector: {Inspector}\n\nKind regards,\n{Company}'),
 ('entry_notice_changed', 'Entry notice – date changed',
  'New date: smoke alarm inspection at {Address} on {Visit date}',
  E'Hi {Tenant greeting},\n\nThe smoke alarm inspection at {Address}, {Suburb} has moved from {Old visit date} to {Visit date}, between 8am and 4pm. Please disregard the earlier notice.\n\nYou do not need to be home. If you have pets or access instructions, please reply to this email.\n\nInspector: {Inspector}\n\nKind regards,\n{Company}')
) v(kind, name, subject, body)
on conflict do nothing;

create or replace function sync_entry_notice() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  p record; t record; tpl record; ins_name text; visit date; old_date date; k text; vars jsonb;
begin
  if new.status <> 'booked' or new.inspector_id is null or new.scheduled_start is null then
    update messages set status = 'cancelled'
    where job_id = new.id and kind like 'entry_notice%' and status = 'queued';
    return new;
  end if;

  visit := new.scheduled_start::date;
  if exists (select 1 from messages where job_id = new.id and kind like 'entry_notice%'
             and for_date = visit and status in ('queued','sent')) then
    return new;
  end if;
  update messages set status = 'cancelled'
  where job_id = new.id and kind like 'entry_notice%' and status = 'queued';

  -- a notice already went out for another date → use the "date changed" template
  select for_date into old_date from messages where job_id = new.id and kind like 'entry_notice%'
    and status = 'sent' and for_date <> visit order by sent_at desc limit 1;
  k := case when old_date is null then 'entry_notice' else 'entry_notice_changed' end;

  select pr.address_line, pr.suburb, pr.postcode, c.name as company
    into p from properties pr join companies c on c.id = pr.company_id where pr.id = new.property_id;
  select * into t from tenancies
    where property_id = new.property_id and (vacate_date is null or vacate_date >= visit)
    order by lease_start desc nulls last limit 1;
  select name into ins_name from inspectors where id = new.inspector_id;
  select * into tpl from templates where company_id = new.company_id and kind = k and channel = 'email';

  vars := jsonb_build_object(
    'Tenant names', coalesce(t.tenant_names, 'Tenant'),
    'Tenant greeting', coalesce(nullif(t.salutation, ''), t.tenant_names, 'Tenant'),
    'Address', p.address_line, 'Suburb', p.suburb, 'Postcode', coalesce(p.postcode, ''),
    'Visit date', to_char(visit, 'FMDay FMDD FMMonth YYYY'),
    'Old visit date', coalesce(to_char(old_date, 'FMDay FMDD FMMonth YYYY'), ''),
    'Inspector', coalesce(ins_name, 'our inspector'), 'Company', p.company);

  insert into messages (company_id, kind, channel, job_id, property_id, tenancy_id, to_name, to_address,
                        subject, body, for_date, send_after, status, error)
  values (new.company_id, k, 'email', new.id, new.property_id, t.id, t.tenant_names, t.email,
          fill_template(coalesce(tpl.subject, 'Entry notice – {Address} on {Visit date}'), vars),
          fill_template(coalesce(tpl.body, 'Hi {Tenant greeting}, {Inspector} will attend {Address}, {Suburb} on {Visit date}. {Company}'), vars),
          visit, next_send_slot(greatest(now(), new.scheduled_start - interval '7 days')),
          case when t.email is null then 'failed' else 'queued' end,
          case when t.email is null then 'No tenant email on file' end);
  return new;
end $$;

-- Minimum notice is now 48 hours
create or replace view notice_alerts with (security_invoker = on) as
select j.id as job_id, j.company_id, j.scheduled_start::date as visit, i.name as inspector,
       p.address_line, p.suburb,
       case
         when cur.status = 'failed' then 'Notice can''t be sent: ' || coalesce(cur.error, 'unknown problem')
         when cur.id is null then 'No entry notice for this visit date'
         when cur.status = 'queued' and cur.send_after > j.scheduled_start - interval '48 hours'
           then 'Notice won''t go out at least 48 hours before the visit'
         when cur.status = 'queued' and old.id is not null
           then 'Date changed after a notice was sent (for ' || to_char(old.for_date, 'DD Mon') || ') – new notice queued'
       end as problem
from jobs j
join properties p on p.id = j.property_id
left join inspectors i on i.id = j.inspector_id
left join lateral (select * from messages m where m.job_id = j.id and m.kind like 'entry_notice%'
                   and m.for_date = j.scheduled_start::date and m.status in ('queued','sent','failed')
                   order by m.created_at desc limit 1) cur on true
left join lateral (select * from messages m where m.job_id = j.id and m.kind like 'entry_notice%'
                   and m.status = 'sent' and m.for_date <> j.scheduled_start::date limit 1) old on true
where j.status = 'booked' and j.inspector_id is not null and j.scheduled_start >= now();
grant select on notice_alerts to authenticated;
