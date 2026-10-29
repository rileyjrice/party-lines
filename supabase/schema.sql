-- PARTY LINES 2026 · Supabase schema
-- Paste this whole file into the Supabase SQL editor and run it. It is safe to run again.
-- The game password is NOT set here; set it separately in the SQL editor so it never lands in the repo:
--   update private.game_settings set join_code_hash = extensions.crypt('YOUR-PASSWORD', extensions.gen_salt('bf')) where id = 1;

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Private schema: not exposed through the API, no table grants to clients
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated; -- only so RLS policies can call the helper functions below

create table if not exists private.game_settings (
  id int primary key default 1 check (id = 1),
  join_code_hash text,                                              -- bcrypt hash, set by hand
  pick_deadline timestamptz not null default '2026-11-03 23:00:00+00' -- Tue Nov 3, 6:00 p.m. ET
);
insert into private.game_settings (id) values (1) on conflict (id) do nothing;

create table if not exists private.join_attempts (
  user_id uuid not null,
  at timestamptz not null default now()
);

alter table private.game_settings enable row level security;
alter table private.join_attempts enable row level security;
revoke all on all tables in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 40),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);
-- grp: which sub-leaderboard you're in, besides the overall one. Players can change it any time.
alter table public.profiles add column if not exists grp text not null default 'friends';
alter table public.profiles drop constraint if exists profiles_grp_check;
alter table public.profiles add constraint profiles_grp_check check (grp in ('polisci', 'undergrad', 'friends', 'family'));
-- grp_confirmed: false for people who joined before the groups changed, so the page asks them to check theirs once
alter table public.profiles add column if not exists grp_confirmed boolean not null default false;
alter table public.profiles alter column grp_confirmed set default true;
create unique index if not exists profiles_display_name_unique on public.profiles (lower(btrim(display_name)));

-- races: { "GA": { "side": "L" | "R", "pts": 3.5 }, ... }
create table if not exists public.picks (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  races jsonb not null default '{}'::jsonb,
  sealed boolean not null default false,
  sealed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.results (
  id int primary key default 1 check (id = 1),
  races jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
-- final: set by an admin once every race is in, so the leaderboard can say the standings are final
alter table public.results add column if not exists final boolean not null default false;
insert into public.results (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Helpers (security definer so policies can look things up without recursion)
-- ---------------------------------------------------------------------------
create or replace function private.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()));
$$;

create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select is_admin from public.profiles where id = (select auth.uid())), false);
$$;

create or replace function private.i_have_sealed() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select sealed from public.picks where user_id = (select auth.uid())), false);
$$;

create or replace function private.race_ids() returns text[]
language sql immutable set search_path = '' as $$
  select array['AK','FL','GA','IA','KS','ME','MI','MN','MS','MT','NE','NH','NC','OH','SC','TX'];
$$;

-- Signed margin, matching signed() in the app: L is negative, R positive, null if incomplete
create or replace function private.signed(p jsonb) returns numeric
language sql immutable set search_path = '' as $$
  select case
    when p is null or jsonb_typeof(p -> 'pts') is distinct from 'number' then null
    when abs((p ->> 'pts')::numeric) = 0 then 0
    when p ->> 'side' = 'L' then -abs((p ->> 'pts')::numeric)
    when p ->> 'side' = 'R' then abs((p ->> 'pts')::numeric)
  end;
$$;

-- Winner of a signed margin, matching the app: under 0.05 counts as a tie
create or replace function private.sgn(v numeric) returns int
language sql immutable set search_path = '' as $$
  select case when abs(v) < 0.05 then 0 else sign(v)::int end;
$$;

-- Validates the races object; with complete = true every race needs a winner and a margin above 0
create or replace function private.check_races(r jsonb, complete boolean) returns void
language plpgsql stable set search_path = '' as $$
declare
  k text;
  v jsonb;
