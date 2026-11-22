-- One row per tenancy (a property can have past and current tenancies)
create table if not exists tenancies (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies on delete cascade,
  property_id uuid not null references properties on delete cascade,
  tenant_names text,
  salutation text,
  mobile text,
  email text,
  move_in date,
  lease_start date,
  lease_end date,
  vacate_date date,
  property_manager text,
  created_at timestamptz default now()
);
create index if not exists tenancies_property on tenancies (property_id);
alter table tenancies enable row level security;
drop policy if exists company_isolation on tenancies;
create policy company_isolation on tenancies
  using (company_id in (select my_company_ids()))
  with check (company_id in (select my_company_ids()));
grant select, insert, update, delete on tenancies to authenticated;
