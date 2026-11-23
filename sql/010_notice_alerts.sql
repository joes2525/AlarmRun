-- Booked visits whose entry notice isn't right
create or replace view notice_alerts with (security_invoker = on) as
select j.id as job_id, j.company_id, j.scheduled_start::date as visit, i.name as inspector,
       p.address_line, p.suburb,
       case
         when cur.status = 'failed' then 'Notice can''t be sent: ' || coalesce(cur.error, 'unknown problem')
         when cur.id is null then 'No entry notice for this visit date'
         when cur.status = 'queued' and cur.send_after > j.scheduled_start - interval '24 hours'
           then 'Notice won''t go out at least 24 hours before the visit'
         when cur.status = 'queued' and old.id is not null
           then 'Date changed after a notice was sent (for ' || to_char(old.for_date, 'DD Mon') || ') – new notice queued'
       end as problem
from jobs j
join properties p on p.id = j.property_id
left join inspectors i on i.id = j.inspector_id
left join lateral (select * from messages m where m.job_id = j.id and m.kind = 'entry_notice'
                   and m.for_date = j.scheduled_start::date and m.status in ('queued','sent','failed')
                   order by m.created_at desc limit 1) cur on true
left join lateral (select * from messages m where m.job_id = j.id and m.kind = 'entry_notice'
                   and m.status = 'sent' and m.for_date <> j.scheduled_start::date limit 1) old on true
where j.status = 'booked' and j.inspector_id is not null and j.scheduled_start >= now();
grant select on notice_alerts to authenticated;
