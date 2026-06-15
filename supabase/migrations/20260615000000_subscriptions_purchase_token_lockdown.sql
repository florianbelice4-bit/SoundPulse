-- Defense-in-depth: make subscriptions.purchase_token unreadable by the client
-- roles (authenticated / anon) via column-level privileges.
--
-- Context: the actual hijack vector was already closed earlier (subscriptions
-- .user_id is immutable + the backend rejects cross-account token reuse), and no
-- client code reads purchase_token (verified). This layer ensures even a crafted
-- PostgREST query (e.g. ?select=purchase_token) is denied at the privilege level.
--
-- Mechanism: replace the blanket table SELECT with a column-scoped SELECT on
-- every column EXCEPT purchase_token. This is deliberately NOT a view + blanket
-- REVOKE: row-level security (subscriptions_select_own) and service_role access
-- are left completely unchanged, so premium detection, the profile screen,
-- restore-purchases, and the backend (service_role, RTDN) keep working exactly as
-- before. The only behavior change is that purchase_token is no longer selectable
-- by clients.
--
-- Columns are enumerated dynamically from the live schema so none is accidentally
-- omitted (an omitted column would become unreadable). New columns added in
-- future migrations must be granted by those migrations.

DO $$
DECLARE
  safe_cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
  INTO safe_cols
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'subscriptions'
    AND column_name <> 'purchase_token';

  IF safe_cols IS NULL THEN
    RAISE EXCEPTION 'subscriptions table not found; aborting token lockdown';
  END IF;

  -- Swap blanket SELECT for column-scoped SELECT (everything but the token).
  -- service_role is intentionally untouched and keeps full access.
  REVOKE SELECT ON public.subscriptions FROM authenticated, anon;
  EXECUTE format('GRANT SELECT (%s) ON public.subscriptions TO authenticated, anon', safe_cols);
END $$;

-- Pick up the privilege change immediately in PostgREST.
NOTIFY pgrst, 'reload schema';
