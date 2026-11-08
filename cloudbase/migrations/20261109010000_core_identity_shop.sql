-- 最小闭环：身份、员工、品类型号、单机，以及登录与首页的数据库函数。
-- 所有业务表只授权给 service_role（云函数持有的 API Key），anon/authenticated 无任何权限。
-- 网关不校验 GRANT EXECUTE，函数一律 SECURITY INVOKER，靠表权限挡住非 service_role 调用。

CREATE TABLE roles (
  role_key varchar(32) PRIMARY KEY,
  label varchar(60) NOT NULL,
  permissions jsonb NOT NULL,
  visible_fields jsonb,
  version int NOT NULL DEFAULT 1
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  openid varchar(128) NOT NULL UNIQUE,
  nickname varchar(100) NOT NULL DEFAULT '微信用户',
  role varchar(32) NOT NULL DEFAULT 'customer',
  status varchar(16) NOT NULL DEFAULT 'active',
  agent_status varchar(16),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid UNIQUE REFERENCES users(id),
  phone char(11) NOT NULL UNIQUE,
  name varchar(100) NOT NULL,
  role_key varchar(32) NOT NULL REFERENCES roles(role_key),
  status varchar(16) NOT NULL DEFAULT 'active',
  store_id varchar(60),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  assurance varchar(8) NOT NULL DEFAULT 'wechat' CHECK (assurance IN ('wechat','staff')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE sms_challenges (
  phone char(11) PRIMARY KEY,
  code_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  sent_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  consumed boolean NOT NULL DEFAULT false,
  delivered boolean NOT NULL DEFAULT false
);

CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid,
  action varchar(80) NOT NULL,
  object_id varchar(120) NOT NULL,
  before_data jsonb,
  after_data jsonb,
  reason varchar(500) NOT NULL DEFAULT '',
  request_id varchar(100) NOT NULL,
  ip varchar(64) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at);

CREATE TABLE categories (
  id varchar(60) PRIMARY KEY,
  label varchar(50) NOT NULL UNIQUE,
  template_id varchar(60),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE models (
  id varchar(60) PRIMARY KEY,
  category_id varchar(60) NOT NULL REFERENCES categories(id),
  brand varchar(50) NOT NULL,
  brand_label varchar(50) NOT NULL,
  series varchar(50) NOT NULL,
  name varchar(100) NOT NULL UNIQUE,
  template_id varchar(60),
  specs jsonb
);

-- 采购、验收、供应商外键在后续迁移补上
CREATE TABLE units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id varchar(60) NOT NULL REFERENCES models(id),
  imei1 char(15) NOT NULL UNIQUE,
  imei2 char(15) UNIQUE,
  status varchar(32) NOT NULL,
  ownership varchar(8) NOT NULL DEFAULT 'own' CHECK (ownership IN ('own','borrowed')),
  condition_type varchar(8) NOT NULL CHECK (condition_type IN ('used','new')),
  attributes jsonb NOT NULL DEFAULT '{}',
  template_snapshot jsonb NOT NULL DEFAULT '{}',
  cost numeric(14,2) NOT NULL,
  retail numeric(14,2) NOT NULL,
  wholesale numeric(14,2) NOT NULL,
  agent_base numeric(14,2) NOT NULL,
  share_flags jsonb NOT NULL DEFAULT '{}',
  peer_desc text NOT NULL DEFAULT '',
  customer_desc text NOT NULL DEFAULT '',
  internal_note text NOT NULL DEFAULT '',
  purchase_line_id uuid,
  acceptance_item_id uuid,
  supplier_id uuid,
  inbound_operator_id uuid NOT NULL,
  price_version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX units_status_created_idx ON units (status, created_at);
CREATE INDEX units_model_idx ON units (model_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['roles','users','staff','sessions','sms_challenges','audit_logs','categories','models','units'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO service_role;
REVOKE UPDATE, DELETE ON audit_logs FROM service_role;

-- 当前登录用户视图：会话有效、用户启用、且会话所属微信与本次调用的 OPENID 一致
CREATE FUNCTION api_session_user(p_token_hash text, p_openid text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT jsonb_build_object(
    'user', to_jsonb(u), 'assurance', s.assurance,
    'staff_id', st.id, 'staff_status', st.status, 'staff_role', st.role_key, 'store_id', st.store_id,
    'role_permissions', r.permissions, 'role_visible_fields', r.visible_fields)
  FROM sessions s
  JOIN users u ON u.id = s.user_id AND u.status = 'active' AND u.openid = p_openid
  LEFT JOIN staff st ON st.user_id = u.id
  LEFT JOIN roles r ON r.role_key = st.role_key
  WHERE s.token_hash = p_token_hash AND s.expires_at > now()
$$;

-- 微信静默登录：建档并签发会话
CREATE FUNCTION api_wx_login(p_openid text, p_token_hash text, p_hours int)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE v users;
BEGIN
  INSERT INTO users (openid) VALUES (p_openid) ON CONFLICT (openid) DO NOTHING;
  SELECT * INTO v FROM users WHERE openid = p_openid FOR UPDATE;
  IF v.status <> 'active' THEN RETURN jsonb_build_object('error', 403, 'message', '账号已停用'); END IF;
  INSERT INTO sessions (token_hash, user_id, expires_at, assurance)
    VALUES (p_token_hash, v.id, now() + make_interval(hours => p_hours), 'wechat');
  RETURN api_session_user(p_token_hash, p_openid);
END $$;

-- 发送验证码前占位；返回 reserved=false 时对外同样提示，避免枚举员工
CREATE FUNCTION api_sms_reserve(p_phone text, p_code_hash text, p_skip_cooling boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE c sms_challenges;
BEGIN
  PERFORM 1 FROM staff WHERE phone = p_phone AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('reserved', false); END IF;
  SELECT * INTO c FROM sms_challenges WHERE phone = p_phone FOR UPDATE;
  IF FOUND AND NOT p_skip_cooling AND c.sent_at > now() - interval '60 seconds' THEN
    RETURN jsonb_build_object('error', 429, 'message', '请稍后再获取验证码');
  END IF;
  INSERT INTO sms_challenges (phone, code_hash, expires_at, sent_at)
    VALUES (p_phone, p_code_hash, now() + interval '5 minutes', now())
  ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at,
    sent_at = EXCLUDED.sent_at, attempts = 0, consumed = false, delivered = false;
  RETURN jsonb_build_object('reserved', true);
END $$;

CREATE FUNCTION api_sms_mark(p_phone text, p_code_hash text, p_delivered boolean)
RETURNS void LANGUAGE sql SECURITY INVOKER AS $$
  UPDATE sms_challenges SET delivered = p_delivered, consumed = NOT p_delivered
  WHERE phone = p_phone AND code_hash = p_code_hash
$$;

-- 员工短信登录并绑定微信；验证码比对结果由云函数算好传入（哈希用云函数里的密钥）
CREATE FUNCTION api_staff_login(p_phone text, p_code_matches_hash text, p_dev_pass boolean,
  p_openid text, p_token_hash text, p_hours int, p_request_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE st staff; c sms_challenges; v users; bound uuid;
BEGIN
  SELECT * INTO st FROM staff WHERE phone = p_phone AND status = 'active' FOR UPDATE;
  SELECT * INTO c FROM sms_challenges WHERE phone = p_phone FOR UPDATE;
  IF st.id IS NULL OR c.phone IS NULL OR c.expires_at <= now() OR c.consumed OR NOT c.delivered OR c.attempts >= 5 THEN
    RETURN jsonb_build_object('error', 401, 'message', '验证码无效或已过期');
  END IF;
  IF NOT p_dev_pass AND c.code_hash <> p_code_matches_hash THEN
    UPDATE sms_challenges SET attempts = attempts + 1 WHERE phone = p_phone;
    RETURN jsonb_build_object('error', 401, 'message', '验证码无效或已过期');
  END IF;
  INSERT INTO users (openid) VALUES (p_openid) ON CONFLICT (openid) DO NOTHING;
  SELECT * INTO v FROM users WHERE openid = p_openid FOR UPDATE;
  IF v.status <> 'active' THEN RAISE EXCEPTION USING ERRCODE = 'P0403', MESSAGE = '账号已停用'; END IF;
  IF st.user_id IS NOT NULL AND st.user_id <> v.id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = '员工账号已绑定其他微信，请联系管理员';
  END IF;
  SELECT id INTO bound FROM staff WHERE user_id = v.id FOR UPDATE;
  IF bound IS NOT NULL AND bound <> st.id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = '当前微信已绑定其他员工账号';
  END IF;
  UPDATE staff SET user_id = v.id WHERE id = st.id;
  UPDATE sms_challenges SET consumed = true WHERE phone = p_phone;
  DELETE FROM sessions WHERE user_id = v.id;
  INSERT INTO sessions (token_hash, user_id, expires_at, assurance)
    VALUES (p_token_hash, v.id, now() + make_interval(hours => p_hours), 'staff');
  INSERT INTO audit_logs (actor_id, action, object_id, request_id)
    VALUES (v.id, '员工登录并绑定微信', st.id::text, p_request_id);
  RETURN api_session_user(p_token_hash, p_openid);
END $$;

CREATE FUNCTION api_logout(p_token_hash text)
RETURNS void LANGUAGE sql SECURITY INVOKER AS $$
  DELETE FROM sessions WHERE token_hash = p_token_hash
$$;

-- 顾客端首页：按渠道开关统计在售数与品牌
CREATE FUNCTION api_shop_home(p_flag text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT jsonb_build_object(
    'count', (SELECT count(*) FROM units u WHERE u.status = 'in_stock' AND (u.share_flags ->> p_flag)::boolean IS TRUE),
    'brands', COALESCE((SELECT jsonb_agg(b ORDER BY b ->> 'value') FROM (
        SELECT DISTINCT jsonb_build_object('value', m.brand, 'label', m.brand_label) b
        FROM units u JOIN models m ON m.id = u.model_id
        WHERE u.status = 'in_stock' AND (u.share_flags ->> p_flag)::boolean IS TRUE) x), '[]'::jsonb))
$$;

REVOKE ALL ON FUNCTION api_session_user(text,text), api_wx_login(text,text,int), api_sms_reserve(text,text,boolean),
  api_sms_mark(text,text,boolean), api_staff_login(text,text,boolean,text,text,int,text), api_logout(text), api_shop_home(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION api_session_user(text,text), api_wx_login(text,text,int), api_sms_reserve(text,text,boolean),
  api_sms_mark(text,text,boolean), api_staff_login(text,text,boolean,text,text,int,text), api_logout(text), api_shop_home(text)
  TO service_role;