begin
  if r is null or jsonb_typeof(r) <> 'object' then
    raise exception 'races must be a JSON object';
  end if;
  for k, v in select * from jsonb_each(r) loop
    if not (k = any (private.race_ids())) then
      raise exception 'Unknown race: %', k;
    end if;
    if jsonb_typeof(v) <> 'object' then
      raise exception 'Race % must be an object', k;
    end if;
    if jsonb_typeof(v -> 'side') = 'string' and v ->> 'side' not in ('L', 'R') then
      raise exception 'Race %: side must be L or R', k;
    end if;
    if v ? 'side' and jsonb_typeof(v -> 'side') not in ('string', 'null') then
      raise exception 'Race %: side must be L or R', k;
    end if;
    if v ? 'pts' and jsonb_typeof(v -> 'pts') <> 'null' then
      if jsonb_typeof(v -> 'pts') <> 'number' or (v ->> 'pts')::numeric not between 0 and 99 then
        raise exception 'Race %: margin must be a number from 0 to 99', k;
      end if;
    end if;
  end loop;
  if complete then
    foreach k in array private.race_ids() loop
      v := r -> k;
      if v is null
         or coalesce(v ->> 'side', '') not in ('L', 'R')
         or jsonb_typeof(v -> 'pts') is distinct from 'number'
         or (v ->> 'pts')::numeric <= 0 then
        raise exception 'Every race needs a winner and a margin before sealing (% is missing)', k;
      end if;
    end loop;
  end if;
end;
$$;

grant execute on function private.is_member(), private.is_admin(), private.i_have_sealed() to authenticated;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create or replace function private.picks_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  deadline timestamptz;
begin
  if tg_op = 'UPDATE' and old.sealed then
    raise exception 'These picks are sealed and can''t be changed.';
  end if;
  select pick_deadline into deadline from private.game_settings where id = 1;
  if deadline is not null and now() >= deadline then
    raise exception 'The pick deadline (Tue Nov 3, 6:00 p.m. ET) has passed.';
  end if;
  perform private.check_races(new.races, new.sealed);
  new.sealed_at := case when new.sealed then now() else null end; -- server time, not the client's
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists picks_guard on public.picks;
create trigger picks_guard before insert or update on public.picks
  for each row execute function private.picks_guard();

create or replace function private.results_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_races(new.races, false);
  new.updated_at := now();
  new.updated_by := (select auth.uid());
  return new;
end;
$$;

drop trigger if exists results_guard on public.results;
create trigger results_guard before insert or update on public.results
  for each row execute function private.results_guard();

-- Family was merged into Friends & Family; an old cached page may still send 'family'
create or replace function private.normalize_grp() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.grp = 'family' then new.grp := 'friends'; end if;
  return new;
end;
$$;

drop trigger if exists profiles_normalize_grp on public.profiles;
create trigger profiles_normalize_grp before insert or update of grp on public.profiles
  for each row execute function private.normalize_grp();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.picks enable row level security;
alter table public.results enable row level security;

revoke all on public.profiles, public.picks, public.results from anon;
revoke insert, update, delete, truncate on public.profiles from authenticated;
revoke delete, truncate on public.picks from authenticated;
revoke insert, delete, truncate on public.results from authenticated;

-- profiles: members see everyone's name; rows are only created by join_game(); is_admin is set by hand
drop policy if exists "members read profiles" on public.profiles;
create policy "members read profiles" on public.profiles
  for select to authenticated using (private.is_member());

-- picks: your own row always; someone else's only when you've both sealed (admins can read any sealed row)
drop policy if exists "read own or mutually sealed picks" on public.picks;
create policy "read own or mutually sealed picks" on public.picks
  for select to authenticated
  using (user_id = (select auth.uid()) or (sealed and (private.i_have_sealed() or private.is_admin())));

drop policy if exists "insert own picks" on public.picks;
create policy "insert own picks" on public.picks
  for insert to authenticated
  with check (user_id = (select auth.uid()) and private.is_member());

drop policy if exists "update own unsealed picks" on public.picks;
create policy "update own unsealed picks" on public.picks
  for update to authenticated
  using (user_id = (select auth.uid()) and not sealed)
  with check (user_id = (select auth.uid()));

-- results: members read, admins write
drop policy if exists "members read results" on public.results;
create policy "members read results" on public.results
  for select to authenticated using (private.is_member());

drop policy if exists "admins update results" on public.results;
create policy "admins update results" on public.results
  for update to authenticated
  using (private.is_admin()) with check (private.is_admin());

-- ---------------------------------------------------------------------------
-- RPC functions
-- ---------------------------------------------------------------------------
-- Functions whose arguments or columns changed since the first version
drop function if exists public.join_game(text, text);
drop function if exists public.list_players();
drop function if exists public.leaderboard();

