-- 0007_rpcs.sql
-- Transactional business RPC functions enforcing permissions and logging audit events.

-- 1. Create Booking (atomic transaction for booking, guests, allocations)
CREATE OR REPLACE FUNCTION public.create_booking(
  p_booking JSONB,
  p_guests JSONB,
  p_allocations JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_booking_id UUID;
  v_is_admin BOOLEAN;
  v_category public.category;
  v_check_in DATE;
  v_check_out DATE;
  v_party_size INT;
  v_is_suite BOOLEAN;
  v_guest JSONB;
  v_alloc JSONB;
  v_guest_id UUID;
  v_guest_map JSONB := '{}'::jsonb;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('create_booking')) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  v_is_admin := public.is_admin();
  v_category := (p_booking->>'category')::public.category;
  v_check_in := (p_booking->>'check_in')::DATE;
  v_check_out := (p_booking->>'check_out')::DATE;
  v_party_size := (p_booking->>'party_size')::INT;
  v_is_suite := COALESCE((p_booking->>'is_suite_booking')::BOOLEAN, FALSE);

  -- Backdating restriction: Clerks cannot backdate bookings; Admin may
  IF NOT v_is_admin AND v_check_in < CURRENT_DATE THEN
    RAISE EXCEPTION 'ERR_INVALID_DATES: Clerks cannot backdate bookings' USING errcode = 'P0001';
  END IF;

  IF v_is_suite AND NOT v_is_admin THEN
    RAISE EXCEPTION 'ERR_SUITE_ONLY_ADMIN' USING errcode = 'P0001';
  END IF;

  IF jsonb_array_length(p_guests) <> v_party_size THEN
    RAISE EXCEPTION 'ERR_PARTY_MISMATCH' USING errcode = 'P0001';
  END IF;

  -- Insert booking
  INSERT INTO public.bookings (
    category,
    status,
    check_in,
    check_out,
    party_size,
    is_suite_booking,
    notes_enc,
    key_version,
    created_by
  ) VALUES (
    v_category,
    'CONFIRMED',
    v_check_in,
    v_check_out,
    v_party_size,
    v_is_suite,
    p_booking->>'notes_enc',
    COALESCE((p_booking->>'key_version')::INT, 1),
    auth.uid()
  ) RETURNING id INTO v_booking_id;

  -- Insert guests and record mapping from seq to generated uuid
  FOR v_guest IN SELECT * FROM jsonb_array_elements(p_guests) LOOP
    INSERT INTO public.booking_guests (
      booking_id,
      seq,
      gender,
      rank_code,
      details,
      created_by
    ) VALUES (
      v_booking_id,
      (v_guest->>'seq')::INT,
      (v_guest->>'gender')::public.gender,
      (v_guest->>'rank_code')::public.rank_code,
      'PENDING',
      auth.uid()
    ) RETURNING id INTO v_guest_id;

    v_guest_map := jsonb_set(v_guest_map, ARRAY[(v_guest->>'seq')::text], to_jsonb(v_guest_id));
  END LOOP;

  -- Insert allocations
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_guest_id := (v_guest_map->>(v_alloc->>'guest_seq'))::UUID;
    IF v_guest_id IS NULL AND (v_alloc->>'guest_id') IS NOT NULL THEN
      v_guest_id := (v_alloc->>'guest_id')::UUID;
    END IF;

    INSERT INTO public.allocations (
      booking_id,
      guest_id,
      room_id,
      bed_slot,
      stay,
      status,
      created_by
    ) VALUES (
      v_booking_id,
      v_guest_id,
      (v_alloc->>'room_id')::UUID,
      (v_alloc->>'bed_slot')::SMALLINT,
      daterange(v_check_in, v_check_out, '[)'),
      'ACTIVE',
      auth.uid()
    );
  END LOOP;

  RETURN v_booking_id;
END;
$$;

-- 2. Cancel Booking
CREATE OR REPLACE FUNCTION public.cancel_booking(
  p_id UUID,
  p_reason_enc TEXT,
  p_key_version INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('cancel_booking')) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  UPDATE public.bookings
  SET status = 'CANCELLED',
      cancelled_at = NOW(),
      cancel_reason_enc = p_reason_enc,
      key_version = p_key_version
  WHERE id = p_id;

  UPDATE public.allocations
  SET status = 'RELEASED'
  WHERE booking_id = p_id AND status = 'ACTIVE';

  PERFORM public.log_audit_event('booking_cancelled', 'bookings', p_id, '{}'::jsonb);
