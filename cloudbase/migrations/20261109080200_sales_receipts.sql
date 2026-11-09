-- 上传基础完成后接通现有销售补传凭证接口；文件认领与审计同一事务。
CREATE FUNCTION api_sales_receipts(p_id uuid,p_data jsonb,p_user jsonb,p_request_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE f files; item jsonb; fid uuid; added jsonb:='[]'; reason_v text; linked uuid;
BEGIN
 IF p_user->>'staffNo' IS NULL OR NOT coalesce(p_user->'permissions','[]') ?| ARRAY['sales:create','sales:refund'] THEN PERFORM stock_error('P0403','无权限补传收款凭证'); END IF;
 reason_v:=stock_text(p_data->'reason','补传说明',500);
 IF jsonb_typeof(p_data->'receipts') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'receipts') NOT BETWEEN 1 AND 9 THEN PERFORM stock_error('P0400','收款凭证须为1～9张内部图片'); END IF;
 IF NOT EXISTS(SELECT 1 FROM sales_orders WHERE id=p_id) THEN PERFORM stock_error('P0404','销售单不存在'); END IF;
 INSERT INTO sales_order_locks(order_id) VALUES(p_id) ON CONFLICT(order_id) DO NOTHING;
 PERFORM 1 FROM sales_order_locks WHERE order_id=p_id FOR UPDATE;
 IF (SELECT count(DISTINCT value->>'fileId') FROM jsonb_array_elements(p_data->'receipts'))<>jsonb_array_length(p_data->'receipts') THEN PERFORM stock_error('P0400','收款凭证重复'); END IF;
 PERFORM 1 FROM files WHERE id IN(SELECT (value->>'fileId')::uuid FROM jsonb_array_elements(p_data->'receipts')) ORDER BY id FOR UPDATE;
 FOR item IN SELECT value FROM jsonb_array_elements(p_data->'receipts') LOOP
  fid:=(stock_text(item->'fileId','收款凭证',36))::uuid;
  SELECT * INTO f FROM files WHERE id=fid;
  IF NOT FOUND OR f.scope<>'internal' OR f.mime NOT LIKE 'image/%' THEN PERFORM stock_error('P0400','收款凭证须单独上传为内部图片'); END IF;
  IF EXISTS(SELECT 1 FROM unit_files WHERE file_id=fid) OR EXISTS(SELECT 1 FROM repair_files WHERE file_id=fid) OR EXISTS(SELECT 1 FROM loan_files WHERE file_id=fid) OR EXISTS(SELECT 1 FROM shipments WHERE receipt_file_id=fid) OR EXISTS(SELECT 1 FROM acceptance_items WHERE attributes->'_receiptImages' @> jsonb_build_array(jsonb_build_object('fileId',fid))) THEN PERFORM stock_error('P0400','其他业务凭证不能用作收款凭证'); END IF;
  IF f.owner_id<>(p_user->>'id')::uuid AND p_user->>'role' NOT IN ('boss','manager') THEN PERFORM stock_error('P0403','无权引用他人的收款凭证'); END IF;
  SELECT order_id INTO linked FROM sales_files WHERE file_id=fid;
  IF FOUND THEN IF linked<>p_id THEN PERFORM stock_error('P0409','该凭证已关联其他销售单'); END IF;
  ELSE INSERT INTO sales_files(order_id,file_id,added_by) VALUES(p_id,fid,(p_user->>'id')::uuid); added:=added||to_jsonb(fid); END IF;
 END LOOP;
 IF (SELECT count(*) FROM sales_files WHERE order_id=p_id)>20 THEN PERFORM stock_error('P0400','每张销售单最多20张收款凭证'); END IF;
 IF jsonb_array_length(added)>0 THEN PERFORM stock_audit(p_user,p_request_id,'补传收款凭证',p_id::text,NULL,jsonb_build_object('fileIds',added),reason_v); END IF;
 RETURN sales_detail(p_id);
EXCEPTION WHEN unique_violation THEN PERFORM stock_error('P0409','该凭证已被其他操作认领');
 WHEN invalid_text_representation THEN PERFORM stock_error('P0400','文件标识无效');
END $$;
REVOKE ALL ON FUNCTION api_sales_receipts(uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION api_sales_receipts(uuid,jsonb,jsonb,text) TO service_role;
