-- 0012_app_config_audit.sql
-- Records every change to app_config (e.g. turning require_mfa on or off) in the
-- hash-chained audit_log, so security-relevant switches leave a tamper-evident trail.

CREATE OR REPLACE FUNCTION public.trigger_audit_app_config()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.log_audit_event(
    'app_config_changed',
    'app_config',
    NULL,
    jsonb_build_object(
      'key', NEW.key,
      'old_value', CASE WHEN TG_OP = 'UPDATE' THEN OLD.value END,
      'new_value', NEW.value
    )
  );
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_app_config ON public.app_config;
CREATE TRIGGER trg_audit_app_config
  BEFORE INSERT OR UPDATE ON public.app_config
  FOR EACH ROW EXECUTE FUNCTION public.trigger_audit_app_config();

REVOKE EXECUTE ON FUNCTION public.trigger_audit_app_config() FROM PUBLIC, anon, authenticated;
