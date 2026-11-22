-- Everything waiting to be booked, with the reason
create or replace view schedule_queue with (security_invoker = on) as
select 'Annual'::text as reason, d.id as property_id, null::uuid as job_id,
       d.address_line, d.suburb, d.postcode, d.agency, d.area, d.last_done, d.due_date, null::text as notes
from property_due d
where not d.has_open_job
union all
select 'Breakdown', p.id, j.id,
       p.address_line, p.suburb, p.postcode, c.name, coalesce(sa.area, 'No area'),
       null::date, j.created_at::date, j.notes
from jobs j
join properties p on p.id = j.property_id
left join clients c on c.id = p.client_id
left join suburb_areas sa on sa.company_id = p.company_id and sa.suburb = upper(trim(p.suburb))
where j.job_type = 'callout' and j.status = 'to_book';
grant select on schedule_queue to authenticated;
