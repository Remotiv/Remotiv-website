-- 054 proof P2: status-only write on a STAMPED session passes. Expect PASS, 1 row.
drop table if exists p_result;
create temp table p_result(proof text, outcome text, detail text);
do $$
declare v_company uuid; v_session uuid; v_q uuid; v_c uuid; n int; r text;
begin
  begin
    select id into v_company from public.companies limit 1;
    if v_company is null then
      raise exception using errcode = 'P0054',
        message = 'NOFIXTURE: no company row to own the fixture';
    end if;
    insert into public.interview_sessions
      (company_id, token_hash, status, expires_at, kind, live_settings,
       attempt, delete_after, purged_at, invited_by_name)
    values
      (v_company, encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 'submitted',
       now() + interval '7 days', 'live', '{}'::jsonb,
       1, now() + interval '60 days', null, 'fixture-054')
    returning id into v_session;
    insert into public.interview_turns
      (session_id, provider_turn_id, sequence, speaker, kind, question_position, text,
       media_path, media_mime_type, media_bytes, media_sha256,
       offset_ms, duration_ms, started_at, ended_at)
    values
      (v_session, 'fx054-i1', 1, 'interviewer', 'base_question', 1, 'fixture question',
       v_session::text || '/t1.wav', 'audio/wav', 1, repeat('0', 64),
       0, 1000, now(), now())
    returning id into v_q;
    insert into public.interview_turns
      (session_id, provider_turn_id, sequence, speaker, responds_to_turn_id,
       transcript, transcript_status,
       media_path, media_mime_type, media_bytes, media_sha256,
       offset_ms, duration_ms, started_at, ended_at)
    values
      (v_session, 'fx054-c2', 2, 'candidate', v_q,
       null, 'pending',
       v_session::text || '/t2.wav', 'audio/wav', 1, repeat('0', 64),
       1000, 1000, now(), now())
    returning id into v_c;
    -- age it: stamped
    update public.interview_sessions
       set expires_at = now() - interval '2 days',
           delete_after = now() - interval '1 day',
           purged_at = now() - interval '1 hour'
     where id = v_session;
    -- probe
    begin
      update public.interview_turns set transcript_status = 'failed' where id = v_c;
      get diagnostics n = row_count;
      r := case when n > 0
                then format('PASS: status-only update landed, %s row(s), rolled back', n)
                else 'OTHER: update matched 0 rows' end;
    exception
      when sqlstate 'RT063' then
        r := 'REFUTED: RT063 on a status-only write ' || left(sqlerrm, 220);
      when others then r := 'OTHER ' || sqlstate || ' ' || left(sqlerrm, 220);
    end;
    -- the only exit: rolls back fixture and probe
    raise exception using errcode = 'P0054', message = r;
  exception
    when sqlstate 'P0054' then
      insert into p_result values ('P2', rtrim(split_part(sqlerrm, ' ', 1), ':'), sqlerrm);
    when others then
      insert into p_result values ('P2', 'FIXTURE ERROR', sqlstate || ' ' || left(sqlerrm, 220));
  end;
end $$;
select * from p_result;
