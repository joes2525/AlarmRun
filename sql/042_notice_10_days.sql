-- Entry notices go out 10 days before the visit (was 7)
create or replace function sync_entry_notice() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  p record; t record; tpl record; ins_name text; ins_full text; visit date; old_date date; k text; vars jsonb; m record;
  notice_at timestamptz; remind_at timestamptz;
begin
  if new.status <> 'booked' or new.inspector_id is null or new.scheduled_start is null then
    update messages set status = 'cancelled'
    where job_id = new.id and status = 'queued' and (kind like 'entry_notice%' or kind = 'reminder');
    return new;
  end if;

  visit := new.scheduled_start::date;
  -- already queued/sent for this exact visit date → nothing to do
  -- tenant's latest notice already says this date (or one is queued for it) → nothing new to send
  if (select for_date from messages where job_id = new.id and kind like 'entry_notice%' and status = 'sent'
      order by sent_at desc limit 1) = visit
     or exists (select 1 from messages where job_id = new.id and kind like 'entry_notice%'
                and for_date = visit and status = 'queued') then
    -- date moved back to one already noticed: drop anything queued for other dates (e.g. an unsent "date changed" notice)
    update messages set status = 'cancelled'
    where job_id = new.id and status in ('queued','failed') and (kind like 'entry_notice%' or kind = 'reminder')
      and for_date is distinct from visit;
    -- and bring back this date's reminder text if it was cancelled and is still in the future
    if not exists (select 1 from messages where job_id = new.id and kind = 'reminder' and for_date = visit and status in ('queued','sent')) then
      update messages set status = 'queued', error = null
      where id = (select id from messages where job_id = new.id and kind = 'reminder' and for_date = visit
                  and status = 'cancelled' and send_after > now() order by send_after desc limit 1);
    end if;
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
  select coalesce(nullif(known_as, ''), first_name, name), name into ins_name, ins_full from inspectors where id = new.inspector_id;
  vars := jsonb_build_object(
    'Tenant names', coalesce(t.tenant_names, 'Tenant'),
    'Tenant greeting', coalesce(nullif(t.salutation, ''), t.tenant_names, 'Tenant'),
    'Address', p.address_line, 'Suburb', p.suburb, 'Postcode', coalesce(p.postcode, ''),
    'Visit date', to_char(visit, 'FMDay FMDD FMMonth YYYY'),
    'Old visit date', coalesce(to_char(old_date, 'FMDay FMDD FMMonth YYYY'), ''),
    'Inspector', coalesce(ins_name, 'our inspector'), 'Inspector full name', coalesce(ins_full, 'our inspector'), 'Company', p.company);

  notice_at := next_send_slot(greatest(now(), new.scheduled_start - interval '10 days'));
  -- letters are printed straight away so they arrive in time
  -- 7am Queensland time, two days before the visit
  remind_at := ((visit - 2) + time '07:00') at time zone 'Australia/Brisbane';

  for m in select * from (values
      (k, case when t.notice_by = 'mail' then 'mail' else 'email' end, notice_at),
      (k, 'sms', notice_at),
      ('reminder', 'sms', remind_at)) x(kind, channel, send_at)
  loop
    continue when m.kind = 'reminder' and m.send_at <= notice_at;      -- too close to the notice: skip
    select * into tpl from templates where company_id = new.company_id and kind = m.kind and channel = m.channel;
    continue when tpl.id is null and m.channel = 'sms';                  -- no text template = no text
    if tpl.id is null and m.channel = 'mail' then                          -- letters use the email wording
      select * into tpl from templates where company_id = new.company_id and kind = m.kind and channel = 'email';
    end if;
    insert into messages (company_id, kind, channel, job_id, property_id, tenancy_id, to_name, to_address,
                          subject, body, for_date, send_after, status, error)
    values (new.company_id, m.kind, m.channel, new.id, new.property_id, t.id, t.tenant_names,
            case m.channel when 'sms' then t.mobile when 'mail' then p.address_line || ', ' || p.suburb || ' QLD ' || coalesce(p.postcode, '') else t.email end,
            case when m.channel in ('email', 'mail') then fill_template(coalesce(tpl.subject, 'Entry notice – {Address} on {Visit date}'), vars) end,
            fill_template(coalesce(tpl.body, 'Hi {Tenant greeting}, {Inspector} will attend {Address}, {Suburb} on {Visit date}. {Company}'), vars),
            visit, case when m.channel = 'mail' then now() else m.send_at end,
            case when (case m.channel when 'sms' then t.mobile when 'mail' then 'post' else t.email end) is null then 'failed' else 'queued' end,
            case when m.channel = 'sms' and t.mobile is null then 'No tenant mobile on file'
                 when m.channel = 'email' and t.email is null then 'No tenant email on file' end);
  end loop;
  return new;
end $$;

-- notices already queued: move them to the new time (letters are printed straight away, so not those)
update messages m set send_after = next_send_slot(greatest(now(), j.scheduled_start - interval '10 days'))
from jobs j
where m.job_id = j.id and m.status = 'queued' and m.kind like 'entry_notice%' and m.channel in ('email', 'sms')
  and j.scheduled_start > now();
