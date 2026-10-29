-- 2026-10-29 · Players' Forecast: the median margin of all sealed picks in each race.
-- Returns only aggregates (median, counts), never anyone's individual picks.
-- Sealed players and admins can see it any time; everyone else only after picks close.
-- Run this by itself in a NEW, empty SQL editor tab. It changes no data.

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

-- Check: one row per race with its median and how many sealed players picked each side
select * from public.players_forecast() order by race;
