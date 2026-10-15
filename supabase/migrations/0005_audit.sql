-- 0005_audit.sql
-- Cryptographically chained, append-only audit trail.

-- 1. Prevent modification or deletion of audit records
CREATE OR REPLACE FUNCTION public.trigger_audit_log_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Audit log entries are immutable and append-only.' USING errcode = 'P0001';
END;
$$;

CREATE TRIGGER trg_audit_log_no_update
  BEFORE UPDATE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.trigger_audit_log_immutable();

CREATE TRIGGER trg_audit_log_no_delete
  BEFORE DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.trigger_audit_log_immutable();

REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_log FROM PUBLIC, anon, authenticated;

-- 2. Hash chaining trigger on audit_log insert
CREATE OR REPLACE FUNCTION public.trigger_audit_log_hash_chain()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_prev_hash BYTEA;
  v_payload TEXT;
BEGIN
  -- Advisory transaction lock ensures strictly sequential hash-chain calculation
  PERFORM pg_advisory_xact_lock(987654321);

  -- Fetch hash of the immediate prior row
  SELECT hash INTO v_prev_hash
  FROM public.audit_log
  ORDER BY id DESC
  LIMIT 1;

  NEW.prev_hash := v_prev_hash;

  -- Canonical JSON payload representation of row attributes (excluding generated hash)
  v_payload := json_build_object(
    'at', NEW.at,
    'actor', NEW.actor,
    'action', NEW.action,
    'entity', NEW.entity,
    'entity_id', NEW.entity_id,
    'meta', NEW.meta,
    'prev_hash', encode(COALESCE(v_prev_hash, ''::bytea), 'hex')
  )::text;

  NEW.hash := digest(COALESCE(v_prev_hash, ''::bytea) || convert_to(v_payload, 'UTF8'), 'sha256');

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_audit_log_hash_chain
  BEFORE INSERT ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.trigger_audit_log_hash_chain();

-- 3. Verify audit chain function
CREATE OR REPLACE FUNCTION public.verify_audit_chain()
RETURNS TABLE(ok BOOLEAN, first_bad_id BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row RECORD;
  v_prev_hash BYTEA := NULL;
  v_payload TEXT;
  v_expected_hash BYTEA;
BEGIN
  FOR v_row IN SELECT * FROM public.audit_log ORDER BY id ASC LOOP
    IF v_prev_hash IS DISTINCT FROM v_row.prev_hash THEN
      RETURN QUERY SELECT FALSE, v_row.id;
      RETURN;
    END IF;

    v_payload := json_build_object(
      'at', v_row.at,
      'actor', v_row.actor,
      'action', v_row.action,
      'entity', v_row.entity,
      'entity_id', v_row.entity_id,
      'meta', v_row.meta,
      'prev_hash', encode(COALESCE(v_prev_hash, ''::bytea), 'hex')
    )::text;

    v_expected_hash := digest(COALESCE(v_prev_hash, ''::bytea) || convert_to(v_payload, 'UTF8'), 'sha256');

    IF v_expected_hash <> v_row.hash THEN
      RETURN QUERY SELECT FALSE, v_row.id;
      RETURN;
    END IF;

    v_prev_hash := v_row.hash;
  END LOOP;

  RETURN QUERY SELECT TRUE, NULL::BIGINT;
END;
$$;

-- 4. Audit event insertion helper
CREATE OR REPLACE FUNCTION public.log_audit_event(
  p_action TEXT,
  p_entity TEXT,
  p_entity_id UUID,
  p_meta JSONB DEFAULT '{}'::JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.audit_log (actor, action, entity, entity_id, meta)
  VALUES (auth.uid(), p_action, p_entity, p_entity_id, COALESCE(p_meta, '{}'::JSONB));
END;
$$;

-- 5. Row triggers writing audit events (ensuring NO PII in meta)
CREATE OR REPLACE FUNCTION public.trigger_audit_bookings()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.log_audit_event(
      'booking_created',
      'bookings',
      NEW.id,
      jsonb_build_object(
        'category', NEW.category,
        'party_size', NEW.party_size,
        'check_in', NEW.check_in,
        'check_out', NEW.check_out,
        'is_suite', NEW.is_suite_booking
      )
    );
  ELSIF TG_OP = 'UPDATE' AND OLD.status <> NEW.status THEN
    PERFORM public.log_audit_event(
      'booking_status_changed',
      'bookings',
      NEW.id,
      jsonb_build_object(
        'old_status', OLD.status,
        'new_status', NEW.status
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_audit_bookings
  AFTER INSERT OR UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.trigger_audit_bookings();

CREATE OR REPLACE FUNCTION public.trigger_audit_guest_pii()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Strict security: audit ONLY that PII was written, NEVER the ciphertext or plaintext!
  PERFORM public.log_audit_event(
    'guest_pii_written',
    'guest_pii',
    NEW.guest_id,
    jsonb_build_object('key_version', NEW.key_version)
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_audit_guest_pii
  AFTER INSERT OR UPDATE ON public.guest_pii
  FOR EACH ROW EXECUTE FUNCTION public.trigger_audit_guest_pii();
