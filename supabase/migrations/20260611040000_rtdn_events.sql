-- Audit log for Google Play Real-Time Developer Notifications (RTDN).
-- Written only by the backend (service_role); RLS on with no policy denies all
-- access to anon/authenticated.

CREATE TABLE IF NOT EXISTS public.rtdn_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_type int NOT NULL,
  purchase_token text NOT NULL,
  subscription_id text,
  event_time_millis bigint,
  raw_payload jsonb NOT NULL,
  processed_at timestamptz DEFAULT now(),
  status text DEFAULT 'processed' CHECK (status IN ('processed', 'failed', 'ignored')),
  error_message text
);

CREATE INDEX IF NOT EXISTS idx_rtdn_events_token ON public.rtdn_events(purchase_token);
CREATE INDEX IF NOT EXISTS idx_rtdn_events_processed_at ON public.rtdn_events(processed_at);

ALTER TABLE public.rtdn_events ENABLE ROW LEVEL SECURITY;
