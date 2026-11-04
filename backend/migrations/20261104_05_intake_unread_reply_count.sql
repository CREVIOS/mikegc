-- Migration date: 2026-11-04
-- Queue rows count the requester replies nobody has opened yet.

-- List rows omit the description, which the queue never shows.
create or replace function public.intake_list_item(r public.intake_requests)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', r.id, 'subject', r.subject,
    'requester_name', r.requester_name, 'requester_email', r.requester_email, 'requester_team', r.requester_team,
    'requested_by_date', r.requested_by_date, 'state', r.state, 'version', r.version,
    'assignee_id', r.assignee_id,
    'assignee_name', case when r.assignee_id is null then null else coalesce(
      (select coalesce(a.display_name, a.email) from public.user_profiles a where a.user_id = r.assignee_id),
      'Former member') end,
    'created_at', r.created_at, 'updated_at', r.updated_at,
    'clarify_stage', r.clarify_stage,
    'new_reply', r.last_reply_at is not null and (r.reply_seen_at is null or r.reply_seen_at < r.last_reply_at),
    'unread_replies', case when r.last_reply_at is null or r.reply_seen_at >= r.last_reply_at then 0 else
      (select count(*) from public.intake_messages m where m.request_id = r.id and m.kind = 'reply'
        and (r.reply_seen_at is null or m.created_at > r.reply_seen_at)) end,
    'capabilities', jsonb_build_object(
      'assign', r.state not in ('resolved', 'cancelled'),
      'cancel', r.state not in ('resolved', 'cancelled'),
      'delete', true))
$$;
