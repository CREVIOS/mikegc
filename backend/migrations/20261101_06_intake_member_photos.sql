-- Migration date: 2026-11-01
-- Intake avatars can show profile photos. The member list carries each
-- member's photo once, the dashboard's workload rows carry their reviewer's,
-- and history entries name who acted by ID, so the page reuses the member
-- list's photos rather than repeating an image on every entry; a request
-- names its creator by ID for the same reason. Signatures are unchanged.

create or replace function public.intake_members(p_org uuid, p_actor uuid)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.organizations where id = p_org for share;
  if public.intake_member_role(p_org, p_actor) is null then
    raise exception 'Intake not found' using errcode = 'P0002';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'display_name', u.display_name, 'email', u.email,
      'profile_photo', u.profile_photo)
      order by lower(coalesce(u.display_name, u.email, '')), m.user_id), '[]')
    from public.org_members m join public.user_profiles u on u.user_id = m.user_id
    where m.org_id = p_org and u.account_deletion_requested_at is null);
end $$;

create or replace function public.intake_dashboard(p_org uuid, p_actor uuid, p_timezone text default 'UTC',
  p_weeks integer default 8)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare first_week date; result jsonb;
begin
  perform 1 from public.organizations where id = p_org for share;
  if public.intake_member_role(p_org, p_actor) is null then
    raise exception 'Intake not found' using errcode = 'P0002';
  end if;
  if p_timezone is null or char_length(p_timezone) > 64 or not public.intake_valid_timezone(p_timezone)
    or p_weeks is null or p_weeks not between 1 and 26 then
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
    'created_30d', (select count(*) from public.intake_requests r
      where r.org_id = p_org and r.created_at >= now() - interval '30 days'),
    'resolved_30d', (select count(distinct x.request_id) from resolved x
      where x.created_at >= now() - interval '30 days'),
    -- From recording to the latest resolution, for requests that are resolved
    -- now and were resolved in the last 90 days.
    'median_hours_to_resolve', (select round((percentile_cont(0.5) within group (
        order by extract(epoch from (l.resolved_at - r.created_at)) / 3600))::numeric, 1)
      from (select request_id, max(created_at) as resolved_at from resolved group by request_id) l
      join public.intake_requests r on r.id = l.request_id and r.org_id = p_org
      where r.state = 'resolved' and l.resolved_at >= now() - interval '90 days'),
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

create or replace function public.intake_read_history(p_org uuid, p_actor uuid, p_request uuid,
  p_events boolean default false, p_offset integer default 0, p_limit integer default 50)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.organizations where id = p_org for share;
  if not public.intake_can_read(p_org, p_actor, p_request) then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if p_offset is null or p_offset < 0 or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Invalid page' using errcode = '22023';
  end if;
  if p_events then
    return (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from (
      select e.id, e.kind, e.from_state, e.to_state, e.created_at,
        -- IDs let the page show each person's photo from its member list.
        case when e.kind in ('assignee_left', 'reviewer_removed') then null else e.actor_id end as actor_id,
        case when e.kind in ('assignee_left', 'reviewer_removed') then null
          else coalesce(u.display_name, u.email, 'Former member') end as actor_name,
        case when e.assignee_id is null then null else coalesce(a.display_name, a.email, 'Former member') end as assignee_name
      from public.intake_events e
      left join public.user_profiles u on u.user_id = e.actor_id
      left join public.user_profiles a on a.user_id = e.assignee_id
      where e.org_id = p_org and e.request_id = p_request
      order by e.id offset p_offset limit p_limit) x);
  end if;
  return (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at, x.id), '[]') from (
    select m.id, m.kind, m.body, m.created_at, m.author_id,
      coalesce(u.display_name, u.email, 'Former member') as author_name
    from public.intake_messages m left join public.user_profiles u on u.user_id = m.author_id
    where m.org_id = p_org and m.request_id = p_request
    order by m.created_at, m.id offset p_offset limit p_limit) x);
end $$;

create or replace function public.intake_request_view(p_org uuid, p_actor uuid, p_request uuid)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', r.id, 'org_id', r.org_id, 'subject', r.subject, 'description', r.description,
    'requester_name', r.requester_name, 'requester_email', r.requester_email, 'requester_team', r.requester_team,
    'requested_by_date', r.requested_by_date, 'timezone', r.timezone, 'state', r.state, 'version', r.version,
    'assignee_id', r.assignee_id,
    'assignee_name', case when r.assignee_id is null then null else coalesce(a.display_name, a.email, 'Former member') end,
    'created_by', r.created_by,
    'created_by_name', coalesce(c.display_name, c.email, 'Former member'),
    'created_at', r.created_at, 'updated_at', r.updated_at,
    'capabilities', jsonb_build_object(
      'edit', r.state not in ('resolved', 'cancelled'),
      'assign', r.state not in ('resolved', 'cancelled'),
      'note', true,
      'wait', r.state in ('submitted', 'in_review'),
      'resume', r.state = 'needs_information',
      'resolve', r.state not in ('resolved', 'cancelled'),
      'cancel', r.state not in ('resolved', 'cancelled'),
      'reopen', r.state in ('resolved', 'cancelled'),
      'delete', true))
  from public.intake_requests r
  left join public.user_profiles c on c.user_id = r.created_by
  left join public.user_profiles a on a.user_id = r.assignee_id
  where r.id = p_request and r.org_id = p_org and public.intake_can_read(p_org, p_actor, p_request)
$$;
