-- Admin moderation tooling (v1: SQL functions run from the Supabase dashboard,
-- no admin UI). See docs/MODERATION_WORKFLOW.md.
--
-- All functions are SECURITY DEFINER and granted to service_role only; the
-- dashboard SQL editor runs as a superuser and can call them regardless.

CREATE TABLE IF NOT EXISTS public.moderation_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  target_sound_id uuid,
  target_user_id uuid,
  target_report_id uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Audit log: RLS on with no policies => only service_role / postgres can touch it.
ALTER TABLE public.moderation_actions ENABLE ROW LEVEL SECURITY;

-- Hide + unpublish a community sound (reversible; keeps the row for audit).
CREATE OR REPLACE FUNCTION public.admin_remove_content(p_sound_id uuid, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.community_sounds
  SET is_hidden = true, is_public = false
  WHERE id = p_sound_id;

  INSERT INTO public.moderation_actions(action, target_sound_id, reason)
  VALUES ('remove_content', p_sound_id, p_reason);
END;
$$;

-- Hide all of a user's community content. Full account removal (revoking access)
-- is done via the Supabase auth dashboard or DELETE /v1/account, not here.
CREATE OR REPLACE FUNCTION public.admin_ban_user(p_user_id uuid, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.community_sounds
  SET is_hidden = true, is_public = false
  WHERE user_id = p_user_id;

  INSERT INTO public.moderation_actions(action, target_user_id, reason)
  VALUES ('ban_user', p_user_id, p_reason);
END;
$$;

-- Resolve a report: 'reviewed' (looked at, no action), 'dismissed' (false report),
-- or 'actioned' (content removed).
CREATE OR REPLACE FUNCTION public.admin_review_report(p_report_id uuid, p_decision text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_decision NOT IN ('reviewed', 'dismissed', 'actioned') THEN
    RAISE EXCEPTION 'invalid decision: % (use reviewed | dismissed | actioned)', p_decision;
  END IF;

  UPDATE public.sound_reports
  SET status = p_decision
  WHERE id = p_report_id;

  INSERT INTO public.moderation_actions(action, target_report_id, reason)
  VALUES ('review_report', p_report_id, p_decision);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_remove_content(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_ban_user(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_review_report(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_remove_content(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_ban_user(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_review_report(uuid, text) TO service_role;
