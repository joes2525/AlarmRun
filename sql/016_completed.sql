-- One row per finished job (completed or no access) with what happened, for the Completed page
create or replace view completed_summary with (security_invoker = on) as
select j.id, j.company_id, j.property_id, j.status, j.outcome,
       coalesce(j.completed_at, j.scheduled_start) as done_at,
       p.address_line, p.suburb, c.name as agency, i.name as inspector,
       j.blind_cleats, j.blind_cleats_needed, j.safety_switch, j.safety_switch_notes, j.outcome_notes as comment,
       cert.number as certificate, cert.compliant,
       coalesce(ch.items, 0) as items,
       ch.actions,                                     -- e.g. "Serviced ×5, Replaced (Broken) ×1"
       ch.quotes,                                      -- e.g. "Upgrade – Hallway, Replace – Bedroom 2"
       (coalesce(ch.billable, 0) > 0 or coalesce(j.blind_cleats, '') = 'Installed') as has_invoice,
       (coalesce(ch.quoted, 0) > 0 or coalesce(j.blind_cleats, '') = 'Needed') as has_quote
from jobs j
join properties p on p.id = j.property_id
left join clients c on c.id = p.client_id
left join inspectors i on i.id = j.inspector_id
left join certificates cert on cert.job_id = j.id
left join lateral (
  select count(*) as items,
         (select string_agg(t.label || ' ×' || t.n, ', ' order by t.n desc) from (
            select coalesce(k2.action, 'No action') || case when k2.action = 'Replaced' and k2.replace_reason is not null then ' (' || k2.replace_reason || ')' else '' end as label,
                   count(*) as n
            from alarm_checks k2 where k2.job_id = j.id group by 1) t) as actions,
         (select string_agg(q.quote || ' – ' || coalesce(a2.location, '?'), ', ')
            from alarm_checks q left join alarms a2 on a2.id = q.alarm_id where q.job_id = j.id and q.quote is not null) as quotes,
         count(*) filter (where k.action = 'Replaced' and coalesce(k.replace_reason, '') <> 'Under warranty') as billable,
         count(*) filter (where k.quote is not null) as quoted
  from alarm_checks k
  where k.job_id = j.id
) ch on true
where j.status in ('completed', 'no_access')
  and j.old_id is null;          -- only jobs done in this system, not imported history
grant select on completed_summary to authenticated;
