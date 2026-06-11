-- Pre-production security hardening.
-- Fix 2: lock down the legacy `reports` table (client now reports via backend → sound_reports).
-- Fix 3: make subscriptions.user_id immutable (purchase tokens cannot be moved between accounts).
-- Fix 8: prevent a sound's owner from un-hiding content that moderation auto-hid.

-- ---------------------------------------------------------------------------
-- Fix 2: reports INSERT is service-role only.
-- Content reports now flow through POST /v1/community/report, which writes to
-- sound_reports (the table whose trigger drives trusted-reporter auto-hide).
-- Drop the client INSERT policy so nothing can write `reports` via the anon key.
-- The SELECT-own policy stays so users can still see reports they filed.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can create reports" ON public.reports;

-- ---------------------------------------------------------------------------
-- Fix 3: subscriptions.user_id is immutable.
-- A subscription row must never be reassigned to a different account. The
-- backend already rejects cross-account token reuse; this is the DB-level
-- backstop so a code regression can't silently move an entitlement.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_subscription_user_reassignment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'subscriptions.user_id is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscriptions_user_id_immutable ON public.subscriptions;
CREATE TRIGGER subscriptions_user_id_immutable
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_subscription_user_reassignment();

-- ---------------------------------------------------------------------------
-- Fix 8: owners cannot un-hide moderated content.
-- Once trusted reports auto-hide a community sound (is_hidden = true), the
-- creator must not be able to flip it back. Only service_role / admin paths
-- (auth.uid() IS NULL) may clear the flag, e.g. to reverse a false positive.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_owner_unhide()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.is_hidden = true
     AND COALESCE(NEW.is_hidden, false) = false
     AND auth.uid() = NEW.user_id THEN
    RAISE EXCEPTION 'Cannot unhide moderated content';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS community_sounds_prevent_unhide ON public.community_sounds;
CREATE TRIGGER community_sounds_prevent_unhide
  BEFORE UPDATE ON public.community_sounds
  FOR EACH ROW
  WHEN (OLD.is_hidden IS DISTINCT FROM NEW.is_hidden)
  EXECUTE FUNCTION public.prevent_owner_unhide();
