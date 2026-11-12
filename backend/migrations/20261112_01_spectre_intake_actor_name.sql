-- Migration date: 2026-11-12

-- The product is now called Spectre. Requests, notes and documents the intake
-- agent records have no member as their actor, so the read functions name the
-- agent with a literal. Re-create the four functions that emitted 'MikeGC' so
-- they emit 'Spectre', with their bodies otherwise unchanged (each is copied
-- from backend/schema.sql). `create or replace` keeps each function's owner
-- and grants; search_path is set inline. The frontend still recognises the
-- old name, so rows read during a rolling deploy keep the agent's avatar.

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
          when e.automated then 'Spectre'
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
    select m.id, m.kind, m.body, m.created_at, m.author_id, m.automated, m.purpose,
      case when m.automated then 'Spectre'
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
      'added_by_name', case when l.automated then 'Spectre'
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
    error = case when p_status = 'failed' then coalesce(p_error, 'Spectre couldn''t send this message.') else null end,
    documents = coalesce(p_documents, documents),
    attempted_at = coalesce(attempted_at, now()),
    sent_at = case when p_status = 'sent' then coalesce(sent_at, now()) else sent_at end
    where org_id = p_org and id = p_outbound;
  return found;
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
    'created_by_name', case when r.created_by is null and r.source <> 'manual' then 'Spectre'
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

-- Failed deliveries recorded before the rename carry the old default message.
update public.intake_outbound
  set error = 'Spectre couldn''t send this message.'
  where error = 'MikeGC couldn''t send this message.';
