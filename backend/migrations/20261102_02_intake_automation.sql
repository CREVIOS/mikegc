-- Migration date: 2026-11-02
-- Automated intake. MikeGC records requests from email forwarded to an
-- organization's intake address and from Slack messages that mention it.
-- MikeGC is not an account: what it records has no actor and is marked
-- automated, so it reads as MikeGC rather than as a former member.
-- Owners and admins configure it; secrets are encrypted by the API
-- (AES-256-GCM) and the email address's token is kept only as a SHA-256 hash.

alter table public.intake_requests add column if not exists source text not null default 'manual';
alter table public.intake_requests drop constraint if exists intake_requests_source_check;
alter table public.intake_requests add constraint intake_requests_source_check
  check (source in ('manual', 'email', 'slack'));
alter table public.intake_events add column if not exists automated boolean not null default false;
alter table public.intake_request_documents add column if not exists automated boolean not null default false;

create table if not exists public.intake_automation (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  email_enabled boolean not null default false,
  email_token_hash text unique check (email_token_hash is null or email_token_hash ~ '^[0-9a-f]{64}$'),
  email_token_hint text check (email_token_hint is null or char_length(email_token_hint) between 1 and 8),
  email_allowed_domains text[] not null default '{}' check (cardinality(email_allowed_domains) <= 50),
  slack_enabled boolean not null default false,
  -- Names the organization in its Slack events URL; requests are verified
  -- with the signing secret, so this identifier is not a credential.
  slack_webhook_id uuid not null default gen_random_uuid() unique,
  slack_team_id text check (slack_team_id is null or char_length(slack_team_id) between 1 and 40),
  slack_team_name text check (slack_team_name is null or char_length(slack_team_name) between 1 and 200),
  slack_bot_user_id text check (slack_bot_user_id is null or char_length(slack_bot_user_id) between 1 and 40),
  slack_signing_secret_encrypted text,
  slack_signing_secret_iv text,
  slack_signing_secret_tag text,
  slack_bot_token_encrypted text,
  slack_bot_token_iv text,
  slack_bot_token_tag text,
  triage_enabled boolean not null default true,
  default_timezone text check (default_timezone is null or char_length(default_timezone) between 1 and 100),
  -- The admin who last saved the settings. Triage uses the organization's
  -- model keys as this member; it runs without AI once they have left.
  configured_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists intake_automation_configured_by on public.intake_automation(configured_by);

-- What each member handles, such as "NDAs and procurement contracts", which
-- triage reads to choose a reviewer. It goes when the member leaves.
create table if not exists public.intake_member_focus (
  org_id uuid not null,
  user_id uuid not null,
  focus text not null check (char_length(focus) between 1 and 500 and btrim(focus) <> ''),
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id),
  foreign key (org_id, user_id) references public.org_members(org_id, user_id) on delete cascade
);
create index if not exists intake_member_focus_user on public.intake_member_focus(user_id);

-- Each message received for intake, once: a webhook delivered again finds
-- its row and records nothing new. The payload is kept only until the
-- message is handled; the request then holds its content.
create table if not exists public.intake_inbound (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  source text not null check (source in ('email', 'slack')),
  external_id text not null check (char_length(external_id) between 1 and 300),
  status text not null default 'pending' check (status in ('pending', 'done', 'failed', 'ignored')),
  payload jsonb,
  request_id uuid references public.intake_requests(id) on delete set null,
  error text check (error is null or char_length(error) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, source, external_id)
);
create index if not exists intake_inbound_request on public.intake_inbound(request_id) where request_id is not null;

-- An email's attachments wait in storage until it is handled. A message
-- deleted first, including by an intake purge or an organization's purge,
-- hands its staged files to the storage worker.
create or replace function public.intake_inbound_staged_cleanup()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_keys jsonb;
begin
  select coalesce(jsonb_agg(a->>'key'), '[]'::jsonb) into v_keys
    from jsonb_array_elements(case when jsonb_typeof(old.payload->'attachments') = 'array'
      then old.payload->'attachments' else '[]'::jsonb end) a
    where coalesce(a->>'key', '') <> '';
  if jsonb_array_length(v_keys) > 0 then
    insert into public.db_jobs(kind, payload, max_attempts)
      values ('storage.cleanup', jsonb_build_object('keys', v_keys), 8);
  end if;
  return null;
