-- Electrical contractor licence number (shown on certificates; required before work starts)
alter table companies add column if not exists electrical_licence text;
grant update (electrical_licence) on companies to authenticated;
