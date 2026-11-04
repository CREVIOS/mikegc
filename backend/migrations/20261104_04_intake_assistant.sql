-- Migration date: 2026-11-04
-- The assistant works on intake requests. A chat whose first message carries a
-- request's pill names it, so each turn reads the request and its documents; and a request's
-- members edit its documents (as tracked changes, in new versions) while it
-- is open, from that chat or wherever documents are edited.

alter table public.chats add column if not exists intake_request_id uuid
  references public.intake_requests(id) on delete set null;
create index if not exists chats_intake_request_idx
  on public.chats(intake_request_id) where intake_request_id is not null;
-- The request a message's pill named, shown with the message.
alter table public.chat_messages add column if not exists intake jsonb;

-- Whether a member may edit one of the organization's intake documents: it
-- belongs to a request they can read that is neither resolved nor cancelled.
create or replace function public.intake_document_editable(p_org uuid, p_actor uuid, p_document uuid)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select exists(select 1 from public.documents d
    join public.intake_request_documents l on l.document_id = d.id and l.org_id = p_org
    join public.intake_requests r on r.id = l.request_id and r.org_id = p_org
    where d.id = p_document and d.org_id = p_org and d.archived_at is null
      and d.library_kind = 'intake_attachment'
      and r.state not in ('resolved', 'cancelled')
      and public.intake_can_read(p_org, p_actor, r.id))
$$;

do $$ declare obj record; begin
  for obj in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'intake_document_editable' loop
    execute format('revoke all on function %s from public,anon,authenticated', obj.signature);
    execute format('grant execute on function %s to service_role', obj.signature);
  end loop;
end $$;
