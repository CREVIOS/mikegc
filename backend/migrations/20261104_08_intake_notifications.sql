-- Migration date: 2026-11-04
-- Toast notifications for the member a request is assigned to: a request that
-- became theirs ("New Intake Request"), or a change someone else made to one
-- that is ("Intake request update"). The web app collects them while it is
-- open, which deletes them.

-- A notification names what happened only by reference, so deleting the
-- request, its history entry or message, the organization or the recipient's
-- account deletes it, and names are read when it is collected.
create table if not exists public.intake_notifications (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.intake_settings(org_id) on delete cascade,
  request_id uuid not null,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('new_request', 'update')),
  event_id bigint references public.intake_events(id) on delete cascade,
  message_id uuid references public.intake_messages(id) on delete cascade,
  -- The change's transaction time, shared by everything one change wrote.
  created_at timestamptz not null default now(),
  check ((event_id is null) <> (message_id is null)),
  foreign key (org_id, request_id) references public.intake_requests(org_id, id) on delete cascade
);
create index if not exists intake_notifications_recipient on public.intake_notifications(recipient_id, id);
create index if not exists intake_notifications_request on public.intake_notifications(org_id, request_id);
create index if not exists intake_notifications_event on public.intake_notifications(event_id)
  where event_id is not null;
create index if not exists intake_notifications_message on public.intake_notifications(message_id)
  where message_id is not null;
create index if not exists intake_notifications_created on public.intake_notifications(created_at);

-- A history entry tells the member the request is assigned to once it is
-- made, unless they made it. A request that became theirs is new to them;
-- anything else is an update. A member leaving and an account's erasure
-- unassign without telling anyone. Those write history as the trusted owner
-- (GoTrue account deletion runs as supabase_auth_admin), so this does too.
create or replace function public.intake_notify_event()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare recipient uuid;
begin
  if new.request_id is null or new.kind not in ('submitted', 'assign', 'wait', 'resume', 'resolve',
      'cancel', 'reopen', 'stop_asking', 'edited', 'document_added') then
    return null;
  end if;
  select assignee_id into recipient from public.intake_requests
    where org_id = new.org_id and id = new.request_id;
  if recipient is null or recipient is not distinct from new.actor_id then return null; end if;
  insert into public.intake_notifications(org_id, request_id, recipient_id, kind, event_id)
    values(new.org_id, new.request_id, recipient,
      case when new.kind in ('submitted', 'assign') then 'new_request' else 'update' end, new.id);
  return null;
end $$;
drop trigger if exists intake_notify_event on public.intake_events;
create trigger intake_notify_event after insert on public.intake_events
  for each row execute function public.intake_notify_event();

-- A requester's reply, and a note by anyone but the assignee, MikeGC's
-- preprocessing included. Other messages come with a status change, whose
-- history entry reports it.
create or replace function public.intake_notify_message()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare recipient uuid;
begin
  if new.kind not in ('note', 'reply') then return null; end if;
  select assignee_id into recipient from public.intake_requests
    where org_id = new.org_id and id = new.request_id;
  if recipient is null or recipient is not distinct from new.author_id then return null; end if;
  insert into public.intake_notifications(org_id, request_id, recipient_id, kind, message_id)
    values(new.org_id, new.request_id, recipient, 'update', new.id);
  return null;
end $$;
drop trigger if exists intake_notify_message on public.intake_messages;
create trigger intake_notify_message after insert on public.intake_messages
  for each row execute function public.intake_notify_message();

-- A member who leaves an organization has nothing more to hear about its
-- requests. GoTrue account deletion cascades here as supabase_auth_admin, so
-- the trigger runs as its trusted owner, like intake_member_departure.
create or replace function public.intake_notification_departure()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  delete from public.intake_notifications where recipient_id = old.user_id and org_id = old.org_id;
  return old;
end $$;
drop trigger if exists intake_notification_departure on public.org_members;
create trigger intake_notification_departure after delete on public.org_members
  for each row execute function public.intake_notification_departure();

-- Hands a member the notifications waiting for them, oldest first, and
-- deletes them, so each is shown once, by whichever of their tabs asks first.
-- One for a request no longer assigned to them, in a workspace they no longer
-- belong to, or older than a day is deleted without being shown; so is a note
-- written with a status change, which the change's own entry reports. A
-- personal workspace is named "personal", never by its organization's ID.
create or replace function public.intake_claim_notifications(p_actor uuid, p_limit integer default 200)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare result jsonb;
begin
  if p_actor is null or p_limit is null or p_limit not between 1 and 500 then
    raise exception 'Invalid notification claim' using errcode = '22023';
  end if;
  with claimed as (
    delete from public.intake_notifications
      where id in (select id from public.intake_notifications where recipient_id = p_actor
        order by id limit p_limit for update skip locked)
      returning *
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id,
      'workspace', case when o.kind = 'personal' then 'personal' else o.id::text end,
      'workspace_name', case when o.kind = 'personal' then 'Personal' else o.name end,
      'request_id', r.id,
      'subject', r.subject,
      'kind', c.kind,
      'change', case when e.id is not null then e.kind
        when m.purpose = 'preprocessing' then 'preprocessing' else m.kind end,
      'actor_name', case
        when e.id is not null then
          (select coalesce(u.display_name, u.email) from public.user_profiles u where u.user_id = e.actor_id)
        when m.author_id is null and m.kind = 'reply' then
          coalesce(nullif(btrim(m.external_author->>'name'), ''), nullif(btrim(m.external_author->>'email'), ''))
        else (select coalesce(u.display_name, u.email) from public.user_profiles u where u.user_id = m.author_id) end,
      'automated', coalesce(e.automated, m.automated, false),
      'channel', m.external_author->>'source',
      'created_at', c.created_at) order by c.id), '[]'::jsonb)
    into result
    from claimed c
    join public.intake_requests r on r.org_id = c.org_id and r.id = c.request_id
    join public.organizations o on o.id = c.org_id
    left join public.intake_events e on e.id = c.event_id
    left join public.intake_messages m on m.id = c.message_id
    where r.assignee_id = p_actor
      and c.created_at > now() - interval '1 day'
      and public.intake_member_role(c.org_id, p_actor) is not null
      and not (c.message_id is not null
        and exists(select 1 from public.intake_events x where x.message_id = c.message_id));
  return result;
end $$;

-- Notifications nobody collected within a day are never shown; the
-- stale-work sweep deletes them.
create or replace function public.intake_expire_notifications()
returns integer language plpgsql set search_path = public, pg_temp as $$
declare removed integer;
begin
  delete from public.intake_notifications where created_at < now() - interval '1 day';
  get diagnostics removed = row_count;
  return removed;
end $$;

-- New tables and functions start with default grants; only the backend's
-- service role may use them.
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
grant usage,select on sequence public.intake_notifications_id_seq to service_role;
