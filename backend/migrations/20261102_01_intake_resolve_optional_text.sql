-- Migration date: 2026-11-02
-- A request can be resolved without a resolution: the text is optional, and
-- when given it is still saved as the resolution. Cancelling still needs a
-- reason. The signature is unchanged.
create or replace function public.intake_change_request(p_org uuid, p_actor uuid, p_command uuid, p_request uuid,
  p_version integer, p_action text, p_body text default null, p_assignee uuid default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare r public.intake_requests; input jsonb; replay jsonb; next_state text; next_assignee uuid; mid uuid; open boolean;
begin
  perform public.intake_lock_org(p_org, p_actor);
  if not public.intake_can_read(p_org, p_actor, p_request) then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  input := jsonb_build_object('id', p_request, 'version', p_version, 'body', p_body, 'assignee', p_assignee);
  -- Resolve committed operations before checking state the original operation
  -- itself may have changed.
  replay := public.intake_replay(p_org, p_actor, p_command, p_action, input);
  if replay is not null then return replay; end if;
  if p_action is null or p_action not in ('assign', 'note', 'wait', 'resume', 'resolve', 'cancel', 'reopen')
    or (p_action <> 'assign' and p_assignee is not null)
    or (p_action in ('assign', 'reopen') and p_body is not null)
    -- A resolution's text is optional; a cancellation still needs its reason.
    or (p_action in ('note', 'cancel') and p_body is null)
  then
    raise exception 'Invalid command' using errcode = '22023';
  end if;
  if p_body is not null and (char_length(p_body) not between 1 and 20000 or btrim(p_body) = '') then
    raise exception 'Enter at most 20000 characters' using errcode = '22023';
  end if;
  select * into r from public.intake_requests where org_id = p_org and id = p_request for update;
  -- Notes leave the request itself unchanged, so they never conflict.
  if p_action <> 'note' and (p_version is null or r.version <> p_version) then
    raise exception 'Request changed; reload it' using errcode = 'P0001';
  end if;
  open := r.state not in ('resolved', 'cancelled');
  next_state := r.state;
  next_assignee := r.assignee_id;
  if (p_action in ('assign', 'resolve', 'cancel') and not open)
    or (p_action = 'wait' and r.state not in ('submitted', 'in_review'))
    or (p_action = 'resume' and r.state <> 'needs_information')
    or (p_action = 'reopen' and open)
  then
    raise exception 'Request changed; reload it' using errcode = 'P0001';
  end if;
  if p_action = 'assign' then
    if p_assignee is not null and public.intake_member_role(p_org, p_assignee) is null then
      raise exception 'Choose a current member of your organization' using errcode = '22023';
    end if;
    next_assignee := p_assignee;
    if r.state in ('submitted', 'in_review') then
      next_state := case when p_assignee is null then 'submitted' else 'in_review' end;
    end if;
  elsif p_action = 'wait' then
    next_state := 'needs_information';
  elsif p_action = 'resume' then
    next_state := case when r.assignee_id is null then 'submitted' else 'in_review' end;
  elsif p_action = 'resolve' then
    next_state := 'resolved';
  elsif p_action = 'cancel' then
    next_state := 'cancelled';
  elsif p_action = 'reopen' then
    if r.assignee_id is not null and public.intake_member_role(p_org, r.assignee_id) is null then
      next_assignee := null;
    end if;
    next_state := case when next_assignee is null then 'submitted' else 'in_review' end;
  end if;
  if p_body is not null then
    insert into public.intake_messages(org_id, request_id, author_id, kind, body)
      values(p_org, p_request, p_actor,
        case p_action when 'resolve' then 'resolution' when 'cancel' then 'cancel_reason' else 'note' end, p_body)
      returning id into mid;
  end if;
  if p_action = 'note' then
    update public.intake_requests set updated_at = now() where id = p_request;
    return public.intake_record_command(p_org, p_actor, p_command, p_request, p_action, input, r.version, mid);
  end if;
  update public.intake_requests set state = next_state, assignee_id = next_assignee,
    version = version + 1, updated_at = now() where id = p_request;
  insert into public.intake_events(org_id, request_id, actor_id, kind, from_state, to_state, assignee_id, message_id)
    values(p_org, p_request, p_actor, p_action, r.state, next_state, next_assignee, mid);
  return public.intake_record_command(p_org, p_actor, p_command, p_request, p_action, input, r.version + 1, mid);
end $$;
