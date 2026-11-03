-- Migration date: 2026-11-03
-- The model AI triage runs with, which an owner or admin chooses from the
-- models the organization has keys for. Triage doesn't run without one.
-- Settings made from now on start with a fast, low-cost model; existing
-- settings have none until an admin chooses one.

alter table public.intake_automation
  add column if not exists triage_model text;

alter table public.intake_automation
  drop constraint if exists intake_automation_triage_model_check;
alter table public.intake_automation
  add constraint intake_automation_triage_model_check
  check (triage_model is null or char_length(triage_model) between 1 and 200);
