-- Migration date: 2026-11-01
-- The dashboard's period figures can each be read over a chosen period:
-- created and resolved over 7, 30, 90 or 365 days each, and the median time
-- to resolve over 30, 90 or 365 days. Their keys no longer name 30 days, and the
-- response says which periods it used. The signature gains two arguments, so
-- the previous one is dropped first.
drop function if exists public.intake_dashboard(uuid, uuid, text, integer);

create or replace function public.intake_dashboard(p_org uuid, p_actor uuid, p_timezone text default 'UTC',
  p_weeks integer default 8, p_created_days integer default 30,
  p_resolved_days integer default 30, p_median_days integer default 30)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare first_week date; result jsonb;
begin
  perform 1 from public.organizations where id = p_org for share;
  if public.intake_member_role(p_org, p_actor) is null then
    raise exception 'Intake not found' using errcode = 'P0002';
  end if;
  if p_timezone is null or char_length(p_timezone) > 64 or not public.intake_valid_timezone(p_timezone)
    or p_weeks is null or p_weeks not between 1 and 26
    or p_created_days is null or p_created_days not in (7, 30, 90, 365)
    or p_resolved_days is null or p_resolved_days not in (7, 30, 90, 365)
    or p_median_days is null or p_median_days not in (30, 90, 365) then
    raise exception 'Invalid dashboard filter' using errcode = '22023';
  end if;
  first_week := date_trunc('week', now() at time zone p_timezone)::date - (p_weeks - 1) * 7;
  with open_requests as (
    select r.state, r.assignee_id,
      r.requested_by_date is not null
        and (now() at time zone coalesce(r.timezone, 'UTC'))::date > r.requested_by_date as overdue
    from public.intake_requests r
    where r.org_id = p_org and r.state not in ('resolved', 'cancelled')
  ), resolved as (
    -- Each time a request was resolved; reopening and resolving it again counts again.
    select e.request_id, e.created_at
    from public.intake_events e
    where e.org_id = p_org and e.request_id is not null and e.to_state = 'resolved'
  ), created_weeks as (
    select date_trunc('week', r.created_at at time zone p_timezone)::date as week, count(*) as n
    from public.intake_requests r
    where r.org_id = p_org and r.created_at >= first_week::timestamp at time zone p_timezone
    group by 1
  ), resolved_weeks as (
    select date_trunc('week', x.created_at at time zone p_timezone)::date as week, count(distinct x.request_id) as n
    from resolved x
    where x.created_at >= first_week::timestamp at time zone p_timezone
    group by 1
  ), workload as (
    select o.assignee_id,
      coalesce(u.display_name, u.email, 'Former member') as name,
      u.profile_photo as photo,
      count(*) as open_count,
      count(*) filter (where o.state = 'needs_information') as waiting_count,
      count(*) filter (where o.overdue) as overdue_count
    from open_requests o
    left join public.user_profiles u on u.user_id = o.assignee_id
    where o.assignee_id is not null
    group by o.assignee_id, u.display_name, u.email, u.profile_photo
  )
  select jsonb_build_object(
    'open', (select count(*) from open_requests),
    'new', (select count(*) from open_requests where state = 'submitted'),
    'in_progress', (select count(*) from open_requests where state = 'in_review'),
    'waiting', (select count(*) from open_requests where state = 'needs_information'),
    'unassigned', (select count(*) from open_requests where assignee_id is null),
    'overdue', (select count(*) from open_requests where overdue),
    'created_days', p_created_days, 'resolved_days', p_resolved_days,
    'median_days', p_median_days, 'weeks_shown', p_weeks,
    'created', (select count(*) from public.intake_requests r
      where r.org_id = p_org and r.created_at >= now() - make_interval(days => p_created_days)),
    'resolved', (select count(distinct x.request_id) from resolved x
      where x.created_at >= now() - make_interval(days => p_resolved_days)),
    -- From recording to the latest resolution, for requests that are resolved
    -- now and were resolved in the last p_median_days days.
    'median_hours_to_resolve', (select round((percentile_cont(0.5) within group (
        order by extract(epoch from (l.resolved_at - r.created_at)) / 3600))::numeric, 1)
      from (select request_id, max(created_at) as resolved_at from resolved group by request_id) l
      join public.intake_requests r on r.id = l.request_id and r.org_id = p_org
      where r.state = 'resolved' and l.resolved_at >= now() - make_interval(days => p_median_days)),
    'weeks', (select jsonb_agg(jsonb_build_object('week_start', w.week::date,
        'created', coalesce(c.n, 0), 'resolved', coalesce(x.n, 0)) order by w.week)
      from generate_series(first_week, first_week + (p_weeks - 1) * 7, interval '1 week') w(week)
      left join created_weeks c on c.week = w.week::date
      left join resolved_weeks x on x.week = w.week::date),
    'workload', (select coalesce(jsonb_agg(jsonb_build_object('assignee_id', assignee_id, 'name', name, 'photo', photo,
        'open', open_count, 'waiting', waiting_count, 'overdue', overdue_count)
        order by open_count desc, lower(name), assignee_id), '[]')
      from workload))
  into result;
  return result;
end $$;

-- Keep the new signature out of reach of browser database roles.
do $$ declare obj record; begin
  for obj in select tablename from pg_tables where schemaname = 'public' and tablename like 'intake_%' loop
    execute format('alter table public.%I enable row level security', obj.tablename);
    execute format('revoke all on public.%I from public,anon,authenticated', obj.tablename);
    execute format('grant all on public.%I to service_role', obj.tablename);
  end loop;
  for obj in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'intake_%' loop
    execute format('revoke all on function %s from public,anon,authenticated', obj.signature);
    execute format('grant execute on function %s to service_role', obj.signature);
  end loop;
end $$;
