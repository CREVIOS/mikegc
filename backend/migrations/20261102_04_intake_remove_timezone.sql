-- Migration date: 2026-11-02
-- Intake keeps no timezones. A target date is a calendar date, and a request
-- is overdue once that date has passed where the viewer is: the queue, its
-- Overdue filter and the dashboard all count it in the viewer's timezone.
-- Requests no longer record one, and automated intake has no default.

drop function if exists public.intake_submit_request(uuid, uuid, uuid, uuid, text, text, text, text, text, date, text, uuid);
drop function if exists public.intake_edit_request(uuid, uuid, uuid, uuid, integer, text, text, text, text, text, date, text);
drop function if exists public.intake_submit_automated(uuid, uuid, uuid, text, text, text, text, date, text, uuid);
drop function if exists public.intake_check_details(text, text, text, text, text, date, text);
drop function if exists public.intake_list_requests(uuid, uuid, text, text, text, text, text, uuid, text, text, integer);
drop function if exists public.intake_list_in_scope(public.intake_requests, text);

-- Its two checks, pairing it with the date and bounding it, go with it.
alter table public.intake_requests drop column if exists timezone;
alter table public.intake_automation drop column if exists default_timezone;

create or replace function public.intake_check_details(p_subject text, p_description text,
  p_requester_name text, p_requester_email text, p_requester_team text)
returns void language plpgsql stable set search_path = public, pg_temp as $$
begin
  if p_subject is null or char_length(p_subject) not between 1 and 200 or btrim(p_subject) = ''
    or p_description is null or char_length(p_description) not between 1 and 20000 or btrim(p_description) = ''
    or p_requester_name is null or char_length(p_requester_name) not between 1 and 200 or btrim(p_requester_name) = ''
    or (p_requester_email is not null and (char_length(p_requester_email) not between 3 and 320
      or p_requester_email !~ '^[^@[:space:]]+@[^@[:space:]]+$'))
    or (p_requester_team is not null and (char_length(p_requester_team) not between 1 and 200 or btrim(p_requester_team) = ''))
  then
    raise exception 'Invalid request details' using errcode = '22023';
  end if;
end $$;

