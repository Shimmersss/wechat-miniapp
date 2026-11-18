WITH candidates AS (
  SELECT u.id, m.name AS model, right(trim(coalesce(u.imei1::text, u.serial_no, '')), 4) AS suffix, u.status,
    (SELECT count(*) FROM sales_items s WHERE s.unit_id=u.id) AS sales,
    (SELECT count(*) FROM agent_orders a WHERE a.unit_id=u.id) AS "agentOrders",
    (SELECT count(*) FROM repair_payments p JOIN repair_orders r ON r.id=p.order_id WHERE r.unit_id=u.id) AS payments,
    (SELECT count(*) FROM unit_files f WHERE f.unit_id=u.id)
      + (SELECT count(*) FROM repair_files f JOIN repair_orders r ON r.id=f.order_id WHERE r.unit_id=u.id) AS "retainedFileLinks",
    (SELECT count(*) FROM audit_logs a WHERE a.object_id=u.id::text) AS "retainedUnitAuditLogs",
    EXISTS(SELECT 1 FROM acceptance_items a WHERE a.unit_id=u.id) AS acceptance,
    EXISTS(SELECT 1 FROM customer_requests c WHERE c.unit_id=u.id) AS "customerRequest",
    EXISTS(SELECT 1 FROM stocktake_session_units s WHERE s.unit_id=u.id)
      OR EXISTS(SELECT 1 FROM stocktake_extras s WHERE s.unit_id=u.id) AS stocktake
  FROM units u JOIN models m ON m.id=u.model_id
  WHERE u.template_snapshot IS NULL OR u.template_snapshot='{}'::jsonb
), classified AS (
  SELECT *, sales=0 AND "agentOrders"=0 AND payments=0
    AND NOT acceptance AND NOT "customerRequest" AND NOT stocktake AS eligible
  FROM candidates
)
SELECT jsonb_build_object(
  'count', count(*) FILTER (WHERE eligible),
  'fingerprint', encode(sha256(convert_to(coalesce(string_agg(id::text, ',' ORDER BY id) FILTER (WHERE eligible), ''), 'UTF8')), 'hex'),
  'deletable', coalesce(jsonb_agg(to_jsonb(c)-'id'-'eligible' ORDER BY model,suffix,id) FILTER (WHERE eligible), '[]'),
  'manualReview', coalesce(jsonb_agg(to_jsonb(c)-'id'-'eligible' ORDER BY model,suffix,id) FILTER (WHERE NOT eligible), '[]')
) AS preview,
coalesce(array_agg(id ORDER BY id) FILTER (WHERE eligible), '{}'::uuid[]) AS eligible_ids
FROM classified c
