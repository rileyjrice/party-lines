-- 2026-10-28 · Adds the UW undergrads group and the one-time "check your group" flag.
-- Run this by itself in a NEW, empty SQL editor tab. It changes no picks, seals or results.

alter table public.profiles drop constraint if exists profiles_grp_check;
alter table public.profiles add constraint profiles_grp_check check (grp in ('polisci', 'undergrad', 'friends', 'family'));

-- Everyone already in the game is asked once to check their group; new players aren't
alter table public.profiles add column if not exists grp_confirmed boolean not null default false;
alter table public.profiles alter column grp_confirmed set default true;
update public.profiles set grp_confirmed = true where is_admin;

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

-- Check: everyone listed, with grp_confirmed = false except you
select display_name, grp, grp_confirmed from public.profiles order by display_name;