end $$;
drop trigger if exists intake_inbound_staged_cleanup on public.intake_inbound;
create trigger intake_inbound_staged_cleanup after delete on public.intake_inbound
  for each row execute function public.intake_inbound_staged_cleanup();


create or replace function public.intake_submit_automated(p_org uuid, p_inbound uuid, p_request uuid,
  p_subject text, p_description text, p_requester_name text, p_requester_email text default null,
  p_date date default null, p_timezone text default null, p_assignee uuid default null)
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
    p_requester_email, null, p_date, p_timezone);
  if reviewer is not null and public.intake_member_role(p_org, reviewer) is null then
    reviewer := null;
  end if;
  if exists(select 1 from public.intake_requests where id = p_request) then
    raise exception 'Request ID already used' using errcode = 'P0007';
  end if;
  insert into public.intake_settings(org_id) values(p_org) on conflict do nothing;
  next_state := case when reviewer is null then 'submitted' else 'in_review' end;
  insert into public.intake_requests(id, org_id, created_by, source, requester_name, requester_email,
      assignee_id, subject, description, requested_by_date, timezone, state)
    values(p_request, p_org, null, i.source, p_requester_name, p_requester_email,
      reviewer, p_subject, p_description, p_date, p_timezone, next_state);
  insert into public.intake_events(org_id, request_id, actor_id, kind, to_state, assignee_id, automated)
    values(p_org, p_request, null, 'submitted', next_state, reviewer, true);
  update public.intake_inbound set request_id = p_request, updated_at = now() where id = p_inbound;
  return p_request;
end $$;

create or replace function public.intake_attach_automated(p_org uuid, p_request uuid, p_document uuid)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.organizations where id = p_org and kind in ('team', 'personal')
    and deleted_at is null for update;
  if not found or not exists(select 1 from public.intake_requests where org_id = p_org and id = p_request) then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if not exists(select 1 from public.documents where id = p_document and org_id = p_org
      and library_kind = 'intake_attachment' and user_id is null
      and project_id is null and workflow_id is null) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if exists(select 1 from public.intake_request_documents
      where document_id = p_document and request_id <> p_request) then
    raise exception 'The document belongs to another request' using errcode = '22023';
  end if;
  insert into public.intake_request_documents(org_id, request_id, document_id, added_by, automated)
    values(p_org, p_request, p_document, null, true) on conflict do nothing;
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
          when e.automated then 'MikeGC'
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

create or replace function public.intake_list_documents(p_org uuid, p_actor uuid, p_request uuid)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.organizations where id = p_org for share;
  if not public.intake_can_read(p_org, p_actor, p_request) then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'document_id', d.id, 'filename', coalesce(v.filename, 'Untitled document'),
      'file_type', v.file_type, 'size_bytes', v.size_bytes, 'status', d.status,
      'added_by_name', case when l.automated then 'MikeGC'
        else coalesce(u.display_name, u.email, 'Former member') end, 'created_at', l.created_at,
      'message_id', l.message_id)
      order by l.created_at, d.id), '[]')
    from public.intake_request_documents l
    join public.documents d on d.id = l.document_id
    left join public.document_versions v on v.id = d.current_version_id and v.deleted_at is null
    left join public.user_profiles u on u.user_id = l.added_by
    where l.org_id = p_org and l.request_id = p_request);
end $$;

create or replace function public.intake_purge(p_org uuid,p_actor uuid)
returns void language plpgsql set search_path=public,pg_temp as $$
begin
  perform public.intake_lock_org(p_org,p_actor);
  if public.intake_member_role(p_org,p_actor)<>'owner' then raise exception 'Only the organization owner can delete intake data' using errcode='42501'; end if;
  insert into public.intake_purged_commands(org_id,actor_id,command_id)
    select org_id,actor_id,command_id from public.intake_commands
    where org_id=p_org and request_id is not null on conflict do nothing;
  delete from public.intake_requests where org_id=p_org;
  -- Messages received for intake hold request text too.
  delete from public.intake_inbound where org_id=p_org;
  insert into public.intake_events(org_id,actor_id,kind)
    select p_org,p_actor,'requests_purged' where exists(select 1 from public.intake_settings where org_id=p_org);
end $$;

-- Browser database roles reach none of it; the API's service role does.
do $$ declare obj record; begin
  for obj in select tablename from pg_tables where schemaname = 'public'
      and tablename in ('intake_automation', 'intake_member_focus', 'intake_inbound') loop
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
