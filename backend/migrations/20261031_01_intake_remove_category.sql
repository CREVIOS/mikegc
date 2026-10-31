-- Migration date: 2026-10-31
-- Requests no longer have a type (contract review or legal question). The
-- column goes, and every function that read or wrote it is redefined without
-- it. The old signatures are dropped first because their arguments change.
drop function if exists public.intake_check_details(text, text, text, text, text, text, date, text);
drop function if exists public.intake_submit_request(uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, uuid);
drop function if exists public.intake_edit_request(uuid, uuid, uuid, uuid, integer, text, text, text, text, text, text, date, text);
drop function if exists public.intake_list_requests(uuid, uuid, text, text, text, text, text, uuid, integer, text);
drop function if exists public.intake_list_matches(public.intake_requests, text, boolean, uuid, text, text);

alter table public.intake_requests drop column if exists category;

create or replace function public.intake_check_details(p_subject text, p_description text,
  p_requester_name text, p_requester_email text, p_requester_team text, p_date date, p_timezone text)
returns void language plpgsql stable set search_path = public, pg_temp as $$
begin
  if p_subject is null or char_length(p_subject) not between 1 and 200 or btrim(p_subject) = ''
    or p_description is null or char_length(p_description) not between 1 and 20000 or btrim(p_description) = ''
    or p_requester_name is null or char_length(p_requester_name) not between 1 and 200 or btrim(p_requester_name) = ''
    or (p_requester_email is not null and (char_length(p_requester_email) not between 3 and 320
      or p_requester_email !~ '^[^@[:space:]]+@[^@[:space:]]+$'))
    or (p_requester_team is not null and (char_length(p_requester_team) not between 1 and 200 or btrim(p_requester_team) = ''))
    or ((p_date is null) <> (p_timezone is null))
    or (p_timezone is not null and not public.intake_valid_timezone(p_timezone))
  then
    raise exception 'Invalid request details' using errcode = '22023';
  end if;
end $$;

create or replace function public.intake_submit_request(p_org uuid, p_actor uuid, p_command uuid, p_request uuid,
  p_subject text, p_description text, p_requester_name text, p_requester_email text default null,
  p_requester_team text default null, p_date date default null, p_timezone text default null, p_assignee uuid default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare input jsonb; replay jsonb; next_state text;
begin
  perform public.intake_lock_org(p_org, p_actor);
  input := jsonb_build_object('id', p_request, 'subject', p_subject,
    'description', p_description, 'requester_name', p_requester_name, 'requester_email', p_requester_email,
    'requester_team', p_requester_team, 'date', p_date, 'timezone', p_timezone, 'assignee', p_assignee);
  replay := public.intake_replay(p_org, p_actor, p_command, 'submit', input);
  if replay is not null then
    if not public.intake_can_read(p_org, p_actor, p_request) then
      raise exception 'Request not found' using errcode = 'P0002';
    end if;
    return replay;
  end if;
  if p_request is null then raise exception 'Invalid request details' using errcode = '22023'; end if;
  perform public.intake_check_details(p_subject, p_description, p_requester_name,
    p_requester_email, p_requester_team, p_date, p_timezone);
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
      assignee_id, subject, description, requested_by_date, timezone, state)
    values(p_request, p_org, p_actor, p_requester_name, p_requester_email, p_requester_team,
      p_assignee, p_subject, p_description, p_date, p_timezone, next_state);
  insert into public.intake_events(org_id, request_id, actor_id, kind, to_state, assignee_id)
    values(p_org, p_request, p_actor, 'submitted', next_state, p_assignee);
  return public.intake_record_command(p_org, p_actor, p_command, p_request, 'submit', input, 1);
end $$;

create or replace function public.intake_edit_request(p_org uuid, p_actor uuid, p_command uuid, p_request uuid, p_version integer,
  p_subject text, p_description text, p_requester_name text, p_requester_email text default null,
  p_requester_team text default null, p_date date default null, p_timezone text default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare r public.intake_requests; input jsonb; replay jsonb;
begin
  perform public.intake_lock_org(p_org, p_actor);
  if not public.intake_can_read(p_org, p_actor, p_request) then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  input := jsonb_build_object('id', p_request, 'version', p_version, 'subject', p_subject,
    'description', p_description, 'requester_name', p_requester_name, 'requester_email', p_requester_email,
    'requester_team', p_requester_team, 'date', p_date, 'timezone', p_timezone);
  replay := public.intake_replay(p_org, p_actor, p_command, 'edit', input);
  if replay is not null then return replay; end if;
  select * into r from public.intake_requests where org_id = p_org and id = p_request for update;
  if p_version is null or r.version <> p_version or r.state in ('resolved', 'cancelled') then
    raise exception 'Request changed; reload it' using errcode = 'P0001';
  end if;
  perform public.intake_check_details(p_subject, p_description, p_requester_name,
    p_requester_email, p_requester_team, p_date, p_timezone);
  update public.intake_requests set subject = p_subject, description = p_description,
    requester_name = p_requester_name, requester_email = p_requester_email, requester_team = p_requester_team,
    requested_by_date = p_date, timezone = p_timezone, version = version + 1, updated_at = now()
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
    'requested_by_date', r.requested_by_date, 'timezone', r.timezone, 'state', r.state, 'version', r.version,
    'assignee_id', r.assignee_id,
    'assignee_name', case when r.assignee_id is null then null else coalesce(a.display_name, a.email, 'Former member') end,
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

create or replace function public.intake_list_item(r public.intake_requests)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', r.id, 'subject', r.subject,
    'requester_name', r.requester_name, 'requester_email', r.requester_email, 'requester_team', r.requester_team,
    'requested_by_date', r.requested_by_date, 'timezone', r.timezone, 'state', r.state, 'version', r.version,
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

create or replace function public.intake_list_matches(r public.intake_requests, p_state text,
  p_unassigned boolean, p_assignee uuid, p_search text)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select (p_state is null or r.state = p_state)
    and (not p_unassigned or r.assignee_id is null)
    and (p_assignee is null or r.assignee_id = p_assignee)
    and (p_search = ''
      or strpos(lower(r.subject), lower(p_search)) > 0
      or strpos(lower(r.description), lower(p_search)) > 0
      or strpos(lower(r.requester_name), lower(p_search)) > 0
      or strpos(lower(coalesce(r.requester_email, '')), lower(p_search)) > 0
      or strpos(lower(coalesce(r.requester_team, '')), lower(p_search)) > 0)
$$;

create or replace function public.intake_list_requests(p_org uuid, p_actor uuid, p_state text default null,
  p_assignee text default null, p_search text default '', p_sort text default 'updated',
  p_after_key text default null, p_after_id uuid default null, p_limit integer default 50)
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
    or (p_after_id is null and p_after_key is not null)
    or (p_sort in ('updated', 'updated_asc') and p_after_id is not null and p_after_key is null)
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

-- Keep the new signatures out of reach of browser database roles.
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