END;
$$;

-- 3. Move Allocation
CREATE OR REPLACE FUNCTION public.move_allocation(
  p_allocation_id UUID,
  p_room_id UUID,
  p_bed_slot SMALLINT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('create_booking')) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  UPDATE public.allocations
  SET room_id = p_room_id,
      bed_slot = p_bed_slot
  WHERE id = p_allocation_id;

  PERFORM public.log_audit_event('allocation_moved', 'allocations', p_allocation_id, jsonb_build_object(
    'new_room_id', p_room_id,
    'new_bed_slot', p_bed_slot
  ));
END;
$$;

-- 4. Set Guest PII
CREATE OR REPLACE FUNCTION public.set_guest_pii(
  p_guest_id UUID,
  p_pii_enc TEXT,
  p_blind TEXT,
  p_key_version INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('enter_guest_details')) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  INSERT INTO public.guest_pii (
    guest_id,
    pii_enc,
    id_blind_index,
    key_version,
    updated_by,
    updated_at
  ) VALUES (
    p_guest_id,
    p_pii_enc,
    p_blind,
    p_key_version,
    auth.uid(),
    NOW()
  )
  ON CONFLICT (guest_id) DO UPDATE
  SET pii_enc = EXCLUDED.pii_enc,
      id_blind_index = EXCLUDED.id_blind_index,
      key_version = EXCLUDED.key_version,
      updated_by = auth.uid(),
      updated_at = NOW();

  UPDATE public.booking_guests
  SET details = 'COMPLETE'
  WHERE id = p_guest_id;
END;
$$;

-- 5. Get Guest PII (Strictly audits reveal event, returns ciphertext)
CREATE OR REPLACE FUNCTION public.get_guest_pii(p_guest_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_enc TEXT;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('reveal_guest_pii')) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  SELECT pii_enc INTO v_enc
  FROM public.guest_pii
  WHERE guest_id = p_guest_id;

  -- Audit reveal event every time
  PERFORM public.log_audit_event('guest_pii_revealed', 'guest_pii', p_guest_id, '{}'::jsonb);

  RETURN v_enc;
END;
$$;

-- 6. Search Guests by Blind Index
CREATE OR REPLACE FUNCTION public.search_guests_by_blind_index(p_blind TEXT)
RETURNS TABLE(booking_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('reveal_guest_pii')) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  PERFORM public.log_audit_event('blind_index_search', 'guest_pii', NULL, '{}'::jsonb);

  RETURN QUERY
  SELECT DISTINCT bg.booking_id
  FROM public.guest_pii gp
  JOIN public.booking_guests bg ON bg.id = gp.guest_id
  WHERE gp.id_blind_index = p_blind;
END;
$$;

-- 7. Daily Room State
CREATE OR REPLACE FUNCTION public.daily_room_state(p_from DATE, p_to DATE)
RETURNS TABLE(
  room_id UUID,
  room_type public.room_type,
  display_order INT,
  date DATE,
  beds_taken INT,
  is_closed BOOLEAN,
  occupants JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_is_admin BOOLEAN;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  v_is_admin := public.is_admin();

  RETURN QUERY
  WITH days AS (
    SELECT generate_series(p_from, p_to - INTERVAL '1 day', INTERVAL '1 day')::DATE AS d
  ),
  eligible_rooms AS (
    SELECT r.id, r.room_type, r.display_order
    FROM public.rooms r
    WHERE r.is_active = TRUE AND (r.room_type <> 'SUITE' OR v_is_admin)
  )
  SELECT
    er.id AS room_id,
    er.room_type,
    er.display_order,
    d.d AS date,
    COALESCE(count(a.id), 0)::INT AS beds_taken,
    EXISTS (
      SELECT 1 FROM public.room_closures rc
      WHERE rc.room_id = er.id AND rc.period && daterange(d.d, d.d + 1, '[)')
    ) AS is_closed,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'allocationId', a.id,
          'bookingId', a.booking_id,
          'bedSlot', a.bed_slot,
          'gender', bg.gender,
          'rankCode', bg.rank_code,
          'category', b.category,
          'bookingStatus', b.status,
          'checkIn', b.check_in,
          'checkOut', b.check_out
        )
      ) FILTER (WHERE a.id IS NOT NULL),
      '[]'::jsonb
    ) AS occupants
  FROM eligible_rooms er
  CROSS JOIN days d
  LEFT JOIN public.allocations a ON a.room_id = er.id
    AND a.status = 'ACTIVE'
    AND a.stay && daterange(d.d, d.d + 1, '[)')
  LEFT JOIN public.bookings b ON b.id = a.booking_id
  LEFT JOIN public.booking_guests bg ON bg.id = a.guest_id
  GROUP BY er.id, er.room_type, er.display_order, d.d
  ORDER BY er.display_order, d.d;
