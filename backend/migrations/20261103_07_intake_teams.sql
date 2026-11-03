-- Migration date: 2026-11-03
-- Microsoft Teams: a new intake channel and requester-loop channel at once.
-- Each organization brings its own single-tenant bot. Its client secret is
-- encrypted like the Slack ones; whether Graph can read and post channel
-- files is detected when the credentials are saved.

alter table public.intake_automation add column if not exists teams_enabled boolean not null default false;
-- Names the organization in its Teams messaging endpoint; activities are
-- checked against Bot Framework's signing keys, so this is not a credential.
alter table public.intake_automation add column if not exists teams_webhook_id uuid not null default gen_random_uuid();
alter table public.intake_automation drop constraint if exists intake_automation_teams_webhook_id_key;
alter table public.intake_automation add constraint intake_automation_teams_webhook_id_key unique (teams_webhook_id);
alter table public.intake_automation add column if not exists teams_app_id text;
alter table public.intake_automation drop constraint if exists intake_automation_teams_app_id_check;
alter table public.intake_automation add constraint intake_automation_teams_app_id_check
  check (teams_app_id is null or char_length(teams_app_id) between 1 and 100);
alter table public.intake_automation add column if not exists teams_tenant_id text;
alter table public.intake_automation drop constraint if exists intake_automation_teams_tenant_id_check;
alter table public.intake_automation add constraint intake_automation_teams_tenant_id_check
  check (teams_tenant_id is null or char_length(teams_tenant_id) between 1 and 100);
alter table public.intake_automation add column if not exists teams_client_secret_encrypted text;
alter table public.intake_automation add column if not exists teams_client_secret_iv text;
alter table public.intake_automation add column if not exists teams_client_secret_tag text;
alter table public.intake_automation add column if not exists teams_files_access boolean;

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
      when 'teams' then coalesce(a.teams_files_access, false)
      else true end)
  from public.intake_channel_links l
  left join public.intake_automation a on a.org_id = l.org_id
  where l.request_id = r.id
$$;

do $$ declare obj record; begin
  for obj in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'intake_%' loop
    execute format('revoke all on function %s from public,anon,authenticated', obj.signature);
    execute format('grant execute on function %s to service_role', obj.signature);
  end loop;
end $$;
