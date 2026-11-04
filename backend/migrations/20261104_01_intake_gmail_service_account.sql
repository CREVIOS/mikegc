-- Migration date: 2026-11-04
-- An organization's own Google service account for its Gmail intake
-- mailbox, so connecting Gmail needs no deployment-wide key. Its JSON key is
-- encrypted like the other channel secrets and never returned to the
-- browser; only the client ID an admin delegates to is kept in the clear.
-- Organizations without one keep using the deployment's
-- INTAKE_GMAIL_SERVICE_ACCOUNT_KEY.
alter table public.intake_automation add column if not exists gmail_service_account_key_encrypted text;
alter table public.intake_automation add column if not exists gmail_service_account_key_iv text;
alter table public.intake_automation add column if not exists gmail_service_account_key_tag text;
alter table public.intake_automation add column if not exists gmail_service_account_id text;
alter table public.intake_automation drop constraint if exists intake_automation_gmail_service_account_id_check;
alter table public.intake_automation add constraint intake_automation_gmail_service_account_id_check
  check (gmail_service_account_id is null or char_length(gmail_service_account_id) between 1 and 320);
