-- Migration date: 2026-11-02
-- AI preprocessing on assignment rules. A rule can have MikeGC work on the
-- requests it assigns: answer the request and mark up its Word documents,
-- following a workflow or playbook when the rule names one. MikeGC posts its
-- answer as a note of its own, which, like the rest of what it records, has
-- no author and reads as MikeGC.

alter table public.intake_assignment_rules add column if not exists preprocess boolean not null default false;
alter table public.intake_assignment_rules add column if not exists preprocess_kind text;
alter table public.intake_assignment_rules add column if not exists preprocess_ref text;
alter table public.intake_assignment_rules drop constraint if exists intake_assignment_rules_preprocess_kind_check;
alter table public.intake_assignment_rules add constraint intake_assignment_rules_preprocess_kind_check
  check (preprocess_kind is null or preprocess_kind in ('workflow', 'playbook'));
-- A workflow or playbook is named by kind and id together, or not at all.
alter table public.intake_assignment_rules drop constraint if exists intake_assignment_rules_preprocess_ref_check;
alter table public.intake_assignment_rules add constraint intake_assignment_rules_preprocess_ref_check
  check ((preprocess_kind is null) = (preprocess_ref is null)
    and (preprocess_ref is null or char_length(preprocess_ref) between 1 and 200));

alter table public.intake_messages add column if not exists automated boolean not null default false;

-- System changes have no actor; erased people read as former members.
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
    select m.id, m.kind, m.body, m.created_at, m.author_id, m.automated,
      case when m.automated then 'MikeGC'
        else coalesce(u.display_name, u.email, 'Former member') end as author_name
    from public.intake_messages m left join public.user_profiles u on u.user_id = m.author_id
    where m.org_id = p_org and m.request_id = p_request
    order by m.created_at, m.id offset p_offset limit p_limit) x);
end $$;

-- A note MikeGC posts on a request it recorded, such as its preprocessing
-- answer. The caller names the note, so posting it again adds nothing.
create or replace function public.intake_note_automated(p_org uuid, p_request uuid, p_note uuid, p_body text)
returns boolean language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.organizations where id = p_org and kind in ('team', 'personal')
    and deleted_at is null for update;
  if not found or not exists(select 1 from public.intake_requests where org_id = p_org and id = p_request) then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if p_note is null or p_body is null or char_length(p_body) not between 1 and 20000 or btrim(p_body) = '' then
    raise exception 'Invalid note' using errcode = '22023';
  end if;
  if exists(select 1 from public.intake_messages where id = p_note) then return false; end if;
  insert into public.intake_messages(id, org_id, request_id, author_id, kind, body, automated)
    values(p_note, p_org, p_request, null, 'note', p_body, true);
  update public.intake_requests set updated_at = now() where id = p_request;
  return true;
end $$;

do $$ declare obj record; begin
  for obj in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('intake_read_history', 'intake_note_automated') loop
    execute format('revoke all on function %s from public,anon,authenticated', obj.signature);
    execute format('grant execute on function %s to service_role', obj.signature);
  end loop;
end $$;
