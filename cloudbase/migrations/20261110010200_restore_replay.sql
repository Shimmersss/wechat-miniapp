-- 已验证的恢复任务也必须校验重放分片，不能把损坏输入当成功。
CREATE OR REPLACE FUNCTION api_maintenance_restore(p_action text,p_run uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET timezone='UTC' AS $$
DECLARE v_run maintenance_restore_runs;v_manifest jsonb;v_current jsonb;v_table jsonb;v_live jsonb;v_col jsonb;v_fk jsonb;v_part jsonb;v_name text;v_target text;v_prefix text;v_cols text;v_refcols text;v_sha text;v_count bigint;v_expected bigint;v_seq text;v_max bigint;v_report jsonb:='[]';v_totals jsonb;v_rows jsonb;v_sum text;
BEGIN
 PERFORM maintenance_guard();
 IF p_action='begin' THEN
  v_manifest:=p_data->'manifest';IF v_manifest->>'format'<>'xiamu-backup-v1' OR jsonb_typeof(v_manifest->'tables')<>'array' OR jsonb_typeof(v_manifest->'parts')<>'array' THEN PERFORM stock_error('P0400','备份清单无效');END IF;
  v_current:=maintenance_table_info();IF jsonb_array_length(v_current)<>jsonb_array_length(v_manifest->'tables') THEN PERFORM stock_error('P0409','备份与当前迁移版本不一致，请先重建匹配的表结构');END IF;
  INSERT INTO maintenance_restore_runs(manifest) VALUES(v_manifest) RETURNING * INTO v_run;
  v_prefix:='r'||substr(replace(v_run.id::text,'-',''),1,12)||'_';
  FOR v_table IN SELECT value FROM jsonb_array_elements(v_manifest->'tables') LOOP
   v_name:=v_table->>'name';SELECT value INTO v_live FROM jsonb_array_elements(v_current) WHERE value->>'name'=v_name;
   IF v_live IS NULL OR v_live->'columns' IS DISTINCT FROM v_table->'columns' OR v_live->'pk' IS DISTINCT FROM v_table->'pk' OR v_live->'foreignKeys' IS DISTINCT FROM v_table->'foreignKeys' THEN PERFORM stock_error('P0409','备份表结构不匹配，拒绝静默丢字段');END IF;
   v_target:=v_prefix||v_name;EXECUTE format('CREATE TABLE xiamu_restore.%I (LIKE public.%I INCLUDING ALL)',v_target,v_name);
   EXECUTE format('ALTER TABLE xiamu_restore.%I ENABLE ROW LEVEL SECURITY',v_target);EXECUTE format('REVOKE ALL ON xiamu_restore.%I FROM PUBLIC,anon,authenticated',v_target);
   FOR v_col IN SELECT value FROM jsonb_array_elements(v_table->'columns') LOOP
    IF v_col->>'identity'='' AND v_col->>'default' LIKE 'nextval(%' THEN
     v_seq:=v_target||'_'||(v_col->>'name')||'_seq';EXECUTE format('CREATE SEQUENCE xiamu_restore.%I',v_seq);EXECUTE format('ALTER SEQUENCE xiamu_restore.%I OWNED BY xiamu_restore.%I.%I',v_seq,v_target,v_col->>'name');EXECUTE format('ALTER TABLE xiamu_restore.%I ALTER COLUMN %I SET DEFAULT nextval(%L::regclass)',v_target,v_col->>'name','xiamu_restore.'||v_seq);
    END IF;
   END LOOP;
  END LOOP;
  RETURN jsonb_build_object('id',v_run.id,'schema','xiamu_restore','prefix',v_prefix);
 END IF;
 SELECT * INTO v_run FROM maintenance_restore_runs WHERE id=p_run FOR UPDATE;IF NOT FOUND THEN PERFORM stock_error('P0404','恢复演练不存在');END IF;
 IF v_run.status='verified' AND p_action='verify' THEN RETURN v_run.result;END IF;
 v_prefix:='r'||substr(replace(v_run.id::text,'-',''),1,12)||'_';
 IF p_action='chunk' THEN
  SELECT value INTO v_part FROM jsonb_array_elements(v_run.manifest->'parts') WHERE value->>'key'=p_data->>'key' AND value->>'kind'='data';
  v_sha:=encode(sha256(convert_to(p_data->>'payload','UTF8')),'hex');
  IF v_part IS NULL OR v_part->>'sha256' IS DISTINCT FROM v_sha THEN PERFORM stock_error('P0400','备份数据分片摘要不匹配');END IF;
  IF EXISTS(SELECT 1 FROM maintenance_restore_chunks WHERE run_id=p_run AND object_key=p_data->>'key') THEN RETURN jsonb_build_object('replayed',true);END IF;
  v_rows:=(p_data->>'payload')::jsonb;v_name:=v_part->>'table';IF v_rows->>'table' IS DISTINCT FROM v_name THEN PERFORM stock_error('P0400','备份分片表名不一致');END IF;
  SELECT value INTO v_table FROM jsonb_array_elements(v_run.manifest->'tables') WHERE value->>'name'=v_name;
  SELECT string_agg(format('%I',value->>'name'),',') INTO v_cols FROM jsonb_array_elements(v_table->'columns') WHERE value->>'generated'='';
  EXECUTE format('INSERT INTO xiamu_restore.%I(%s) OVERRIDING SYSTEM VALUE SELECT %s FROM jsonb_populate_recordset(NULL::xiamu_restore.%I,$1->''rows'')',v_prefix||v_name,v_cols,v_cols,v_prefix||v_name) USING v_rows;
  INSERT INTO maintenance_restore_chunks(run_id,object_key,sha256) VALUES(p_run,p_data->>'key',v_sha);RETURN jsonb_build_object('rows',jsonb_array_length(v_rows->'rows'));
 ELSIF p_action='verify' THEN
  IF (SELECT count(*) FROM maintenance_restore_chunks WHERE run_id=p_run)<>(SELECT count(*) FROM jsonb_array_elements(v_run.manifest->'parts') WHERE value->>'kind'='data') THEN PERFORM stock_error('P0409','备份分片尚未全部恢复');END IF;
  FOR v_table IN SELECT value FROM jsonb_array_elements(v_run.manifest->'tables') LOOP
   v_name:=v_table->>'name';v_target:=v_prefix||v_name;
   SELECT string_agg(format('%I',value),',') INTO v_cols FROM jsonb_array_elements_text(v_table->'pk');
   EXECUTE format('SELECT count(*),encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(to_jsonb(t)::text,''UTF8'')),''hex''),'''' ORDER BY %s),''''),''UTF8'')),''hex'') FROM xiamu_restore.%I t',v_cols,v_target) INTO v_count,v_sha;
   IF v_count<>(v_table->>'rows')::bigint OR v_sha IS DISTINCT FROM v_table->>'sha256' THEN PERFORM stock_error('P0400','恢复表行数或完整内容摘要不一致');END IF;
   v_report:=v_report||jsonb_build_array(jsonb_build_object('table',v_name,'rows',v_count,'sha256',v_sha));
   FOR v_fk IN SELECT value FROM jsonb_array_elements(v_table->'foreignKeys') LOOP
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_run.manifest->'tables') WHERE value->>'name'=v_fk->>'target') THEN PERFORM stock_error('P0400','备份缺少外键依赖表');END IF;
    SELECT string_agg(format('%I',value),',') INTO v_cols FROM jsonb_array_elements_text(v_fk->'columns');SELECT string_agg(format('%I',value),',') INTO v_refcols FROM jsonb_array_elements_text(v_fk->'targetColumns');
    v_seq:='fk_'||substr(md5(v_name||(v_fk->>'name')),1,20);
    EXECUTE format('ALTER TABLE xiamu_restore.%I ADD CONSTRAINT %I FOREIGN KEY(%s) REFERENCES xiamu_restore.%I(%s) NOT VALID',v_target,v_seq,v_cols,v_prefix||(v_fk->>'target'),v_refcols);
    EXECUTE format('ALTER TABLE xiamu_restore.%I VALIDATE CONSTRAINT %I',v_target,v_seq);
   END LOOP;
   FOR v_col IN SELECT value FROM jsonb_array_elements(v_table->'columns') LOOP
    IF v_col->>'identity'<>'' OR v_col->>'default' LIKE 'nextval(%' THEN
     v_seq:=pg_get_serial_sequence(format('xiamu_restore.%I',v_target),v_col->>'name');
     IF v_seq IS NULL OR v_seq NOT LIKE 'xiamu_restore.%' THEN PERFORM stock_error('P0400','恢复序列未隔离，拒绝修改线上序列');END IF;
     EXECUTE format('SELECT coalesce(max(%I),0)+1 FROM xiamu_restore.%I',v_col->>'name',v_target) INTO v_max;PERFORM setval(v_seq::regclass,greatest(v_max,1),false);
    END IF;
   END LOOP;
  END LOOP;
  EXECUTE format('SELECT jsonb_build_object(''units'',(SELECT count(*) FROM xiamu_restore.%I),''unitCost'',(SELECT coalesce(sum(cost),0)::text FROM xiamu_restore.%I),''salesAmount'',(SELECT coalesce(sum(amount),0)::text FROM xiamu_restore.%I),''refundAmount'',(SELECT coalesce(sum(amount),0)::text FROM xiamu_restore.%I),''agentEarnings'',(SELECT coalesce(sum(amount),0)::text FROM xiamu_restore.%I),''files'',(SELECT count(*) FROM xiamu_restore.%I))',v_prefix||'units',v_prefix||'units',v_prefix||'sales_orders',v_prefix||'sales_refunds',v_prefix||'agent_earnings',v_prefix||'files') INTO v_totals;
  IF v_totals IS DISTINCT FROM v_run.manifest->'totals' THEN PERFORM stock_error('P0400','恢复后的库存/销售/退款/收益金额不一致');END IF;
  UPDATE maintenance_restore_runs SET status='verified',verified_at=now(),result=jsonb_build_object('id',p_run,'status','verified','tables',v_report,'totals',v_totals,'foreignKeysValidated',true,'sequencesIsolated',true) WHERE id=p_run RETURNING result INTO v_rows;
  INSERT INTO maintenance_events(kind,object_id,detail) VALUES('restore_verified',p_run::text,jsonb_build_object('totals',v_totals,'tables',jsonb_array_length(v_report)));RETURN v_rows;
 END IF;PERFORM stock_error('P0404','恢复操作不存在');
END $$;
REVOKE ALL ON FUNCTION api_maintenance_restore(text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION api_maintenance_restore(text,uuid,jsonb) TO service_role;
