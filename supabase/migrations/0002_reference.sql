-- 0002_reference.sql
-- Reference tables seeded with immutable data.

CREATE TABLE IF NOT EXISTS public.ranks (
  code public.rank_code PRIMARY KEY,
  seniority INT NOT NULL UNIQUE,
  label TEXT NOT NULL
);

-- Seed ranks in ascending order of seniority
INSERT INTO public.ranks (code, seniority, label) VALUES
  ('FO', 1, 'Flying Officer'),
  ('FLT_LT', 2, 'Flight Lieutenant'),
  ('SQN_LDR', 3, 'Squadron Leader'),
  ('WG_CDR', 4, 'Wing Commander'),
  ('GP_CAPT', 5, 'Group Captain'),
  ('AIR_CDRE', 6, 'Air Commodore'),
  ('AVM', 7, 'Air Vice Marshal'),
  ('AM', 8, 'Air Marshal'),
  ('ACM', 9, 'Air Chief Marshal'),
  ('MIAF', 10, 'Marshal of the Indian Air Force')
ON CONFLICT (code) DO UPDATE
SET seniority = EXCLUDED.seniority,
    label = EXCLUDED.label;

-- Revoke mutation permissions to ensure read-only reference data
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.ranks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ranks TO authenticated, anon;
