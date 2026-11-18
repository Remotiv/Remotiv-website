-- ============================================================================
-- Migration 064 - queue_manual_whatsapp + claim_manual_communication_log:
--                 a recruiter's WhatsApp message is queued as its log row AND
--                 its job in ONE transaction, and claimed by the database's
--                 clock before it is sent (#52, QA-SAFETY-40 M-1, outbox)
-- ----------------------------------------------------------------------------
-- NOT RUN YET. Apply by hand in the Supabase SQL editor: STAGING first, then
-- PRODUCTION, BEFORE the application code that calls it is deployed. Until it
-- exists the interview invitation still goes out by email; only its WhatsApp
-- copy is not queued (the call fails, the app logs it, nothing is half-written).
--
-- ── Why ──────────────────────────────────────────────────────
--
-- A recruiter's WhatsApp (the interview invitation) used to be queued as a job
-- with NO log row; the dispatcher wrote a fresh row on every run and sent. So
-- a retry after an uncertain answer from Meta sent the message again, a crash
-- after Meta accepted it sent it again, and Stop had nothing to stop until the
-- message was already on its way.
--
-- Now the row comes first, durable and cancellable, and the job carries its
-- id. Both are written here, in one transaction: either both exist or neither
-- does, so there is no row without a job (stuck 'queued' for ever) and no job
-- without a row (a send nobody could stop). The dispatcher then CLAIMS that
-- exact row (status 'queued' AND attempt_started_at IS NULL, one conditional
-- UPDATE) before it sends; a row Stopped first is 'cancelled' and is never
-- sent, and a row already claimed by an earlier run is never sent again.
--
-- ── Contract ─────────────────────────────────────────────────
--
-- Returns one row: (out_outcome, out_log_id, out_job_id).
--   queued                 both written
--   application_not_found  no job_applications row with that id IN THAT
--                          company (company_id_snapshot): nothing written
--   bad_input              empty recipient, body or sender, an event other
--                          than 'interview', or a payload that is not an
--                          object: nothing written
-- The job's payload is p_payload with logId, applicationId, event, channel
-- and sentByName set HERE, so the job always matches its row.
--
-- SECURITY DEFINER with search_path = '' and every reference schema-qualified.
-- EXECUTE for service_role only.
--
-- claim_manual_communication_log(p_id, p_company_id, p_uncertain_error) returns
-- one row, (out_outcome):
--   claimed    this run owns the row: attempt_started_at = now(), the
--              DATABASE's clock (#85's rule: no stamp is ever written or read
--              back by the application)
--   stopped    the row was cancelled first (Stop): nothing is sent
--   uncertain  an earlier run claimed it and never finished: it may have sent.
--              Marked failed with p_uncertain_error in the same transaction,
--              never sent again
--   finished   sent, failed, skipped, delivered or read already
--   missing    no such recruiter WhatsApp row in that company
--
-- Rollback (revert the application code first: it calls both for every
-- WhatsApp invite):
--   drop function public.claim_manual_communication_log(uuid, uuid, text);
--   drop function public.queue_manual_whatsapp(uuid, uuid, text, text, text, text, jsonb);
-- ============================================================================

begin;

set local lock_timeout = '5s';

create or replace function public.queue_manual_whatsapp(
  p_company_id uuid,
  p_application_id uuid,
  p_event text,
  p_to_address text,
  p_body text,
  p_sent_by_name text,
  p_payload jsonb
)
returns table (out_outcome text, out_log_id uuid, out_job_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_log_id uuid;
  v_job_id uuid;
  v_to text := pg_catalog.btrim(coalesce(p_to_address, ''));
  v_body text := pg_catalog.btrim(coalesce(p_body, ''));
  v_sender text := pg_catalog.btrim(coalesce(p_sent_by_name, ''));
begin
  if p_company_id is null or p_application_id is null
     or v_to = '' or v_body = '' or v_sender = ''
     or p_event is distinct from 'interview'
     or p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    return query select 'bad_input'::text, null::uuid, null::uuid;
    return;
  end if;

  perform 1
     from public.job_applications a
    where a.id = p_application_id
      and a.company_id_snapshot = p_company_id;
  if not found then
    return query select 'application_not_found'::text, null::uuid, null::uuid;
    return;
  end if;

  insert into public.communication_logs
    (company_id, application_id, event, channel, to_address, body, status, sent_by_name, attempt_started_at)
  values
    (p_company_id, p_application_id, p_event, 'whatsapp', v_to, p_body, 'queued', v_sender, null)
  returning id into v_log_id;

  insert into public.background_jobs (company_id, type, payload, status)
  values (
    p_company_id,
    'send_message',
    p_payload || pg_catalog.jsonb_build_object(
      'logId', v_log_id,
      'applicationId', p_application_id,
      'event', p_event,
      'channel', 'whatsapp',
      'sentByName', v_sender
    ),
    'queued'
  )
  returning id into v_job_id;

  return query select 'queued'::text, v_log_id, v_job_id;
end;
$$;

create or replace function public.claim_manual_communication_log(
  p_id uuid,
  p_company_id uuid,
  p_uncertain_error text
)
returns table (out_outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  update public.communication_logs l
     set attempt_started_at = pg_catalog.now()
   where l.id = p_id
     and l.company_id = p_company_id
     and l.channel = 'whatsapp'
     and l.sent_by_name is not null
     and l.status = 'queued'
     and l.attempt_started_at is null;
  if found then
    return query select 'claimed'::text;
    return;
  end if;

  select l.status, l.attempt_started_at
    into r
    from public.communication_logs l
   where l.id = p_id
     and l.company_id = p_company_id
     and l.channel = 'whatsapp'
     and l.sent_by_name is not null
     for update;
  if not found then
    return query select 'missing'::text;
    return;
  end if;
  if r.status = 'queued' and r.attempt_started_at is not null then
    update public.communication_logs
       set status = 'failed', error = p_uncertain_error
     where id = p_id;
    return query select 'uncertain'::text;
    return;
  end if;
  if r.status = 'cancelled' then
    return query select 'stopped'::text;
    return;
  end if;
  return query select 'finished'::text;
end;
$$;

revoke all on function public.claim_manual_communication_log(uuid, uuid, text) from public;
revoke all on function public.claim_manual_communication_log(uuid, uuid, text) from anon, authenticated;
grant execute on function public.claim_manual_communication_log(uuid, uuid, text) to service_role;

revoke all on function public.queue_manual_whatsapp(uuid, uuid, text, text, text, text, jsonb) from public;
revoke all on function public.queue_manual_whatsapp(uuid, uuid, text, text, text, text, jsonb) from anon, authenticated;
grant execute on function public.queue_manual_whatsapp(uuid, uuid, text, text, text, text, jsonb) to service_role;

commit;

-- ── Post-check (read-only) ──────────────────────────────────────────────────
--
--   select p.proname, p.prosecdef, p.proconfig,
--          pg_catalog.has_function_privilege('anon', p.oid, 'execute') as anon_exec,
--          pg_catalog.has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
--          pg_catalog.has_function_privilege('service_role', p.oid, 'execute') as service_exec
--     from pg_catalog.pg_proc p
--     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('queue_manual_whatsapp', 'claim_manual_communication_log');
--
-- Expect two rows, each: prosecdef = true, proconfig = {search_path=""}, anon_exec = false,
-- auth_exec = false, service_exec = true.
