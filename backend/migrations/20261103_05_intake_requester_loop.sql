-- Migration date: 2026-11-03
-- The intake requester loop. MikeGC holds a conversation with the requester
-- in the Slack, Outlook, Gmail or Teams thread a request came from: it asks
-- for missing details on its own (to choose a triage rule, then what the
-- rule's playbook or workflow needs), posts a lawyer's questions, and posts
-- the resolution and chosen documents when a request is resolved. The
-- requester's answers come back onto the request.
--
-- One channel-agnostic layer carries all of it: a request's link to its
-- thread (intake_channel_links), an outbox of requester-facing messages
-- written in the same transaction as the message they carry
-- (intake_outbound), and replies recorded on the request.

-- Where a request came from, and the channels MikeGC talks back in. Requests
-- recorded through Postmark keep 'email'.
alter table public.intake_requests drop constraint if exists intake_requests_source_check;
alter table public.intake_requests add constraint intake_requests_source_check
  check (source in ('manual', 'email', 'slack', 'outlook', 'gmail', 'teams'));

-- Which clarifying stage MikeGC is waiting on: 'rule' (choosing a triage
-- rule) or 'readiness' (what the rule's playbook or workflow needs). Rounds
-- count MikeGC's automatic questions across both stages. A lawyer acting on
-- the request stops MikeGC asking for good.
alter table public.intake_requests add column if not exists clarify_stage text;
alter table public.intake_requests drop constraint if exists intake_requests_clarify_stage_check;
alter table public.intake_requests add constraint intake_requests_clarify_stage_check
  check (clarify_stage is null or clarify_stage in ('rule', 'readiness'));
alter table public.intake_requests add column if not exists clarify_rounds smallint not null default 0;
alter table public.intake_requests drop constraint if exists intake_requests_clarify_rounds_check;
alter table public.intake_requests add constraint intake_requests_clarify_rounds_check
  check (clarify_rounds between 0 and 10);
alter table public.intake_requests add column if not exists clarify_stopped boolean not null default false;
-- The rule's preprocessing the readiness check asked for, {with, condition},
-- so the round after an answer, or a lawyer stopping it, runs the same.
alter table public.intake_requests add column if not exists clarify_preprocess jsonb;
alter table public.intake_requests drop constraint if exists intake_requests_clarify_preprocess_check;
alter table public.intake_requests add constraint intake_requests_clarify_preprocess_check
  check (clarify_preprocess is null or (jsonb_typeof(clarify_preprocess) = 'object'
    and octet_length(clarify_preprocess::text) <= 2000));
-- The queue's New reply flag: a requester's reply after the request was last opened.
alter table public.intake_requests add column if not exists last_reply_at timestamptz;
alter table public.intake_requests add column if not exists reply_seen_at timestamptz;

-- Who wrote a requester's reply: their name, email and channel user ID.
alter table public.intake_messages add column if not exists external_author jsonb;
alter table public.intake_messages drop constraint if exists intake_messages_external_author_check;
alter table public.intake_messages add constraint intake_messages_external_author_check
  check (external_author is null or (jsonb_typeof(external_author) = 'object'
    and octet_length(external_author::text) <= 2000));

alter table public.intake_inbound drop constraint if exists intake_inbound_source_check;
alter table public.intake_inbound add constraint intake_inbound_source_check
  check (source in ('email', 'slack', 'outlook', 'gmail', 'teams'));
-- A new request, or a message in a request's thread.
alter table public.intake_inbound add column if not exists kind text not null default 'request';
alter table public.intake_inbound drop constraint if exists intake_inbound_kind_check;
alter table public.intake_inbound add constraint intake_inbound_kind_check
  check (kind in ('request', 'reply'));

-- Ask requesters for missing details. On by default; off returns triage and
-- preprocessing to recording and working requests without asking.
alter table public.intake_automation add column if not exists clarify_enabled boolean not null default true;
-- The Slack bot token's scopes, read from auth.test, so settings can say
-- when the app needs reinstalling to send documents.
alter table public.intake_automation add column if not exists slack_scopes text[];
alter table public.intake_automation drop constraint if exists intake_automation_slack_scopes_check;
alter table public.intake_automation add constraint intake_automation_slack_scopes_check
  check (slack_scopes is null or cardinality(slack_scopes) <= 100);
-- When a Slack thread message last arrived, so settings can say whether the
-- app is subscribed to message events.
alter table public.intake_automation add column if not exists slack_messages_seen_at timestamptz;

-- A request's thread: one per request, one request per thread. `address`
-- holds what the channel's adapter needs to post there.
create table if not exists public.intake_channel_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  request_id uuid not null unique,
  source text not null check (source in ('slack', 'outlook', 'gmail', 'teams')),
  thread_key text not null check (char_length(thread_key) between 1 and 500),
  address jsonb not null default '{}'::jsonb check (jsonb_typeof(address) = 'object'
    and octet_length(address::text) <= 20000),
  created_at timestamptz not null default now(),
  unique (org_id, source, thread_key),
  foreign key (org_id, request_id) references public.intake_requests(org_id, id) on delete cascade
);

-- Requester-facing messages, written by the RPC that writes the message
-- they carry and sent by the intake.deliver job. `error` is a sentence
-- MikeGC writes from a known failure, never a provider's response.
create table if not exists public.intake_outbound (
  id uuid primary key,
  org_id uuid not null,
  request_id uuid not null,
  link_id uuid not null references public.intake_channel_links(id) on delete cascade,
  -- The question or resolution it carries; null for a bare acknowledgement
  -- and for a resolution sent with documents and no text.
  message_id uuid references public.intake_messages(id) on delete cascade,
  -- The member it is sent for; null for MikeGC's own messages.
  author_id uuid references auth.users(id) on delete set null,
  kind text not null check (kind in ('acknowledgement', 'question', 'answer')),
  -- Up to 10 {document_id, version_id}, each gaining the channel's ID for
  -- it once posted, or left_out when it couldn't be sent.
  documents jsonb not null default '[]'::jsonb check (jsonb_typeof(documents) = 'array'
    and jsonb_array_length(documents) <= 10),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  external_id text check (external_id is null or char_length(external_id) between 1 and 500),
  error text check (error is null or char_length(error) <= 200),
  -- The first time sending was tried, which retries look for an earlier send after.
  attempted_at timestamptz,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  foreign key (org_id, request_id) references public.intake_requests(org_id, id) on delete cascade
);
create index if not exists intake_outbound_request on public.intake_outbound(request_id, created_at);
create index if not exists intake_outbound_message on public.intake_outbound(message_id) where message_id is not null;
create index if not exists intake_outbound_link on public.intake_outbound(link_id);
create index if not exists intake_outbound_author on public.intake_outbound(author_id) where author_id is not null;
-- The stale-work sweep finds messages left pending without a job.
create index if not exists intake_outbound_pending on public.intake_outbound(created_at) where status = 'pending';
-- A request is acknowledged once.
create unique index if not exists intake_outbound_acknowledgement
  on public.intake_outbound(request_id) where kind = 'acknowledgement';

-- The resolution reply a "resolved" change sent, shown with that change.
alter table public.intake_events add column if not exists outbound_id uuid;
alter table public.intake_events drop constraint if exists intake_events_outbound_id_fkey;
alter table public.intake_events add constraint intake_events_outbound_id_fkey
  foreign key (outbound_id) references public.intake_outbound(id) on delete set null;
create index if not exists intake_events_outbound on public.intake_events(outbound_id) where outbound_id is not null;

-- A request's thread is linked once, after it is recorded. A thread already
-- linked to another request is left alone: null.
create or replace function public.intake_link_thread(p_org uuid, p_request uuid, p_source text,
  p_thread_key text, p_address jsonb)
returns uuid language plpgsql set search_path = public, pg_temp as $$
declare link uuid;
begin
  perform 1 from public.organizations where id = p_org and kind in ('team', 'personal')
    and deleted_at is null for update;
  if not found or not exists(select 1 from public.intake_requests where org_id = p_org and id = p_request) then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  select id into link from public.intake_channel_links where org_id = p_org and request_id = p_request;
  if link is not null then return link; end if;
  if exists(select 1 from public.intake_channel_links where org_id = p_org and source = p_source
      and thread_key = p_thread_key) then
    return null;
  end if;
  insert into public.intake_channel_links(org_id, request_id, source, thread_key, address)
    values(p_org, p_request, p_source, p_thread_key, coalesce(p_address, '{}'::jsonb))
    returning id into link;
  return link;
end $$;

-- MikeGC's acknowledgement in the thread, once per request. Returns the
-- outbox row to send while it is still waiting to go, else null.
create or replace function public.intake_acknowledge_automated(p_org uuid, p_request uuid, p_outbound uuid)
returns uuid language plpgsql set search_path = public, pg_temp as $$
declare link uuid; existing public.intake_outbound;
begin
  perform 1 from public.organizations where id = p_org and kind in ('team', 'personal')
    and deleted_at is null for update;
  if not found then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  select id into link from public.intake_channel_links where org_id = p_org and request_id = p_request;
  if link is null then return null; end if;
  select * into existing from public.intake_outbound where request_id = p_request and kind = 'acknowledgement';
  if found then
    return case when existing.status = 'pending' then existing.id end;
  end if;
  insert into public.intake_outbound(id, org_id, request_id, link_id, kind)
    values(p_outbound, p_org, p_request, link, 'acknowledgement');
  return p_outbound;
end $$;

-- MikeGC asks the requester for missing details: a question marked
-- automated, its outbox row, and the request waiting on the requester.
-- The caller names the question and its outbox row, so asking again adds
-- nothing. With p_acknowledge, the questions go in the acknowledgement when
-- it hasn't been sent. False when MikeGC may no longer ask: a lawyer has
-- taken over, the rounds are used up, the request is closed or has no thread.
drop function if exists public.intake_ask_automated(uuid, uuid, uuid, uuid, text, text, boolean);
create or replace function public.intake_ask_automated(p_org uuid, p_request uuid, p_outbound uuid,
  p_message uuid, p_body text, p_stage text, p_acknowledge boolean default false,
  p_preprocess jsonb default null)
returns boolean language plpgsql set search_path = public, pg_temp as $$
declare r public.intake_requests; link uuid; outbound_kind text := 'question';
begin
  perform 1 from public.organizations where id = p_org and kind in ('team', 'personal')
    and deleted_at is null for update;
  if not found then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  select * into r from public.intake_requests where org_id = p_org and id = p_request for update;
  if not found then raise exception 'Request not found' using errcode = 'P0002'; end if;
  if p_message is null or p_outbound is null or p_stage is null or p_stage not in ('rule', 'readiness')
    or p_body is null or char_length(p_body) not between 1 and 20000 or btrim(p_body) = ''
    or (p_preprocess is not null and jsonb_typeof(p_preprocess) <> 'object') then
    raise exception 'Invalid question' using errcode = '22023';
  end if;
  if exists(select 1 from public.intake_messages where id = p_message) then return true; end if;
  select id into link from public.intake_channel_links where org_id = p_org and request_id = p_request;
  if link is null or r.clarify_stopped or r.clarify_rounds >= 2
    or r.state in ('resolved', 'cancelled') then
    return false;
  end if;
  if coalesce(p_acknowledge, false) and not exists(select 1 from public.intake_outbound
      where request_id = p_request and kind = 'acknowledgement') then
    outbound_kind := 'acknowledgement';
  end if;
  insert into public.intake_messages(id, org_id, request_id, author_id, kind, body, automated)
    values(p_message, p_org, p_request, null, 'question', p_body, true);
  insert into public.intake_outbound(id, org_id, request_id, link_id, message_id, kind)
    values(p_outbound, p_org, p_request, link, p_message, outbound_kind);
  update public.intake_requests set clarify_stage = p_stage, clarify_rounds = clarify_rounds + 1,
    clarify_preprocess = coalesce(p_preprocess, clarify_preprocess),
    state = 'needs_information', version = version + 1, updated_at = now() where id = p_request;
  if r.state <> 'needs_information' then
    insert into public.intake_events(org_id, request_id, actor_id, kind, from_state, to_state, assignee_id, automated)
      values(p_org, p_request, null, 'wait', r.state, 'needs_information', r.assignee_id, true);
  end if;
  return true;
end $$;

-- The stage MikeGC was waiting on has what it needs, or no rounds are left:
-- the request returns to where it would be (New or In progress), assigned to
-- the rule's member when the rule stage settles. False when the request is no
-- longer waiting on that stage, as when a lawyer has taken over.
create or replace function public.intake_settle_clarify_automated(p_org uuid, p_request uuid, p_stage text,
  p_assign boolean default false, p_assignee uuid default null)
returns boolean language plpgsql set search_path = public, pg_temp as $$
declare r public.intake_requests; next_assignee uuid; next_state text;
begin
  perform 1 from public.organizations where id = p_org and kind in ('team', 'personal')
    and deleted_at is null for update;
  if not found then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  select * into r from public.intake_requests where org_id = p_org and id = p_request for update;
  if not found then raise exception 'Request not found' using errcode = 'P0002'; end if;
  if r.clarify_stage is distinct from p_stage then return false; end if;
  next_assignee := r.assignee_id;
  if coalesce(p_assign, false) then
    next_assignee := case when p_assignee is not null and public.intake_member_role(p_org, p_assignee) is not null
      then p_assignee else r.assignee_id end;
  end if;
  next_state := case when r.state = 'needs_information'
    then case when next_assignee is null then 'submitted' else 'in_review' end else r.state end;
  update public.intake_requests set clarify_stage = null, assignee_id = next_assignee, state = next_state,
    version = version + 1, updated_at = now() where id = p_request;
  if next_assignee is distinct from r.assignee_id then
    insert into public.intake_events(org_id, request_id, actor_id, kind, from_state, to_state, assignee_id, automated)
      values(p_org, p_request, null, 'assign', r.state, next_state, next_assignee, true);
  elsif next_state <> r.state then
    insert into public.intake_events(org_id, request_id, actor_id, kind, from_state, to_state, assignee_id, automated)
      values(p_org, p_request, null, 'resume', r.state, next_state, next_assignee, true);
  end if;
  return true;
end $$;

-- A requester's message in a request's thread, recorded once as a reply. An
-- answer to a lawyer's question moves the request back to work; an answer
-- to MikeGC's leaves the stage that asked to decide; a message on a closed
-- request is only recorded. Every reply raises the queue's New reply flag.
-- Returns what the reply job needs, or null when the request is gone.
create or replace function public.intake_reply_automated(p_org uuid, p_inbound uuid, p_message uuid,
  p_body text, p_author jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare i public.intake_inbound; r public.intake_requests; next_state text;
begin
  perform 1 from public.organizations where id = p_org and kind in ('team', 'personal')
    and deleted_at is null for update;
  if not found then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  select * into i from public.intake_inbound where id = p_inbound and org_id = p_org for update;
  if not found or i.kind <> 'reply' then raise exception 'Message not found' using errcode = 'P0002'; end if;
  if i.request_id is null then return null; end if;
  select * into r from public.intake_requests where org_id = p_org and id = i.request_id for update;
  if not found then return null; end if;
  if p_message is null or p_body is null or char_length(p_body) not between 1 and 20000 or btrim(p_body) = ''
    or (p_author is not null and (jsonb_typeof(p_author) <> 'object' or octet_length(p_author::text) > 2000)) then
    raise exception 'Invalid reply' using errcode = '22023';
  end if;
  if not exists(select 1 from public.intake_messages where id = p_message) then
    insert into public.intake_messages(id, org_id, request_id, author_id, kind, body, external_author)
      values(p_message, p_org, r.id, null, 'reply', p_body, p_author);
    next_state := r.state;
    if r.state = 'needs_information' and r.clarify_stage is null then
      next_state := case when r.assignee_id is null then 'submitted' else 'in_review' end;
      insert into public.intake_events(org_id, request_id, actor_id, kind, from_state, to_state, assignee_id, automated)
        values(p_org, r.id, null, 'resume', r.state, next_state, r.assignee_id, true);
    end if;
    update public.intake_requests set state = next_state, last_reply_at = clock_timestamp(), updated_at = now(),
      version = version + case when next_state <> r.state then 1 else 0 end
      where id = r.id
      returning * into r;
  end if;
  return jsonb_build_object('request_id', r.id, 'message_id', p_message, 'state', r.state,
    'assignee_id', r.assignee_id, 'clarify_stage', r.clarify_stage, 'clarify_rounds', r.clarify_rounds,
    'clarify_stopped', r.clarify_stopped, 'clarify_preprocess', r.clarify_preprocess);
end $$;

-- What the intake.deliver job learned. 'pending' records progress, such as
-- the documents already posted, without finishing.
create or replace function public.intake_record_delivery(p_org uuid, p_outbound uuid, p_status text,
  p_external_id text default null, p_error text default null, p_documents jsonb default null)
returns boolean language plpgsql set search_path = public, pg_temp as $$
begin
  if p_status is null or p_status not in ('pending', 'sent', 'failed')
    or (p_error is not null and char_length(p_error) > 200)
    or (p_documents is not null and (jsonb_typeof(p_documents) <> 'array' or jsonb_array_length(p_documents) > 10)) then
    raise exception 'Invalid delivery' using errcode = '22023';
  end if;
  update public.intake_outbound set status = p_status,
    external_id = coalesce(p_external_id, external_id),
    error = case when p_status = 'failed' then coalesce(p_error, 'MikeGC couldn''t send this message.') else null end,
    documents = coalesce(p_documents, documents),
    attempted_at = coalesce(attempted_at, now()),
    sent_at = case when p_status = 'sent' then coalesce(sent_at, now()) else sent_at end
    where org_id = p_org and id = p_outbound;
  return found;
end $$;

-- A member sends a message that couldn't be sent again.
create or replace function public.intake_retry_delivery(p_org uuid, p_actor uuid, p_request uuid, p_outbound uuid)
returns boolean language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.organizations where id = p_org for share;
  if not public.intake_can_read(p_org, p_actor, p_request) then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  update public.intake_outbound set status = 'pending', error = null
    where org_id = p_org and request_id = p_request and id = p_outbound and status = 'failed';
  if found then return true; end if;
  if not exists(select 1 from public.intake_outbound where org_id = p_org and request_id = p_request and id = p_outbound) then
    raise exception 'Message not found' using errcode = 'P0002';
  end if;
  return false;
end $$;

drop function if exists public.intake_mark_reply_seen(uuid, uuid, uuid);
-- Opening a request clears its New reply flag, up to the reply the page
-- showed (p_seen, its last_reply_at), so a reply arriving meanwhile stays new.
create or replace function public.intake_mark_reply_seen(p_org uuid, p_actor uuid, p_request uuid,
  p_seen timestamptz default null)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.organizations where id = p_org for share;
  if not public.intake_can_read(p_org, p_actor, p_request) then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  update public.intake_requests set reply_seen_at = least(coalesce(p_seen, now()), now())
    where org_id = p_org and id = p_request and last_reply_at is not null
      and (reply_seen_at is null or reply_seen_at < least(coalesce(p_seen, now()), now()));
end $$;

-- A document MikeGC made from an attachment, linked to its request and, for
-- a requester's reply, to that reply. Linking it again is a no-op.
drop function if exists public.intake_attach_automated(uuid, uuid, uuid);
create or replace function public.intake_attach_automated(p_org uuid, p_request uuid, p_document uuid,
  p_message uuid default null)
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
  if p_message is not null and not exists(select 1 from public.intake_messages where id = p_message
      and org_id = p_org and request_id = p_request and kind = 'reply') then
    raise exception 'Reply not found' using errcode = 'P0002';
  end if;
  if exists(select 1 from public.intake_request_documents
      where document_id = p_document and request_id <> p_request) then
    raise exception 'The document belongs to another request' using errcode = '22023';
  end if;
  insert into public.intake_request_documents(org_id, request_id, document_id, added_by, automated, message_id)
    values(p_org, p_request, p_document, null, true, p_message) on conflict do nothing;
  if found and p_message is not null then
    update public.intake_requests set updated_at = now() where id = p_request;
  end if;
end $$;

-- Internal common transaction boundary for every state and activity change.
-- With p_send, a lawyer's question ('wait') or resolution ('resolve', with
-- up to 10 of the request's documents) is also written to the outbox for
-- the request's thread. Every change but a note clears the stage MikeGC was
-- asking in and stops it asking; stopping a readiness stage while the
-- request stays open asks the caller to run preprocessing now.
drop function if exists public.intake_change_request(uuid, uuid, uuid, uuid, integer, text, text, uuid);
create or replace function public.intake_change_request(p_org uuid, p_actor uuid, p_command uuid, p_request uuid,
  p_version integer, p_action text, p_body text default null, p_assignee uuid default null,
  p_send boolean default false, p_documents uuid[] default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare r public.intake_requests; input jsonb; replay jsonb; next_state text; next_assignee uuid; mid uuid; open boolean;
  send boolean := coalesce(p_send, false); link uuid; oid uuid; docs jsonb := '[]'::jsonb; found_docs integer;
  receipt jsonb; extra jsonb := '{}'::jsonb;
begin
  perform public.intake_lock_org(p_org, p_actor);
  if not public.intake_can_read(p_org, p_actor, p_request) then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  input := jsonb_build_object('id', p_request, 'version', p_version, 'body', p_body, 'assignee', p_assignee);
  -- Only a sent message adds to the input, so earlier receipts still replay.
  if send then
    input := input || jsonb_build_object('send', true, 'documents', to_jsonb(coalesce(p_documents, '{}'::uuid[])));
  end if;
  -- Resolve committed operations before checking state the original operation
  -- itself may have changed.
  replay := public.intake_replay(p_org, p_actor, p_command, p_action, input);
  if replay is not null then return replay; end if;
  if p_action is null or p_action not in ('assign', 'note', 'wait', 'resume', 'resolve', 'cancel', 'reopen', 'stop_asking')
    or (p_action <> 'assign' and p_assignee is not null)
    or (p_action in ('assign', 'reopen', 'stop_asking') and p_body is not null)
    -- A resolution's text is optional; a cancellation still needs its reason.
    or (p_action in ('note', 'cancel') and p_body is null)
    or (send and p_action not in ('wait', 'resolve'))
    -- A question sent to the requester needs its text.
    or (send and p_action = 'wait' and p_body is null)
    or (p_documents is not null and (not send or p_action <> 'resolve' or cardinality(p_documents) > 10))
  then
    raise exception 'Invalid command' using errcode = '22023';
  end if;
  if p_body is not null and (char_length(p_body) not between 1 and 20000 or btrim(p_body) = '') then
    raise exception 'Enter at most 20000 characters' using errcode = '22023';
  end if;
  select * into r from public.intake_requests where org_id = p_org and id = p_request for update;
  -- Notes leave the request itself unchanged, so they never conflict.
  if p_action <> 'note' and (p_version is null or r.version <> p_version) then
    raise exception 'Request changed; reload it' using errcode = 'P0001';
  end if;
  open := r.state not in ('resolved', 'cancelled');
  next_state := r.state;
  next_assignee := r.assignee_id;
  if (p_action in ('assign', 'resolve', 'cancel') and not open)
    -- A question can follow another while the request waits on the requester.
    or (p_action = 'wait' and not (r.state in ('submitted', 'in_review')
      or (send and r.state = 'needs_information')))
    or (p_action = 'resume' and r.state <> 'needs_information')
    or (p_action = 'reopen' and open)
    or (p_action = 'stop_asking' and (r.clarify_stage is null or not open))
  then
    raise exception 'Request changed; reload it' using errcode = 'P0001';
  end if;
  if send then
    select id into link from public.intake_channel_links where org_id = p_org and request_id = p_request;
    if link is null then
      raise exception 'The request has no thread to send to' using errcode = '22023';
    end if;
  end if;
  if p_documents is not null and cardinality(p_documents) > 0 then
    if (select count(distinct d) from unnest(p_documents) d) <> cardinality(p_documents) then
      raise exception 'Choose each document once' using errcode = '22023';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('document_id', d.id, 'version_id', d.current_version_id)
        order by x.ord), '[]'::jsonb), count(*)
      into docs, found_docs
      from unnest(p_documents) with ordinality as x(id, ord)
      join public.intake_request_documents l on l.document_id = x.id and l.org_id = p_org and l.request_id = p_request
      join public.documents d on d.id = x.id and d.current_version_id is not null;
    if found_docs <> cardinality(p_documents) then
      raise exception 'Choose documents of this request' using errcode = '22023';
    end if;
  end if;
  if p_action = 'assign' then
    if p_assignee is not null and public.intake_member_role(p_org, p_assignee) is null then
      raise exception 'Choose a current member of your organization' using errcode = '22023';
    end if;
    next_assignee := p_assignee;
    if r.state in ('submitted', 'in_review') then
      next_state := case when p_assignee is null then 'submitted' else 'in_review' end;
    end if;
  elsif p_action = 'wait' then
    next_state := 'needs_information';
  elsif p_action in ('resume', 'stop_asking') then
    next_state := case when r.state <> 'needs_information' then r.state
      when r.assignee_id is null then 'submitted' else 'in_review' end;
  elsif p_action = 'resolve' then
    next_state := 'resolved';
  elsif p_action = 'cancel' then
    next_state := 'cancelled';
  elsif p_action = 'reopen' then
    if r.assignee_id is not null and public.intake_member_role(p_org, r.assignee_id) is null then
      next_assignee := null;
    end if;
    next_state := case when next_assignee is null then 'submitted' else 'in_review' end;
  end if;
  if p_body is not null then
    insert into public.intake_messages(org_id, request_id, author_id, kind, body)
      values(p_org, p_request, p_actor,
        case when p_action = 'resolve' then 'resolution' when p_action = 'cancel' then 'cancel_reason'
          when p_action = 'wait' and send then 'question' else 'note' end, p_body)
      returning id into mid;
  end if;
  -- Nothing to send: a resolution with no text and no documents.
  if send and (mid is not null or jsonb_array_length(docs) > 0) then
    oid := gen_random_uuid();
    insert into public.intake_outbound(id, org_id, request_id, link_id, message_id, author_id, kind, documents)
      values(oid, p_org, p_request, link, mid, p_actor,
        case when p_action = 'wait' then 'question' else 'answer' end, docs);
  end if;
  if p_action = 'note' then
    update public.intake_requests set updated_at = now(),
      reply_seen_at = case when last_reply_at is null then reply_seen_at else now() end
      where id = p_request;
    return public.intake_record_command(p_org, p_actor, p_command, p_request, p_action, input, r.version, mid);
  end if;
  update public.intake_requests set state = next_state, assignee_id = next_assignee,
    clarify_stage = null, clarify_stopped = true,
    reply_seen_at = case when last_reply_at is null then reply_seen_at else now() end,
    version = version + 1, updated_at = now() where id = p_request;
  insert into public.intake_events(org_id, request_id, actor_id, kind, from_state, to_state, assignee_id, message_id,
      outbound_id)
    values(p_org, p_request, p_actor, p_action, r.state, next_state, next_assignee, mid,
      case when p_action = 'resolve' then oid end);
  receipt := public.intake_record_command(p_org, p_actor, p_command, p_request, p_action, input, r.version + 1, mid);
  extra := jsonb_build_object('outbound_id', oid,
    'preprocess', r.clarify_stage = 'readiness' and next_state not in ('resolved', 'cancelled'));
  update public.intake_commands c set result = c.result || extra
    where c.org_id = p_org and c.actor_id = p_actor and c.command_id = p_command;
  return receipt || extra;
end $$;

create or replace function public.intake_assign_request(p_org uuid, p_actor uuid, p_command uuid, p_request uuid, p_version integer, p_assignee uuid)
returns jsonb language sql set search_path = public, pg_temp as $$
  select public.intake_change_request(p_org, p_actor, p_command, p_request, p_version, 'assign', null, p_assignee)
$$;

create or replace function public.intake_note_request(p_org uuid, p_actor uuid, p_command uuid, p_request uuid, p_body text)
returns jsonb language sql set search_path = public, pg_temp as $$
  select public.intake_change_request(p_org, p_actor, p_command, p_request, null, 'note', p_body, null)
$$;

drop function if exists public.intake_wait_request(uuid, uuid, uuid, uuid, integer, text);
create or replace function public.intake_wait_request(p_org uuid, p_actor uuid, p_command uuid, p_request uuid, p_version integer,
  p_body text default null, p_send boolean default false)
returns jsonb language sql set search_path = public, pg_temp as $$
  select public.intake_change_request(p_org, p_actor, p_command, p_request, p_version, 'wait', p_body, null, p_send, null)
$$;

create or replace function public.intake_resume_request(p_org uuid, p_actor uuid, p_command uuid, p_request uuid, p_version integer, p_body text default null)
returns jsonb language sql set search_path = public, pg_temp as $$
  select public.intake_change_request(p_org, p_actor, p_command, p_request, p_version, 'resume', p_body, null)
$$;

drop function if exists public.intake_resolve_request(uuid, uuid, uuid, uuid, integer, text);
create or replace function public.intake_resolve_request(p_org uuid, p_actor uuid, p_command uuid, p_request uuid, p_version integer,
  p_body text, p_send boolean default false, p_documents uuid[] default null)
returns jsonb language sql set search_path = public, pg_temp as $$
  select public.intake_change_request(p_org, p_actor, p_command, p_request, p_version, 'resolve', p_body, null,
    p_send, p_documents)
$$;

create or replace function public.intake_cancel_request(p_org uuid, p_actor uuid, p_command uuid, p_request uuid, p_version integer, p_body text)
returns jsonb language sql set search_path = public, pg_temp as $$
  select public.intake_change_request(p_org, p_actor, p_command, p_request, p_version, 'cancel', p_body, null)
$$;

create or replace function public.intake_reopen_request(p_org uuid, p_actor uuid, p_command uuid, p_request uuid, p_version integer)
returns jsonb language sql set search_path = public, pg_temp as $$
  select public.intake_change_request(p_org, p_actor, p_command, p_request, p_version, 'reopen', null, null)
$$;

-- A lawyer stops MikeGC asking the requester: the request returns to work.
create or replace function public.intake_stop_asking_request(p_org uuid, p_actor uuid, p_command uuid, p_request uuid, p_version integer)
returns jsonb language sql set search_path = public, pg_temp as $$
  select public.intake_change_request(p_org, p_actor, p_command, p_request, p_version, 'stop_asking', null, null)
$$;

create or replace function public.intake_edit_request(p_org uuid, p_actor uuid, p_command uuid, p_request uuid, p_version integer,
  p_subject text, p_description text, p_requester_name text, p_requester_email text default null,
  p_requester_team text default null, p_date date default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare r public.intake_requests; input jsonb; replay jsonb; receipt jsonb; extra jsonb; next_state text;
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
  -- Editing stops MikeGC asking; a request only it was waiting on goes back
  -- to work, as Stop asking does.
  next_state := case when r.clarify_stage is not null and r.state = 'needs_information'
    then case when r.assignee_id is null then 'submitted' else 'in_review' end else r.state end;
  update public.intake_requests set subject = p_subject, description = p_description,
    requester_name = p_requester_name, requester_email = p_requester_email, requester_team = p_requester_team,
    requested_by_date = p_date, clarify_stage = null, clarify_stopped = true, state = next_state,
    reply_seen_at = case when last_reply_at is null then reply_seen_at else now() end,
    version = version + 1, updated_at = now()
    where id = p_request;
  insert into public.intake_events(org_id, request_id, actor_id, kind, from_state, to_state, assignee_id)
    values(p_org, p_request, p_actor, 'edited', r.state, r.state, r.assignee_id);
  if next_state <> r.state then
    insert into public.intake_events(org_id, request_id, actor_id, kind, from_state, to_state, assignee_id)
      values(p_org, p_request, p_actor, 'stop_asking', r.state, next_state, r.assignee_id);
  end if;
  receipt := public.intake_record_command(p_org, p_actor, p_command, p_request, 'edit', input, r.version + 1);
  extra := jsonb_build_object('outbound_id', null, 'preprocess', r.clarify_stage = 'readiness');
  update public.intake_commands c set result = c.result || extra
    where c.org_id = p_org and c.actor_id = p_actor and c.command_id = p_command;
  return receipt || extra;
end $$;

-- A request's thread, as the request page shows where a message goes.
create or replace function public.intake_conversation(r public.intake_requests)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('source', l.source,
    'channel_name', l.address->>'channel_name', 'team_name', l.address->>'team_name',
    'permalink', l.address->>'permalink',
    'mailbox', l.address->>'mailbox', 'to', coalesce(l.address->'to', '[]'::jsonb),
    'cc', coalesce(l.address->'cc', '[]'::jsonb),
    'max_attachment_bytes', (l.address->>'max_attachment_bytes')::bigint,
    -- Whether the channel can take documents: a Slack app without
    -- files:write, or Teams without document access, posts text only.
    'documents', case l.source
      when 'slack' then coalesce('files:write' = any(a.slack_scopes), true)
      when 'teams' then coalesce((to_jsonb(a) ->> 'teams_files_access')::boolean, false)
      else true end)
  from public.intake_channel_links l
  left join public.intake_automation a on a.org_id = l.org_id
  where l.request_id = r.id
$$;

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
    'clarify_stage', r.clarify_stage, 'clarify_rounds', r.clarify_rounds, 'clarify_max_rounds', 2,
    'new_reply', r.last_reply_at is not null and (r.reply_seen_at is null or r.reply_seen_at < r.last_reply_at),
    'last_reply_at', r.last_reply_at,
    'conversation', public.intake_conversation(r),
    'capabilities', jsonb_build_object(
      'edit', r.state not in ('resolved', 'cancelled'),
      'assign', r.state not in ('resolved', 'cancelled'),
      'note', true,
      'wait', r.state in ('submitted', 'in_review'),
      'resume', r.state = 'needs_information',
      'resolve', r.state not in ('resolved', 'cancelled'),
      'cancel', r.state not in ('resolved', 'cancelled'),
      'reopen', r.state in ('resolved', 'cancelled'),
      'delete', true,
      'send_to_requester', r.state not in ('resolved', 'cancelled')
        and exists(select 1 from public.intake_channel_links l where l.request_id = r.id),
      'stop_asking', r.clarify_stage is not null and r.state not in ('resolved', 'cancelled')))
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
    'clarify_stage', r.clarify_stage,
    'new_reply', r.last_reply_at is not null and (r.reply_seen_at is null or r.reply_seen_at < r.last_reply_at),
    'capabilities', jsonb_build_object(
      'assign', r.state not in ('resolved', 'cancelled'),
      'cancel', r.state not in ('resolved', 'cancelled'),
      'delete', true))
