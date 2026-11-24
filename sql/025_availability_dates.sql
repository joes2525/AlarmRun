-- Availability by date: weekdays available, weekends not, unless a day is changed here
create table if not exists inspector_days (
  company_id uuid not null references companies on delete cascade,
  inspector_id uuid not null references inspectors on delete cascade,
  day date not null,
  available boolean not null,
  primary key (inspector_id, day)
);
alter table inspector_days enable row level security;
drop policy if exists company_isolation on inspector_days;
create policy company_isolation on inspector_days
  using (company_id in (select my_company_ids()))
  with check (company_id in (select my_company_ids()));
grant select, insert, update, delete on inspector_days to authenticated;

-- the fortnightly pattern is no longer used
alter table inspectors drop column if exists availability;
