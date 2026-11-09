-- 员工/角色维护：对应server/src/staff-admin.js，变更、会话撤销和审计一次事务完成。
CREATE INDEX staff_admin_sessions_user_time ON sessions(user_id,created_at DESC);
CREATE INDEX staff_admin_staff_status_role ON staff(status,role_key,created_at,id);
CREATE FUNCTION staff_admin_raw(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT to_jsonb(st)||jsonb_build_object('last_login',(SELECT max(se.created_at) FROM sessions se WHERE se.user_id=st.user_id)) FROM staff st WHERE st.id=p_id
$$;
CREATE FUNCTION staff_admin_transition_guard(p_old jsonb,p_role text,p_status text,p_user jsonb,p_bosses bigint) RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
 IF p_user->>'role'<>'boss' AND (p_old->>'role_key'='boss' OR p_role='boss') THEN PERFORM stock_error('P0403','仅老板可修改老板账号或授予老板角色'); END IF;
 IF p_old->>'user_id'=p_user->>'id' AND (p_role<>p_old->>'role_key' OR p_status<>'active') THEN PERFORM stock_error('P0400','不能停用或更改自己的角色'); END IF;
 IF p_old->>'role_key'='boss' AND p_old->>'status'='active' AND (p_role<>'boss' OR p_status<>'active') AND p_bosses<=1 THEN PERFORM stock_error('P0409','至少保留一名在职老板'); END IF;
END $$;
CREATE FUNCTION api_staff_admin(p_action text,p_id uuid,p_key text,p_data jsonb,p_user jsonb,p_rules jsonb,p_request_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE a text:=p_action;d jsonb:=p_data;u jsonb:=p_user;actor uuid:=(p_user->>'id')::uuid;current_staff staff;actor_role_row roles;target_staff staff;target_role roles;result jsonb;new_role text;new_status text;target uuid;boss_count bigint;
BEGIN
 IF actor IS NULL THEN PERFORM stock_error('P0401','请先登录'); END IF;
 -- 管理写入先串行化员工名册/角色，再锁目标行；跨老板变更不能同时越过最后老板检查。
 IF a IN ('create','update','unbind','roles.update') THEN PERFORM pg_advisory_xact_lock(hashtextextended('staff-admin-roster',0)); END IF;
 SELECT st.* INTO current_staff FROM staff st JOIN users usr ON usr.id=st.user_id AND usr.status='active' WHERE st.user_id=actor AND st.id=(u->>'staffNo')::uuid AND st.status='active';
 IF NOT FOUND THEN PERFORM stock_error('P0403','仅在职员工可操作'); END IF;
 SELECT * INTO actor_role_row FROM roles WHERE role_key=current_staff.role_key;
 IF current_staff.role_key<>'boss' AND NOT coalesce(actor_role_row.permissions,'[]') ? 'staff:manage' THEN PERFORM stock_error('P0403','无员工管理权限'); END IF;
 u:=u||jsonb_build_object('role',current_staff.role_key);
 IF a='list' THEN
  WITH matches AS(SELECT st.* FROM staff st WHERE (nullif(d->>'status','') IS NULL OR st.status=d->>'status') AND (nullif(d->>'roleKey','') IS NULL OR st.role_key=d->>'roleKey') AND (nullif(d->>'keyword','') IS NULL OR st.name ILIKE '%'||(d->>'keyword')||'%' OR st.phone ILIKE '%'||(d->>'keyword')||'%')),
  paged AS(SELECT * FROM matches ORDER BY status,(role_key='boss') DESC,created_at,id LIMIT(d->>'pageSize')::int OFFSET(d->>'offset')::int)
  SELECT jsonb_build_object('total',(SELECT count(*) FROM matches),'rows',coalesce(jsonb_agg(staff_admin_raw(pg.id) ORDER BY pg.status,(pg.role_key='boss') DESC,pg.created_at,pg.id),'[]')) INTO result FROM paged pg;RETURN result;
 END IF;
 IF a='create' THEN
  IF NOT (p_rules->'roles') ? (d->>'roleKey') THEN PERFORM stock_error('P0400','角色无效'); END IF;
  IF d->>'roleKey'='boss' AND current_staff.role_key<>'boss' THEN PERFORM stock_error('P0403','仅老板可添加老板账号'); END IF;
  IF EXISTS(SELECT 1 FROM staff WHERE phone=d->>'phone') THEN PERFORM stock_error('P0409','该手机号已是员工'); END IF;
  target:=gen_random_uuid();INSERT INTO staff(id,phone,name,role_key) VALUES(target,d->>'phone',d->>'name',d->>'roleKey');
  PERFORM stock_audit(u,p_request_id,'新增员工',target::text,NULL,jsonb_build_object('name',d->'name','roleKey',d->'roleKey'),d->>'reason');RETURN staff_admin_raw(target);
 END IF;
 IF a IN ('update','unbind') THEN
  SELECT * INTO target_staff FROM staff WHERE id=p_id FOR UPDATE;IF NOT FOUND THEN PERFORM stock_error('P0404','员工不存在'); END IF;
  IF target_staff.version<>(d->>'version')::int THEN PERFORM stock_error('P0409','员工资料已更新，请刷新'); END IF;
  IF a='unbind' THEN
   IF target_staff.user_id IS NULL THEN PERFORM stock_error('P0409','该员工尚未绑定微信'); END IF;
   IF target_staff.user_id=actor THEN PERFORM stock_error('P0400','不能解绑自己的微信'); END IF;
   IF target_staff.role_key='boss' AND current_staff.role_key<>'boss' THEN PERFORM stock_error('P0403','仅老板可解绑老板账号'); END IF;
   UPDATE staff SET user_id=NULL,version=version+1 WHERE id=p_id;
   DELETE FROM sessions WHERE user_id=target_staff.user_id;
   PERFORM stock_audit(u,p_request_id,'解绑员工微信',p_id::text,jsonb_build_object('wechatBound',true),jsonb_build_object('wechatBound',false),d->>'reason');
  ELSE
   new_role:=coalesce(d->>'roleKey',target_staff.role_key);new_status:=coalesce(d->>'status',target_staff.status);
   IF NOT (p_rules->'roles') ? new_role OR new_status NOT IN ('active','disabled') THEN PERFORM stock_error('P0400','角色或状态无效'); END IF;
   SELECT count(*) INTO boss_count FROM staff WHERE role_key='boss' AND status='active';
   PERFORM staff_admin_transition_guard(to_jsonb(target_staff),new_role,new_status,u,boss_count);
   UPDATE staff SET name=coalesce(d->>'name',name),role_key=new_role,status=new_status,version=version+1 WHERE id=p_id;
   IF new_status<>'active' AND target_staff.user_id IS NOT NULL THEN DELETE FROM sessions WHERE user_id=target_staff.user_id; END IF;
   PERFORM stock_audit(u,p_request_id,CASE WHEN new_status<>target_staff.status THEN CASE WHEN new_status='active' THEN '恢复员工' ELSE '停用员工' END ELSE '调整员工资料或角色' END,p_id::text,jsonb_build_object('name',target_staff.name,'roleKey',target_staff.role_key,'status',target_staff.status),jsonb_build_object('name',coalesce(d->>'name',target_staff.name),'roleKey',new_role,'status',new_status),d->>'reason');
  END IF;RETURN staff_admin_raw(p_id);
 END IF;
 IF a='roles.list' THEN
  SELECT jsonb_build_object('canEdit',current_staff.role_key='boss','rows',coalesce(jsonb_agg(to_jsonb(rr)||jsonb_build_object('staff_count',(SELECT count(*) FROM staff st WHERE st.status='active' AND st.role_key=rr.role_key)) ORDER BY def.n),'[]')) INTO result FROM jsonb_array_elements_text(p_rules->'roles') WITH ORDINALITY def(role_key,n) JOIN roles rr ON rr.role_key=def.role_key;RETURN result;
 END IF;
 IF a='roles.update' THEN
  IF current_staff.role_key<>'boss' THEN PERFORM stock_error('P0403','仅老板可调整角色权限'); END IF;
  IF NOT (p_rules->'roles') ? p_key THEN PERFORM stock_error('P0404','角色不存在'); END IF;
  IF p_key='boss' THEN PERFORM stock_error('P0400','老板角色固定拥有全部权限，不能编辑'); END IF;
  IF jsonb_typeof(d->'permissions') IS DISTINCT FROM 'array' OR jsonb_typeof(d->'visibleFields') IS DISTINCT FROM 'array' THEN PERFORM stock_error('P0400','权限点或字段无效'); END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(d->'permissions') el WHERE jsonb_typeof(el)<>'string' OR NOT (p_rules->'permissions') ? (el#>>'{}')) OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'visibleFields') el WHERE jsonb_typeof(el)<>'string' OR NOT (p_rules->'fields') ? (el#>>'{}')) THEN PERFORM stock_error('P0400','权限点或字段无效'); END IF;
  SELECT * INTO target_role FROM roles WHERE role_key=p_key FOR UPDATE;IF NOT FOUND THEN PERFORM stock_error('P0404','角色不存在'); END IF;
  IF target_role.version<>(d->>'version')::int THEN PERFORM stock_error('P0409','角色已被他人修改，请刷新'); END IF;
  UPDATE roles SET permissions=d->'permissions',visible_fields=d->'visibleFields',version=version+1 WHERE role_key=p_key;
  PERFORM stock_audit(u,p_request_id,'调整角色权限与字段可见性',p_key,jsonb_build_object('permissions',target_role.permissions,'visibleFields',target_role.visible_fields),jsonb_build_object('permissions',d->'permissions','visibleFields',d->'visibleFields'),d->>'reason');
  RETURN (SELECT to_jsonb(rr)||jsonb_build_object('staff_count',(SELECT count(*) FROM staff st WHERE st.role_key=rr.role_key AND st.status='active')) FROM roles rr WHERE rr.role_key=p_key);
 END IF;
 PERFORM stock_error('P0404','接口尚未迁移');
EXCEPTION WHEN unique_violation THEN PERFORM stock_error('P0409','手机号或微信已被其他员工使用');
 WHEN foreign_key_violation OR invalid_text_representation OR not_null_violation OR check_violation THEN PERFORM stock_error('P0400','员工参数无效');
 WHEN deadlock_detected OR serialization_failure OR lock_not_available THEN PERFORM stock_error('P0409','员工资料正被其他操作更新，请重试');
END $$;
REVOKE ALL ON FUNCTION staff_admin_raw(uuid),staff_admin_transition_guard(jsonb,text,text,jsonb,bigint),api_staff_admin(text,uuid,text,jsonb,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION staff_admin_raw(uuid),staff_admin_transition_guard(jsonb,text,text,jsonb,bigint),api_staff_admin(text,uuid,text,jsonb,jsonb,jsonb,text) TO service_role;
