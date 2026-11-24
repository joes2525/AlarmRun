-- Text messages: entry notice SMS (with the email) + reminder SMS 2 days before (7am)

alter table templates alter column subject drop not null;
insert into templates (company_id, kind, channel, name, subject, body)
select c.id, v.kind, 'sms', v.name, null, v.body from companies c, (values
 ('entry_notice', 'Entry notice (text)',
  'Hi {Tenant greeting}, {Company} will test the smoke alarms at {Address} on {Visit date} between 8am and 4pm. You don''t need to be home. Notice has been emailed to you.'),
 ('entry_notice_changed', 'Entry notice – date changed (text)',
  'Hi {Tenant greeting}, the smoke alarm check at {Address} has moved from {Old visit date} to {Visit date}, 8am-4pm. {Company}'),
 ('reminder', 'Reminder (text)',
  'Reminder: {Company} will test the smoke alarms at {Address} on {Visit date} between 8am and 4pm. Reply to this message if there are any access issues.')
) v(kind, name, body)
on conflict do nothing;

-- Keep all of a job's tenant messages in step with its booking
create or replace function sync_entry_notice() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  p record; t record; tpl record; ins_name text; visit date; old_date date; k text; vars jsonb; m record;
  notice_at timestamptz; remind_at timestamptz;
begin
  if new.status <> 'booked' or new.inspector_id is null or new.scheduled_start is null then
    update messages set status = 'cancelled'
    where job_id = new.id and status = 'queued' and (kind like 'entry_notice%' or kind = 'reminder');
    return new;
  end if;

  visit := new.scheduled_start::date;
  -- already queued/sent for this exact visit date → nothing to do
  if exists (select 1 from messages where job_id = new.id and kind like 'entry_notice%'
             and for_date = visit and status in ('queued','sent')) then
    return new;
  end if;
  update messages set status = 'cancelled'
  where job_id = new.id and status = 'queued' and (kind like 'entry_notice%' or kind = 'reminder');

  select for_date into old_date from messages where job_id = new.id and kind like 'entry_notice%'
    and status = 'sent' and for_date <> visit order by sent_at desc limit 1;
  k := case when old_date is null then 'entry_notice' else 'entry_notice_changed' end;

  select pr.address_line, pr.suburb, pr.postcode, c.name as company
    into p from properties pr join companies c on c.id = pr.company_id where pr.id = new.property_id;
  select * into t from tenancies
    where property_id = new.property_id and (vacate_date is null or vacate_date >= visit)
    order by lease_start desc nulls last limit 1;
  select name into ins_name from inspectors where id = new.inspector_id;
  vars := jsonb_build_object(
    'Tenant names', coalesce(t.tenant_names, 'Tenant'),
    'Tenant greeting', coalesce(nullif(t.salutation, ''), t.tenant_names, 'Tenant'),
    'Address', p.address_line, 'Suburb', p.suburb, 'Postcode', coalesce(p.postcode, ''),
    'Visit date', to_char(visit, 'FMDay FMDD FMMonth YYYY'),
    'Old visit date', coalesce(to_char(old_date, 'FMDay FMDD FMMonth YYYY'), ''),
    'Inspector', coalesce(ins_name, 'our inspector'), 'Company', p.company);

  notice_at := next_send_slot(greatest(now(), new.scheduled_start - interval '7 days'));
  -- 7am Queensland time, two days before the visit
  remind_at := ((visit - 2) + time '07:00') at time zone 'Australia/Brisbane';

  for m in select * from (values
      (k, 'email', notice_at),
      (k, 'sms', notice_at),
      ('reminder', 'sms', remind_at)) x(kind, channel, send_at)
  loop
    continue when m.kind = 'reminder' and m.send_at <= notice_at;      -- too close to the notice: skip
    select * into tpl from templates where company_id = new.company_id and kind = m.kind and channel = m.channel;
    continue when tpl.id is null and m.channel = 'sms';                  -- no text template = no text
    insert into messages (company_id, kind, channel, job_id, property_id, tenancy_id, to_name, to_address,
                          subject, body, for_date, send_after, status, error)
    values (new.company_id, m.kind, m.channel, new.id, new.property_id, t.id, t.tenant_names,
            case when m.channel = 'sms' then t.mobile else t.email end,
            case when m.channel = 'email' then fill_template(coalesce(tpl.subject, 'Entry notice – {Address} on {Visit date}'), vars) end,
            fill_template(coalesce(tpl.body, 'Hi {Tenant greeting}, {Inspector} will attend {Address}, {Suburb} on {Visit date}. {Company}'), vars),
            visit, m.send_at,
            case when (case when m.channel = 'sms' then t.mobile else t.email end) is null then 'failed' else 'queued' end,
            case when m.channel = 'sms' and t.mobile is null then 'No tenant mobile on file'
                 when m.channel = 'email' and t.email is null then 'No tenant email on file' end);
  end loop;
  return new;
end $$;

-- Queue texts for jobs already booked (email notices already exist, so add the texts directly)
insert into messages (company_id, kind, channel, job_id, property_id, tenancy_id, to_name, to_address, body, for_date, send_after, status, error)
select e.company_id, x.kind, 'sms', e.job_id, e.property_id, e.tenancy_id, e.to_name, tn.mobile,
       fill_template(tp.body, jsonb_build_object(
         'Tenant names', coalesce(tn.tenant_names, 'Tenant'), 'Tenant greeting', coalesce(nullif(tn.salutation, ''), tn.tenant_names, 'Tenant'),
         'Address', pr.address_line, 'Suburb', pr.suburb, 'Postcode', coalesce(pr.postcode, ''),
         'Visit date', to_char(e.for_date, 'FMDay FMDD FMMonth YYYY'), 'Old visit date', '',
         'Inspector', coalesce(i.name, 'our inspector'), 'Company', co.name)),
       e.for_date, x.send_at,
       case when tn.mobile is null then 'failed' else 'queued' end, case when tn.mobile is null then 'No tenant mobile on file' end
from messages e
join jobs j on j.id = e.job_id
join properties pr on pr.id = e.property_id
join companies co on co.id = e.company_id
left join tenancies tn on tn.id = e.tenancy_id
left join inspectors i on i.id = j.inspector_id
cross join lateral (values (e.kind, e.send_after),
                           ('reminder', ((e.for_date - 2) + time '07:00') at time zone 'Australia/Brisbane')) x(kind, send_at)
join templates tp on tp.company_id = e.company_id and tp.kind = x.kind and tp.channel = 'sms'
where e.channel = 'email' and e.status = 'queued' and e.kind like 'entry_notice%'
  and not (x.kind = 'reminder' and x.send_at <= e.send_after)
  and not exists (select 1 from messages s where s.job_id = e.job_id and s.channel = 'sms' and s.kind = x.kind and s.status in ('queued','sent'));
