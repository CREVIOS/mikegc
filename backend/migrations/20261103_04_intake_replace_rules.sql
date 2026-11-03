-- Migration date: 2026-11-03
-- An organization's triage rules are replaced in one transaction that holds
-- its intake settings row. Two saves at once then take turns, rather than
-- each deleting the rules the other wrote and leaving none.

create or replace function public.intake_replace_rules(p_org uuid, p_rules jsonb)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.intake_automation where org_id = p_org for update;
  if not found then raise exception 'Intake settings not found' using errcode = 'P0002'; end if;
  if jsonb_typeof(p_rules) is distinct from 'array' then
    raise exception 'Invalid rules' using errcode = '22023';
  end if;
  delete from public.intake_assignment_rules where org_id = p_org;
  insert into public.intake_assignment_rules(org_id, position, condition, assignee_id,
      preprocess, preprocess_kind, preprocess_ref)
    select p_org, (r.ordinality - 1)::integer, r.value->>'condition', (r.value->>'assignee_id')::uuid,
        coalesce((r.value->>'preprocess')::boolean, false), r.value->>'preprocess_kind', r.value->>'preprocess_ref'
      from jsonb_array_elements(p_rules) with ordinality as r(value, ordinality);
end $$;

revoke all on function public.intake_replace_rules(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.intake_replace_rules(uuid, jsonb) to service_role;
