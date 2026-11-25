CREATE FUNCTION stock_restock_token(unit_id_v uuid) RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
 SELECT coalesce((SELECT id::text FROM inventory_ledger WHERE unit_id=unit_id_v ORDER BY id DESC LIMIT 1),'')
$$;
CREATE OR REPLACE FUNCTION stock_raw(uid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT to_jsonb(u)||jsonb_build_object('name',m.name,'brand',m.brand,'category_id',m.category_id,'identifier_mode',stock_unit_mode(m.id),'supplier_name',s.name,'attached',coalesce((SELECT jsonb_agg(to_jsonb(f)||jsonb_build_object('field_key',uf.field_key) ORDER BY uf.field_key,uf.position) FROM unit_files uf JOIN files f ON f.id=uf.file_id WHERE uf.unit_id=u.id),'[]'),'inspectionVersion',(SELECT count(*) FROM unit_inspections WHERE unit_id=u.id),'loan',(SELECT jsonb_build_object('id',o.id,'no',o.no,'type',o.type) FROM loan_active_units a JOIN loan_orders o ON o.id=a.order_id WHERE a.unit_id=u.id))
 || CASE WHEN u.status='sold' AND u.ownership='own' THEN jsonb_build_object('restockToken',stock_restock_token(u.id)) ELSE '{}'::jsonb END
 FROM units u JOIN models m ON m.id=u.model_id LEFT JOIN suppliers s ON s.id=u.supplier_id WHERE u.id=uid
$$;
CREATE FUNCTION api_stock_restock(p_id uuid,p_data jsonb,p_user jsonb,p_request_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
 device units;
 reason_v text:=stock_text(p_data->'reason','重新入库原因',500);
BEGIN
 SELECT * INTO device FROM units WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN PERFORM stock_error('P0404','设备不存在'); END IF;
 IF device.status<>'sold' OR device.ownership<>'own' THEN
  PERFORM stock_error('P0409','只有自有已售设备可以重新入库，请刷新后核对');
 END IF;
 IF p_data->'restockToken' IS DISTINCT FROM to_jsonb(stock_restock_token(p_id)) THEN
  PERFORM stock_error('P0409','设备流水已更新，请刷新后核对');
 END IF;

 UPDATE units SET status='in_stock',share_flags='{"showInShop":false,"sharePeer":false,"shareAgent":false}',
                  price_version=price_version+1 WHERE id=p_id;
 INSERT INTO inventory_ledger(unit_id,from_status,to_status,doc_type,doc_id,operator_id,reason)
 VALUES(p_id,'sold','in_stock','restock',p_id::text,(p_user->>'id')::uuid,reason_v);
 PERFORM stock_audit(p_user,p_request_id,'已售设备重新入库',p_id::text,
  jsonb_build_object('status','sold'),jsonb_build_object('status','in_stock'),reason_v);
 RETURN jsonb_build_object('id',p_id,'status','in_stock');
END $$;
CREATE FUNCTION sales_check_refund_stock_cycle() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
 sale sales_items;
 latest_order text;
BEGIN
 SELECT * INTO sale FROM sales_items WHERE id=NEW.sale_item_id;
 SELECT doc_id INTO latest_order FROM inventory_ledger
 WHERE unit_id=sale.unit_id AND doc_type='sales_order' AND to_status='sold' ORDER BY id DESC LIMIT 1;
 IF FOUND AND latest_order<>sale.order_id::text THEN
  PERFORM stock_error('P0409','设备已再次售出，请核对对应销售单');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sales_refund_items_check_stock_cycle BEFORE INSERT ON sales_refund_items
 FOR EACH ROW EXECUTE FUNCTION sales_check_refund_stock_cycle();
REVOKE ALL ON FUNCTION stock_restock_token(uuid),api_stock_restock(uuid,jsonb,jsonb,text),
 sales_check_refund_stock_cycle() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION stock_restock_token(uuid),api_stock_restock(uuid,jsonb,jsonb,text),
 sales_check_refund_stock_cycle() TO service_role;