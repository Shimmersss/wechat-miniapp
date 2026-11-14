# 入库扫码识别机型

单台和批量入库共用现有「扫码识别型号」入口。后端先查店内维护的已核验 TAC，再查导入的开放 TAC。两边都没命中且付费兜底已启用时，扫码或手输离开输入框才会尝试付费查询。恢复草稿和提交时补做的校验只查本库。

店内已核验的 TAC 继续参与原有入库型号一致性校验。开放库和付费接口的结果显示为候选。员工核对后可选择候选型号，容量、颜色和机况仍按实机填写。

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

## 启用付费兜底

在部署时所用的本机私有配置中填写以下变量。本项目个人版的私有配置通常是 `.local/cloudbase/functions-new-personal.env`。也可在云控制台为 `staff-stock` 配置同名变量。

```dotenv
IMEI_PAID_LOOKUP_ENABLED=0
IMEI_51GCC_API_KEY=
IMEI_PAID_LOOKUP_DAILY_LIMIT=20
```

实现使用 [果查查通用 IMEI 查询](https://api.51gcc.com/api_details.php?id=1)。该接口接收完整 IMEI。确认可以把串码发送给该服务后，填写密钥并将开关设为 `1`。密钥留在服务端，第三方原始响应仅在请求期间处理，候选结果不会写入 TAC 映射。数据库原子限制全环境的调用预算，默认每天 20 次、每分钟 5 次，超时或失败时可继续手动选择型号。
