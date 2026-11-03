-- Migration date: 2026-11-03
-- The model AI preprocessing runs with, chosen like triage's from the models
-- the organization has keys for. Preprocessing doesn't run without one.
-- Settings made from now on start with a stronger model; existing settings
-- have none until an admin chooses one.

alter table public.intake_automation
  add column if not exists preprocessing_model text;

alter table public.intake_automation
  drop constraint if exists intake_automation_preprocessing_model_check;
alter table public.intake_automation
  add constraint intake_automation_preprocessing_model_check
  check (preprocessing_model is null or char_length(preprocessing_model) between 1 and 200);
