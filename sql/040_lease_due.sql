-- Due = whichever comes first: 12 months after the last inspection, or a lease ending soon.
-- Queensland requires a check within 30 days before each new/renewed tenancy, so a lease shows
-- as due once its last 30 days begin, unless the property was inspected in that window.
-- Any inspection (lease or annual) restarts the 12-month clock.
create or replace view property_due with (security_invoker = on) as
select p.id, p.company_id, p.address_line, p.suburb, p.postcode, c.name as agency,
       coalesce(sa.area, 'No area') as area,
       lj.last_done,
       least(coalesce((lj.last_done + interval '1 year')::date, current_date), ls.lease_due) as due_date,
       exists (select 1 from jobs o where o.property_id = p.id
               and o.status in ('to_book','booked','in_progress')) as has_open_job,
       case when ls.lease_due is not null and ls.lease_due <= coalesce((lj.last_done + interval '1 year')::date, current_date)
            then 'Lease' else 'Annual' end as due_reason,
       ls.lease_end
from properties p
left join clients c on c.id = p.client_id
left join suburb_areas sa on sa.company_id = p.company_id and sa.suburb = upper(trim(p.suburb))
left join lateral (
  select max(j.scheduled_start)::date as last_done
  from jobs j where j.property_id = p.id and j.status = 'completed'
) lj on true
left join lateral (                                   -- current tenancy's lease end, if still to come and not yet checked
  select t.lease_end, (t.lease_end - 30) as lease_due
  from tenancies t
  where t.property_id = p.id and not t.owner_occupied and t.lease_end >= current_date
    and (t.vacate_date is null or t.vacate_date >= current_date)
    and (lj.last_done is null or lj.last_done < t.lease_end - 30)
  order by t.lease_end limit 1
) ls on true
where p.active;
grant select on property_due to authenticated;

create or replace view schedule_queue with (security_invoker = on) as
select d.due_reason as reason, d.id as property_id, null::uuid as job_id,
       d.address_line, d.suburb, d.postcode, d.agency, d.area, d.last_done, d.due_date,
       case when d.due_reason = 'Lease' then 'Lease ends ' || to_char(d.lease_end, 'FMDD Mon') end as notes
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
