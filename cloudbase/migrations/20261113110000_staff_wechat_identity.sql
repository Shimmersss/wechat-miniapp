ALTER TABLE public.staff ALTER COLUMN phone DROP NOT NULL;

CREATE FUNCTION public.api_staff_wechat_login(
  p_openid text, p_token_hash text, p_hours int, p_request_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  employee staff;
BEGIN
  -- Lock the roster before checking the binding, just as staff administration does.
  PERFORM pg_advisory_xact_lock(hashtextextended('staff-admin-roster', 0));
  SELECT st.* INTO employee
  FROM staff st
  JOIN users u ON u.id = st.user_id
  WHERE u.openid = p_openid AND u.status = 'active' AND st.status = 'active'
  FOR UPDATE OF st;

  IF NOT FOUND THEN
    RETURN api_wx_login(p_openid, p_token_hash, p_hours);
  END IF;

  INSERT INTO sessions (token_hash, user_id, expires_at, assurance)
  VALUES (p_token_hash, employee.user_id, now() + make_interval(hours => p_hours), 'staff');
  INSERT INTO audit_logs (actor_id, action, object_id, request_id)
  VALUES (employee.user_id, '微信登录员工端', employee.id::text, p_request_id);
  RETURN api_session_user(p_token_hash, p_openid);
END $$;

CREATE FUNCTION public.api_staff_bind_wechat(
  p_id uuid, p_user_id uuid, p_version int, p_reason text, p_user jsonb, p_request_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  actor staff;
  employee staff;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('staff-admin-roster', 0));
  SELECT st.* INTO actor
  FROM staff st
  JOIN users u ON u.id = st.user_id AND u.status = 'active'
  JOIN roles r ON r.role_key = st.role_key
  WHERE st.user_id = (p_user->>'id')::uuid
    AND st.id = (p_user->>'staffNo')::uuid AND st.status = 'active'
    AND (st.role_key = 'boss' OR r.permissions ? 'staff:manage');
  IF NOT FOUND THEN PERFORM stock_error('P0403', '无员工管理权限'); END IF;

  SELECT * INTO employee FROM staff WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM stock_error('P0404', '员工不存在'); END IF;
  IF employee.role_key = 'boss' AND actor.role_key <> 'boss' THEN
    PERFORM stock_error('P0403', '仅老板可绑定老板账号');
  END IF;
  IF employee.version IS DISTINCT FROM p_version THEN
    PERFORM stock_error('P0409', '员工资料已更新，请刷新');
  END IF;
  IF employee.status <> 'active' OR employee.user_id IS NOT NULL THEN
    PERFORM stock_error('P0409', '只能为在职且未绑定微信的员工绑定');
  END IF;
  IF nullif(btrim(p_reason), '') IS NULL OR length(p_reason) > 500 THEN
    PERFORM stock_error('P0400', '请填写调整原因');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user_id AND status = 'active') THEN
    PERFORM stock_error('P0404', '找不到可绑定的微信账号');
  END IF;

  UPDATE staff SET user_id = p_user_id, version = version + 1 WHERE id = p_id;
  PERFORM stock_audit(p_user, p_request_id, '绑定员工微信', p_id::text,
    jsonb_build_object('wechatBound', false),
    jsonb_build_object('wechatBound', true, 'userId', p_user_id), p_reason);
  RETURN staff_admin_raw(p_id);
EXCEPTION WHEN unique_violation THEN
  PERFORM stock_error('P0409', '该微信已绑定其他员工');
END $$;

REVOKE ALL ON FUNCTION public.api_staff_wechat_login(text,text,int,text),
  public.api_staff_bind_wechat(uuid,uuid,int,text,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_staff_wechat_login(text,text,int,text),
  public.api_staff_bind_wechat(uuid,uuid,int,text,jsonb,text) TO service_role;
