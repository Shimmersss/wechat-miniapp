-- Keep open-data provenance separate from the manually maintained TAC catalog.
CREATE TABLE public.imei_open_tac_mappings (
  tac char(8) PRIMARY KEY CHECK (tac ~ '^[0-9]{8}$'),
  model_id varchar(60) NOT NULL REFERENCES public.models(id),
  source varchar(200) NOT NULL
);

ALTER TABLE public.imei_open_tac_mappings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.imei_open_tac_mappings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.imei_open_tac_mappings TO service_role;

CREATE FUNCTION public.api_imei_model_lookup(p_imei text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  lookup_tac char(8) := left(stock_imei(p_imei), 8);
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'matched', true, 'model', stock_model(m.model_id), 'source', m.source,
    'message', '请核对实机型号；容量、颜色与机况需另行填写'
  ) INTO result
  FROM tac_mappings m WHERE m.tac = lookup_tac;
  IF FOUND THEN RETURN result; END IF;

  SELECT jsonb_build_object(
    'matched', false,
    'candidate', jsonb_build_object('model', stock_model(m.model_id), 'source', m.source),
    'message', '开放数据库候选，请核对实机型号；容量、颜色与机况需另行填写'
  ) INTO result
  FROM imei_open_tac_mappings m WHERE m.tac = lookup_tac;
  RETURN coalesce(result, '{"matched":false,"message":"未找到已核验型号，请手动选择"}'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.api_imei_model_lookup(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_imei_model_lookup(text) TO service_role;

-- A single row enforces the paid lookup budget across all cloud function instances.
CREATE TABLE public.imei_paid_lookup_budget (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  budget_day date NOT NULL,
  day_calls integer NOT NULL CHECK (day_calls >= 0),
  budget_minute timestamptz NOT NULL,
  minute_calls integer NOT NULL CHECK (minute_calls >= 0)
);

ALTER TABLE public.imei_paid_lookup_budget ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.imei_paid_lookup_budget FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.imei_paid_lookup_budget TO service_role;

CREATE FUNCTION public.api_imei_paid_lookup_reserve(p_imei text, p_daily_limit integer)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  lookup_imei char(15) := stock_imei(p_imei);
  lookup_tac char(8) := left(lookup_imei, 8);
  now_at timestamptz := statement_timestamp();
  today date := (now_at AT TIME ZONE 'Asia/Shanghai')::date;
  current_minute timestamptz := date_trunc('minute', now_at);
BEGIN
  IF p_daily_limit IS NULL OR p_daily_limit NOT BETWEEN 1 AND 1000 THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM unit_identifiers WHERE imei = lookup_imei)
    OR EXISTS (SELECT 1 FROM tac_mappings WHERE tac = lookup_tac)
    OR EXISTS (SELECT 1 FROM imei_open_tac_mappings WHERE tac = lookup_tac) THEN
    RETURN false;
  END IF;

  INSERT INTO imei_paid_lookup_budget AS budget (budget_day, day_calls, budget_minute, minute_calls)
  VALUES (today, 1, current_minute, 1)
  ON CONFLICT (singleton) DO UPDATE
  SET budget_day = EXCLUDED.budget_day,
      day_calls = CASE WHEN budget.budget_day = EXCLUDED.budget_day THEN budget.day_calls + 1 ELSE 1 END,
      budget_minute = EXCLUDED.budget_minute,
      minute_calls = CASE WHEN budget.budget_minute = EXCLUDED.budget_minute THEN budget.minute_calls + 1 ELSE 1 END
  WHERE budget.budget_minute <= EXCLUDED.budget_minute
    AND (budget.budget_day <> EXCLUDED.budget_day OR budget.day_calls < p_daily_limit)
    AND (budget.budget_minute <> EXCLUDED.budget_minute OR budget.minute_calls < 5);
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.api_imei_paid_lookup_reserve(text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_imei_paid_lookup_reserve(text,integer) TO service_role;