create or replace function public.intake_submit_request(p_org uuid, p_actor uuid, p_command uuid, p_request uuid,
  p_subject text, p_description text, p_requester_name text, p_requester_email text default null,
  p_requester_team text default null, p_date date default null, p_assignee uuid default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare input jsonb; replay jsonb; next_state text;
begin
  perform public.intake_lock_org(p_org, p_actor);
  input := jsonb_build_object('id', p_request, 'subject', p_subject,
    'description', p_description, 'requester_name', p_requester_name, 'requester_email', p_requester_email,
    'requester_team', p_requester_team, 'date', p_date, 'assignee', p_assignee);
  replay := public.intake_replay(p_org, p_actor, p_command, 'submit', input);
  if replay is not null then
    if not public.intake_can_read(p_org, p_actor, p_request) then
      raise exception 'Request not found' using errcode = 'P0002';
    end if;
    return replay;
  end if;
  if p_request is null then raise exception 'Invalid request details' using errcode = '22023'; end if;
  perform public.intake_check_details(p_subject, p_description, p_requester_name,
    p_requester_email, p_requester_team);
  if p_assignee is not null and public.intake_member_role(p_org, p_assignee) is null then
    raise exception 'Choose a current member of your organization' using errcode = '22023';
  end if;
  if exists(select 1 from public.intake_requests where id = p_request) then
    raise exception 'Request ID already used' using errcode = 'P0007';
  end if;
  -- The organization's intake anchor is created with its first request.
  insert into public.intake_settings(org_id) values(p_org) on conflict do nothing;
  next_state := case when p_assignee is null then 'submitted' else 'in_review' end;
  insert into public.intake_requests(id, org_id, created_by, requester_name, requester_email, requester_team,
      assignee_id, subject, description, requested_by_date, state)
    values(p_request, p_org, p_actor, p_requester_name, p_requester_email, p_requester_team,
      p_assignee, p_subject, p_description, p_date, next_state);
  insert into public.intake_events(org_id, request_id, actor_id, kind, to_state, assignee_id)
    values(p_org, p_request, p_actor, 'submitted', next_state, p_assignee);
  return public.intake_record_command(p_org, p_actor, p_command, p_request, 'submit', input, 1);
end $$;

create or replace function public.intake_edit_request(p_org uuid, p_actor uuid, p_command uuid, p_request uuid, p_version integer,
  p_subject text, p_description text, p_requester_name text, p_requester_email text default null,
  p_requester_team text default null, p_date date default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare r public.intake_requests; input jsonb; replay jsonb;
begin
  perform public.intake_lock_org(p_org, p_actor);
  if not public.intake_can_read(p_org, p_actor, p_request) then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  input := jsonb_build_object('id', p_request, 'version', p_version, 'subject', p_subject,
    'description', p_description, 'requester_name', p_requester_name, 'requester_email', p_requester_email,
    'requester_team', p_requester_team, 'date', p_date);
  replay := public.intake_replay(p_org, p_actor, p_command, 'edit', input);
  if replay is not null then return replay; end if;
  select * into r from public.intake_requests where org_id = p_org and id = p_request for update;
  if p_version is null or r.version <> p_version or r.state in ('resolved', 'cancelled') then
    raise exception 'Request changed; reload it' using errcode = 'P0001';
  end if;
  perform public.intake_check_details(p_subject, p_description, p_requester_name,
    p_requester_email, p_requester_team);
  update public.intake_requests set subject = p_subject, description = p_description,
    requester_name = p_requester_name, requester_email = p_requester_email, requester_team = p_requester_team,
    requested_by_date = p_date, version = version + 1, updated_at = now()
    where id = p_request;
  insert into public.intake_events(org_id, request_id, actor_id, kind, from_state, to_state, assignee_id)
    values(p_org, p_request, p_actor, 'edited', r.state, r.state, r.assignee_id);
  return public.intake_record_command(p_org, p_actor, p_command, p_request, 'edit', input, r.version + 1);
end $$;

create or replace function public.intake_request_view(p_org uuid, p_actor uuid, p_request uuid)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', r.id, 'org_id', r.org_id, 'subject', r.subject, 'description', r.description,
    'requester_name', r.requester_name, 'requester_email', r.requester_email, 'requester_team', r.requester_team,
    'requested_by_date', r.requested_by_date, 'state', r.state, 'version', r.version,
    'assignee_id', r.assignee_id,
    'assignee_name', case when r.assignee_id is null then null else coalesce(a.display_name, a.email, 'Former member') end,
    'created_by', r.created_by,
    'created_by_name', case when r.created_by is null and r.source <> 'manual' then 'MikeGC'
      else coalesce(c.display_name, c.email, 'Former member') end,
    'source', r.source,
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

-- List rows omit the description, which the queue never shows.
create or replace function public.intake_list_item(r public.intake_requests)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', r.id, 'subject', r.subject,
    'requester_name', r.requester_name, 'requester_email', r.requester_email, 'requester_team', r.requester_team,
    'requested_by_date', r.requested_by_date, 'state', r.state, 'version', r.version,
    'assignee_id', r.assignee_id,
    'assignee_name', case when r.assignee_id is null then null else coalesce(
      (select coalesce(a.display_name, a.email) from public.user_profiles a where a.user_id = r.assignee_id),
      'Former member') end,
    'created_at', r.created_at, 'updated_at', r.updated_at,
    'capabilities', jsonb_build_object(
      'assign', r.state not in ('resolved', 'cancelled'),
      'cancel', r.state not in ('resolved', 'cancelled'),
      'delete', true))
$$;

-- The intake dashboard: where the open requests stand, how many came in and
-- were resolved each week, how long resolving takes, and who holds what.
-- Weeks start on Monday in the viewer's timezone, and a request is overdue
-- once its target date has passed there, as the queue shows it.
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
        and (now() at time zone p_timezone)::date > r.requested_by_date as overdue
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

-- What a dashboard figure counted, so each figure opens exactly its requests:
-- open, open and unassigned, overdue (its target date passed in the viewer's
-- timezone), recorded in the last 30 days, or resolved in the last 30 days.
create or replace function public.intake_list_in_scope(r public.intake_requests, p_scope text, p_timezone text)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select p_scope is null
    or (p_scope in ('open', 'unassigned', 'overdue') and r.state not in ('resolved', 'cancelled')
      and (p_scope = 'open'
        or (p_scope = 'unassigned' and r.assignee_id is null)
        or (p_scope = 'overdue' and r.requested_by_date is not null
          and (now() at time zone p_timezone)::date > r.requested_by_date)))
    or (p_scope = 'recorded_30d' and r.created_at >= now() - interval '30 days')
    or (p_scope = 'resolved_30d' and exists(select 1 from public.intake_events e
      where e.org_id = r.org_id and e.request_id = r.id and e.to_state = 'resolved'
        and e.created_at >= now() - interval '30 days'))
$$;

-- Keyset pages: a request created or updated between pages is never repeated.
-- p_assignee is null (everyone), 'unassigned', 'me' or a member's user ID.
-- p_requester is null (everyone) or one requester's name, matched without case.
-- p_timezone is the viewer's, which the overdue scope is judged in.
create or replace function public.intake_list_requests(p_org uuid, p_actor uuid, p_state text default null,
  p_assignee text default null, p_search text default '', p_sort text default 'updated',
  p_after_key text default null, p_after_id uuid default null, p_scope text default null,
  p_requester text default null, p_limit integer default 50, p_timezone text default 'UTC')
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare unassigned boolean; assignee uuid; after_at timestamptz; after_date date;
  page jsonb; more boolean; last jsonb;
begin
  perform 1 from public.organizations where id = p_org for share;
  if public.intake_member_role(p_org, p_actor) is null then
    raise exception 'Intake not found' using errcode = 'P0002';
  end if;
  if p_sort is null or p_sort not in ('updated', 'updated_asc', 'target')
    or p_limit is null or p_limit not between 1 and 100
    or p_search is null or char_length(p_search) > 200
    or (p_state is not null and p_state not in ('submitted', 'in_review', 'needs_information', 'resolved', 'cancelled'))
    or (p_requester is not null and char_length(p_requester) not between 1 and 200)
    or (p_scope is not null and p_scope not in ('open', 'unassigned', 'overdue', 'recorded_30d', 'resolved_30d'))
    or (p_after_id is null and p_after_key is not null)
    or (p_sort in ('updated', 'updated_asc') and p_after_id is not null and p_after_key is null)
    or p_timezone is null or char_length(p_timezone) > 64 or not public.intake_valid_timezone(p_timezone)
  then
    raise exception 'Invalid request filter' using errcode = '22023';
  end if;
  unassigned := coalesce(p_assignee = 'unassigned', false);
  assignee := case when p_assignee is null or unassigned then null
    when p_assignee = 'me' then p_actor else p_assignee::uuid end;
  if p_sort = 'updated' then
    after_at := p_after_key::timestamptz;
    select coalesce(jsonb_agg(x.item order by x.n) filter (where x.n <= p_limit), '[]'), coalesce(max(x.n), 0) > p_limit
      into page, more
      from (select public.intake_list_item(r) as item,
          row_number() over (order by r.updated_at desc, r.id desc) as n
        from public.intake_requests r
        where r.org_id = p_org and public.intake_list_matches(r, p_state, unassigned, assignee, p_search)
          and public.intake_list_in_scope(r, p_scope, p_timezone)
          and (p_requester is null or lower(r.requester_name) = lower(p_requester))
          and (p_after_id is null or (r.updated_at, r.id) < (after_at, p_after_id))
        order by r.updated_at desc, r.id desc limit p_limit + 1) x;
  elsif p_sort = 'updated_asc' then
    after_at := p_after_key::timestamptz;
    select coalesce(jsonb_agg(x.item order by x.n) filter (where x.n <= p_limit), '[]'), coalesce(max(x.n), 0) > p_limit
      into page, more
      from (select public.intake_list_item(r) as item,
          row_number() over (order by r.updated_at asc, r.id asc) as n
        from public.intake_requests r
        where r.org_id = p_org and public.intake_list_matches(r, p_state, unassigned, assignee, p_search)
          and public.intake_list_in_scope(r, p_scope, p_timezone)
          and (p_requester is null or lower(r.requester_name) = lower(p_requester))
          and (p_after_id is null or (r.updated_at, r.id) > (after_at, p_after_id))
        order by r.updated_at asc, r.id asc limit p_limit + 1) x;
  else
    after_date := p_after_key::date;
    select coalesce(jsonb_agg(x.item order by x.n) filter (where x.n <= p_limit), '[]'), coalesce(max(x.n), 0) > p_limit
      into page, more
      from (select public.intake_list_item(r) as item,
          row_number() over (order by r.requested_by_date asc nulls last, r.id asc) as n
        from public.intake_requests r
        where r.org_id = p_org and public.intake_list_matches(r, p_state, unassigned, assignee, p_search)
          and public.intake_list_in_scope(r, p_scope, p_timezone)
          and (p_requester is null or lower(r.requester_name) = lower(p_requester))
          and (p_after_id is null
            or (after_date is null and r.requested_by_date is null and r.id > p_after_id)
            or (after_date is not null and (r.requested_by_date is null or r.requested_by_date > after_date
              or (r.requested_by_date = after_date and r.id > p_after_id))))
        order by r.requested_by_date asc nulls last, r.id asc limit p_limit + 1) x;
  end if;
  last := page -> -1;
  return jsonb_build_object('requests', page, 'next', case when more then jsonb_build_object(
    'key', last ->> (case when p_sort = 'target' then 'requested_by_date' else 'updated_at' end),
    'id', last ->> 'id') end);
end $$;

-- A request MikeGC records from a received message. No member makes it, so
-- it has no creator and its "submitted" event is marked automated. Asking
-- again for the same message returns the request it already made. A
-- reviewer who is not a current member leaves the request unassigned.
create or replace function public.intake_submit_automated(p_org uuid, p_inbound uuid, p_request uuid,
  p_subject text, p_description text, p_requester_name text, p_requester_email text default null,
  p_date date default null, p_assignee uuid default null)
returns uuid language plpgsql set search_path = public, pg_temp as $$
declare i public.intake_inbound; next_state text; reviewer uuid := p_assignee;
begin
  perform 1 from public.organizations where id = p_org and kind in ('team', 'personal')
    and deleted_at is null for update;
  if not found then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  select * into i from public.intake_inbound where id = p_inbound and org_id = p_org for update;
  if not found then raise exception 'Message not found' using errcode = 'P0002'; end if;
  if i.request_id is not null then return i.request_id; end if;
  if i.status <> 'pending' then raise exception 'Message already handled' using errcode = 'P0001'; end if;
  if p_request is null then raise exception 'Invalid request details' using errcode = '22023'; end if;
  perform public.intake_check_details(p_subject, p_description, p_requester_name,
    p_requester_email, null);
  if reviewer is not null and public.intake_member_role(p_org, reviewer) is null then
    reviewer := null;
  end if;
  if exists(select 1 from public.intake_requests where id = p_request) then
    raise exception 'Request ID already used' using errcode = 'P0007';
  end if;
  insert into public.intake_settings(org_id) values(p_org) on conflict do nothing;
  next_state := case when reviewer is null then 'submitted' else 'in_review' end;
  insert into public.intake_requests(id, org_id, created_by, source, requester_name, requester_email,
      assignee_id, subject, description, requested_by_date, state)
    values(p_request, p_org, null, i.source, p_requester_name, p_requester_email,
      reviewer, p_subject, p_description, p_date, next_state);
  insert into public.intake_events(org_id, request_id, actor_id, kind, to_state, assignee_id, automated)
    values(p_org, p_request, null, 'submitted', next_state, reviewer, true);
  update public.intake_inbound set request_id = p_request, updated_at = now() where id = p_inbound;
  return p_request;
end $$;

-- The functions above are recreated, so they need their grants again: the API
-- calls them as service_role and no browser role may.
do $$ declare obj record; begin
  for obj in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('intake_check_details', 'intake_submit_request',
      'intake_edit_request', 'intake_list_in_scope', 'intake_list_requests', 'intake_submit_automated') loop
    execute format('revoke all on function %s from public,anon,authenticated', obj.signature);
    execute format('grant execute on function %s to service_role', obj.signature);
  end loop;
end $$;
