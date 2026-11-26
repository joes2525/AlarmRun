-- Work order + Upgrade job types; every logged (to_book) job now shows on Due with its reason
alter table jobs drop constraint if exists jobs_job_type_check;
alter table jobs add constraint jobs_job_type_check
  check (job_type in ('annual','pre_tenancy','sale','install','callout','work_order','upgrade'));

create or replace view schedule_queue with (security_invoker = on) as
select 'Annual'::text as reason, d.id as property_id, null::uuid as job_id,
       d.address_line, d.suburb, d.postcode, d.agency, d.area, d.last_done, d.due_date, null::text as notes
from property_due d
where not d.has_open_job
union all
select case j.job_type when 'callout' then 'Breakdown' when 'pre_tenancy' then 'Lease' when 'work_order' then 'Work order'
         when 'upgrade' then 'Upgrade' when 'sale' then 'Sale' when 'install' then 'Install' else 'Annual' end,
       p.id, j.id, p.address_line, p.suburb, p.postcode, c.name, coalesce(sa.area, 'No area'),
       null::date, j.created_at::date, j.notes
from jobs j
join properties p on p.id = j.property_id
left join clients c on c.id = p.client_id
left join suburb_areas sa on sa.company_id = p.company_id and sa.suburb = upper(trim(p.suburb))
where j.job_type <> 'annual' and j.status = 'to_book';
grant select on schedule_queue to authenticated;
