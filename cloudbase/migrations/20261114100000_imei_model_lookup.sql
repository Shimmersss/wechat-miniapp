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
