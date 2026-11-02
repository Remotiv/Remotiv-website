-- Everything a fixture INSERT into interview_sessions or interview_turns must
-- satisfy, in one read-only query: columns (type, nullability, default),
-- CHECK / UNIQUE / PRIMARY KEY / FOREIGN KEY constraints with definitions
-- (a foreign key's definition carries its target and ON DELETE action),
-- unique indexes not backed by a constraint, foreign keys FROM other tables
-- (the cascade's children), non-internal triggers, and each trigger
-- function's body. Catalog metadata only; no row data.
with t(rel) as (values ('public.interview_sessions'::regclass), ('public.interview_turns'::regclass))
select rel::text as table_name, 'column' as kind, a.attname as name,
       format_type(a.atttypid, a.atttypmod)
         || case when a.attnotnull then ' NOT NULL' else ' null' end
         || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '') as definition,
       a.attnum as ord
from t join pg_attribute a on a.attrelid = t.rel and a.attnum > 0 and not a.attisdropped
left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
union all
select rel::text,
       case c.contype when 'c' then 'check' when 'u' then 'unique' when 'p' then 'primary key' when 'f' then 'foreign key' end,
       c.conname, pg_get_constraintdef(c.oid), 1000
from t join pg_constraint c on c.conrelid = t.rel and c.contype in ('c','u','p','f')
union all
select rel::text, 'unique index', i.indexrelid::regclass::text, pg_get_indexdef(i.indexrelid), 2000
from t join pg_index i on i.indrelid = t.rel and i.indisunique
where not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid)
union all
select rel::text, 'referenced by', c.conrelid::regclass::text || '.' || c.conname, pg_get_constraintdef(c.oid), 2500
from t join pg_constraint c on c.confrelid = t.rel and c.contype = 'f'
union all
select rel::text, 'trigger', tg.tgname, pg_get_triggerdef(tg.oid), 3000
from t join pg_trigger tg on tg.tgrelid = t.rel and not tg.tgisinternal
union all
select rel::text, 'trigger function', p.proname, pg_get_functiondef(p.oid), 4000
from t join pg_trigger tg on tg.tgrelid = t.rel and not tg.tgisinternal
join pg_proc p on p.oid = tg.tgfoid
order by 1, 5, 2, 3;
