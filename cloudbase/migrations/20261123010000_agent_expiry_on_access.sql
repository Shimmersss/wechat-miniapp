-- A business request releases expired locks in its own transaction, before reading
-- or acquiring stock. Keep the existing lock order, ledger, and service-role grants.
CREATE OR REPLACE FUNCTION api_shop_home(p_flag text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
BEGIN
  PERFORM agent_release_expired();
  RETURN jsonb_build_object(
    'count', (SELECT count(*) FROM units u WHERE u.status = 'in_stock' AND (u.share_flags ->> p_flag)::boolean IS TRUE),
    'brands', COALESCE((SELECT jsonb_agg(b ORDER BY b ->> 'value') FROM (
        SELECT DISTINCT jsonb_build_object('value', m.brand, 'label', m.brand_label) b
        FROM units u JOIN models m ON m.id = u.model_id
        WHERE u.status = 'in_stock' AND (u.share_flags ->> p_flag)::boolean IS TRUE) x), '[]'::jsonb));
END $$;

CREATE FUNCTION agent_release_expired_units(p_units uuid[])
RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  rid uuid;
BEGIN
  FOR rid IN
    SELECT a.request_id
    FROM agent_unit_locks l
    JOIN agent_orders a ON a.request_id = l.request_id
    JOIN agent_order_states s ON s.request_id = a.request_id
    WHERE l.unit_id = ANY(p_units) AND s.status = 'locked' AND a.lock_expires_at <= now()
    ORDER BY l.unit_id
    FOR UPDATE OF s SKIP LOCKED
  LOOP
    PERFORM agent_unlock(rid, '下单锁定到期自动释放');
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION agent_release_expired_units(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION agent_release_expired_units(uuid[]) TO service_role;
ALTER FUNCTION api_shop_units(jsonb) VOLATILE;
ALTER FUNCTION agent_shop_unit(uuid,jsonb) VOLATILE;

-- Keep the deployed implementations of these RPCs and add the release before
-- their first business statement. The same RPC serves old and new clients.
DO $migration$
DECLARE
  rule record;
  definition text;
BEGIN
  FOR rule IN SELECT * FROM (VALUES
    ('api_shop_units(jsonb)', 'PERFORM agent_release_expired();'),
    ('agent_shop_unit(uuid,jsonb)', 'PERFORM agent_release_expired_units(ARRAY[p_id]);'),
    ('api_agents(text,text,jsonb,jsonb,text,jsonb)',
      'IF a = ''order.create'' THEN
         PERFORM agent_release_expired_units(ARRAY[(d->>''unitId'')::uuid]);
       ELSIF a IN (''share.get'',''share.copy'',''share.poster'',''units'',''markup'',''share.create'') THEN
         PERFORM agent_release_expired();
       END IF;'),
    ('api_customer_requests(text,uuid,jsonb,jsonb,text,jsonb)',
      'IF a IN (''list'',''staff.list'',''get'',''staff.get'') THEN PERFORM agent_release_expired(); END IF;'),
    ('api_stock(text,jsonb,jsonb,jsonb,text)',
      'IF p_action = ''units.get'' THEN
         PERFORM agent_release_expired_units(ARRAY[(p_params->>''id'')::uuid]);
       ELSIF split_part(p_action,''.'',1) = ''units'' OR p_action = ''sessions.create'' THEN
         PERFORM agent_release_expired();
       END IF;'),
    ('stock_sale(text,jsonb,jsonb,jsonb,text)',
      'IF action = ''sales.lookup'' THEN
         PERFORM agent_release_expired_units(ARRAY[stock_find_unit(d->>''code'')]);
       ELSIF action IN (''sales.quote'',''sales.create'') THEN
         PERFORM agent_release_expired_units(
           ARRAY(SELECT (value->>''unitId'')::uuid FROM jsonb_array_elements(d->''items'')));
       END IF;'),
    ('api_loans(text,uuid,jsonb,jsonb,text)', 'IF p_action = ''create'' THEN PERFORM agent_release_expired(); END IF;'),
    ('api_repairs(text,uuid,jsonb,jsonb,text,text)', 'IF p_action = ''create'' THEN PERFORM agent_release_expired(); END IF;'),
    ('api_reports(text,uuid,jsonb,jsonb,text)', 'IF p_action IN (''dashboard'',''ageing'') THEN PERFORM agent_release_expired(); END IF;')
  ) AS rules(signature, prelude)
  LOOP
    SELECT pg_get_functiondef(('public.' || rule.signature)::regprocedure) INTO definition;
    IF strpos(definition, E'\nBEGIN\n') = 0 THEN
      RAISE EXCEPTION 'Unexpected function body for %', rule.signature;
    END IF;
    EXECUTE regexp_replace(definition, E'\nBEGIN\n',
      E'\nBEGIN\n  ' || rule.prelude || E'\n');
  END LOOP;
END
$migration$;
