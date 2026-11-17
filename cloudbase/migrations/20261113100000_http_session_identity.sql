-- The HTTPS transport uses the existing opaque session as a bearer credential.
CREATE FUNCTION public.api_http_session_openid(p_token_hash text)
RETURNS text LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT u.openid::text
  FROM sessions s
  JOIN users u ON u.id = s.user_id AND u.status = 'active'
  WHERE s.token_hash = p_token_hash AND s.expires_at > now()
$$;

REVOKE ALL ON FUNCTION public.api_http_session_openid(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_http_session_openid(text) TO service_role;
