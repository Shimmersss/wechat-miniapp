-- 借还主链：规则对应 server/src/loans.js；订单/快照/事件/关联只追加，状态独立更新。
REVOKE UPDATE,DELETE,TRUNCATE ON loan_orders,loan_items,loan_events,loan_files FROM service_role;
CREATE INDEX loan_orders_created ON loan_orders(created_at DESC,id);
CREATE INDEX loan_orders_due ON loan_orders(due_date,id);
CREATE INDEX loan_items_unit ON loan_items(unit_id,order_id);
CREATE INDEX loan_files_file ON loan_files(file_id);
CREATE INDEX loan_states_status ON loan_states(status,order_id);
CREATE INDEX loan_item_states_status ON loan_item_states(status,item_id);

CREATE FUNCTION loan_raw(oid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT to_jsonb(o)||jsonb_build_object('status',s.status,'version',s.version,'loanAccess',true,
 'items',coalesce((SELECT jsonb_agg(to_jsonb(i)||to_jsonb(ls)||jsonb_build_object('unit_status',u.status) ORDER BY i.unit_id) FROM loan_items i JOIN loan_item_states ls ON ls.item_id=i.id JOIN units u ON u.id=i.unit_id WHERE i.order_id=o.id),'[]'),
 'events',coalesce((SELECT jsonb_agg(to_jsonb(e)||jsonb_build_object('operator',u.nickname) ORDER BY e.version,e.id) FROM loan_events e JOIN users u ON u.id=e.actor_id WHERE e.order_id=o.id),'[]'),
 'attached',coalesce((SELECT jsonb_agg(to_jsonb(f)||jsonb_build_object('event_id',lf.event_id,'field_key','loanPhotos') ORDER BY lf.event_id,lf.file_id) FROM loan_files lf JOIN files f ON f.id=lf.file_id WHERE lf.order_id=o.id),'[]'))
 FROM loan_orders o JOIN loan_states s ON s.order_id=o.id WHERE o.id=oid
$$;
CREATE FUNCTION loan_proofs(vals jsonb,u jsonb,required boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE ids jsonb; fid uuid; f files;
BEGIN
 vals:=coalesce(vals,'[]');
 IF jsonb_typeof(vals)<>'array' OR jsonb_array_length(vals)>9 OR (required AND jsonb_array_length(vals)=0) THEN PERFORM stock_error('P0400','交接凭证须为1～9张内部图片'); END IF;
 SELECT coalesce(jsonb_agg((value->>'fileId')::uuid),'[]') INTO ids FROM jsonb_array_elements(vals);
 IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(ids))<>jsonb_array_length(vals) THEN PERFORM stock_error('P0400','凭证重复'); END IF;
 PERFORM 1 FROM files WHERE id IN(SELECT value::uuid FROM jsonb_array_elements_text(ids)) ORDER BY id FOR UPDATE;
 FOR fid IN SELECT value::uuid FROM jsonb_array_elements_text(ids) LOOP
  SELECT * INTO f FROM files WHERE id=fid;
  IF NOT FOUND OR f.scope<>'internal' OR f.mime NOT LIKE 'image/%' THEN PERFORM stock_error('P0400','借还凭证须单独上传为内部图片'); END IF;
  IF EXISTS(SELECT 1 FROM unit_files WHERE file_id=fid) OR EXISTS(SELECT 1 FROM repair_files WHERE file_id=fid) OR EXISTS(SELECT 1 FROM sales_files WHERE file_id=fid) THEN PERFORM stock_error('P0400','其他业务凭证不能用作借还附件'); END IF;
  IF f.owner_id<>(u->>'id')::uuid AND u->>'role' NOT IN ('boss','manager') THEN PERFORM stock_error('P0403','无权引用他人的交接凭证'); END IF;
 END LOOP;
 RETURN ids;
END $$;
CREATE FUNCTION api_loans(p_action text,p_id uuid,p_data jsonb,p_user jsonb,p_request_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
 d jsonb:=p_data; actor uuid:=(p_user->>'id')::uuid; oid uuid:=p_id; o loan_orders; st loan_states;
 key_v text; sig text; why text; old_hash text; inp jsonb; x jsonb; dev jsonb; proof jsonb:='[]'; part jsonb; data_v jsonb:='[]';
 uid uuid; iid uuid; eid uuid:=gen_random_uuid(); u units; ident unit_identifiers; prior_uid uuid;
 imei_v text; imei2_v text; code_v text; form jsonb; model_name text; seen text[]:='{}'; typ text; next_v text;
 li loan_items; ls loan_item_states; cnt int; ledger_id bigint; today_v date:=(now() AT TIME ZONE 'Asia/Shanghai')::date; result jsonb; total_v bigint;
 closed_flags jsonb:='{"showInShop":false,"sharePeer":false,"shareAgent":false}';
BEGIN
 IF p_user->>'staffNo' IS NULL OR NOT coalesce(p_user->'permissions','[]') ? 'loan:manage' THEN PERFORM stock_error('P0403','仅有借还权限的员工可管理借还'); END IF;
 IF p_action='options' THEN RETURN '{"financialPolicy":"none","supportsPayments":false,"borrowedSalesEnabled":false,"maxItems":50}'::jsonb; END IF;
 IF p_action='get' THEN result:=loan_raw(oid); IF result IS NULL THEN PERFORM stock_error('P0404','借还单不存在'); END IF; RETURN result; END IF;
 IF p_action='list' THEN
  WITH matches AS(SELECT ord.id,ord.created_at FROM loan_orders ord JOIN loan_states s ON s.order_id=ord.id WHERE
   (nullif(d->>'type','') IS NULL OR ord.type=d->>'type') AND
   (nullif(d->>'status','') IS NULL OR (d->>'status'='overdue' AND s.status='active' AND ord.due_date<today_v) OR
    (d->>'status'='returned_recheck' AND EXISTS(SELECT 1 FROM loan_items i JOIN loan_item_states item_state ON item_state.item_id=i.id WHERE i.order_id=ord.id AND item_state.status='returned_recheck')) OR (d->>'status' IN ('active','closed') AND s.status=d->>'status')) AND
   (nullif(d->>'keyword','') IS NULL OR ord.no ILIKE '%'||(d->>'keyword')||'%' OR ord.counterparty ILIKE '%'||(d->>'keyword')||'%' OR EXISTS(SELECT 1 FROM loan_items i JOIN units unit_row ON unit_row.id=i.unit_id WHERE i.order_id=ord.id AND (unit_row.imei1=d->>'keyword' OR unit_row.imei2=d->>'keyword')))
  ), paged AS(SELECT * FROM matches ORDER BY created_at DESC,id LIMIT (d->>'pageSize')::int OFFSET (d->>'offset')::int)
  SELECT jsonb_build_object('total',(SELECT count(*) FROM matches),'rows',coalesce(jsonb_agg(loan_raw(paged.id) ORDER BY created_at DESC,id),'[]')) INTO result FROM paged;
  RETURN result;
 END IF;
 key_v:=stock_text(d->'requestKey','提交标识',100); sig:=d->>'signature'; why:=stock_text(d->'reason','处理说明',500);
 IF sig IS NULL OR sig !~ '^[a-f0-9]{64}$' THEN PERFORM stock_error('P0400','请求摘要无效'); END IF;
 IF p_action='create' THEN
  -- 同一员工同一提交标识串行化；重试在任何库存变动之前直接返回原单。
  PERFORM pg_advisory_xact_lock(hashtextextended('loan:'||actor::text||':'||key_v,0));
  SELECT * INTO o FROM loan_orders WHERE creator_id=actor AND request_key=key_v;
  IF FOUND THEN IF o.request_hash<>sig THEN PERFORM stock_error('P0409','提交标识内容冲突'); END IF; RETURN loan_raw(o.id); END IF;
  typ:=d->>'type'; inp:=CASE WHEN typ='loan_out' THEN d->'unitIds' ELSE d->'devices' END;
  IF typ NOT IN ('loan_out','borrow_in') OR inp IS NULL OR jsonb_typeof(inp)<>'array' OR jsonb_array_length(inp) NOT BETWEEN 1 AND 50 THEN PERFORM stock_error('P0400','每单须有1～50台且类型与设备匹配'); END IF;
  proof:=loan_proofs(d->'photos',p_user); oid:=gen_random_uuid();
  INSERT INTO loan_orders(id,no,type,counterparty,phone,due_date,remark,creator_id,request_key,request_hash) VALUES(oid,'LN'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||left(oid::text,8),typ,stock_text(d->'counterparty','对方',120),stock_text(d->'phone','联系电话',30),(d->>'dueAt')::date,stock_text(d->'remark','备注',2000,true),actor,key_v,sig) RETURNING * INTO o;
  INSERT INTO loan_states(order_id) VALUES(oid) RETURNING * INTO st;
  -- 先按设备/串码排序，所有多台写入同一事务，任意失败全单回滚。
  FOR dev IN SELECT value FROM jsonb_array_elements(inp) ORDER BY CASE WHEN typ='loan_out' THEN value#>>'{}' ELSE value->>'imei1' END LOOP
   IF typ='loan_out' THEN
    IF NOT coalesce(p_user->'permissions','[]') ? 'inventory:view' THEN PERFORM stock_error('P0403','无权限查看库存'); END IF;
    uid:=(dev#>>'{}')::uuid; IF uid::text=ANY(seen) THEN PERFORM stock_error('P0400','设备重复'); END IF; seen:=array_append(seen,uid::text);
    SELECT * INTO u FROM units WHERE id=uid FOR UPDATE; IF NOT FOUND THEN PERFORM stock_error('P0404','设备不存在'); END IF;
    IF u.status<>'in_stock' OR u.ownership<>'own' THEN PERFORM stock_error('P0409','仅本店自有可售设备可以出借'); END IF;
    INSERT INTO loan_active_units(unit_id,order_id) VALUES(uid,oid);
    UPDATE units SET status='loaned_out',share_flags=closed_flags WHERE id=uid;
    INSERT INTO inventory_ledger(unit_id,from_status,to_status,doc_type,doc_id,operator_id,reason) VALUES(uid,u.status,'loaned_out','loan_out',oid::text,actor,why);
   ELSE
    imei_v:=stock_imei(dev->>'imei1'); imei2_v:=nullif(dev->>'imei2','');
    FOR code_v IN SELECT value FROM unnest(ARRAY[imei_v,imei2_v]) value WHERE value IS NOT NULL ORDER BY value LOOP
     PERFORM stock_imei(code_v); IF code_v=ANY(seen) THEN PERFORM stock_error('P0400','借入串码无效或重复'); END IF; seen:=array_append(seen,code_v);
     PERFORM pg_advisory_xact_lock(hashtextextended('imei:'||code_v,0));
     PERFORM 1 FROM repair_external_slots WHERE identifier=code_v FOR SHARE; IF FOUND THEN PERFORM stock_error('P0409','设备正在外部维修'); END IF;
    END LOOP;
    SELECT name INTO model_name FROM models WHERE id=dev->>'modelId'; IF NOT FOUND THEN PERFORM stock_error('P0400','型号不存在'); END IF;
    -- 原借入设备只可在已归还且型号/主副串码完全一致时再借入，历史快照不变。
    prior_uid:=NULL; cnt:=0;
    FOR code_v IN SELECT value FROM unnest(ARRAY[imei_v,imei2_v]) value WHERE value IS NOT NULL ORDER BY value LOOP
     SELECT * INTO ident FROM unit_identifiers WHERE imei=code_v FOR UPDATE;
     IF FOUND THEN
      cnt:=cnt+1; IF ident.unit_id IS NULL OR (prior_uid IS NOT NULL AND prior_uid<>ident.unit_id) THEN PERFORM stock_error('P0409','串码已用于其他业务'); END IF; prior_uid:=ident.unit_id;
     END IF;
    END LOOP;
    IF cnt>0 THEN
     IF cnt<>(CASE WHEN imei2_v IS NULL THEN 1 ELSE 2 END) THEN PERFORM stock_error('P0409','串码已用于其他业务'); END IF;
     SELECT * INTO u FROM units WHERE id=prior_uid FOR UPDATE;
     IF u.ownership<>'borrowed' OR u.status<>'returned' OR u.model_id<>dev->>'modelId' OR u.imei1<>imei_v OR coalesce(u.imei2,'')<>coalesce(imei2_v,'') THEN PERFORM stock_error('P0409','该设备不是已归还的相同借入设备'); END IF;
     uid:=u.id; UPDATE units SET status='borrowed_in',share_flags=closed_flags,internal_note=dev->>'description' WHERE id=uid;
    ELSE
     uid:=gen_random_uuid(); form:=stock_form(dev->>'modelId');
     INSERT INTO units(id,model_id,imei1,imei2,status,ownership,condition_type,attributes,template_snapshot,cost,retail,wholesale,agent_base,share_flags,peer_desc,customer_desc,internal_note,inbound_operator_id) VALUES(uid,dev->>'modelId',imei_v,imei2_v,'borrowed_in','borrowed',coalesce(dev->>'condition','used'),'{}',form-'modelId'-'modelName'-'specs',0,0,0,0,closed_flags,'','',coalesce(dev->>'description',''),actor) RETURNING * INTO u;
     INSERT INTO unit_identifiers(imei,unit_id,slot) VALUES(imei_v,uid,'imei1');
     IF imei2_v IS NOT NULL THEN INSERT INTO unit_identifiers(imei,unit_id,slot) VALUES(imei2_v,uid,'imei2'); END IF;
    END IF;
    INSERT INTO loan_active_units(unit_id,order_id) VALUES(uid,oid);
    INSERT INTO inventory_ledger(unit_id,from_status,to_status,doc_type,doc_id,operator_id,reason) VALUES(uid,CASE WHEN u.status='returned' THEN 'returned' END,'borrowed_in','borrow_in',oid::text,actor,why);
   END IF;
   SELECT name INTO model_name FROM models WHERE id=u.model_id;
   iid:=gen_random_uuid();
   INSERT INTO loan_items(id,order_id,unit_id,snapshot) VALUES(iid,oid,uid,jsonb_build_object('modelId',u.model_id,'name',model_name,'imei1',u.imei1,'imei2',coalesce(u.imei2,'')));
   INSERT INTO loan_item_states(item_id) VALUES(iid);
  END LOOP;
  data_v:=jsonb_build_object('count',jsonb_array_length(inp),'type',typ);
 ELSE
  SELECT * INTO st FROM loan_states WHERE order_id=oid FOR UPDATE; IF NOT FOUND THEN PERFORM stock_error('P0404','借还单不存在'); END IF;
  SELECT * INTO o FROM loan_orders WHERE id=oid;
  SELECT request_hash INTO old_hash FROM loan_events WHERE order_id=oid AND request_key=key_v;
  IF FOUND THEN IF old_hash<>sig THEN PERFORM stock_error('P0409','操作标识内容冲突'); END IF; RETURN loan_raw(oid); END IF;
  IF st.version<>(d->>'version')::int OR st.status='closed' THEN PERFORM stock_error('P0409','借还单已更新或已完结'); END IF;
  inp:=CASE WHEN p_action='return' THEN d->'items' ELSE d->'unitIds' END;
  IF p_action NOT IN ('return','recheck') OR inp IS NULL OR jsonb_typeof(inp)<>'array' OR jsonb_array_length(inp) NOT BETWEEN 1 AND 50 THEN PERFORM stock_error('P0400','请选择逐台处理设备'); END IF;
  IF p_action='recheck' AND o.type<>'loan_out' THEN PERFORM stock_error('P0400','请选择已实际通过库存复检的设备'); END IF;
  -- 全部凭证按全局顺序预锁，随后逐台归还，避免同一次提交文件锁顺序不一致。
  IF p_action='return' THEN PERFORM 1 FROM files WHERE id IN(SELECT (f->>'fileId')::uuid FROM jsonb_array_elements(inp) item CROSS JOIN LATERAL jsonb_array_elements(item->'photos') f) ORDER BY id FOR UPDATE; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(inp) ORDER BY CASE WHEN p_action='return' THEN value->>'unitId' ELSE value#>>'{}' END LOOP
   uid:=CASE WHEN p_action='return' THEN (x->>'unitId')::uuid ELSE (x#>>'{}')::uuid END;
   IF uid::text=ANY(seen) THEN PERFORM stock_error('P0400','设备重复'); END IF; seen:=array_append(seen,uid::text);
   SELECT * INTO li FROM loan_items WHERE order_id=oid AND unit_id=uid;
   IF NOT FOUND THEN PERFORM stock_error('P0409','设备不在本单待处理列表'); END IF;
   SELECT * INTO ls FROM loan_item_states WHERE item_id=li.id;
   IF (p_action='return' AND ls.status<>'active') OR (p_action='recheck' AND ls.status<>'returned_recheck') THEN PERFORM stock_error('P0409','设备不在本单待处理列表'); END IF;
   SELECT * INTO u FROM units WHERE id=uid FOR UPDATE;
   IF p_action='return' THEN
    part:=loan_proofs(x->'photos',p_user,true); proof:=proof||part;
    typ:=CASE WHEN o.type='loan_out' THEN 'loaned_out' ELSE 'borrowed_in' END; next_v:=CASE WHEN o.type='loan_out' THEN 'recheck' ELSE 'returned' END;
    IF u.status<>typ THEN PERFORM stock_error('P0409','设备状态已变化，不能登记归还'); END IF;
    SELECT count(*) INTO cnt FROM unit_inspections WHERE unit_id=uid;
    UPDATE units SET status=next_v,share_flags=closed_flags WHERE id=uid;
    INSERT INTO inventory_ledger(unit_id,from_status,to_status,doc_type,doc_id,operator_id,reason) VALUES(uid,typ,next_v,CASE WHEN o.type='loan_out' THEN 'loan_return' ELSE 'borrow_return' END,oid::text,actor,why) RETURNING id INTO ledger_id;
    UPDATE loan_item_states SET status=CASE WHEN o.type='loan_out' THEN 'returned_recheck' ELSE 'closed' END,returned_at=now(),inspection_version=cnt,return_ledger_id=ledger_id WHERE item_id=li.id;
    IF o.type='borrow_in' THEN DELETE FROM loan_active_units WHERE unit_id=uid AND order_id=oid; END IF;
    data_v:=data_v||jsonb_build_array(jsonb_build_object('unitId',uid,'condition',stock_text(x->'condition','归还外观和功能结论',2000),'damage',stock_text(x->'damage','损坏描述',2000,true),'next',next_v));
   ELSE
    IF ls.return_ledger_id IS NULL OR NOT EXISTS(SELECT 1 FROM inventory_ledger l JOIN unit_inspections i ON i.id::text=l.doc_id WHERE l.unit_id=uid AND l.id>ls.return_ledger_id AND l.doc_type='recheck' AND l.to_status='in_stock' AND i.result='pass') THEN PERFORM stock_error('P0409','须先在库存复检页逐项检查并实际通过，不能一键恢复可售'); END IF;
    UPDATE loan_item_states SET status='closed' WHERE item_id=li.id;
    DELETE FROM loan_active_units WHERE unit_id=uid AND order_id=oid;
    data_v:=data_v||jsonb_build_array(uid);
   END IF;
  END LOOP;
  SELECT CASE WHEN bool_and(s.status='closed') THEN 'closed' WHEN bool_or(s.status='active') THEN 'active' ELSE 'returned_recheck' END INTO next_v FROM loan_items i JOIN loan_item_states s ON s.item_id=i.id WHERE i.order_id=oid;
  UPDATE loan_states SET status=next_v,version=version+1,updated_at=now() WHERE order_id=oid RETURNING * INTO st;
  data_v:=jsonb_build_object(CASE WHEN p_action='return' THEN 'items' ELSE 'unitIds' END,data_v);
 END IF;
 INSERT INTO loan_events(id,order_id,actor_id,action,version,reason,data,request_key,request_hash) VALUES(eid,oid,actor,p_action,st.version,why,data_v,key_v,sig);
 INSERT INTO loan_files(order_id,file_id,event_id) SELECT oid,value::uuid,eid FROM jsonb_array_elements_text(proof) GROUP BY value;
 PERFORM stock_audit(p_user,p_request_id,'借还:'||p_action,oid::text,NULL,jsonb_build_object('type',o.type,'status',st.status,'version',st.version),why);
 RETURN loan_raw(oid);
EXCEPTION WHEN unique_violation THEN PERFORM stock_error('P0409','设备已被其他借还或串码已占用');
 WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow OR check_violation OR not_null_violation THEN PERFORM stock_error('P0400','借还参数无效');
END $$;
REVOKE ALL ON FUNCTION loan_raw(uuid),loan_proofs(jsonb,jsonb,boolean),api_loans(text,uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION loan_raw(uuid),loan_proofs(jsonb,jsonb,boolean),api_loans(text,uuid,jsonb,jsonb,text) TO service_role;
