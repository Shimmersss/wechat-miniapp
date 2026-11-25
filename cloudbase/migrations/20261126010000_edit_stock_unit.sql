-- 编辑已在库设备的成本与机况。行版本也会随现有出库、复检或改价更新。
CREATE FUNCTION public.api_stock_unit_edit(p_id uuid, p_data jsonb, p_user jsonb, p_request_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  current_unit record;
  edit_info boolean := coalesce(p_user->'permissions' ? 'inbound:do', false);
  edit_cost boolean := coalesce(p_user->'permissions' ? 'price:edit', false) AND stock_can(p_user, 'cost');
  snapshot jsonb;
  fields jsonb;
  revision text;
  attrs jsonb;
  patch jsonb;
  field jsonb;
  key text;
  value_in jsonb;
  old_value jsonb;
  new_value jsonb;
  previous jsonb := '{}';
  changed jsonb := '{}';
  internal_old jsonb := '{}';
  internal_new jsonb := '{}';
  why text;
BEGIN
  IF nullif(p_user->>'staffNo', '') IS NULL
      OR NOT coalesce(p_user->'permissions' ? 'inventory:view', false)
      OR NOT (edit_info OR edit_cost) THEN
    PERFORM stock_error('P0403', '无权限编辑设备资料');
  END IF;
  IF p_data IS NULL THEN
    SELECT u.*, u.xmin::text AS row_version INTO current_unit FROM units u WHERE u.id = p_id;
  ELSE
    SELECT u.*, u.xmin::text AS row_version INTO current_unit FROM units u WHERE u.id = p_id FOR UPDATE;
  END IF;
  IF NOT FOUND THEN PERFORM stock_error('P0404', '设备不存在'); END IF;
  IF current_unit.status <> 'in_stock' OR current_unit.ownership <> 'own' THEN
    PERFORM stock_error('P0409', '仅可编辑在库自有设备，请刷新库存');
  END IF;

  snapshot := current_unit.template_snapshot;
  IF jsonb_typeof(snapshot->'fields') IS DISTINCT FROM 'array' THEN
    snapshot := stock_form(current_unit.model_id) - 'modelId' - 'modelName' - 'specs';
  END IF;
  SELECT coalesce(jsonb_agg(f ORDER BY ord), '[]') INTO fields
  FROM jsonb_array_elements(snapshot->'fields') WITH ORDINALITY AS source(f, ord)
  WHERE edit_info AND f->>'type' <> 'image'
    AND f->>'key' NOT IN ('supplier', 'receipt', 'receiptImages', 'publicImages', 'cost',
      'retail', 'wholesale', 'wholesalePrice', 'agentBase', 'profit', 'modelId', 'category',
      'serialNo', 'noSerialReason', 'imei', 'imei1', 'imei2', 'fullImei', 'condition',
      'peerDesc', 'customerDesc', 'internalNote', 'status', 'ownership')
    AND (NOT (f->'visibility' ? 'internal') OR stock_can(p_user, 'internalNote'));

  revision := encode(sha256(convert_to(p_id::text || ':' || current_unit.row_version || ':' || snapshot::text, 'UTF8')), 'hex');
  attrs := current_unit.attributes;
  IF p_data IS NULL THEN
    RETURN jsonb_build_object(
      'editVersion', revision,
      'fields', fields,
      'values', coalesce((SELECT jsonb_object_agg(f->>'key', attrs->(f->>'key'))
        FROM jsonb_array_elements(fields) AS f WHERE attrs ? (f->>'key')), '{}')
    )
    || CASE WHEN edit_info THEN jsonb_build_object('condition', current_unit.condition_type,
      'peerDesc', current_unit.peer_desc, 'customerDesc', current_unit.customer_desc) ELSE '{}'::jsonb END
    || CASE WHEN edit_info AND stock_can(p_user, 'internalNote')
      THEN jsonb_build_object('internalNote', current_unit.internal_note) ELSE '{}'::jsonb END
    || CASE WHEN edit_cost THEN jsonb_build_object('cost', current_unit.cost) ELSE '{}'::jsonb END;
  END IF;

  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object'
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_data) AS k
        WHERE k NOT IN ('editVersion', 'reason', 'cost', 'condition', 'attributes', 'peerDesc', 'customerDesc', 'internalNote')) THEN
    PERFORM stock_error('P0400', '设备编辑参数无效');
  END IF;
  IF p_data->>'editVersion' IS DISTINCT FROM revision THEN
    PERFORM stock_error('P0409', '设备资料已更新，请刷新后重新编辑');
  END IF;
  why := stock_text(p_data->'reason', '修改原因', 500);
  IF (p_data ? 'cost' AND NOT edit_cost)
      OR (p_data ?| ARRAY['condition', 'attributes', 'peerDesc', 'customerDesc', 'internalNote'] AND NOT edit_info)
      OR (p_data ? 'internalNote' AND NOT stock_can(p_user, 'internalNote')) THEN
    PERFORM stock_error('P0403', '无权修改该设备字段');
  END IF;

  patch := coalesce(p_data->'attributes', '{}');
  IF jsonb_typeof(patch) IS DISTINCT FROM 'object' THEN
    PERFORM stock_error('P0400', '机况参数格式无效');
  END IF;
  FOR key, value_in IN SELECT * FROM jsonb_each(patch) LOOP
    SELECT f INTO field FROM jsonb_array_elements(fields) AS f WHERE f->>'key' = key;
    IF NOT FOUND THEN PERFORM stock_error('P0403', '该机况字段不可编辑'); END IF;
    IF field->>'type' = 'select' AND field->'allowCustom' = 'true' AND jsonb_typeof(value_in) = 'string' THEN
      value_in := to_jsonb(btrim(value_in #>> '{}'));
    END IF;
    PERFORM stock_values(jsonb_build_array(field), jsonb_build_object(key, value_in));
    old_value := attrs->key;
    IF old_value IS NOT DISTINCT FROM value_in THEN CONTINUE; END IF;
    attrs := attrs || jsonb_build_object(key, value_in);
    IF field->'visibility' ? 'internal' THEN
      internal_old := internal_old || jsonb_build_object(key, old_value);
      internal_new := internal_new || jsonb_build_object(key, value_in);
    ELSE
      previous := previous || jsonb_build_object('attributes', coalesce(previous->'attributes','{}') || jsonb_build_object(key, old_value));
      changed := changed || jsonb_build_object('attributes', coalesce(changed->'attributes','{}') || jsonb_build_object(key, value_in));
    END IF;
  END LOOP;

  FOR key IN SELECT jsonb_object_keys(p_data - 'editVersion' - 'reason' - 'attributes') LOOP
    CASE key
      WHEN 'cost' THEN
        old_value := to_jsonb(current_unit.cost);
        new_value := to_jsonb(stock_money(p_data->key));
      WHEN 'condition' THEN
        IF coalesce(p_data->>key, '') NOT IN ('new','used') THEN PERFORM stock_error('P0400', '新旧状态无效'); END IF;
        old_value := to_jsonb(current_unit.condition_type);
        new_value := p_data->key;
      WHEN 'peerDesc' THEN
        old_value := to_jsonb(current_unit.peer_desc);
        new_value := to_jsonb(stock_text(p_data->key, '同行描述', 4000, true));
      WHEN 'customerDesc' THEN
        old_value := to_jsonb(current_unit.customer_desc);
        new_value := to_jsonb(stock_text(p_data->key, '顾客描述', 4000, true));
      WHEN 'internalNote' THEN
        old_value := to_jsonb(current_unit.internal_note);
        new_value := to_jsonb(stock_text(p_data->key, '内部备注', 4000, true));
    END CASE;
    IF old_value IS DISTINCT FROM new_value THEN
      previous := previous || jsonb_build_object(key, old_value);
      changed := changed || jsonb_build_object(key, new_value);
    END IF;
  END LOOP;

  IF changed = '{}' AND internal_new = '{}' THEN RETURN jsonb_build_object('id', p_id); END IF;
  UPDATE units SET
    cost = coalesce((changed->>'cost')::numeric, cost),
    price_version = price_version + CASE WHEN changed ? 'cost' THEN 1 ELSE 0 END,
    condition_type = coalesce(changed->>'condition', condition_type),
    peer_desc = coalesce(changed->>'peerDesc', peer_desc),
    customer_desc = coalesce(changed->>'customerDesc', customer_desc),
    internal_note = coalesce(changed->>'internalNote', internal_note),
    template_snapshot = CASE WHEN attrs IS DISTINCT FROM attributes THEN snapshot ELSE template_snapshot END,
    attributes = attrs
  WHERE id = p_id;

  -- 审计视图按 internalNote 键裁剪内部模板参数。
  IF internal_new <> '{}' THEN
    previous := previous || jsonb_build_object('internalNoteAttributes', internal_old);
    changed := changed || jsonb_build_object('internalNoteAttributes', internal_new);
  END IF;
  PERFORM stock_audit(p_user, p_request_id, '修改库存设备资料', p_id::text, previous, changed, why);
  RETURN jsonb_build_object('id', p_id);
END $$;

REVOKE ALL ON FUNCTION public.api_stock_unit_edit(uuid,jsonb,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_stock_unit_edit(uuid,jsonb,jsonb,text) TO service_role;
