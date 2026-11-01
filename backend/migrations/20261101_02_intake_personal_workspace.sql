-- Migration date: 2026-11-01
-- Intake works in Personal too. Each account's personal organization (its
-- only member is its owner) holds that person's own requests, the way a team
-- organization holds its members'. The API names it "personal" and resolves
-- it to the caller's own, so its id never reaches the client.

create or replace function public.intake_member_role(p_org uuid,p_actor uuid)
returns text language sql stable set search_path=public,pg_temp as $$
  select m.role from public.org_members m join public.organizations o on o.id=m.org_id
  join public.user_profiles u on u.user_id=m.user_id
  where m.org_id=p_org and m.user_id=p_actor and o.kind in ('team','personal') and o.deleted_at is null
    and u.account_deletion_requested_at is null
$$;

create or replace function public.intake_lock_org(p_org uuid,p_actor uuid)
returns void language plpgsql set search_path=public,pg_temp as $$
begin
  -- Same first lock as remove_org_member and organization deletion. Avoid
  -- membership row locks: existing deletion triggers already lock the org.
  perform 1 from public.organizations where id=p_org and kind in ('team','personal') and deleted_at is null for update;
  if not found or public.intake_member_role(p_org,p_actor) is null then
    raise exception 'Intake not found' using errcode='P0002';
  end if;
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
