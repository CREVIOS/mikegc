-- Migration date: 2026-11-03
-- AI triage is how automated intake fills in a request, so it is no longer
-- something to switch off: it runs whenever a model is available, and
-- without one MikeGC records each message as it arrived.

alter table public.intake_automation drop column if exists triage_enabled;
