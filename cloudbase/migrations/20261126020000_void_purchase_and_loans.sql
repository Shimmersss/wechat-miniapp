-- 老板可作废已有采购单与借还记录，保留流水、历史单据外键及审计日志。
DO $migration$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conrelid::regclass AS tbl, conname
    FROM pg_constraint
    WHERE conrelid IN ('public.loan_states'::regclass, 'public.loan_item_states'::regclass)
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%returned_recheck%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
  END LOOP;
END $migration$;

ALTER TABLE public.loan_states
  ADD CONSTRAINT loan_states_status_check
  CHECK (status IN ('active','returned_recheck','closed','voided'));

ALTER TABLE public.loan_item_states
  ADD CONSTRAINT loan_item_states_status_check
  CHECK (status IN ('active','returned_recheck','closed','voided'));

CREATE FUNCTION public.stock_void_purchase(pid uuid, d jsonb, u jsonb, req text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  po purchase_orders;
  actor uuid := (u->>'id')::uuid;
  why text;
  shipments_v jsonb;
  exception_ids_v jsonb;
  before_v jsonb;
  released_shipments int := 0;
  released_identifiers int := 0;
BEGIN
  IF u->>'role' IS DISTINCT FROM 'boss'
    OR NOT EXISTS (SELECT 1 FROM staff WHERE user_id = actor AND status = 'active' AND role_key = 'boss') THEN
    PERFORM stock_error('P0403', '仅老板账号可以删除采购单');
  END IF;
  why := stock_text(d->'reason', '删除原因', 200);
  SELECT * INTO po FROM purchase_orders WHERE id = pid FOR UPDATE;
  IF NOT FOUND THEN PERFORM stock_error('P0404', '采购单不存在'); END IF;
  IF po.status = 'voided' THEN
    RETURN jsonb_build_object('id', pid, 'deleted', true);
  END IF;

  SELECT coalesce(jsonb_agg(
    jsonb_build_object('id', sh.id, 'carrier', sh.carrier, 'trackingNo', sh.tracking_no, 'status', sh.status)
    ORDER BY sh.shipped_at, sh.id
  ), '[]'::jsonb)
  INTO shipments_v
  FROM shipments sh
  WHERE sh.purchase_id = pid;

  SELECT coalesce(jsonb_agg(
    jsonb_build_object('itemId', a.id, 'imei1', a.imei1, 'imei2', a.imei2, 'serialNo', a.serial_no)
    ORDER BY a.created_at, a.id
  ), '[]'::jsonb)
  INTO exception_ids_v
  FROM acceptance_items a
  JOIN acceptance_batches b ON b.id = a.batch_id
  WHERE b.purchase_id = pid
    AND a.result = 'fail'
    AND a.resolution IN ('none', 'dispute')
    AND a.unit_id IS NULL;

  before_v := jsonb_build_object(
    'no', po.no,
    'status', po.status,
    'qty', po.quantity,
    'expectedAt', po.expected_at,
    'supplierId', po.supplier_id,
    'costAmount', po.amount,
    'freightCost', po.freight,
    'shipments', shipments_v,
    'releasedExceptionImei', exception_ids_v
  );

  -- 仅释放尚未入库异常项预留的串码；已验收生成的库存设备保留原档案与采购关联。
  DELETE FROM unit_identifiers
  WHERE unit_id IS NULL
    AND acceptance_item_id IN (
      SELECT a.id FROM acceptance_items a
      JOIN acceptance_batches b ON b.id = a.batch_id
      WHERE b.purchase_id = pid
    );
  GET DIAGNOSTICS released_identifiers = ROW_COUNT;

  DELETE FROM shipments WHERE purchase_id = pid;
  GET DIAGNOSTICS released_shipments = ROW_COUNT;

  UPDATE purchase_orders SET status = 'voided' WHERE id = pid;

  PERFORM stock_audit(u, req, '删除采购单', pid::text, before_v,
    jsonb_build_object(
      'status', 'voided',
      'releasedShipments', released_shipments,
      'releasedAcceptanceIdentifiers', released_identifiers
    ), why);

  RETURN jsonb_build_object('id', pid, 'deleted', true);
END $$;

CREATE FUNCTION public.loan_void_order(oid uuid, d jsonb, p_user jsonb, p_request_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  actor uuid := (p_user->>'id')::uuid;
  why text;
  st loan_states;
  o loan_orders;
  rec record;
  u units;
  prev_status text;
  prev_version int;
  before_items jsonb := '[]'::jsonb;
  affected jsonb := '[]'::jsonb;
  has_other_loans boolean;
  has_other_refs boolean;
  eid uuid := gen_random_uuid();
  closed_flags jsonb := '{"showInShop":false,"sharePeer":false,"shareAgent":false}';
BEGIN
  IF p_user->>'role' IS DISTINCT FROM 'boss'
    OR NOT EXISTS (SELECT 1 FROM staff WHERE user_id = actor AND status = 'active' AND role_key = 'boss') THEN
    PERFORM stock_error('P0403', '仅老板账号可以删除借还记录');
  END IF;
  why := stock_text(d->'reason', '删除原因', 200);
  SELECT * INTO st FROM loan_states WHERE order_id = oid FOR UPDATE;
  IF NOT FOUND THEN PERFORM stock_error('P0404', '借还单不存在'); END IF;
  IF st.status = 'voided' THEN
    RETURN jsonb_build_object('id', oid, 'deleted', true);
  END IF;

  prev_status := st.status;
  prev_version := st.version;
  SELECT * INTO o FROM loan_orders WHERE id = oid;

  FOR rec IN
    SELECT li.id AS item_id, li.unit_id, li.snapshot, ls.status AS item_status
    FROM loan_items li
    JOIN loan_item_states ls ON ls.item_id = li.id
    WHERE li.order_id = oid
    ORDER BY li.unit_id
  LOOP
    SELECT * INTO u FROM units WHERE id = rec.unit_id FOR UPDATE;
    IF NOT FOUND THEN PERFORM stock_error('P0404', '关联设备不存在'); END IF;

    before_items := before_items || jsonb_build_array(jsonb_build_object(
      'unitId', u.id,
      'modelId', u.model_id,
      'itemStatus', rec.item_status,
      'unitStatus', u.status,
      'imei1', u.imei1,
      'imei2', u.imei2,
      'serialNo', u.serial_no
    ));

    IF o.type = 'loan_out' THEN
      IF rec.item_status = 'active' THEN
        IF u.status <> 'loaned_out' THEN
          PERFORM stock_error('P0409', '设备状态已变化，不能删除该借还记录');
        END IF;
        DELETE FROM loan_active_units WHERE unit_id = u.id AND order_id = oid;
        UPDATE units SET status = 'in_stock', share_flags = closed_flags WHERE id = u.id;
        INSERT INTO inventory_ledger(unit_id, from_status, to_status, doc_type, doc_id, operator_id, reason)
          VALUES(u.id, 'loaned_out', 'in_stock', 'loan_void', oid::text, actor, why);
        affected := affected || jsonb_build_array(jsonb_build_object('unitId', u.id, 'action', 'restored_in_stock'));
      ELSIF rec.item_status = 'returned_recheck' THEN
        DELETE FROM loan_active_units WHERE unit_id = u.id AND order_id = oid;
        affected := affected || jsonb_build_array(jsonb_build_object('unitId', u.id, 'action', 'detached_recheck', 'unitStatus', u.status));
      ELSE
        DELETE FROM loan_active_units WHERE unit_id = u.id AND order_id = oid;
        affected := affected || jsonb_build_array(jsonb_build_object('unitId', u.id, 'action', 'kept_closed', 'unitStatus', u.status));
      END IF;
    ELSE
      SELECT EXISTS(
        SELECT 1 FROM loan_items oi
        JOIN loan_states os ON os.order_id = oi.order_id
        WHERE oi.unit_id = u.id AND oi.order_id <> oid AND os.status <> 'voided'
      ) INTO has_other_loans;

      SELECT (
        EXISTS(SELECT 1 FROM sales_items WHERE unit_id = u.id)
        OR EXISTS(SELECT 1 FROM agent_orders WHERE unit_id = u.id)
        OR EXISTS(SELECT 1 FROM repair_orders WHERE unit_id = u.id)
        OR EXISTS(
          SELECT 1 FROM stocktake_session_units su
          JOIN stocktake_sessions ss ON ss.id = su.session_id
          WHERE su.unit_id = u.id AND ss.status = 'open'
        )
      ) INTO has_other_refs;

      IF rec.item_status = 'active' THEN
        IF has_other_refs THEN
          PERFORM stock_error('P0409', '借入设备存在关联业务单据或进行中的盘点，不能删除');
        END IF;
        IF u.status <> 'borrowed_in' THEN
          PERFORM stock_error('P0409', '借入设备状态已变化，不能删除');
        END IF;
        DELETE FROM loan_active_units WHERE unit_id = u.id AND order_id = oid;
        IF has_other_loans THEN
          UPDATE units SET status = 'returned', share_flags = closed_flags WHERE id = u.id;
          INSERT INTO inventory_ledger(unit_id, from_status, to_status, doc_type, doc_id, operator_id, reason)
            VALUES(u.id, 'borrowed_in', 'returned', 'loan_void', oid::text, actor, why);
          affected := affected || jsonb_build_array(jsonb_build_object('unitId', u.id, 'action', 'restored_returned'));
        ELSE
          DELETE FROM unit_identifiers WHERE unit_id = u.id;
          UPDATE units SET status = 'voided', imei1 = NULL, imei2 = NULL, serial_no = NULL,
            no_serial_reason = '借入单已作废，原串码见审计', share_flags = closed_flags
            WHERE id = u.id;
          INSERT INTO inventory_ledger(unit_id, from_status, to_status, doc_type, doc_id, operator_id, reason)
            VALUES(u.id, 'borrowed_in', 'voided', 'loan_void', oid::text, actor, why);
          affected := affected || jsonb_build_array(jsonb_build_object('unitId', u.id, 'action', 'voided_borrowed_unit'));
        END IF;
      ELSIF rec.item_status = 'closed' AND u.ownership = 'borrowed' AND u.status = 'returned'
        AND NOT has_other_loans AND NOT has_other_refs THEN
        DELETE FROM unit_identifiers WHERE unit_id = u.id;
        UPDATE units SET status = 'voided', imei1 = NULL, imei2 = NULL, serial_no = NULL,
          no_serial_reason = '借入单已作废，原串码见审计', share_flags = closed_flags
          WHERE id = u.id;
        INSERT INTO inventory_ledger(unit_id, from_status, to_status, doc_type, doc_id, operator_id, reason)
          VALUES(u.id, 'returned', 'voided', 'loan_void', oid::text, actor, why);
        affected := affected || jsonb_build_array(jsonb_build_object('unitId', u.id, 'action', 'voided_returned_borrowed_unit'));
      ELSE
        affected := affected || jsonb_build_array(jsonb_build_object('unitId', u.id, 'action', 'kept_closed', 'unitStatus', u.status));
      END IF;
    END IF;
  END LOOP;

  UPDATE loan_item_states SET status = 'voided'
  WHERE item_id IN (SELECT id FROM loan_items WHERE order_id = oid);
  UPDATE loan_states SET status = 'voided', version = version + 1, updated_at = now()
  WHERE order_id = oid RETURNING * INTO st;

  INSERT INTO loan_events(id, order_id, actor_id, action, version, reason, data, request_key, request_hash)
  VALUES(eid, oid, actor, 'void', st.version, why, jsonb_build_object('affectedUnits', affected),
    'void_' || eid::text, encode(sha256(convert_to('void_' || eid::text, 'UTF8')), 'hex'));

  PERFORM stock_audit(p_user, p_request_id, '删除借还记录', oid::text,
    jsonb_build_object(
      'no', o.no,
      'type', o.type,
      'status', prev_status,
      'version', prev_version,
      'counterparty', o.counterparty,
      'dueAt', o.due_date,
      'imeiAndSerial', before_items
    ),
    jsonb_build_object('type', o.type, 'status', 'voided', 'version', st.version, 'affectedUnits', affected),
    why);

  RETURN jsonb_build_object('id', oid, 'deleted', true);
END $$;

REVOKE ALL ON FUNCTION public.stock_void_purchase(uuid,jsonb,jsonb,text), public.loan_void_order(uuid,jsonb,jsonb,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stock_void_purchase(uuid,jsonb,jsonb,text), public.loan_void_order(uuid,jsonb,jsonb,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.stock_unit_can_void(target units) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT target.ownership = 'own'
    AND target.status IN ('in_stock', 'recheck')
    AND target.purchase_line_id IS NULL
    AND target.acceptance_item_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM unit_identifiers WHERE unit_id = target.id AND acceptance_item_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM sales_items WHERE unit_id = target.id)
    AND NOT EXISTS (SELECT 1 FROM agent_orders WHERE unit_id = target.id)
    AND NOT EXISTS (SELECT 1 FROM repair_orders WHERE unit_id = target.id)
    AND NOT EXISTS (
      SELECT 1 FROM loan_items li
      JOIN loan_states ls ON ls.order_id = li.order_id
      WHERE li.unit_id = target.id AND ls.status <> 'voided'
    )
    AND NOT EXISTS (
      SELECT 1 FROM stocktake_session_units i
      JOIN stocktake_sessions s ON s.id = i.session_id
      WHERE i.unit_id = target.id AND s.status = 'open'
    )
$$;

-- 在当前已部署函数定义上增量插入删除与过滤逻辑，保留原有业务规则与前导释放逻辑。
DO $migration$
DECLARE
  f text;
  edit record;
BEGIN
  f := pg_get_functiondef('public.stock_purchase(text,jsonb,jsonb,jsonb,text)'::regprocedure);
  FOR edit IN SELECT * FROM (VALUES
    ($old$FROM purchase_orders o WHERE (NOT d ? 'status'$old$,
     $new$FROM purchase_orders o WHERE o.status<>'voided' AND (NOT d ? 'status'$new$),
    ($old$ WHEN 'purchase.get','purchase.acceptance' THEN
  result:=stock_purchase_raw(target); IF result IS NULL THEN PERFORM stock_error('P0404','采购单不存在'); END IF;$old$,
     $new$ WHEN 'purchase.get' THEN
  result:=stock_purchase_raw(target); IF result IS NULL OR result->>'status'='voided' THEN PERFORM stock_error('P0404','采购单不存在或已删除'); END IF;
  result:=result||jsonb_build_object('canVoid',u->>'role'='boss');
 WHEN 'purchase.acceptance' THEN
  result:=stock_purchase_raw(target); IF result IS NULL OR result->>'status'='voided' THEN PERFORM stock_error('P0404','采购单不存在或已删除'); END IF;
 WHEN 'purchase.void' THEN RETURN stock_void_purchase(target,d,u,req);$new$),
    ($old$IF action='purchase.update' THEN SELECT * INTO po FROM purchase_orders WHERE id=target FOR UPDATE; IF NOT FOUND THEN PERFORM stock_error('P0404','采购单不存在'); END IF;$old$,
     $new$IF action='purchase.update' THEN SELECT * INTO po FROM purchase_orders WHERE id=target FOR UPDATE; IF NOT FOUND OR po.status='voided' THEN PERFORM stock_error('P0404','采购单不存在或已删除'); END IF;$new$),
    ($old$WHEN 'purchase.shipment' THEN
  SELECT * INTO po FROM purchase_orders WHERE id=target FOR UPDATE; IF NOT FOUND THEN PERFORM stock_error('P0404','采购单不存在'); END IF;$old$,
     $new$WHEN 'purchase.shipment' THEN
  SELECT * INTO po FROM purchase_orders WHERE id=target FOR UPDATE; IF NOT FOUND OR po.status='voided' THEN PERFORM stock_error('P0404','采购单不存在或已删除'); END IF;$new$),
    ($old$PERFORM 1 FROM purchase_orders WHERE id=sh.purchase_id FOR UPDATE; SELECT * INTO sh FROM shipments WHERE id=target FOR UPDATE;$old$,
     $new$PERFORM 1 FROM purchase_orders WHERE id=sh.purchase_id AND status<>'voided' FOR UPDATE; IF NOT FOUND THEN PERFORM stock_error('P0404','采购单已删除'); END IF; SELECT * INTO sh FROM shipments WHERE id=target FOR UPDATE;$new$)
  ) AS edits(old_sql, new_sql)
  LOOP
    IF strpos(f, edit.old_sql) = 0 THEN RAISE EXCEPTION 'Unexpected stock_purchase definition: %', edit.old_sql; END IF;
    f := replace(f, edit.old_sql, edit.new_sql);
  END LOOP;
  EXECUTE f;

  f := pg_get_functiondef('public.stock_accept(text,jsonb,jsonb,jsonb,text)'::regprocedure);
  FOR edit IN SELECT * FROM (VALUES
    ($old$SELECT * INTO po FROM purchase_orders WHERE id=(p->>'id')::uuid FOR UPDATE; IF NOT FOUND THEN PERFORM stock_error('P0404','采购单不存在'); END IF;$old$,
     $new$SELECT * INTO po FROM purchase_orders WHERE id=(p->>'id')::uuid FOR UPDATE; IF NOT FOUND OR po.status='voided' THEN PERFORM stock_error('P0404','采购单不存在或已删除'); END IF;$new$),
    ($old$SELECT o.* INTO po FROM purchase_orders o JOIN acceptance_batches b ON b.purchase_id=o.id WHERE b.id=ai.batch_id FOR UPDATE OF o;$old$,
     $new$SELECT o.* INTO po FROM purchase_orders o JOIN acceptance_batches b ON b.purchase_id=o.id WHERE b.id=ai.batch_id AND o.status<>'voided' FOR UPDATE OF o; IF NOT FOUND THEN PERFORM stock_error('P0404','采购单已删除，不能处理原验收异常'); END IF;$new$)
  ) AS edits(old_sql, new_sql)
  LOOP
    IF strpos(f, edit.old_sql) = 0 THEN RAISE EXCEPTION 'Unexpected stock_accept definition: %', edit.old_sql; END IF;
    f := replace(f, edit.old_sql, edit.new_sql);
  END LOOP;
  EXECUTE f;

  f := pg_get_functiondef('public.stock_insert(jsonb,jsonb,jsonb)'::regprocedure);
  FOR edit IN SELECT * FROM (VALUES
    ($old$IF EXISTS(SELECT 1 FROM acceptance_items WHERE model_id=mid AND serial_no=serial_v AND unit_id IS NULL AND result='fail' AND resolution IN ('none','dispute') AND id IS DISTINCT FROM reserved) THEN PERFORM stock_error('P0409','该序列号正在异常验收中'); END IF;$old$,
     $new$IF EXISTS(SELECT 1 FROM acceptance_items ai JOIN acceptance_batches ab ON ab.id=ai.batch_id JOIN purchase_orders po ON po.id=ab.purchase_id WHERE ai.model_id=mid AND ai.serial_no=serial_v AND ai.unit_id IS NULL AND ai.result='fail' AND ai.resolution IN ('none','dispute') AND ai.id IS DISTINCT FROM reserved AND po.status<>'voided') THEN PERFORM stock_error('P0409','该序列号正在异常验收中'); END IF;$new$)
  ) AS edits(old_sql, new_sql)
  LOOP
    IF strpos(f, edit.old_sql) = 0 THEN RAISE EXCEPTION 'Unexpected stock_insert definition: %', edit.old_sql; END IF;
    f := replace(f, edit.old_sql, edit.new_sql);
  END LOOP;
  EXECUTE f;

  f := pg_get_functiondef('public.api_loans(text,uuid,jsonb,jsonb,text)'::regprocedure);
  FOR edit IN SELECT * FROM (VALUES
    ($old$IF p_action='get' THEN result:=loan_raw(oid); IF result IS NULL THEN PERFORM stock_error('P0404','借还单不存在'); END IF; RETURN result; END IF;$old$,
     $new$IF p_action='get' THEN result:=loan_raw(oid); IF result IS NULL OR result->>'status'='voided' THEN PERFORM stock_error('P0404','借还单不存在或已删除'); END IF; RETURN result||jsonb_build_object('canVoid',p_user->>'role'='boss'); END IF;
 IF p_action='void' THEN RETURN loan_void_order(oid,d,p_user,p_request_id); END IF;$new$),
    ($old$WITH matches AS(SELECT ord.id,ord.created_at FROM loan_orders ord JOIN loan_states s ON s.order_id=ord.id WHERE$old$,
     $new$WITH matches AS(SELECT ord.id,ord.created_at FROM loan_orders ord JOIN loan_states s ON s.order_id=ord.id WHERE s.status<>'voided' AND$new$),
    ($old$SELECT * INTO st FROM loan_states WHERE order_id=oid FOR UPDATE; IF NOT FOUND THEN PERFORM stock_error('P0404','借还单不存在'); END IF;$old$,
     $new$SELECT * INTO st FROM loan_states WHERE order_id=oid FOR UPDATE; IF NOT FOUND OR st.status='voided' THEN PERFORM stock_error('P0404','借还单不存在或已删除'); END IF;$new$)
  ) AS edits(old_sql, new_sql)
  LOOP
    IF strpos(f, edit.old_sql) = 0 THEN RAISE EXCEPTION 'Unexpected api_loans definition: %', edit.old_sql; END IF;
    f := replace(f, edit.old_sql, edit.new_sql);
  END LOOP;
  EXECUTE f;
END $migration$;