$$;

-- Keyset pages: a request created or updated between pages is never repeated.
-- p_assignee is null (everyone), 'unassigned', 'me' or a member's user ID.
-- p_requester is null (everyone) or one requester's name, matched without case.
-- p_timezone is the viewer's, which the overdue scope is judged in.
-- p_new_reply keeps only requests with a reply nobody has opened yet.
drop function if exists public.intake_list_requests(uuid, uuid, text, text, text, text, text, uuid, text, text, integer, text);
create or replace function public.intake_list_requests(p_org uuid, p_actor uuid, p_state text default null,
  p_assignee text default null, p_search text default '', p_sort text default 'updated',
  p_after_key text default null, p_after_id uuid default null, p_scope text default null,
  p_requester text default null, p_limit integer default 50, p_timezone text default 'UTC',
  p_new_reply boolean default false)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare unassigned boolean; assignee uuid; after_at timestamptz; after_date date;
  page jsonb; more boolean; last jsonb; replies boolean := coalesce(p_new_reply, false);
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
          and (not replies or (r.last_reply_at is not null and (r.reply_seen_at is null or r.reply_seen_at < r.last_reply_at)))
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
          and (not replies or (r.last_reply_at is not null and (r.reply_seen_at is null or r.reply_seen_at < r.last_reply_at)))
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
          and (not replies or (r.last_reply_at is not null and (r.reply_seen_at is null or r.reply_seen_at < r.last_reply_at)))
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

