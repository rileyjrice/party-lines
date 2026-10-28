-- 2026-10-28 · Adds model benchmarks (Silver Bulletin, FiftyPlusOne) shown on the leaderboard but not ranked.
-- Run this by itself in a NEW, empty SQL editor tab. It changes no picks, seals or results.

-- True once picks have closed (security definer so policies can read the private deadline)
create or replace function private.past_deadline() returns boolean
language sql stable security definer set search_path = '' as $$
  select now() >= coalesce((select pick_deadline from private.game_settings where id = 1), 'infinity'::timestamptz);
$$;
grant execute on function private.past_deadline() to authenticated;

create table if not exists public.benchmarks (
  id text primary key check (id in ('silver', 'fiftyplusone')),
  name text not null,
  races jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.benchmarks (id, name) values
  ('silver', 'Silver Bulletin'),
  ('fiftyplusone', 'FiftyPlusOne')
on conflict (id) do nothing;

create or replace function private.benchmarks_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_races(new.races, false);
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists benchmarks_guard on public.benchmarks;
create trigger benchmarks_guard before insert or update on public.benchmarks
  for each row execute function private.benchmarks_guard();

alter table public.benchmarks enable row level security;
revoke all on public.benchmarks from anon;
revoke insert, delete, truncate on public.benchmarks from authenticated;

-- Players see the models only after picks close; admins can see and edit them any time
drop policy if exists "read benchmarks" on public.benchmarks;
create policy "read benchmarks" on public.benchmarks
  for select to authenticated
  using (private.is_admin() or (private.is_member() and private.past_deadline()));

drop policy if exists "admins update benchmarks" on public.benchmarks;
create policy "admins update benchmarks" on public.benchmarks
  for update to authenticated
  using (private.is_admin()) with check (private.is_admin());

do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'benchmarks') then
    alter publication supabase_realtime add table public.benchmarks;
  end if;
end;
$$;

-- Check: two rows, both with empty races
select id, name, races from public.benchmarks order by id;
