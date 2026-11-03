-- Migration date: 2026-11-03
-- Outlook and Gmail: MikeGC connects to the organization's intake mailbox
-- itself, through Microsoft Graph (Microsoft 365) or the Gmail API (Google
-- Workspace), reads new mail from it and replies as it, so replies thread
-- natively. Postmark is retired, for receiving as well as sending: its token
-- columns go, and an organization that recorded email through it sees a
-- notice to connect its mailbox. Until it does, no email is recorded.

-- Every Message-ID seen or sent in a request's email thread, so a reply is
-- matched on In-Reply-To or References even when its subject was edited.
create table if not exists public.intake_email_message_ids (
  org_id uuid not null,
  link_id uuid not null references public.intake_channel_links(id) on delete cascade,
  message_id text not null check (char_length(message_id) between 1 and 300),
  created_at timestamptz not null default now(),
  unique (org_id, message_id)
);
create index if not exists intake_email_message_ids_link on public.intake_email_message_ids(link_id, created_at);

-- The intake mailbox and how MikeGC reaches it. Secrets use the same
-- encrypted columns and key as the Slack ones.
alter table public.intake_automation add column if not exists email_provider text;
alter table public.intake_automation drop constraint if exists intake_automation_email_provider_check;
alter table public.intake_automation add constraint intake_automation_email_provider_check
  check (email_provider is null or email_provider in ('graph', 'gmail'));
alter table public.intake_automation add column if not exists email_mailbox text;
alter table public.intake_automation drop constraint if exists intake_automation_email_mailbox_check;
alter table public.intake_automation add constraint intake_automation_email_mailbox_check
  check (email_mailbox is null or (char_length(email_mailbox) between 3 and 320
    and email_mailbox ~ '^[^@[:space:]]+@[^@[:space:]]+$'));
alter table public.intake_automation add column if not exists email_from_name text not null default 'Legal';
alter table public.intake_automation drop constraint if exists intake_automation_email_from_name_check;
alter table public.intake_automation add constraint intake_automation_email_from_name_check
  check (char_length(email_from_name) between 1 and 80);
-- Names the organization in its Graph notification URL; notifications are
-- checked against their client state, so this identifier is not a credential.
alter table public.intake_automation add column if not exists email_webhook_id uuid not null default gen_random_uuid();
alter table public.intake_automation drop constraint if exists intake_automation_email_webhook_id_key;
alter table public.intake_automation add constraint intake_automation_email_webhook_id_key unique (email_webhook_id);
alter table public.intake_automation add column if not exists email_last_read_at timestamptz;
alter table public.intake_automation add column if not exists email_error text;
alter table public.intake_automation drop constraint if exists intake_automation_email_error_check;
alter table public.intake_automation add constraint intake_automation_email_error_check
  check (email_error is null or char_length(email_error) <= 200);
alter table public.intake_automation add column if not exists email_reconnect_notice boolean not null default false;
alter table public.intake_automation add column if not exists graph_tenant_id text;
alter table public.intake_automation drop constraint if exists intake_automation_graph_tenant_id_check;
alter table public.intake_automation add constraint intake_automation_graph_tenant_id_check
  check (graph_tenant_id is null or char_length(graph_tenant_id) between 1 and 200);
alter table public.intake_automation add column if not exists graph_client_id text;
alter table public.intake_automation drop constraint if exists intake_automation_graph_client_id_check;
alter table public.intake_automation add constraint intake_automation_graph_client_id_check
  check (graph_client_id is null or char_length(graph_client_id) between 1 and 200);
alter table public.intake_automation add column if not exists graph_client_secret_encrypted text;
alter table public.intake_automation add column if not exists graph_client_secret_iv text;
alter table public.intake_automation add column if not exists graph_client_secret_tag text;
alter table public.intake_automation add column if not exists graph_subscription_id text;
alter table public.intake_automation drop constraint if exists intake_automation_graph_subscription_id_check;
alter table public.intake_automation add constraint intake_automation_graph_subscription_id_check
  check (graph_subscription_id is null or char_length(graph_subscription_id) between 1 and 200);
alter table public.intake_automation add column if not exists graph_subscription_expires_at timestamptz;
-- Only the SHA-256 of the client state Graph echoes on each notification.
alter table public.intake_automation add column if not exists graph_client_state_hash text;
alter table public.intake_automation drop constraint if exists intake_automation_graph_client_state_hash_check;
alter table public.intake_automation add constraint intake_automation_graph_client_state_hash_check
  check (graph_client_state_hash is null or graph_client_state_hash ~ '^[0-9a-f]{64}$');
alter table public.intake_automation add column if not exists graph_delta_link text;
alter table public.intake_automation drop constraint if exists intake_automation_graph_delta_link_check;
alter table public.intake_automation add constraint intake_automation_graph_delta_link_check
  check (graph_delta_link is null or char_length(graph_delta_link) <= 4000);
alter table public.intake_automation add column if not exists gmail_history_id text;
alter table public.intake_automation drop constraint if exists intake_automation_gmail_history_id_check;
alter table public.intake_automation add constraint intake_automation_gmail_history_id_check
  check (gmail_history_id is null or gmail_history_id ~ '^[0-9]{1,30}$');

-- Postmark's token goes. An organization that used it is told to connect
-- its mailbox, and email stays off until it does.
do $$ begin
  if exists(select 1 from information_schema.columns where table_schema = 'public'
      and table_name = 'intake_automation' and column_name = 'email_token_hash') then
    execute 'update public.intake_automation set email_reconnect_notice = true, email_enabled = false
      where email_token_hash is not null and email_provider is null';
  end if;
end $$;
alter table public.intake_automation drop column if exists email_token_hash;
alter table public.intake_automation drop column if exists email_token_hint;

do $$ declare obj record; begin
  for obj in select tablename from pg_tables where schemaname = 'public' and tablename like 'intake_%' loop
    execute format('alter table public.%I enable row level security', obj.tablename);
    execute format('revoke all on public.%I from public,anon,authenticated', obj.tablename);
    execute format('grant all on public.%I to service_role', obj.tablename);
  end loop;
end $$;
