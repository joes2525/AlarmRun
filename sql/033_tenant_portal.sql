-- Tenant page: a private link per tenancy (in entry notice emails) where tenants can
-- add contacts, leave permanent notes and notes for the next visit.
-- The link only works while there's a visit within 30 days either side of today.

alter table tenancies add column if not exists portal_token uuid not null default gen_random_uuid();
create unique index if not exists tenancies_portal_token on tenancies (portal_token);
alter table tenancies add column if not exists tenant_notes text;          -- permanent: pets, gate code, access
alter table tenancies add column if not exists extra_emails text[] not null default '{}';
alter table tenancies add column if not exists extra_phones text[] not null default '{}';
alter table jobs add column if not exists tenant_note text;               -- for this visit only

-- every change a tenant makes, for the office
create table if not exists tenant_changes (
  id bigint generated always as identity primary key,
  company_id uuid not null references companies on delete cascade,
  tenancy_id uuid references tenancies on delete cascade,
  job_id uuid references jobs on delete set null,
  what text not null,
  at timestamptz not null default now()
);
alter table tenant_changes enable row level security;
drop policy if exists tenant_changes_company on tenant_changes;
create policy tenant_changes_company on tenant_changes for select to authenticated using (company_id in (select my_company_ids()));
grant select on tenant_changes to authenticated;
grant select, insert, update, delete on tenant_changes to service_role;

create or replace function portal_url(tok uuid) returns text language sql immutable as
  $$ select 'https://joes2525.github.io/AlarmRun/tenant.html?t=' || tok $$;

create or replace function mask_email(e text) returns text language sql immutable as
  $$ select case when e is null or position('@' in e) = 0 then e
            else left(e, 2) || '•••@' || split_part(e, '@', 2) end $$;
create or replace function mask_phone(p text) returns text language sql immutable as
  $$ select case when p is null or length(regexp_replace(p, '\D', '', 'g')) < 6 then p
            else left(regexp_replace(p, '\D', '', 'g'), 2) || '•• ••• ' || right(regexp_replace(p, '\D', '', 'g'), 3) end $$;

-- the tenancy + its current/next visit for a token, or nothing if the link has expired
create or replace function portal_find(tok uuid, out t tenancies, out j jobs)
language plpgsql stable security definer set search_path = public as $$
begin
  select * into t from tenancies where portal_token = tok;
  if t.id is null then return; end if;
  select * into j from jobs
   where property_id = t.property_id and scheduled_start between now() - interval '30 days' and now() + interval '60 days'
     and status not in ('cancelled')
   order by (scheduled_start < now()), abs(extract(epoch from scheduled_start - now())) limit 1;
  if j.id is null then t := null; end if;      -- no visit near: link expired
end $$;

-- queue a plain email to go out with the next send
create or replace function portal_mail(t tenancies, j jobs, addr text, subj text, msg text)
returns void language sql security definer set search_path = public as $$
  insert into messages (company_id, kind, channel, job_id, property_id, tenancy_id, to_name, to_address, subject, body, send_after, status)
  values (t.company_id, 'portal_notice', 'email', j.id, t.property_id, t.id, t.tenant_names, addr, subj, msg, now(), 'queued');
$$;