-- How a requester-facing message is going, with the documents it carries.
create or replace function public.intake_delivery(o public.intake_outbound)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('outbound_id', o.id, 'kind', o.kind, 'status', o.status, 'error', o.error,
    'sent_at', o.sent_at,
    'documents', coalesce((select jsonb_agg(jsonb_build_object(
        'document_id', d->>'document_id',
        'filename', coalesce(v.filename, 'Document'),
        'left_out', coalesce((d->>'left_out')::boolean, false)) order by x.ord)
      from jsonb_array_elements(o.documents) with ordinality as x(d, ord)
      left join public.document_versions v on v.id = (d->>'version_id')::uuid), '[]'::jsonb))
$$;

-- System changes have no actor; erased people read as former members. A
-- requester's reply reads as its author; a message sent to the requester
-- says how its delivery is going.
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
        case when e.assignee_id is null then null else coalesce(a.display_name, a.email, 'Former member') end as assignee_name,
        (select public.intake_delivery(o) from public.intake_outbound o where o.id = e.outbound_id) as delivery
      from public.intake_events e
      left join public.user_profiles u on u.user_id = e.actor_id
      left join public.user_profiles a on a.user_id = e.assignee_id
      where e.org_id = p_org and e.request_id = p_request
      order by e.id offset p_offset limit p_limit) x);
  end if;
  return (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at, x.id), '[]') from (
    select m.id, m.kind, m.body, m.created_at, m.author_id, m.automated,
      case when m.automated then 'MikeGC'
        when m.kind = 'reply' and m.author_id is null then coalesce(nullif(btrim(m.external_author->>'name'), ''),
          nullif(btrim(m.external_author->>'email'), ''), 'The requester')
        else coalesce(u.display_name, u.email, 'Former member') end as author_name,
      m.external_author,
      case when m.kind = 'question' then (select public.intake_delivery(o) from public.intake_outbound o
        where o.message_id = m.id order by o.created_at limit 1) end as delivery
    from public.intake_messages m left join public.user_profiles u on u.user_id = m.author_id
    where m.org_id = p_org and m.request_id = p_request
    order by m.created_at, m.id offset p_offset limit p_limit) x);
end $$;

-- A request's documents. `revised` marks one whose current version is newer
-- than the one it arrived as, such as MikeGC's redline after a lawyer
-- accepted its changes: the resolution reply ticks those by default.
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
      'message_id', l.message_id,
      'revised', d.current_version_id is not null and d.current_version_id is distinct from
        (select f.id from public.document_versions f where f.document_id = d.id order by f.created_at, f.id limit 1))
      order by l.created_at, d.id), '[]')
    from public.intake_request_documents l
    join public.documents d on d.id = l.document_id
    left join public.document_versions v on v.id = d.current_version_id and v.deleted_at is null
    left join public.user_profiles u on u.user_id = l.added_by
    where l.org_id = p_org and l.request_id = p_request);
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
