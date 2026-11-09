-- 云开发生成验证码：短租约避免同一挑战并发外验；验证成功后沿用原员工绑定/会话事务。
ALTER TABLE sms_challenges ADD COLUMN provider_kind text NOT NULL DEFAULT 'development' CHECK(provider_kind IN('development','cloudbase')),
 ADD COLUMN verification_id text,ADD COLUMN verification_nonce uuid,ADD COLUMN verification_until timestamptz,
 ADD COLUMN captcha_required boolean NOT NULL DEFAULT false;
CREATE TABLE sms_send_budget(day date PRIMARY KEY,attempts int NOT NULL CHECK(attempts>=0));
ALTER TABLE sms_send_budget ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sms_send_budget FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON sms_send_budget TO service_role;
CREATE FUNCTION api_sms_flow(p_action text,p_data jsonb,p_actor text,p_request_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE d jsonb:=p_data;c sms_challenges;st staff;r jsonb;n uuid;budget int;kind text;nonce uuid;
BEGIN
 IF p_actor IS NULL OR p_actor !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('error',401,'message','无法识别微信身份');END IF;
 IF p_action='captcha' THEN
  IF NOT agent_rate_limit(p_actor,'sms-captcha',10) THEN RETURN jsonb_build_object('error',429,'message','图片验证过于频繁，请稍后重试');END IF;
  RETURN '{}'::jsonb;
 END IF;
 IF p_action='reserve' THEN
  IF NOT agent_rate_limit(p_actor,'sms-send',5) THEN RETURN jsonb_build_object('error',429,'message','请稍后再获取验证码');END IF;
 END IF;
 IF p_action='begin' THEN
  IF NOT agent_rate_limit(p_actor,'sms-login',15) THEN RETURN jsonb_build_object('error',429,'message','登录过于频繁，请稍后重试');END IF;
 END IF;
 -- 同原登录/员工管理顺序：先员工、后挑战；新发码不能与旧验证混用。
 SELECT * INTO st FROM staff WHERE phone=d->>'phone' FOR UPDATE;
 SELECT * INTO c FROM sms_challenges WHERE phone=d->>'phone' FOR UPDATE;
 IF p_action='reserve' THEN
  IF st.id IS NULL OR st.status<>'active' THEN RETURN jsonb_build_object('reserved',false);END IF;
  kind:=d->>'kind';IF kind NOT IN('development','cloudbase') OR kind IS NULL THEN PERFORM stock_error('P0400','验证码模式无效');END IF;
  IF c.captcha_required AND kind='cloudbase' AND NOT coalesce((d->>'captchaPassed')::boolean,false) THEN RETURN jsonb_build_object('error',428,'message','请完成图片验证后重试');END IF;
  r:=api_sms_reserve(d->>'phone',d->>'attemptHash',kind='development' OR (c.captcha_required AND coalesce((d->>'captchaPassed')::boolean,false)));
  IF r ? 'error' OR NOT coalesce((r->>'reserved')::boolean,false) THEN RETURN r;END IF;
  IF kind='cloudbase' THEN
   budget:=(d->>'dailyLimit')::int;IF budget<1 OR budget>10000 OR budget IS NULL THEN PERFORM stock_error('P0400','短信预算无效');END IF;
   INSERT INTO sms_send_budget(day,attempts) VALUES((now() AT TIME ZONE 'Asia/Shanghai')::date,1)
   ON CONFLICT(day) DO UPDATE SET attempts=sms_send_budget.attempts+1 WHERE sms_send_budget.attempts<budget RETURNING attempts INTO budget;
   IF NOT FOUND THEN UPDATE sms_challenges SET consumed=true WHERE phone=d->>'phone';RETURN jsonb_build_object('error',429,'message','今日短信发送额度已用完，请联系管理员');END IF;
  END IF;
  UPDATE sms_challenges SET provider_kind=kind,verification_id=NULL,verification_nonce=NULL,verification_until=NULL,captcha_required=false WHERE phone=d->>'phone';RETURN r;
 END IF;
 IF p_action='mark' THEN
  IF c.code_hash IS DISTINCT FROM d->>'attemptHash' THEN RETURN jsonb_build_object('error',409,'message','验证码请求已更新，请重新获取');END IF;
  UPDATE sms_challenges SET delivered=coalesce((d->>'delivered')::boolean,false),consumed=NOT coalesce((d->>'delivered')::boolean,false),
   verification_id=d->>'verificationId',captcha_required=coalesce((d->>'captchaRequired')::boolean,false),
   expires_at=least(expires_at,now()+make_interval(secs=>least(coalesce((d->>'expiresIn')::int,300),300))) WHERE phone=d->>'phone';RETURN '{}'::jsonb;
 END IF;
 IF st.id IS NULL OR st.status<>'active' OR c.phone IS NULL OR c.expires_at<=now() OR c.consumed OR NOT c.delivered OR c.attempts>=5 OR c.provider_kind IS DISTINCT FROM d->>'kind' THEN RETURN jsonb_build_object('error',401,'message','验证码无效或已过期');END IF;
 IF p_action='begin' THEN
  IF c.verification_until>now() THEN RETURN jsonb_build_object('error',409,'message','正在验证，请勿重复提交');END IF;
  IF c.verification_nonce IS NOT NULL THEN
   UPDATE sms_challenges SET attempts=attempts+1 WHERE phone=c.phone;
   IF c.attempts>=4 THEN RETURN jsonb_build_object('error',401,'message','验证码无效或已过期');END IF;
  END IF;
  nonce:=gen_random_uuid();UPDATE sms_challenges SET verification_nonce=nonce,verification_until=now()+interval '15 seconds' WHERE phone=c.phone;
  RETURN jsonb_build_object('nonce',nonce,'verificationId',c.verification_id,'codeHash',c.code_hash);
 END IF;
 IF p_action='complete' THEN
  IF c.verification_nonce IS DISTINCT FROM (d->>'nonce')::uuid OR c.verification_until<=now() THEN RETURN jsonb_build_object('error',409,'message','验证请求已失效，请重新获取验证码');END IF;
  IF NOT coalesce((d->>'verified')::boolean,false) THEN UPDATE sms_challenges SET attempts=attempts+1,verification_nonce=NULL,verification_until=NULL WHERE phone=c.phone;RETURN jsonb_build_object('error',401,'message','验证码无效或已过期');END IF;
  -- 只有云函数持有服务端租约且平台核验成功，才以当前挑战摘要进入原绑定事务。
  r:=api_staff_login(c.phone,c.code_hash,false,d->>'openid',d->>'tokenHash',(d->>'hours')::int,p_request_id);
  IF NOT (r ? 'error') THEN UPDATE sms_challenges SET verification_id=NULL,verification_nonce=NULL,verification_until=NULL WHERE phone=c.phone;END IF;RETURN r;
 END IF;
 PERFORM stock_error('P0404','短信接口不存在');
END $$;
REVOKE ALL ON FUNCTION api_sms_flow(text,jsonb,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION api_sms_flow(text,jsonb,text,text) TO service_role;
