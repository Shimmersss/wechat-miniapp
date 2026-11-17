-- 机型库导入（20261117030000）后，CSV 未收录而保留下来的 9 个型号沿用了旧系列名，归入 CSV 的系列，使同品牌系列分组一致。
UPDATE models SET series = 'iPhone' WHERE category_id = 'phone' AND id IN ('iphone-air', 'iphone-se-3');
UPDATE models SET series = 'Find X 系列' WHERE category_id = 'phone' AND id = 'oppo-find-x10';
UPDATE models SET series = 'Galaxy S 系列' WHERE category_id = 'phone' AND id IN ('galaxy-s26', 'galaxy-s26-plus', 'galaxy-s26-ultra', 'galaxy-s25-plus');
UPDATE models SET series = 'Galaxy Z 系列' WHERE category_id = 'phone' AND id IN ('galaxy-z-fold7', 'galaxy-z-flip6');
