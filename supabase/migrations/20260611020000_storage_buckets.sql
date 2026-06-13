-- Formalize the soundscapes storage bucket (previously created by hand in the
-- dashboard) and remove the orphaned avatars bucket (no app code references it).

-- ---------------------------------------------------------------------------
-- soundscapes: public-read streaming bucket for generated audio.
-- Path convention is `<user_id>/<file>.mp3` (see soundscapeStorage.ts).
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'soundscapes',
  'soundscapes',
  true,
  10485760, -- 10 MB
  ARRAY['audio/mpeg', 'audio/mp4', 'audio/wav']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Soundscapes are publicly readable" ON storage.objects;
CREATE POLICY "Soundscapes are publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'soundscapes');

DROP POLICY IF EXISTS "Users upload own soundscape" ON storage.objects;
CREATE POLICY "Users upload own soundscape"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'soundscapes'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users delete own soundscape" ON storage.objects;
CREATE POLICY "Users delete own soundscape"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'soundscapes'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- No UPDATE policy: objects are immutable once written (re-upload uses a new key).

-- ---------------------------------------------------------------------------
-- Remove the orphaned avatars bucket. The app never reads or writes it
-- (ProfileAvatar renders initials), so drop its policies, objects, and bucket.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Avatar images are publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Users upload own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Users update own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Users delete own avatar" ON storage.objects;

DELETE FROM storage.objects WHERE bucket_id = 'avatars';
DELETE FROM storage.buckets WHERE id = 'avatars';
