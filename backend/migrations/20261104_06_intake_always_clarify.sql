-- Migration date: 2026-11-04
-- MikeGC always asks requesters for missing details before Legal starts; the
-- setting that turned it off is gone.
alter table public.intake_automation drop column if exists clarify_enabled;
