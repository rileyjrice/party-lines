-- Late entry: lets an admin give one player extra time to enter and seal picks after the deadline.
-- Run this by itself in a NEW, empty SQL editor tab. It changes no picks.
-- Then grant a window with (not stored in the repo):
--   insert into private.late_entry (user_id, until)
--   values ((select id from auth.users where email = '...'), now() + interval '2 hours')
--   on conflict (user_id) do update set until = excluded.until;

create table if not exists private.late_entry (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  until timestamptz not null
);
alter table private.late_entry enable row level security; -- read only by the security-definer functions below

-- This player's own deadline: the game deadline, or their late-entry window if it's later
create or replace function private.deadline_for(u uuid) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select greatest(
    (select pick_deadline from private.game_settings where id = 1),
    (select until from private.late_entry where user_id = u)
  );
$$;

create or replace function public.my_deadline() returns timestamptz
language sql stable security definer set search_path = '' as $$
  select private.deadline_for((select auth.uid()));
$$;
revoke execute on function public.my_deadline() from public, anon;
grant execute on function public.my_deadline() to authenticated;

create or replace function private.picks_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  deadline timestamptz;
begin
  if tg_op = 'UPDATE' and old.sealed then
    raise exception 'These picks are sealed and can''t be changed.';
  end if;
  deadline := private.deadline_for(new.user_id);
  if deadline is not null and now() >= deadline then
    raise exception 'The pick deadline (Tue Nov 3, 6:00 p.m. ET) has passed.';
  end if;
  perform private.check_races(new.races, new.sealed);
  new.sealed_at := case when new.sealed then now() else null end; -- server time, not the client's
  new.updated_at := now();
  return new;
end;
$$;
