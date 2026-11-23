-- Outbox: every automated email/SMS is queued here first. Nothing sends until a sender is connected.
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies on delete cascade,
  kind text not null,                       -- 'entry_notice', later 'reminder', 'certificate', ...
  channel text not null default 'email',    -- 'email' | 'sms'
  job_id uuid references jobs on delete cascade,
  property_id uuid references properties on delete cascade,
  tenancy_id uuid references tenancies on delete set null,
  to_name text,
  to_address text,
  subject text,
  body text,
  for_date date,                            -- the visit date this message is about
  send_after timestamptz not null default now(),
  status text not null default 'queued' check (status in ('queued','sent','cancelled','failed')),
  sent_at timestamptz,
  error text,
  created_at timestamptz default now()
);
create index if not exists messages_queue on messages (company_id, status, send_after);
create index if not exists messages_job on messages (job_id);
alter table messages enable row level security;
drop policy if exists company_isolation on messages;
create policy company_isolation on messages
  using (company_id in (select my_company_ids()))
  with check (company_id in (select my_company_ids()));
grant select, insert, update, delete on messages to authenticated;

-- Messages go out in two batches a day: 7am and 7pm Brisbane time
create or replace function next_send_slot(t timestamptz) returns timestamptz
language sql stable as $$
  select min(s) from (
    select (((t at time zone 'Australia/Brisbane')::date + d) + h) at time zone 'Australia/Brisbane' as s
    from (values (0), (1)) days(d), (values (time '07:00'), (time '19:00')) hrs(h)
  ) x where s >= t
$$;

-- Keep entry notices in step with bookings
create or replace function sync_entry_notice() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  p record; t record; ins_name text; visit date; subj text; msg text;
begin
  -- not (or no longer) a booked visit → cancel anything still waiting
  if new.status <> 'booked' or new.inspector_id is null or new.scheduled_start is null then
    update messages set status = 'cancelled'
    where job_id = new.id and kind = 'entry_notice' and status = 'queued';
    return new;
  end if;

  visit := new.scheduled_start::date;
  -- already have a notice for this exact visit date? nothing to do
  if exists (select 1 from messages where job_id = new.id and kind = 'entry_notice'
             and for_date = visit and status in ('queued','sent')) then
    return new;
  end if;
  -- date changed: cancel the old queued one
  update messages set status = 'cancelled'
  where job_id = new.id and kind = 'entry_notice' and status = 'queued';

  select pr.address_line, pr.suburb, pr.postcode, c.name as company
    into p from properties pr join companies c on c.id = pr.company_id where pr.id = new.property_id;
  select * into t from tenancies
    where property_id = new.property_id and (vacate_date is null or vacate_date >= visit)
    order by lease_start desc nulls last limit 1;
  select name into ins_name from inspectors where id = new.inspector_id;

  subj := format('Entry notice – smoke alarm inspection at %s on %s',
                 p.address_line, to_char(visit, 'FMDay FMDD FMMonth YYYY'));
  msg := format(E'Hi %s,\n\nThis is notice that %s will attend %s, %s on %s between 8am and 4pm to test and service the smoke alarms, as required under Queensland law.\n\nYou do not need to be home. If you have pets or access instructions, please reply to this email.\n\nInspector: %s\n\nKind regards,\n%s',
                coalesce(nullif(t.salutation, ''), t.tenant_names, 'Tenant'), p.company,
                p.address_line, p.suburb, to_char(visit, 'FMDay FMDD FMMonth YYYY'),
                coalesce(ins_name, 'our inspector'), p.company);

  insert into messages (company_id, kind, channel, job_id, property_id, tenancy_id, to_name, to_address,
                        subject, body, for_date, send_after, status, error)
  values (new.company_id, 'entry_notice', 'email', new.id, new.property_id, t.id,
          t.tenant_names, t.email, subj, msg, visit,
          next_send_slot(greatest(now(), new.scheduled_start - interval '7 days')),   -- next 7am/7pm, up to a week before the visit
          case when t.email is null then 'failed' else 'queued' end,
          case when t.email is null then 'No tenant email on file' end);
  return new;
end $$;

drop trigger if exists trg_entry_notice on jobs;
create trigger trg_entry_notice after insert or update of status, inspector_id, scheduled_start on jobs
  for each row execute function sync_entry_notice();

-- Queue notices for jobs that were already booked before this existed
update jobs set scheduled_start = scheduled_start
where status = 'booked' and inspector_id is not null and scheduled_start >= now();
