-- Migration date: 2026-11-01
-- The queue can be filtered to one requester, and lists the requesters to
-- choose from. The list function gains p_requester, so the previous
-- signature is dropped first.
drop function if exists public.intake_list_requests(uuid, uuid, text, text, text, text, text, uuid, text, integer);

-- Keyset pages: a request created or updated between pages is never repeated.
-- p_assignee is null (everyone), 'unassigned', 'me' or a member's user ID.
-- p_requester is null (everyone) or one requester's name, matched without case.
create or replace function public.intake_list_requests(p_org uuid, p_actor uuid, p_state text default null,
  p_assignee text default null, p_search text default '', p_sort text default 'updated',
  p_after_key text default null, p_after_id uuid default null, p_scope text default null,
  p_requester text default null, p_limit integer default 50)
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
          and public.intake_list_in_scope(r, p_scope)
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
          and public.intake_list_in_scope(r, p_scope)
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
          and public.intake_list_in_scope(r, p_scope)
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
end $$;-- The requesters the queue can be filtered by: each name once, ignoring case,
-- with the email it was most recently recorded with.
create or replace function public.intake_list_requesters(p_org uuid, p_actor uuid)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.organizations where id = p_org for share;
  if public.intake_member_role(p_org, p_actor) is null then
    raise exception 'Intake not found' using errcode = 'P0002';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('name', x.requester_name, 'email', x.requester_email)
      order by lower(x.requester_name), x.requester_name), '[]')
    from (select distinct on (lower(r.requester_name)) r.requester_name, r.requester_email
      from public.intake_requests r where r.org_id = p_org
      order by lower(r.requester_name), r.updated_at desc, r.id) x);
end $$;

-- Keep the new functions out of reach of browser database roles.
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
