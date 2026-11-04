-- Migration date: 2026-11-04
-- MikeGC's preprocessing note says what it is: the activity reads it as
-- MikeGC preprocessing the request, not as a comment. Its other notes, such
-- as a related-thread notice, stay comments.

-- What a note of MikeGC's is: 'preprocessing' for its preprocessing of the
-- request, which the activity names as such; null for any other note.
alter table public.intake_messages add column if not exists purpose text;
alter table public.intake_messages drop constraint if exists intake_messages_purpose_check;
alter table public.intake_messages add constraint intake_messages_purpose_check
  check (purpose is null or (automated and kind = 'note' and purpose = 'preprocessing'));

-- Notes posted before: every automated note but the related-thread notice
-- came from preprocessing.
update public.intake_messages set purpose = 'preprocessing'
  where automated and kind = 'note' and purpose is null
    and body not like 'A message in this request''s email thread came from %';

drop function if exists public.intake_note_automated(uuid, uuid, uuid, text);
create or replace function public.intake_note_automated(p_org uuid, p_request uuid, p_note uuid, p_body text,
  p_purpose text default null)
returns boolean language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.organizations where id = p_org and kind in ('team', 'personal')
    and deleted_at is null for update;
  if not found or not exists(select 1 from public.intake_requests where org_id = p_org and id = p_request) then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if p_note is null or p_body is null or char_length(p_body) not between 1 and 20000 or btrim(p_body) = ''
    or (p_purpose is not null and p_purpose <> 'preprocessing') then
    raise exception 'Invalid note' using errcode = '22023';
  end if;
  if exists(select 1 from public.intake_messages where id = p_note) then return false; end if;
  insert into public.intake_messages(id, org_id, request_id, author_id, kind, body, automated, purpose)
    values(p_note, p_org, p_request, null, 'note', p_body, true, p_purpose);
  update public.intake_requests set updated_at = now() where id = p_request;
  return true;
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
    select m.id, m.kind, m.body, m.created_at, m.author_id, m.automated, m.purpose,
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
    where n.nspname = 'public' and p.proname in ('intake_note_automated', 'intake_read_history') loop
    execute format('revoke all on function %s from public,anon,authenticated', obj.signature);
    execute format('grant execute on function %s to service_role', obj.signature);
  end loop;
end $$;
