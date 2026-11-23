-- Company email settings
alter table companies add column if not exists sender_name text;     -- shown as the From name
alter table companies add column if not exists sender_code text;     -- e.g. 'aasa' → aasa@<platform domain>
alter table companies add column if not exists reply_to_email text;  -- where tenant replies go
alter table companies add column if not exists phone text;

-- owners and admins can edit their own company
drop policy if exists owner_update on companies;
create policy owner_update on companies for update
  using (id in (select company_id from memberships where user_id = auth.uid() and role in ('owner','admin')))
  with check (id in (select company_id from memberships where user_id = auth.uid() and role in ('owner','admin')));
grant update (name, sender_name, sender_code, reply_to_email, phone, abn, qbcc_licence) on companies to authenticated;

update companies set sender_name = coalesce(sender_name, name),
  sender_code = coalesce(sender_code, 'aasa'), reply_to_email = coalesce(reply_to_email, 'joes25@gmail.com')
where name = 'All About Smoke Alarms';
