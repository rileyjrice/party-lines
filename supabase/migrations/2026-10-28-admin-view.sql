-- 2026-10-28 · Lets admins read every SEALED player's picks without sealing their own (for troubleshooting).
-- Unsealed picks stay private. Run this by itself in a NEW, empty SQL editor tab. It changes no data.

drop policy if exists "read own or mutually sealed picks" on public.picks;
create policy "read own or mutually sealed picks" on public.picks
  for select to authenticated
  using (user_id = (select auth.uid()) or (sealed and (private.i_have_sealed() or private.is_admin())));