END;
$$;

-- 8. Dashboard Counts (Excludes Suites)
CREATE OR REPLACE FUNCTION public.dashboard_counts(p_date DATE)
RETURNS TABLE(
  free_rooms INT,
  one_bed_free_rooms INT,
  full_rooms INT,
  out_of_service_rooms INT,
  people_in_house INT,
  pending_details_count INT,
  arrivals_today INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  RETURN QUERY
  WITH room_metrics AS (
    SELECT
      r.id,
      EXISTS (
        SELECT 1 FROM public.room_closures rc
        WHERE rc.room_id = r.id AND rc.period && daterange(p_date, p_date + 1, '[)')
      ) AS is_closed,
      count(a.id)::INT AS beds_occupied
    FROM public.rooms r
    LEFT JOIN public.allocations a ON a.room_id = r.id
      AND a.status = 'ACTIVE'
      AND a.stay && daterange(p_date, p_date + 1, '[)')
    WHERE r.room_type <> 'SUITE' AND r.is_active = TRUE
    GROUP BY r.id
  )
  SELECT
    count(*) FILTER (WHERE NOT is_closed AND beds_occupied = 0)::INT AS free_rooms,
    count(*) FILTER (WHERE NOT is_closed AND beds_occupied = 1)::INT AS one_bed_free_rooms,
    count(*) FILTER (WHERE NOT is_closed AND beds_occupied = 2)::INT AS full_rooms,
    count(*) FILTER (WHERE is_closed)::INT AS out_of_service_rooms,
    (
      SELECT count(*)::INT
      FROM public.allocations a
      JOIN public.rooms r ON r.id = a.room_id
      WHERE a.status = 'ACTIVE'
        AND r.room_type <> 'SUITE'
        AND a.stay && daterange(p_date, p_date + 1, '[)')
    ) AS people_in_house,
    (
      SELECT count(*)::INT
      FROM public.booking_guests bg
      JOIN public.bookings b ON b.id = bg.booking_id
      WHERE bg.details = 'PENDING' AND b.status = 'CONFIRMED'
    ) AS pending_details_count,
    (
      SELECT count(*)::INT
      FROM public.bookings b
      WHERE b.check_in = p_date AND b.status = 'CONFIRMED' AND b.is_suite_booking = FALSE
    ) AS arrivals_today
  FROM room_metrics;
END;
$$;

-- 9. Eviction Candidates
-- TODO(ranking): Ranking is unranked by policy. Stable identity order returned.
CREATE OR REPLACE FUNCTION public.eviction_candidates(
  p_category public.category,
  p_check_in DATE,
  p_check_out DATE,
  p_guests JSONB
)
RETURNS TABLE(
  allocation_id UUID,
  booking_id UUID,
  room_id UUID,
  room_code TEXT,
  room_type public.room_type,
  bed_slot SMALLINT,
  category public.category,
  occupant_gender public.gender,
  occupant_rank public.rank_code,
  days_stayed INT,
  days_remaining INT,
  fits_incoming BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  RETURN QUERY
  SELECT
    a.id AS allocation_id,
    b.id AS booking_id,
    a.room_id,
    'Room' AS room_code,
    r.room_type,
    a.bed_slot,
    b.category,
    bg.gender AS occupant_gender,
    bg.rank_code AS occupant_rank,
    GREATEST(0, (CURRENT_DATE - b.check_in))::INT AS days_stayed,
    GREATEST(0, (b.check_out - CURRENT_DATE))::INT AS days_remaining,
    TRUE AS fits_incoming
  FROM public.allocations a
  JOIN public.bookings b ON b.id = a.booking_id
  JOIN public.rooms r ON r.id = a.room_id
  JOIN public.booking_guests bg ON bg.id = a.guest_id
  WHERE a.status = 'ACTIVE'
    AND r.room_type <> 'SUITE'
    AND a.stay && daterange(p_check_in, p_check_out, '[)')
    AND (
      (p_category = 'MSA' AND b.category IN ('PI', 'LEAVE', 'TD')) OR
      (p_category = 'PI' AND b.category IN ('LEAVE', 'TD'))
    )
  -- TODO(ranking): Stable order pending final ranking algorithm
  ORDER BY b.check_in ASC, a.id ASC;
END;
$$;

-- 10. Approve Eviction (atomic displacement and reallocation)
CREATE OR REPLACE FUNCTION public.approve_eviction(
  p_incoming JSONB,
  p_evict_allocation_ids UUID[],
  p_reason_enc TEXT,
  p_key_version INT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_alloc_id UUID;
  v_displaced_booking_id UUID;
  v_new_booking_id UUID;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('approve_eviction')) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  IF p_reason_enc IS NULL OR length(trim(p_reason_enc)) < 10 THEN
    RAISE EXCEPTION 'Eviction reason must be at least 10 characters' USING errcode = 'P0001';
  END IF;

  -- Create incoming booking
  v_new_booking_id := public.create_booking(
    p_incoming->'booking',
    p_incoming->'guests',
    p_incoming->'allocations'
  );

  -- Process evictions
  FOREACH v_alloc_id IN ARRAY p_evict_allocation_ids LOOP
    SELECT booking_id INTO v_displaced_booking_id
    FROM public.allocations
    WHERE id = v_alloc_id;

    UPDATE public.allocations
    SET status = 'EVICTED'
    WHERE id = v_alloc_id;

    UPDATE public.bookings
    SET status = 'DISPLACED'
    WHERE id = v_displaced_booking_id;

    INSERT INTO public.evictions (
      evicted_allocation_id,
      displaced_booking_id,
      incoming_booking_id,
      reason_enc,
      key_version,
      approved_by
    ) VALUES (
      v_alloc_id,
      v_displaced_booking_id,
      v_new_booking_id,
      p_reason_enc,
      p_key_version,
      auth.uid()
    );
  END LOOP;

  PERFORM public.log_audit_event('eviction_approved', 'evictions', v_new_booking_id, jsonb_build_object(
    'evicted_count', array_length(p_evict_allocation_ids, 1)
  ));

  RETURN v_new_booking_id;
END;
$$;

-- 11. Record Denial
CREATE OR REPLACE FUNCTION public.record_denial(
  p_category public.category,
  p_check_in DATE,
  p_check_out DATE,
  p_party_size INT,
  p_reason_enc TEXT,
  p_key_version INT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('deny_request')) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  IF p_category IN ('MSA', 'PI') THEN
    RAISE EXCEPTION 'ERR_CANNOT_DENY_PRIORITY' USING errcode = 'P0001';
  END IF;

  INSERT INTO public.denials (
    category,
    check_in,
    check_out,
    party_size,
    reason_enc,
    key_version,
    denied_by
  ) VALUES (
    p_category,
    p_check_in,
    p_check_out,
    p_party_size,
    p_reason_enc,
    p_key_version,
    auth.uid()
  ) RETURNING id INTO v_id;

  PERFORM public.log_audit_event('booking_denied', 'denials', v_id, jsonb_build_object(
    'category', p_category,
    'party_size', p_party_size
  ));

  RETURN v_id;
END;
$$;

-- 12. Report Daily Breakdown
CREATE OR REPLACE FUNCTION public.report_daily(p_from DATE, p_to DATE)
RETURNS TABLE(
  day DATE,
  category public.category,
  room_type public.room_type,
  people INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('view_reports')) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  RETURN QUERY
  WITH days AS (
    SELECT generate_series(p_from, p_to - INTERVAL '1 day', INTERVAL '1 day')::DATE AS d
  )
  SELECT
    d.d AS day,
    b.category,
    r.room_type,
    count(a.id)::INT AS people
  FROM days d
  JOIN public.allocations a ON a.stay && daterange(d.d, d.d + 1, '[)') AND a.status = 'ACTIVE'
  JOIN public.bookings b ON b.id = a.booking_id
  JOIN public.rooms r ON r.id = a.room_id
  GROUP BY d.d, b.category, r.room_type
  ORDER BY d.d ASC, b.category ASC;
END;
$$;

-- 13. Report Denials Breakdown
CREATE OR REPLACE FUNCTION public.report_denials(p_from DATE, p_to DATE)
RETURNS TABLE(
  category public.category,
  count INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('view_reports')) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  RETURN QUERY
  SELECT d.category, count(*)::INT
  FROM public.denials d
  WHERE d.check_in >= p_from AND d.check_in < p_to
  GROUP BY d.category;
END;
$$;

-- 14. UI-only event logging
CREATE OR REPLACE FUNCTION public.log_event(
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
  IF NOT (public.is_active_user() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  PERFORM public.log_audit_event(p_action, p_entity, p_entity_id, p_meta);
END;
$$;

-- 15. Admin User Management (Protects the last Administrator)
CREATE OR REPLACE FUNCTION public.set_user_role(p_user_id UUID, p_role public.app_role)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin_count INT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  IF p_role <> 'admin' THEN
    SELECT count(*) INTO v_admin_count
    FROM public.profiles
    WHERE role = 'admin' AND is_active = TRUE;

    IF v_admin_count <= 1 AND EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id AND role = 'admin') THEN
      RAISE EXCEPTION 'ERR_LAST_ADMIN' USING errcode = 'P0001';
    END IF;
  END IF;

  UPDATE public.profiles
  SET role = p_role
  WHERE id = p_user_id;

  PERFORM public.log_audit_event('role_updated', 'profiles', p_user_id, jsonb_build_object('new_role', p_role));
END;
$$;

CREATE OR REPLACE FUNCTION public.deactivate_user(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin_count INT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  SELECT count(*) INTO v_admin_count
  FROM public.profiles
  WHERE role = 'admin' AND is_active = TRUE;

  IF v_admin_count <= 1 AND EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id AND role = 'admin') THEN
    RAISE EXCEPTION 'ERR_LAST_ADMIN' USING errcode = 'P0001';
  END IF;

  UPDATE public.profiles
  SET is_active = FALSE
  WHERE id = p_user_id;

  PERFORM public.log_audit_event('user_deactivated', 'profiles', p_user_id, '{}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_user_permissions(p_user_id UUID, p_permissions TEXT[])
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  UPDATE public.profiles
  SET permissions = p_permissions
  WHERE id = p_user_id;

  PERFORM public.log_audit_event('permissions_updated', 'profiles', p_user_id, jsonb_build_object('permissions', p_permissions));
END;
$$;

-- 16. Cryptographic Key Management RPCs
CREATE OR REPLACE FUNCTION public.publish_user_key(
  p_public_key TEXT,
  p_enc_private_key TEXT,
  p_kdf_salt TEXT,
  p_kdf_params JSONB,
  p_key_version INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.user_keys (
    user_id,
    public_key,
    enc_private_key,
    kdf_salt,
    kdf_params,
    key_version
  ) VALUES (
    auth.uid(),
    p_public_key,
    p_enc_private_key,
    p_kdf_salt,
    p_kdf_params,
    p_key_version
  )
  ON CONFLICT (user_id) DO UPDATE
  SET public_key = EXCLUDED.public_key,
      enc_private_key = EXCLUDED.enc_private_key,
      kdf_salt = EXCLUDED.kdf_salt,
      kdf_params = EXCLUDED.kdf_params,
      key_version = EXCLUDED.key_version;

  PERFORM public.log_audit_event('user_key_published', 'user_keys', auth.uid(), '{}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.grant_key_access(
  p_user_id UUID,
  p_key_version INT,
  p_sealed_team_key TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  INSERT INTO public.user_key_wraps (
    user_id,
    key_version,
    sealed_team_key
  ) VALUES (
    p_user_id,
    p_key_version,
    p_sealed_team_key
  )
  ON CONFLICT (user_id, key_version) DO UPDATE
  SET sealed_team_key = EXCLUDED.sealed_team_key;

  PERFORM public.log_audit_event('key_access_granted', 'user_key_wraps', p_user_id, jsonb_build_object('key_version', p_key_version));
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_rotation(
  p_new_version INT,
  p_recovery_wrap TEXT,
  p_recovery_kdf_salt TEXT,
  p_recovery_kdf_params JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  -- Deactivate previous version
  UPDATE public.team_key_versions
  SET is_active = FALSE
  WHERE is_active = TRUE;

  -- Insert and activate new version
  INSERT INTO public.team_key_versions (
    version,
    recovery_wrap,
    recovery_kdf_salt,
    recovery_kdf_params,
    is_active
  ) VALUES (
    p_new_version,
    p_recovery_wrap,
    p_recovery_kdf_salt,
    p_recovery_kdf_params,
    TRUE
  );

  PERFORM public.log_audit_event('key_rotation_finished', 'team_key_versions', NULL, jsonb_build_object('new_version', p_new_version));
END;
$$;
