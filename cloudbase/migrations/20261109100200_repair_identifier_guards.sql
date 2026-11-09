-- PG没有MySQL的缺失键间隙锁。入库/借入与外部维修以同一串码事务锁互斥，保持原业务规则。
-- 异常验收仅预留串码(unit_id NULL)时不额外限制；实际形成库存设备时才核对维修占用。
CREATE FUNCTION repair_guard_unit_identifier() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
 IF NEW.unit_id IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('imei:'||NEW.imei::text,0));
  IF EXISTS(SELECT 1 FROM repair_external_slots WHERE identifier=NEW.imei::text) THEN PERFORM stock_error('P0409','串码正在外部维修中，不能作为本店库存入库'); END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION repair_guard_external_identifier() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('imei:'||NEW.identifier,0));
 IF EXISTS(SELECT 1 FROM unit_identifiers ident JOIN units unit_row ON unit_row.id=ident.unit_id WHERE ident.imei=NEW.identifier AND unit_row.status NOT IN ('sold','returned')) THEN PERFORM stock_error('P0409','该串码属于门店业务库存，请从库存档案发起'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER repair_unit_identifier_guard BEFORE INSERT OR UPDATE OF unit_id ON unit_identifiers FOR EACH ROW EXECUTE FUNCTION repair_guard_unit_identifier();
CREATE TRIGGER repair_external_identifier_guard BEFORE INSERT ON repair_external_slots FOR EACH ROW EXECUTE FUNCTION repair_guard_external_identifier();
REVOKE ALL ON FUNCTION repair_guard_unit_identifier(),repair_guard_external_identifier() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION repair_guard_unit_identifier(),repair_guard_external_identifier() TO service_role;
