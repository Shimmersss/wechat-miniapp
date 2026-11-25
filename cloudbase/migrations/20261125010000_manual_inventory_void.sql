-- 只作废误录的独立入库设备，原设备行、附件、流水与审计均保留。
CREATE FUNCTION stock_unit_can_void(target units) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT target.ownership = 'own'
    AND target.status IN ('in_stock', 'recheck')
    AND target.purchase_line_id IS NULL
    AND target.acceptance_item_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM unit_identifiers WHERE unit_id = target.id AND acceptance_item_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM sales_items WHERE unit_id = target.id)
    AND NOT EXISTS (SELECT 1 FROM agent_orders WHERE unit_id = target.id)
    AND NOT EXISTS (SELECT 1 FROM repair_orders WHERE unit_id = target.id)
    AND NOT EXISTS (SELECT 1 FROM loan_items WHERE unit_id = target.id)
    AND NOT EXISTS (
      SELECT 1 FROM stocktake_session_units i
      JOIN stocktake_sessions s ON s.id = i.session_id
      WHERE i.unit_id = target.id AND s.status = 'open'
    )
$$;

CREATE FUNCTION stock_void_unit(uid uuid, d jsonb, u jsonb, req text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  current_unit units;
  actor uuid := (u->>'id')::uuid;
  why text;
BEGIN
  IF u->>'role' IS DISTINCT FROM 'boss'
    OR NOT EXISTS (SELECT 1 FROM staff WHERE user_id = actor AND status = 'active' AND role_key = 'boss') THEN
    PERFORM stock_error('P0403', '仅老板账号可以删除库存设备');
  END IF;
  why := stock_text(d->'reason', '删除原因', 200);
  SELECT * INTO current_unit FROM units WHERE id = uid FOR UPDATE;
  IF NOT FOUND THEN PERFORM stock_error('P0404', '设备不存在'); END IF;
  IF current_unit.status = 'voided' THEN
    RETURN jsonb_build_object('id', uid, 'deleted', true);
  END IF;
  IF NOT stock_unit_can_void(current_unit) THEN
    PERFORM stock_error('P0409', '设备状态已变化或已有业务单据，不能删除');
  END IF;

  PERFORM stock_audit(u, req, '删除库存设备', uid::text,
    jsonb_build_object('status', current_unit.status, 'modelId', current_unit.model_id,
      'imeiAndSerial', jsonb_build_object('imei1', current_unit.imei1,
        'imei2', current_unit.imei2, 'serialNo', current_unit.serial_no),
      'shareFlags', current_unit.share_flags),
    jsonb_build_object('status', 'voided'), why);

  -- 放开活跃串码的占用，原串码保存在有字段权限的审计记录中。
  DELETE FROM unit_identifiers WHERE unit_id = uid;
  UPDATE units SET status = 'voided', imei1 = NULL, imei2 = NULL, serial_no = NULL,
    no_serial_reason = '设备已作废，原串码见审计',
    share_flags = '{"showInShop":false,"sharePeer":false,"shareAgent":false}'
    WHERE id = uid;
  INSERT INTO inventory_ledger(unit_id,from_status,to_status,doc_type,doc_id,operator_id,reason)
    VALUES(uid,current_unit.status,'voided','inventory_void',uid::text,actor,why);
  RETURN jsonb_build_object('id', uid, 'deleted', true);
END $$;

REVOKE ALL ON FUNCTION stock_unit_can_void(units), stock_void_unit(uuid,jsonb,jsonb,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION stock_unit_can_void(units), stock_void_unit(uuid,jsonb,jsonb,text)
  TO service_role;

CREATE OR REPLACE FUNCTION stock_find_unit(code text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE c text := btrim(coalesce(code,'')); r uuid; ids uuid[];
BEGIN
  IF c = '' THEN RETURN NULL; END IF;
  SELECT id INTO r FROM units WHERE status <> 'voided' AND (id::text = c OR imei1 = c OR imei2 = c) LIMIT 1;
  IF FOUND THEN RETURN r; END IF;
  SELECT array_agg(id) INTO ids FROM units WHERE status <> 'voided' AND serial_no = upper(c);
  IF coalesce(array_length(ids,1),0) > 1 THEN
    PERFORM stock_error('P0409','该序列号对应多台设备，请扫设备标签或从库存选择');
  END IF;
  RETURN ids[1];
END $$;

-- 在当前版本的库存例程中增量插入，保留早先上线的入库、模板和复检逻辑。
DO $migration$
DECLARE
  f text := pg_get_functiondef('public.stock_inventory(text,jsonb,jsonb,jsonb,text)'::regprocedure);
  edit record;
BEGIN
  FOR edit IN SELECT * FROM (VALUES
    ($old$ CASE action
 WHEN 'inbound.check' THEN$old$, $new$ CASE action
 WHEN 'units.void' THEN RETURN stock_void_unit(uid,d,u,req);
 WHEN 'inbound.check' THEN$new$),
    ($old$WHERE model_id=d->>'modelId' ORDER BY cost$old$,
     $new$WHERE model_id=d->>'modelId' AND status<>'voided' ORDER BY cost$new$),
    ($old$JOIN models m ON m.id=u.model_id WHERE (NOT d ? 'status'$old$,
     $new$JOIN models m ON m.id=u.model_id WHERE u.status<>'voided' AND (NOT d ? 'status'$new$),
    ($old$FROM units GROUP BY status$old$, $new$FROM units WHERE status<>'voided' GROUP BY status$new$),
    ($old$jsonb_build_object('all',(SELECT count(*) FROM units))$old$,
     $new$jsonb_build_object('all',(SELECT count(*) FROM units WHERE status<>'voided'))$new$),
    ($old$SELECT * INTO row_v FROM units WHERE id=k::uuid; IF NOT FOUND$old$,
     $new$SELECT * INTO row_v FROM units WHERE id=k::uuid AND status<>'voided'; IF NOT FOUND$new$),
    ($old$IF NOT FOUND THEN PERFORM stock_error('P0404','设备不存在'); END IF;
  CASE action
  WHEN 'units.get','units.recheckForm' THEN result:=stock_raw(uid);$old$,
     $new$IF NOT FOUND OR (row_v.status='voided' AND action<>'units.ledger') THEN
    PERFORM stock_error('P0404','设备不存在或已删除');
  END IF;
  CASE action
  WHEN 'units.get' THEN
    result:=stock_raw(uid)||jsonb_build_object('canVoid',
      CASE WHEN u->>'role'='boss' THEN stock_unit_can_void(row_v) ELSE false END);
  WHEN 'units.recheckForm' THEN result:=stock_raw(uid);$new$)
  ) AS edits(old_sql,new_sql)
  LOOP
    IF strpos(f,edit.old_sql)=0 THEN RAISE EXCEPTION 'Unexpected stock_inventory definition'; END IF;
    f := replace(f,edit.old_sql,edit.new_sql);
  END LOOP;
  EXECUTE f;
END $migration$;
