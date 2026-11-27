-- Signature image for entry notices (path in the private 'photos' bucket)
alter table companies add column if not exists signature text;
grant update (signature) on companies to authenticated;
