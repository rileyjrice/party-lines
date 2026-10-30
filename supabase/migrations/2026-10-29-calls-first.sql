-- 2026-10-29 · Calls first: a result with a winner but no margin yet counts toward winners called
-- (and races called), and joins average miss once its margin is entered.
-- Run this by itself in a NEW, empty SQL editor tab. It changes no data.

create or replace function public.leaderboard()
returns table (id uuid, display_name text, grp text, races_in int, called int, scored int, avg_miss numeric)
language sql stable security definer set search_path = '' as $$
  with res as (
    -- w: the winner (-1 Dem/Ind, 1 Rep, 0 even), from the margin if there is one, otherwise from the call alone
    select e.key as st, private.signed(e.value) as v,
      case when private.signed(e.value) is not null then private.sgn(private.signed(e.value))
           when e.value ->> 'side' = 'L' then -1
           when e.value ->> 'side' = 'R' then 1 end as w
    from public.results r, jsonb_each(r.races) e
    where r.id = 1
  ),
  called as (select * from res where w is not null),
  hits as (
    select k.user_id, c.st, private.signed(k.races -> c.st) as g, c.v, c.w
    from public.picks k
    join called c on true
    where k.sealed and private.signed(k.races -> c.st) is not null
  )
  select p.id, p.display_name, p.grp,
    (select count(*) from called)::int,
    (count(h.st) filter (where private.sgn(h.g) = h.w))::int,
    (count(h.st))::int,
    avg(abs(h.g - h.v)) filter (where h.st <> 'MT' and h.v is not null)
  from public.profiles p
  join public.picks k on k.user_id = p.id and k.sealed
  left join hits h on h.user_id = p.id
  where private.is_member()
  group by p.id, p.display_name, p.grp;
$$;
