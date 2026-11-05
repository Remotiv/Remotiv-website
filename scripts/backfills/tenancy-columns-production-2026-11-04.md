# Tenancy columns and keys, read from production (2026-11-04)

## Source

- **Where:** PRODUCTION, read on **2026-11-04** by Waleed in the Supabase SQL editor.
- **What:** `information_schema` and `pg_catalog` only. Read-only, and no row data was read.
- **Why it matters:** this is the first citable schema source for the 12 dashboard tables
  that no migration in `src/lib/supabase/migrations/` creates. That folder starts at `001`,
  and these tables predate it:
  - `application_scores`, `application_stage_history`, `communication_logs`, `communication_opt_outs`
  - `interview_answer_scores`, `interview_answers`, `interview_bookings`, `interview_notes`
  - `interview_session_scores`, `interview_sessions`, `notifications_company`, `whatsapp_inbound`
- **`schema.sql` is still not an authority, and this file does not make it one.** It remains
  an untracked pg_dump of unknown date (see AGENTS.md). Nothing here was compared against it,
  and nothing should be read out of it on the strength of this file.

The three queries and their results are recorded verbatim, in the order they were run.

## Query 1: tenancy-relevant columns

```sql
select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and table_name in (
    'interview_answers','interview_sessions','interview_bookings','application_scores',
    'application_stage_history','communication_logs','communication_opt_outs',
    'interview_answer_scores','interview_notes','interview_session_scores',
    'notifications_company','whatsapp_inbound'
  )
  and column_name in (
    'company_id','company_id_snapshot','application_id','session_id','job_id','kind','session_kind'
  )
order by table_name, column_name;
```

### Result 1

```
application_scores        | application_id
application_scores        | company_id
application_scores        | job_id
application_stage_history | application_id
application_stage_history | company_id
communication_logs        | application_id
communication_logs        | company_id
communication_opt_outs    | company_id
interview_answer_scores   | company_id
interview_answer_scores   | session_id
interview_answers         | session_id
interview_bookings        | application_id
interview_bookings        | company_id
interview_bookings        | job_id
interview_notes           | company_id
interview_notes           | session_id
interview_session_scores  | company_id
interview_session_scores  | session_id
interview_sessions        | application_id
interview_sessions        | company_id
interview_sessions        | job_id
interview_sessions        | kind
notifications_company     | application_id
notifications_company     | company_id
notifications_company     | job_id
whatsapp_inbound          | application_id
whatsapp_inbound          | company_id
```

**How to read an absence:** the query asked only for those seven column names. A column
missing here means "not one of these seven", never "no such column". For example,
`communication_opt_outs` has no `application_id` among them, which says nothing about any
other column it has.

## Query 2: foreign keys via information_schema (do not use for column pairs)

```sql
select tc.table_name, kcu.column_name, ccu.table_name as parent_table,
       ccu.column_name as parent_column
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'
  and tc.table_name in ('interview_answers','interview_turns')
order by tc.table_name, kcu.column_name;
```

### Result 2

```
interview_answers | question_id         | interview_questions | id
interview_answers | session_id          | interview_sessions  | id
interview_turns   | responds_to_turn_id | interview_turns     | id
interview_turns   | responds_to_turn_id | interview_turns     | session_id
interview_turns   | session_id          | interview_turns     | id
interview_turns   | session_id          | interview_turns     | session_id
interview_turns   | session_id          | interview_sessions  | id
interview_turns   | session_id          | interview_sessions  | kind
interview_turns   | session_kind        | interview_sessions  | id
interview_turns   | session_kind        | interview_sessions  | kind
```

> **WARNING: this output is a cross product. Do not read column pairs from it.**
>
> - **Why:** the query joins child columns to parent columns on `constraint_name` alone, with
>   no ordinal position, so a composite FK prints every child column against every parent column.
> - **The 10 rows come from FOUR constraints, not ten and not three:**
>   - `interview_answers.question_id`: 1 row;
>   - `interview_answers.session_id`: 1 row;
>   - the composite `interview_turns -> interview_sessions`: 4 rows (2 columns x 2 columns);
>   - the composite `interview_turns -> interview_turns`: 4 rows.
> - Three of the four are the session and turn relationships; the fourth is the question FK.
> - **Read literally, the output claims `session_id` references `interview_sessions.kind`,
>   which is FALSE.**
> - **Anyone re-running this query gets the same artifact.** Query 3 is the one that gives
>   ordered pairs.

## Query 3: ordered keys (the authority for column pairs and unique keys)

