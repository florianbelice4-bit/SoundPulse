# Moderation Workflow (v1)

SoundPulse v1 has no admin UI. Moderation is done from the **Supabase dashboard
→ SQL editor**, using the helper functions in
`supabase/migrations/20260611030000_moderation_admin.sql`.

## How content gets hidden automatically

- Users report sounds via the app → `POST /v1/community/report` → a row in
  `sound_reports` (reporters must have a verified email and a 24h-old account).
- A trigger (`handle_sound_report`) counts **distinct trusted reporters** per
  sound. At **3+**, the sound's `is_hidden` is set to `true` and it drops out of
  the feed.
- A sound's owner **cannot** un-hide it (enforced by the
  `community_sounds_prevent_unhide` trigger). Only an admin can reverse it.

## Response-time SLA

- Triage new reports within **24–48 hours**.
- CSAM or imminent-harm reports: act **immediately** and preserve evidence
  before removal; escalate per the procedure below.

## Common queries

**Pending reports, most-reported first**
```sql
SELECT cs.id AS sound_id, cs.title, cs.user_id AS creator,
       count(*) FILTER (WHERE sr.status = 'pending') AS pending_reports,
       cs.is_hidden
FROM public.sound_reports sr
JOIN public.community_sounds cs ON cs.id = sr.sound_id
GROUP BY cs.id
HAVING count(*) FILTER (WHERE sr.status = 'pending') > 0
ORDER BY pending_reports DESC;
```

**Auto-hidden content awaiting review**
```sql
SELECT id, title, user_id, report_count, created_at
FROM public.community_sounds
WHERE is_hidden = true
ORDER BY created_at DESC;
```

**The reports on one sound**
```sql
SELECT id, user_id AS reporter, reason, status, created_at
FROM public.sound_reports
WHERE sound_id = '<SOUND_UUID>'
ORDER BY created_at;
```

## Actions (helper functions)

**Remove a sound** (hide + unpublish, keeps the row for audit)
```sql
SELECT public.admin_remove_content('<SOUND_UUID>', 'reason / report id');
```

**Hide all of a user's content**
```sql
SELECT public.admin_ban_user('<USER_UUID>', 'reason');
```
> Full account removal (revoking sign-in) is separate: delete the user in
> **Authentication → Users**, or call `DELETE /v1/account` on their behalf. FK
> cascades remove their rows; storage files are cleaned by the delete endpoint.

**Resolve a report** (`reviewed` | `dismissed` | `actioned`)
```sql
SELECT public.admin_review_report('<REPORT_UUID>', 'actioned');
```

Every action is logged to `public.moderation_actions` (audit trail):
```sql
SELECT * FROM public.moderation_actions ORDER BY created_at DESC LIMIT 50;
```

## Escalation

1. **CSAM**: do not download. Preserve the `sound_id`, `user_id`, and storage
   path. Report to NCMEC (https://report.cybertip.org) and your legal contact,
   then `admin_remove_content` + `admin_ban_user`.
2. **Credible threats / self-harm**: remove, preserve context, escalate to the
   on-call contact, and surface local-resource messaging if contacting the user.
3. **Repeat offenders**: `admin_ban_user`, then delete the auth account.

## Notifications (not yet automated)

New-report and auto-hide email alerts to `support@pulsestudios.app` are **not**
wired in v1 (they need an SMTP provider / Supabase webhook). Until then, run the
"pending reports" query on the SLA cadence. Tracking issue: wire a Supabase
Database Webhook on `sound_reports` INSERT → email/Slack once SMTP is configured.