-- Checks the game password on the server and creates the caller's profile.
-- Returns { ok: true } or { ok: false, error: "..." }. Five wrong tries locks you out for 15 minutes.
create or replace function public.join_game(display_name text, code text, grp text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  v_name text := btrim(coalesce(join_game.display_name, ''));
  h text;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'error', 'Sign in first.');
  end if;
  if exists (select 1 from public.profiles p where p.id = uid) then
    return jsonb_build_object('ok', true);
  end if;
  if (select count(*) from private.join_attempts a
      where a.user_id = uid and a.at > now() - interval '15 minutes') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong tries. Wait 15 minutes and try again.');
  end if;
  if char_length(v_name) not between 1 and 40 then
    return jsonb_build_object('ok', false, 'error', 'Pick a display name of 1 to 40 characters.');
  end if;
  if join_game.grp is null or join_game.grp not in ('polisci', 'undergrad', 'friends', 'family') then
    return jsonb_build_object('ok', false, 'error', 'Choose the group that fits you best.');
  end if;
  select s.join_code_hash into h from private.game_settings s where s.id = 1;
  if h is null then
    return jsonb_build_object('ok', false, 'error', 'The game password hasn''t been set yet.');
  end if;
  if join_game.code is null or extensions.crypt(join_game.code, h) <> h then
    insert into private.join_attempts (user_id) values (uid);
    return jsonb_build_object('ok', false, 'error', 'Wrong game password.');
  end if;
  begin
    insert into public.profiles (id, display_name, grp) values (uid, v_name, join_game.grp);
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'That name is taken. Try another.');
  end;
  return jsonb_build_object('ok', true);
end;
$$;

-- Changes the caller's group (which sub-leaderboard they're in)
create or replace function public.set_group(grp text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if set_group.grp is null or set_group.grp not in ('polisci', 'undergrad', 'friends', 'family') then
    return jsonb_build_object('ok', false, 'error', 'Unknown group.');
  end if;
  update public.profiles p set grp = set_group.grp, grp_confirmed = true where p.id = auth.uid();
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Join the game first.');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- Everyone's name, group and seal status, without their picks
create or replace function public.list_players()
returns table (id uuid, display_name text, is_admin boolean, grp text, sealed boolean, sealed_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select p.id, p.display_name, p.is_admin, p.grp, coalesce(k.sealed, false), k.sealed_at
  from public.profiles p
  left join public.picks k on k.user_id = p.id
  where private.is_member()
  order by lower(p.display_name);
$$;

-- Scores for every sealed player, without exposing their picks.
-- called: races where the pick's winner matches the result. avg_miss: mean |pick - result|, Montana excluded.
create or replace function public.leaderboard()
returns table (id uuid, display_name text, grp text, races_in int, called int, scored int, avg_miss numeric)
language sql stable security definer set search_path = '' as $$
  with res as (
    select e.key as st, private.signed(e.value) as v
    from public.results r, jsonb_each(r.races) e
    where r.id = 1 and private.signed(e.value) is not null
  ),
  hits as (
    select k.user_id, res.st, private.signed(k.races -> res.st) as g, res.v
    from public.picks k
    join res on true
    where k.sealed and private.signed(k.races -> res.st) is not null
  )
  select p.id, p.display_name, p.grp,
    (select count(*) from res)::int,
    (count(h.st) filter (where private.sgn(h.g) = private.sgn(h.v)))::int,
    (count(h.st))::int,
    avg(abs(h.g - h.v)) filter (where h.st <> 'MT')
  from public.profiles p
  join public.picks k on k.user_id = p.id and k.sealed
  left join hits h on h.user_id = p.id
  where private.is_member()
  group by p.id, p.display_name, p.grp;
$$;

revoke execute on function public.join_game(text, text, text), public.set_group(text), public.list_players(), public.leaderboard() from public, anon;
grant execute on function public.join_game(text, text, text), public.set_group(text), public.list_players(), public.leaderboard() to authenticated;

-- ---------------------------------------------------------------------------
-- Model benchmarks (shown on the leaderboard for comparison, never ranked)
-- ---------------------------------------------------------------------------
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

-- Players' Forecast: per-race median of sealed picks (aggregates only)
create or replace function public.players_forecast()
returns table (race text, median numeric, n int, n_left int, n_right int)
language sql stable security definer set search_path = '' as $$
  with v as (
    select e.key as race, private.signed(e.value) as m
    from public.picks k, jsonb_each(k.races) e
    where k.sealed and private.signed(e.value) is not null
  )
  select v.race,
    (percentile_cont(0.5) within group (order by v.m))::numeric,
    count(*)::int,
    (count(*) filter (where v.m <= -0.05))::int,
    (count(*) filter (where v.m >= 0.05))::int
  from v
  where private.is_member() and (private.i_have_sealed() or private.is_admin() or private.past_deadline())
  group by v.race;
$$;

revoke execute on function public.players_forecast() from public, anon;
grant execute on function public.players_forecast() to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime (RLS still applies to what each client receives)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['profiles', 'picks', 'results'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
