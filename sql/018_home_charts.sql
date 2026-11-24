-- Weekly totals for the Home page charts (weeks start Monday, Queensland time)
create or replace view home_due_weekly with (security_invoker = on) as
select greatest(date_trunc('week', due_date)::date, date_trunc('week', current_date)::date) as wk, count(*) as due
from schedule_queue
where due_date < current_date + 56
group by 1;
grant select on home_due_weekly to authenticated;

create or replace view home_jobs_weekly with (security_invoker = on) as
select date_trunc('week', scheduled_start at time zone 'Australia/Brisbane')::date as wk,
       count(*) filter (where status = 'completed') as completed,
       count(*) filter (where status = 'no_access') as no_access,
       count(*) filter (where status in ('booked', 'in_progress') and inspector_id is not null) as booked
from jobs
where scheduled_start >= now() - interval '12 weeks' and scheduled_start < now() + interval '8 weeks'
group by 1;
grant select on home_jobs_weekly to authenticated;
