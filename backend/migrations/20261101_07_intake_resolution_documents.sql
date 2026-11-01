-- Migration date: 2026-11-01
-- A resolution is written in the note form, so documents added there link to
-- the resolution the way they link to a note: the uploader's own message on
-- the same request, which records them, so they get no separate event.

-- The upload worker links each new document as soon as its row exists, so an
-- interrupted browser never leaves a file that belongs to no request. A
-- document added with a note or a resolution links to that message, which must
-- be the uploader's own on the same request. The message records it, so it
-- gets no event.
create or replace function public.intake_attach_document(p_org uuid, p_actor uuid, p_request uuid, p_document uuid,
  p_message uuid default null)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  perform public.intake_lock_org(p_org, p_actor);
  if not public.intake_can_read(p_org, p_actor, p_request) then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if not exists(select 1 from public.documents where id = p_document and org_id = p_org
      and library_kind = 'intake_attachment' and user_id = p_actor
      and project_id is null and workflow_id is null) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  if p_message is not null and not exists(select 1 from public.intake_messages where id = p_message
      and org_id = p_org and request_id = p_request and author_id = p_actor
      and kind in ('note', 'resolution')) then
    raise exception 'Note not found' using errcode = 'P0002';
  end if;
  if exists(select 1 from public.intake_request_documents where document_id = p_document and request_id <> p_request) then
    raise exception 'The document belongs to another request' using errcode = '22023';
  end if;
  insert into public.intake_request_documents(org_id, request_id, document_id, added_by, message_id)
    values(p_org, p_request, p_document, p_actor, p_message) on conflict do nothing;
  if found then
    if p_message is null then
      insert into public.intake_events(org_id, request_id, actor_id, kind)
        values(p_org, p_request, p_actor, 'document_added');
    end if;
    update public.intake_requests set updated_at = now() where id = p_request;
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
