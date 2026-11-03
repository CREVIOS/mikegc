-- Migration date: 2026-11-02
-- Assignment rules replace the note of what each member handles. A rule is a
-- condition in plain words, such as "The request is about an NDA", and the
-- member it assigns to. Triage assigns a request to the first rule, in
-- order, whose condition it meets. A rule goes when its member leaves.

create table if not exists public.intake_assignment_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  position integer not null check (position between 0 and 99),
  condition text not null check (char_length(condition) between 1 and 500 and btrim(condition) <> ''),
  assignee_id uuid not null,
  updated_at timestamptz not null default now(),
  foreign key (org_id, assignee_id) references public.org_members(org_id, user_id) on delete cascade
);
create index if not exists intake_assignment_rules_org on public.intake_assignment_rules(org_id, position);
create index if not exists intake_assignment_rules_assignee on public.intake_assignment_rules(assignee_id);

-- Each member's note becomes a rule assigning to them, oldest first. An
-- organization can hold at most 100 rules, so one with more notes stops the
-- migration rather than losing some.
do $$ begin
  if to_regclass('public.intake_member_focus') is not null then
    if exists (select 1 from public.intake_member_focus group by org_id having count(*) > 100) then
      raise exception 'An organization has more than 100 intake focus notes, and can hold at most 100 assignment rules. Remove the extra notes, then migrate again.';
    end if;
    insert into public.intake_assignment_rules(org_id, position, condition, assignee_id)
    select org_id, position, focus, user_id from (
      select f.org_id, f.focus, f.user_id,
             (row_number() over (partition by f.org_id order by f.updated_at, f.user_id) - 1)::integer as position
        from public.intake_member_focus f
        where not exists (select 1 from public.intake_assignment_rules r where r.org_id = f.org_id)
    ) numbered;
  end if;
end $$;
drop table if exists public.intake_member_focus;

alter table public.intake_assignment_rules enable row level security;
revoke all on public.intake_assignment_rules from public, anon, authenticated;
grant all on public.intake_assignment_rules to service_role;
