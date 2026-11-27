-- Property search across address, suburb, postcode, client, property manager and tenants
-- (names, phones – digits only, so "0434 997 201" finds "0434997201" – and emails). Uses the caller's access rights.
create or replace function search_property_ids(q text) returns setof uuid
language sql stable security invoker set search_path = public as $$
  with w as (select lower(trim(q)) t, nullif(regexp_replace(q, '\D', '', 'g'), '') d)
  select p.id from properties p cross join w
  left join clients c on c.id = p.client_id
  where w.t <> '' and (
       lower(concat_ws(' ', p.address_line, p.suburb, p.postcode, c.name)) like '%' || w.t || '%'
    or exists (select 1 from tenancies tn where tn.property_id = p.id and (
         lower(concat_ws(' ', tn.tenant_names, tn.email, tn.property_manager, array_to_string(tn.extra_emails, ' '))) like '%' || w.t || '%'
         or (length(w.d) >= 4 and regexp_replace(concat_ws(' ', tn.mobile, array_to_string(tn.extra_phones, ' ')), '\D', '', 'g') like '%' || w.d || '%'))))
  limit 1000
$$;
grant execute on function search_property_ids(text) to authenticated;
