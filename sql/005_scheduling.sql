-- Scheduling: inspectors, job assignment, and "what's due" view

create table if not exists inspectors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies on delete cascade,
  name text not null,
  phone text,
  base_suburb text,
  daily_capacity int default 18,
  active boolean default true,
  user_id uuid references auth.users,      -- link to a login later
  created_at timestamptz default now()
);
alter table inspectors enable row level security;
drop policy if exists company_isolation on inspectors;
create policy company_isolation on inspectors
  using (company_id in (select my_company_ids()))
  with check (company_id in (select my_company_ids()));
grant select, insert, update, delete on inspectors to authenticated;

alter table jobs add column if not exists inspector_id uuid references inspectors on delete set null;
create index if not exists jobs_property on jobs (property_id);
create index if not exists jobs_day on jobs (company_id, scheduled_start);

-- Which properties we still look after
alter table properties add column if not exists active boolean default true;
update properties set active = (access_notes is null or access_notes not like 'Status: Not Managing%');

-- Due list: last completed inspection + 1 year (never inspected = due now)
create or replace view property_due with (security_invoker = on) as
select p.id, p.company_id, p.address_line, p.suburb, p.postcode, c.name as agency,
       lj.last_done,
       coalesce((lj.last_done + interval '1 year')::date, current_date) as due_date,
       exists (select 1 from jobs o where o.property_id = p.id
               and o.status in ('to_book','booked','in_progress')) as has_open_job
from properties p
left join clients c on c.id = p.client_id
left join lateral (
  select max(j.scheduled_start)::date as last_done
  from jobs j where j.property_id = p.id and j.status = 'completed'
) lj on true
where p.active;
grant select on property_due to authenticated;

-- Starter inspectors (names from the old system's history)
insert into inspectors (company_id, name)
select (select id from companies order by created_at limit 1), n
from unnest(array['Liam','Grant','Nick','Joseph','Inspector 5']) n
where not exists (select 1 from inspectors);
