-- 0001_extensions_enums.sql
-- Enables required Postgres extensions and creates domain ENUM types.

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('admin', 'clerk');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE public.category AS ENUM ('MFA', 'PI', 'LEAVE', 'TD');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE public.room_type AS ENUM ('VIP', 'SEMI_VIP', 'NORMAL', 'SUITE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE public.gender AS ENUM ('M', 'F');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE public.rank_code AS ENUM (
    'FO',
    'FLT_LT',
    'SQN_LDR',
    'WG_CDR',
    'GP_CAPT',
    'AIR_CDRE',
    'AVM',
    'AM',
    'ACM',
    'MIAF'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE public.booking_status AS ENUM ('CONFIRMED', 'CANCELLED', 'DISPLACED', 'COMPLETED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE public.allocation_status AS ENUM ('ACTIVE', 'RELEASED', 'EVICTED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE public.details_status AS ENUM ('PENDING', 'COMPLETE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
