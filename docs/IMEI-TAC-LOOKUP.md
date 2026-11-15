# 入库扫码识别机型

单台和批量入库共用现有「扫码识别型号」入口。后端按 IMEI 的前八位先查店内已核验 TAC，再查导入的开放 TAC。两边都没命中时，员工可手动选择型号。

店内已核验的 TAC 继续参与原有入库型号一致性校验。开放库的结果显示为候选。员工核对后可选择候选型号，容量、颜色和机况仍按实机填写。

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
