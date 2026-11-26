-- Tenancy can be the owner living there (no tenant notices needed later)
alter table tenancies add column if not exists owner_occupied boolean not null default false;
