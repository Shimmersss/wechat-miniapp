# 入库扫码识别机型

单台和批量入库共用「扫码识别型号」入口。后端按 IMEI 的前八位依次查店内已核验 TAC、人工复核的开放 TAC 和云端开放 TAC 目录。开放目录按八位 TAC 建索引，扫码时直接查询 PostgreSQL。

店内已核验的 TAC 继续参与原有入库型号一致性校验。开放库的结果显示为候选。员工核对后可选择候选型号，容量、颜色和机况仍按实机填写。

## 云端开放目录

`20261117070000_open_tac_catalog.sql` 创建开放目录和识别逻辑。当前数据来自 [MoazEb TAC Database](https://github.com/MoazEb/tac-database)，Copyright © 2026 Moaz Ebrahem，[MIT 许可](https://github.com/MoazEb/tac-database/blob/main/LICENSE)。源数据和导入产物放在本机忽略目录。目录只保留八位 TAC，跳过冲突条目，按同品牌和规格中的精确名称尝试关联现有机型。未能唯一关联时展示原库描述，员工可手动选择机型。

应用迁移后，用 `python3 scripts/import-open-tac.py <tac_full.csv> --env-id <数据环境> --env-file <私有配置>` 预览统计。导入时通过管理端临时授予 `service_role` 对 `public.imei_open_tac_catalog` 的 `INSERT` 权限，用相同命令加 `--apply` 分批写入，结束后撤销该权限。导入可重复执行，已有 TAC 保留原记录。普通小程序用户不直接读表。

## 准备开放数据

从 [Osmocom TAC Database](https://tacdb.osmocom.org/) 下载 CSV，按 CC BY-SA 3.0 保留署名。需要商用时，按所选数据的实际许可使用。原始数据、型号目录和审核清单放在本机忽略的 `.local/` 目录。

1. 通过已有 PostgreSQL 网关导出 `public.models` 的 `id, brand, brand_label, name` 四列，保存为 JSON 数组。
2. 生成审核清单。脚本只收录八位 TAC、品牌及型号精确匹配、且没有冲突的候选。列名示例为 `TAC, Manufacturer, Model`。名称采用大小写、全半角、分隔符和常用品牌别名归一化。
3. 对照实机、包装标签或可核验的厂商资料，把确认的记录改为 `"approved": true`。未确认的条目保留为 `false`。

```bash
python3 scripts/prepare-tac-mappings.py review .local/osmocom-tac.csv .local/models.json > .local/tac-review.json
python3 scripts/prepare-tac-mappings.py sql .local/tac-review.json > .local/tac-import.sql
```

依次应用 `cloudbase/migrations/20261114100000_imei_model_lookup.sql`、审阅过的 `.local/tac-import.sql`，再部署 `staff-stock`。导入 SQL 可重复执行，已有型号不一致会整批回滚。生成脚本只读本机输入文件并输出到标准输出。