create or replace function tenant_portal_get(tok uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r record; p properties; c companies;
begin
  select * into r from portal_find(tok);
  if (r.t).id is null then return jsonb_build_object('expired', true); end if;
  select * into p from properties where id = (r.t).property_id;
  select * into c from companies where id = (r.t).company_id;
  return jsonb_build_object(
    'company', coalesce(c.sender_name, c.name), 'company_phone', c.phone,
    'address', p.address_line || ', ' || p.suburb || ' ' || coalesce(p.postcode, ''),
    'tenants', (r.t).tenant_names,
    'visit', (r.j).scheduled_start,
    'main_email', mask_email((r.t).email), 'main_phone', mask_phone((r.t).mobile),
    'emails', coalesce((select jsonb_agg(mask_email(e)) from unnest((r.t).extra_emails) e), '[]'),
    'phones', coalesce((select jsonb_agg(mask_phone(x)) from unnest((r.t).extra_phones) x), '[]'),
    'tenant_notes', (r.t).tenant_notes, 'visit_note', (r.j).tenant_note);
end $$;

create or replace function tenant_portal_save_notes(tok uuid, p_tenant_notes text, p_visit_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from portal_find(tok);
  if (r.t).id is null then return jsonb_build_object('error', 'This link has expired'); end if;
  p_tenant_notes := left(nullif(trim(p_tenant_notes), ''), 2000);
  p_visit_note := left(nullif(trim(p_visit_note), ''), 1000);
  if p_tenant_notes is distinct from (r.t).tenant_notes then
    update tenancies set tenant_notes = p_tenant_notes where id = (r.t).id;
    insert into tenant_changes (company_id, tenancy_id, job_id, what) values ((r.t).company_id, (r.t).id, (r.j).id, 'Permanent notes: ' || coalesce(p_tenant_notes, '(cleared)'));
  end if;
  if p_visit_note is distinct from (r.j).tenant_note then
    update jobs set tenant_note = p_visit_note where id = (r.j).id;
    insert into tenant_changes (company_id, tenancy_id, job_id, what) values ((r.t).company_id, (r.t).id, (r.j).id, 'Visit note: ' || coalesce(p_visit_note, '(cleared)'));
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- add or remove an extra email/phone. The main ones (set by the office) can't be changed here.
create or replace function tenant_portal_contact(tok uuid, p_kind text, p_action text, p_value text, p_index int default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; v text := trim(p_value); old text; addrs text[]; note text;
begin
  select * into r from portal_find(tok);
  if (r.t).id is null then return jsonb_build_object('error', 'This link has expired'); end if;
  if (select count(*) from tenant_changes where tenancy_id = (r.t).id and at > now() - interval '1 hour') >= 20 then
    return jsonb_build_object('error', 'Too many changes – please try again later'); end if;
  addrs := array_remove(array[(r.t).email] || (r.t).extra_emails, null);     -- who's on file before this change

  if p_kind = 'email' and p_action = 'add' then
    if v !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return jsonb_build_object('error', 'That email address doesn''t look right'); end if;
    if lower(v) = any (select lower(x) from unnest(addrs) x) then return jsonb_build_object('error', 'Already on file'); end if;
    if cardinality((r.t).extra_emails) >= 5 then return jsonb_build_object('error', 'Up to 5 extra emails'); end if;
    update tenancies set extra_emails = extra_emails || v where id = (r.t).id;
    note := 'Email added: ' || v;
    perform portal_mail(r.t, r.j, v, 'You''ve been added for smoke alarm notices',
      'Hello,' || chr(10) || chr(10) || 'This email address was added to receive smoke alarm entry notices for ' ||
      (select address_line || ', ' || suburb from properties where id = (r.t).property_id) ||
      '. If this wasn''t you or you don''t live there, please reply to let us know.');
  elsif p_kind = 'phone' and p_action = 'add' then
    v := regexp_replace(v, '[^\d+ ]', '', 'g');
    if length(regexp_replace(v, '\D', '', 'g')) < 8 then return jsonb_build_object('error', 'That phone number doesn''t look right'); end if;
    if cardinality((r.t).extra_phones) >= 5 then return jsonb_build_object('error', 'Up to 5 extra phone numbers'); end if;
    update tenancies set extra_phones = extra_phones || v where id = (r.t).id;
    note := 'Phone added: ' || v;
  elsif p_action = 'remove' and p_index between 1 and 5 then
    if p_kind = 'email' then old := (r.t).extra_emails[p_index];
      update tenancies set extra_emails = extra_emails[:p_index - 1] || extra_emails[p_index + 1:] where id = (r.t).id;
    else old := (r.t).extra_phones[p_index];
      update tenancies set extra_phones = extra_phones[:p_index - 1] || extra_phones[p_index + 1:] where id = (r.t).id;
    end if;
    if old is null then return jsonb_build_object('error', 'Not found'); end if;
    note := initcap(p_kind) || ' removed: ' || old;
  else
    return jsonb_build_object('error', 'Unknown change');
  end if;

  insert into tenant_changes (company_id, tenancy_id, job_id, what) values ((r.t).company_id, (r.t).id, (r.j).id, note);
  -- tell everyone already on file (not the new address)
  perform portal_mail(r.t, r.j, a, 'Your contact details were changed',
    'Hello,' || chr(10) || chr(10) || 'The contact details for your smoke alarm notices were just changed: ' ||
    regexp_replace(note, '(added|removed): .*', '\1') || ' (' || p_kind || ').' || chr(10) ||
    'If this wasn''t you, please reply to let us know.')
  from unnest(addrs) a;
  return jsonb_build_object('ok', true);
end $$;

-- email the full (unmasked) contact list, only to the main email set by the office; once an hour at most
create or replace function tenant_portal_send_details(tok uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from portal_find(tok);
  if (r.t).id is null then return jsonb_build_object('error', 'This link has expired'); end if;
  if (r.t).email is null then return jsonb_build_object('error', 'No main email on file – please contact us'); end if;
  if exists (select 1 from messages where tenancy_id = (r.t).id and kind = 'portal_details' and created_at > now() - interval '1 hour') then
    return jsonb_build_object('error', 'Already sent in the last hour'); end if;
  insert into messages (company_id, kind, channel, job_id, property_id, tenancy_id, to_name, to_address, subject, body, send_after, status)
  values ((r.t).company_id, 'portal_details', 'email', (r.j).id, (r.t).property_id, (r.t).id, (r.t).tenant_names, (r.t).email,
    'Your contact details on file',
    'Hello,' || chr(10) || chr(10) || 'These are the contact details we hold for smoke alarm notices:' || chr(10) || chr(10) ||
    'Emails: ' || array_to_string(array_remove(array[(r.t).email] || (r.t).extra_emails, null), ', ') || chr(10) ||
    'Phones: ' || coalesce(nullif(array_to_string(array_remove(array[(r.t).mobile] || (r.t).extra_phones, null), ', '), ''), '—') || chr(10) || chr(10) ||
    'Permanent notes: ' || coalesce((r.t).tenant_notes, '—') || chr(10) ||
    'Note for the next visit: ' || coalesce((r.j).tenant_note, '—'),
    now(), 'queued');
  return jsonb_build_object('ok', true, 'sent_to', mask_email((r.t).email));
end $$;

revoke all on function tenant_portal_get(uuid), tenant_portal_save_notes(uuid, text, text),
  tenant_portal_contact(uuid, text, text, text, int), tenant_portal_send_details(uuid),
  portal_find(uuid), portal_mail(tenancies, jobs, text, text, text) from public;
grant execute on function tenant_portal_get(uuid), tenant_portal_save_notes(uuid, text, text),
  tenant_portal_contact(uuid, text, text, text, int), tenant_portal_send_details(uuid) to anon, authenticated;

-- entry-notice emails: fill {Tenant link} and also send to the tenant's extra emails
create or replace function messages_portal_fill() returns trigger language plpgsql security definer set search_path = public as $$
declare t tenancies;
begin
  if new.tenancy_id is null then return new; end if;
  select * into t from tenancies where id = new.tenancy_id;
  new.body := replace(coalesce(new.body, ''), '{Tenant link}', portal_url(t.portal_token));
  if new.channel = 'email' and new.kind like 'entry_notice%' and cardinality(t.extra_emails) > 0 then
    new.to_address := array_to_string(array[new.to_address] || t.extra_emails, ', ');
  end if;
  return new;
end $$;
drop trigger if exists messages_portal_fill on messages;
create trigger messages_portal_fill before insert on messages for each row execute function messages_portal_fill();

-- add the link to the entry notice email wording (once)
update templates set body = body || chr(10) || chr(10) ||
  'Update your contact details or leave notes for our technician (pets, access, best times): {Tenant link}'
where channel = 'email' and kind like 'entry_notice%' and body not like '%{Tenant link}%';