```sql
select c.conrelid::regclass::text as child_table, c.conname, c.contype, k.ord,
       ca.attname as child_column,
       case when c.contype = 'f' then c.confrelid::regclass::text end as parent_table,
       pa.attname as parent_column
from pg_constraint c
join lateral unnest(c.conkey) with ordinality as k(attnum, ord) on true
join pg_attribute ca on ca.attrelid = c.conrelid and ca.attnum = k.attnum
left join pg_attribute pa on c.contype = 'f' and pa.attrelid = c.confrelid
                         and pa.attnum = c.confkey[k.ord]
where c.contype in ('f','p','u')
  and c.conrelid in ('public.interview_answers'::regclass,
                     'public.interview_turns'::regclass,
                     'public.interview_sessions'::regclass)
order by child_table, c.conname, k.ord;
```

### Result 3

```
interview_answers  | interview_answers_pkey                    | p | 1 | id                  | null                | null
interview_answers  | interview_answers_question_id_fkey        | f | 1 | question_id         | interview_questions | id
interview_answers  | interview_answers_session_id_fkey         | f | 1 | session_id          | interview_sessions  | id
interview_answers  | interview_answers_session_id_position_key | u | 1 | session_id          | null                | null
interview_answers  | interview_answers_session_id_position_key | u | 2 | position            | null                | null
interview_sessions | interview_sessions_application_id_fkey    | f | 1 | application_id      | job_applications    | id
interview_sessions | interview_sessions_company_id_fkey        | f | 1 | company_id          | companies           | id
interview_sessions | interview_sessions_id_kind_key            | u | 1 | id                  | null                | null
interview_sessions | interview_sessions_id_kind_key            | u | 2 | kind                | null                | null
interview_sessions | interview_sessions_job_id_fkey            | f | 1 | job_id              | jobs                | id
interview_sessions | interview_sessions_pkey                   | p | 1 | id                  | null                | null
interview_sessions | interview_sessions_previous_attempt_fk    | f | 1 | previous_attempt_id | interview_sessions  | id
interview_sessions | interview_sessions_token_hash_key         | u | 1 | token_hash          | null                | null
interview_turns    | interview_turns_id_session_key            | u | 1 | id                  | null                | null
interview_turns    | interview_turns_id_session_key            | u | 2 | session_id          | null                | null
interview_turns    | interview_turns_pkey                      | p | 1 | id                  | null                | null
interview_turns    | interview_turns_provider_turn_key         | u | 1 | session_id          | null                | null
interview_turns    | interview_turns_provider_turn_key         | u | 2 | provider_turn_id    | null                | null
interview_turns    | interview_turns_responds_to_fk            | f | 1 | responds_to_turn_id | interview_turns     | id
interview_turns    | interview_turns_responds_to_fk            | f | 2 | session_id          | interview_turns     | session_id
interview_turns    | interview_turns_sequence_key              | u | 1 | session_id          | null                | null
interview_turns    | interview_turns_sequence_key              | u | 2 | sequence            | null                | null
interview_turns    | interview_turns_session_fk                | f | 1 | session_id          | interview_sessions  | id
interview_turns    | interview_turns_session_fk                | f | 2 | session_kind        | interview_sessions  | kind
```

## Settled from Query 3

### The four foreign keys of interview_answers and interview_turns, in ordered pairs

| Constraint | Child column(s), in order | Parent column(s), in order |
|---|---|---|
| `interview_answers_session_id_fkey` | `interview_answers (session_id)` | `interview_sessions (id)` (single column) |
| `interview_answers_question_id_fkey` | `interview_answers (question_id)` | `interview_questions (id)` (single column) |
| `interview_turns_session_fk` | `interview_turns (session_id, session_kind)` | `interview_sessions (id, kind)` |
| `interview_turns_responds_to_fk` | `interview_turns (responds_to_turn_id, session_id)` | `interview_turns (id, session_id)` |

The last row matches `021_interview_turns.sql:123-125`. An earlier note on this item had its two
columns the other way round; production agrees with the migration.

### Other keys read in Query 3

- **Primary keys, each on `id` alone:**
  - `interview_sessions_pkey`: so a `session_id` identifies exactly one session.
  - `interview_answers_pkey`
  - `interview_turns_pkey`
- **The other foreign keys of `interview_sessions`, all single column:**
  - `application_id` -> `job_applications (id)`
  - `company_id` -> `companies (id)`
  - `job_id` -> `jobs (id)`
  - `previous_attempt_id` -> `interview_sessions (id)` (`interview_sessions_previous_attempt_fk`)
- **Unique keys:**

| Unique key | Columns, in order |
|---|---|
| `interview_answers_session_id_position_key` | `(session_id, position)` |
| `interview_sessions_id_kind_key` | `(id, kind)` |
| `interview_sessions_token_hash_key` | `(token_hash)` |
| `interview_turns_id_session_key` | `(id, session_id)` |
| `interview_turns_provider_turn_key` | `(session_id, provider_turn_id)` |
| `interview_turns_sequence_key` | `(session_id, sequence)` |

- **Why `interview_sessions_id_kind_key` exists:** it is the target that
  `interview_turns_session_fk` requires. It is not evidence that `kind` is needed for tenant
  isolation; `id` alone is already the primary key.
