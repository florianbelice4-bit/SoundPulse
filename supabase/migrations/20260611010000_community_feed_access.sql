-- Community feed access hardening.
-- Fix 4: require authentication to read the public feed (anti-scraping; the app
--        is always signed in to reach Discover, so this is not a UX change).
-- Fix 3: enforce blocking server-side — a blocked creator's sounds are invisible
--        to the blocker even via direct PostgREST calls, not just in the client.
--
-- service_role (the Railway backend) bypasses RLS, so share/pulse/report writes
-- and lookups are unaffected.

DROP POLICY IF EXISTS "community_sounds_select_public" ON public.community_sounds;

CREATE POLICY "community_sounds_select_public"
  ON public.community_sounds FOR SELECT
  TO authenticated
  USING (
    is_public = true
    AND is_hidden = false
    AND NOT EXISTS (
      SELECT 1
      FROM public.blocked_users b
      WHERE b.blocker_id = auth.uid()
        AND b.blocked_id = community_sounds.user_id
    )
  );

-- Index supports the per-request block lookup above.
CREATE INDEX IF NOT EXISTS idx_blocked_users_blocker_blocked
  ON public.blocked_users (blocker_id, blocked_id);
