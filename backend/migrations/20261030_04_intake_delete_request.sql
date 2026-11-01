-- Migration date: 2026-10-30
-- Requests can be deleted one at a time by any member of the organization.
-- The request view and queue rows advertise it, and intake_delete_request
-- removes the request with everything that belongs to it.

create or replace function public.intake_request_view(p_org uuid, p_actor uuid, p_request uuid)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', r.id, 'org_id', r.org_id, 'category', r.category, 'subject', r.subject, 'description', r.description,
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

-- List rows omit the description, which the queue never shows.
create or replace function public.intake_list_item(r public.intake_requests)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', r.id, 'category', r.category, 'subject', r.subject,
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

-- Any member can delete one request, in any state. Its notes, history,
-- receipts and attachments go with it. Command IDs that touched it become
-- identity-only tombstones, so a lost submit or command retry cannot recreate
-- it. The organization keeps a content-free event naming who deleted a request.
create or replace function public.intake_delete_request(p_org uuid, p_actor uuid, p_command uuid, p_request uuid, p_version integer)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare r public.intake_requests; input jsonb; replay jsonb; result jsonb;
begin
  perform public.intake_lock_org(p_org, p_actor);
  input := jsonb_build_object('id', p_request, 'version', p_version);
  -- A retry after the request is gone still finds its own receipt.
  replay := public.intake_replay(p_org, p_actor, p_command, 'delete', input);
  if replay is not null then return replay; end if;
  if not public.intake_can_read(p_org, p_actor, p_request) then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  select * into r from public.intake_requests where org_id = p_org and id = p_request for update;
  if p_version is null or r.version <> p_version then
    raise exception 'Request changed; reload it' using errcode = 'P0001';
  end if;
  insert into public.intake_purged_commands(org_id, actor_id, command_id)
    select org_id, actor_id, command_id from public.intake_commands
    where org_id = p_org and request_id = p_request on conflict do nothing;
  delete from public.intake_requests where org_id = p_org and id = p_request;
  insert into public.intake_events(org_id, actor_id, kind) values(p_org, p_actor, 'request_deleted');
  -- The receipt names no request row, so it outlives the request it deleted.
  result := jsonb_build_object('request_id', p_request, 'applied_version', r.version + 1,
    'message_id', null, 'replayed', false);
  insert into public.intake_commands(org_id, actor_id, command_id, request_id, action, input, result)
    values(p_org, p_actor, p_command, null, 'delete', input, result);
  return result;
end $$;

-- Tables and functions are inaccessible to browser database roles, even if
-- default Supabase grants change. The backend service role supplies the actor.
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
