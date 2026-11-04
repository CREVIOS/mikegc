-- Migration date: 2026-11-04
-- A resolution's reply to the requester is written apart from the internal
-- resolution: the resolve command takes it as p_reply, stores it as an
-- 'answer' message, and sends only it, with any documents. The resolution
-- itself stays in the app.

drop function if exists public.intake_change_request(uuid, uuid, uuid, uuid, integer, text, text, uuid, boolean, uuid[]);
create or replace function public.intake_change_request(p_org uuid, p_actor uuid, p_command uuid, p_request uuid,
  p_version integer, p_action text, p_body text default null, p_assignee uuid default null,
  p_send boolean default false, p_documents uuid[] default null, p_reply text default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare r public.intake_requests; input jsonb; replay jsonb; next_state text; next_assignee uuid; mid uuid; open boolean;
  send boolean := coalesce(p_send, false); link uuid; oid uuid; docs jsonb := '[]'::jsonb; found_docs integer;
  receipt jsonb; extra jsonb := '{}'::jsonb; reply_mid uuid;
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
  if p_reply is not null then
    input := input || jsonb_build_object('reply', p_reply);
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
    -- A resolution's reply is its own text, sent in place of the resolution.
    or (p_reply is not null and (not send or p_action <> 'resolve'))
  then
    raise exception 'Invalid command' using errcode = '22023';
  end if;
  if (p_body is not null and (char_length(p_body) not between 1 and 20000 or btrim(p_body) = ''))
    or (p_reply is not null and (char_length(p_reply) not between 1 and 20000 or btrim(p_reply) = '')) then
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
  -- The reply a resolution sends: written apart from the internal resolution,
  -- which stays in the app.
  if p_reply is not null then
    insert into public.intake_messages(org_id, request_id, author_id, kind, body)
      values(p_org, p_request, p_actor, 'answer', p_reply)
      returning id into reply_mid;
  end if;
  -- A question sends its text; a resolution only its reply and documents,
  -- and nothing when it has neither.
  if send and ((p_action = 'wait' and mid is not null)
      or (p_action = 'resolve' and (reply_mid is not null or jsonb_array_length(docs) > 0))) then
    oid := gen_random_uuid();
    insert into public.intake_outbound(id, org_id, request_id, link_id, message_id, author_id, kind, documents)
      values(oid, p_org, p_request, link, case when p_action = 'wait' then mid else reply_mid end, p_actor,
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

drop function if exists public.intake_resolve_request(uuid, uuid, uuid, uuid, integer, text, boolean, uuid[]);
create or replace function public.intake_resolve_request(p_org uuid, p_actor uuid, p_command uuid, p_request uuid, p_version integer,
  p_body text, p_send boolean default false, p_documents uuid[] default null, p_reply text default null)
returns jsonb language sql set search_path = public, pg_temp as $$
  select public.intake_change_request(p_org, p_actor, p_command, p_request, p_version, 'resolve', p_body, null,
    p_send, p_documents, p_reply)
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
      -- A question, or a resolution's reply, sent to the requester.
      case when m.kind in ('question', 'answer') then (select public.intake_delivery(o) from public.intake_outbound o
        where o.message_id = m.id order by o.created_at limit 1) end as delivery
    from public.intake_messages m left join public.user_profiles u on u.user_id = m.author_id
    where m.org_id = p_org and m.request_id = p_request
    order by m.created_at, m.id offset p_offset limit p_limit) x);
end $$;

-- Recreated functions start with default grants; only the backend's service
-- role, which supplies the actor, may call them.
do $$ declare obj record; begin
  for obj in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('intake_change_request', 'intake_resolve_request', 'intake_read_history') loop
    execute format('revoke all on function %s from public,anon,authenticated', obj.signature);
    execute format('grant execute on function %s to service_role', obj.signature);
  end loop;
end $$;
