create schema if not exists fuhrpark_private;
revoke all on schema fuhrpark_private from public, anon, authenticated;
create table fuhrpark_private.report_tickets (
  token uuid primary key default gen_random_uuid(),
  week_start date not null,
  expires_at timestamptz not null default now() + interval '90 seconds'
);
create index report_tickets_expiry on fuhrpark_private.report_tickets(expires_at);
alter table fuhrpark_private.report_tickets enable row level security;

create function public.request_report_ticket(p_week date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare result uuid;
begin
  if auth.uid() is null or not public.is_admin() then raise insufficient_privilege; end if;
  if p_week is null or extract(isodow from p_week) <> 1 then raise exception 'invalid_week'; end if;
  delete from fuhrpark_private.report_tickets where expires_at <= now();
  insert into fuhrpark_private.report_tickets(week_start) values (p_week) returning token into result;
  return result;
end $$;
revoke all on function public.request_report_ticket(date) from public, anon;
grant execute on function public.request_report_ticket(date) to authenticated;

-- One-use bearer capability, scoped to a single week. No account session leaves Fuhrpark.
create function public.consume_report_ticket(p_token uuid) returns date
language sql security definer set search_path = '' as $$
  delete from fuhrpark_private.report_tickets where token = p_token and expires_at > now() returning week_start;
$$;
revoke all on function public.consume_report_ticket(uuid) from public;
grant execute on function public.consume_report_ticket(uuid) to anon, authenticated;
