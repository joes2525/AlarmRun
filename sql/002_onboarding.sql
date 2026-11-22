-- Run after schema.sql. Lets a newly signed-up user create their company.
create or replace function create_company(company_name text, your_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into companies (name) values (company_name) returning id into new_id;
  insert into memberships (company_id, user_id, role, full_name)
    values (new_id, auth.uid(), 'owner', your_name);
  return new_id;
end $$;

grant execute on function create_company(text, text) to authenticated;
