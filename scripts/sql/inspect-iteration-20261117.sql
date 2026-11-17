-- 目标网关环境确定后执行，只读诊断；不要用旧测试库结果代替目标环境结果。
SELECT count(*) AS legacy_preparing_recheck_count
FROM units WHERE status='recheck' AND attributes->>'refurbishment'='正在整备';

SELECT id,model_id,attributes->>'storage' AS storage,attributes->>'color' AS color,
 attributes->>'grade' AS grade,customer_desc,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('key',f->>'key','visibility',f->'visibility')),'[]')
  FROM jsonb_array_elements(template_snapshot->'fields') AS f
  WHERE f->>'key' IN ('storage','color','grade')) AS snapshot_fields
FROM units WHERE id::text LIKE '19ba492e%';
