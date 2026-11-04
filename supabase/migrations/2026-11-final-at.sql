-- Records when an admin marks results final, for the "Thanks for playing" banner.
-- Run this by itself in a NEW, empty SQL editor tab. It changes no results.

alter table public.results add column if not exists final_at timestamptz;
-- If results were already marked final before this ran, use the last update time
update public.results set final_at = updated_at where final and final_at is null;

create or replace function private.results_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_races(new.races, false);
  new.updated_at := now();
  new.updated_by := (select auth.uid());
  -- Stamp the moment results are marked final (server time); clear it on reopen
  if new.final and (tg_op = 'INSERT' or not old.final) then new.final_at := now();
  elsif not new.final then new.final_at := null;
  elsif tg_op = 'UPDATE' then new.final_at := old.final_at;
  end if;
  return new;
end;
$$;
