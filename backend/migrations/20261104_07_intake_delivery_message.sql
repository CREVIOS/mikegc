-- Migration date: 2026-11-04
-- A delivery names the message whose text it sent: a question, or a
-- resolution's reply. A resolution that sent documents alone has none. The
-- request page reads it to show a resolution's internal comment and the reply
-- that went out side by side.

create or replace function public.intake_delivery(o public.intake_outbound)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('outbound_id', o.id, 'kind', o.kind, 'status', o.status, 'error', o.error,
    'sent_at', o.sent_at, 'message_id', o.message_id,
    'documents', coalesce((select jsonb_agg(jsonb_build_object(
        'document_id', d->>'document_id',
        'filename', coalesce(v.filename, 'Document'),
        'left_out', coalesce((d->>'left_out')::boolean, false)) order by x.ord)
      from jsonb_array_elements(o.documents) with ordinality as x(d, ord)
      left join public.document_versions v on v.id = (d->>'version_id')::uuid), '[]'::jsonb))
$$;

-- Only the backend's service role reads it, as with every intake function.
do $$ declare obj record; begin
  for obj in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'intake_delivery' loop
    execute format('revoke all on function %s from public,anon,authenticated', obj.signature);
    execute format('grant execute on function %s to service_role', obj.signature);
  end loop;
end $$;
