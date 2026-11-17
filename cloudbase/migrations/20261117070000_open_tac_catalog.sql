-- Public reference data. Never store an IMEI here; only eight-digit TACs.
CREATE TABLE public.imei_open_tac_catalog (
  tac char(8) PRIMARY KEY CHECK (tac ~ '^[0-9]{8}$'),
  brand varchar(100) NOT NULL,
  description varchar(200) NOT NULL,
  model_id varchar(60) REFERENCES public.models(id) ON DELETE SET NULL,
  source varchar(200) NOT NULL DEFAULT 'MoazEb/tac-database | https://github.com/MoazEb/tac-database | MIT'
);

ALTER TABLE public.imei_open_tac_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.imei_open_tac_catalog FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.imei_open_tac_catalog TO service_role;

CREATE INDEX imei_open_tac_catalog_model_idx ON public.imei_open_tac_catalog (model_id) WHERE model_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.api_imei_model_lookup(p_imei text)
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
  IF FOUND THEN RETURN result; END IF;

  SELECT jsonb_build_object('matched', false,
    'reference', jsonb_build_object('brand', c.brand, 'name', c.description, 'source', c.source),
    'message', CASE WHEN c.model_id IS NULL
      THEN '开放库识别：' || c.description || '。请核对后手动选择机型。'
      ELSE '开放库候选：' || m.name || '。请核对实机型号。'
    END
  ) || CASE WHEN c.model_id IS NULL THEN '{}'::jsonb
    ELSE jsonb_build_object('candidate', jsonb_build_object('model', stock_model(c.model_id), 'source', c.source))
  END INTO result
  FROM imei_open_tac_catalog c LEFT JOIN models m ON m.id = c.model_id
  WHERE c.tac = lookup_tac;
  RETURN coalesce(result, '{"matched":false,"message":"开放库未收录此 TAC，请手动选择机型"}'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.api_imei_model_lookup(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_imei_model_lookup(text) TO service_role;
