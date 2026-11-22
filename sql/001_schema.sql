-- Smoke alarm SaaS (QLD) — Supabase schema v0.1
-- Multi-company: every row belongs to a company; RLS keeps companies apart.

create extension if not exists "pgcrypto";

-- ===== Tenancy & users =====
create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  abn text,
  qbcc_licence text,
  created_at timestamptz default now()
);

create type member_role as enum ('owner','admin','scheduler','technician');

create table memberships (
  company_id uuid references companies on delete cascade,
  user_id uuid references auth.users on delete cascade,
  role member_role not null default 'technician',
  full_name text,
  phone text,
  primary key (company_id, user_id)
);

-- helper: companies the current user belongs to
create or replace function my_company_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select company_id from memberships where user_id = auth.uid()
$$;

-- ===== Clients & properties =====
create table clients (            -- real estate agencies / landlords
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies on delete cascade,
  name text not null,
  type text check (type in ('agency','landlord','owner_occupier','other')),
  billing_email text,
  phone text,
  default_price numeric(10,2),
  created_at timestamptz default now()
);

create table properties (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies on delete cascade,
  client_id uuid references clients on delete set null,
  address_line text not null,
  suburb text, postcode text, state text default 'QLD',
  lat double precision, lng double precision,
  storeys int default 1,
  bedrooms int,
  access_notes text,              -- keys, tenant contact, dogs
  tenant_name text, tenant_phone text, tenant_email text,
  lease_start date, lease_end date,
  next_due date,                  -- next annual / pre-tenancy check
  created_at timestamptz default now()
);

create table alarms (             -- one row per physical alarm
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies on delete cascade,
  property_id uuid not null references properties on delete cascade,
  location text not null,         -- 'Bedroom 1', 'Hallway', 'Storey 2 landing'
  storey int default 1,
  sensor_type text check (sensor_type in ('photoelectric','ionisation','heat','other')),
  power_source text check (power_source in ('hardwired','10yr_lithium','9v','other')),
  interconnected boolean,
  brand text, model text,
  manufacture_date date,
  expiry_date date generated always as ((manufacture_date + interval '10 years')::date) stored,
  as3786_compliant boolean,
  active boolean default true,
  created_at timestamptz default now()
);

-- ===== Scheduling =====
create type job_status as enum ('to_book','booked','in_progress','completed','cancelled','no_access');

create table jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies on delete cascade,
  property_id uuid not null references properties on delete cascade,
  job_type text check (job_type in ('annual','pre_tenancy','sale','install','callout')),
  status job_status default 'to_book',
  technician_id uuid references auth.users,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  route_order int,                -- position in tech's daily run
  notes text,
  completed_at timestamptz,
  locked boolean default false,   -- true once certificate issued
  created_at timestamptz default now()
);
create index on jobs (company_id, technician_id, scheduled_start);

-- ===== On-site inspection =====
create table alarm_checks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies on delete cascade,
  job_id uuid not null references jobs on delete cascade,
  alarm_id uuid references alarms,
  tested_ok boolean,
  cleaned boolean,
  battery_replaced boolean,
  replaced_alarm boolean,
  in_date boolean,
  photo_path text,                -- Supabase Storage path
  notes text,
  checked_at timestamptz default now()
);

-- ===== Certificates =====
create table certificates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies on delete cascade,
  job_id uuid not null unique references jobs on delete cascade,
  number text not null,
  compliant boolean not null,
  issued_at timestamptz default now(),
  pdf_path text,
  share_token text unique default encode(gen_random_bytes(16),'hex') -- public link for agents
);

-- lock job + checks once a certificate exists (tamper-proof record)
create or replace function lock_job_on_cert() returns trigger language plpgsql as $$
begin
  update jobs set locked = true, status = 'completed', completed_at = coalesce(completed_at, now())
  where id = new.job_id;
  return new;
end $$;
create trigger trg_lock_job after insert on certificates
  for each row execute function lock_job_on_cert();

create or replace function block_locked_edits() returns trigger language plpgsql as $$
begin
  if exists (select 1 from jobs where id = coalesce(new.job_id, old.job_id) and locked) then
    raise exception 'Job is locked: certificate already issued';
  end if;
  return coalesce(new, old);
end $$;
create trigger trg_block_checks before update or delete on alarm_checks
  for each row execute function block_locked_edits();

-- ===== Billing =====
create table invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies on delete cascade,
  client_id uuid references clients,
  job_id uuid references jobs,
  number text not null,
  amount_ex_gst numeric(10,2) not null,
  gst numeric(10,2) generated always as (round(amount_ex_gst * 0.10, 2)) stored,
  status text check (status in ('draft','sent','paid','void')) default 'draft',
  due_date date,
  created_at timestamptz default now()
);

-- ===== Row level security =====
do $$
declare t text;
begin
  foreach t in array array['clients','properties','alarms','jobs','alarm_checks','certificates','invoices'] loop
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy company_isolation on %I
      using (company_id in (select my_company_ids()))
      with check (company_id in (select my_company_ids()))$p$, t);
  end loop;
end $$;

alter table companies enable row level security;
create policy member_read on companies for select using (id in (select my_company_ids()));

alter table memberships enable row level security;
create policy member_read on memberships for select using (company_id in (select my_company_ids()));
