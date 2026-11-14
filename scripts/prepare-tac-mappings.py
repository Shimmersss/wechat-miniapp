#!/usr/bin/env python3
"""Prepare reviewed Osmocom TAC mappings without connecting to the database."""

import argparse
import csv
import json
import re
import sys
import unicodedata
from pathlib import Path


SOURCE = "Osmocom TAC Database | https://tacdb.osmocom.org/ | CC BY-SA 3.0"
BRAND_ALIASES = {
    "苹果": "apple", "华为": "huawei", "小米": "xiaomi", "荣耀": "honor",
    "三星": "samsung", "一加": "oneplus", "红米": "redmi",
    "真我": "realme", "魅族": "meizu",
}


def name_key(value):
    return re.sub(r"[\s._-]+", "", unicodedata.normalize("NFKC", value or "").lower())


def brand_key(value):
    key = name_key(value)
    return BRAND_ALIASES.get(key, key)


def read_candidates(csv_path, catalog_path):
    catalog = json.loads(catalog_path.read_text(encoding="utf-8-sig"))
    models = {}
    for model in catalog:
        for brand in {brand_key(model.get(key)) for key in ("brand", "brandLabel", "brand_label")} - {""}:
            models.setdefault((brand, name_key(model["name"])), {})[model["id"]] = model["name"]

    by_tac = {}
    with csv_path.open(encoding="utf-8-sig", newline="") as source:
        dialect = csv.Sniffer().sniff(source.readline(), delimiters=",;\t")
        source.seek(0)
        reader = csv.DictReader(source, dialect=dialect)
        headers = {name_key(column): column for column in reader.fieldnames or []}
        tac = headers.get("tac")
        brand = next((headers[key] for key in ("manufacturer", "brand", "vendor") if key in headers), None)
        name = next((headers[key] for key in (
            "marketingname", "model", "modelname", "device", "specs",
        ) if key in headers), None)
        if not all((tac, brand, name)):
            raise ValueError("CSV 须包含 TAC、品牌或厂商、型号列")
        for row in reader:
            code = (row[tac] or "").strip()
            if re.fullmatch(r"[0-9]{8}", code):
                by_tac.setdefault(code, set()).add((brand_key(row[brand]), name_key(row[name])))

    for code, names in sorted(by_tac.items()):
        if len(names) != 1:
            continue
        matches = models.get(next(iter(names)), {})
        if len(matches) == 1:
            model_id, model_name = next(iter(matches.items()))
            yield {"tac": code, "modelId": model_id, "modelName": model_name,
                   "source": SOURCE, "approved": False}


def literal(text):
    return "'" + text.replace("'", "''") + "'"


def import_sql(review_path):
    review = json.loads(review_path.read_text(encoding="utf-8-sig"))
    rows = {}
    for row in review:
        if row.get("approved") is not True:
            continue
        tac, model_id = row["tac"], row["modelId"]
        if not isinstance(tac, str) or not re.fullmatch(r"[0-9]{8}", tac):
            raise ValueError("核验记录中有无效 TAC")
        if not isinstance(model_id, str) or not model_id or len(model_id) > 60 or "\0" in model_id:
            raise ValueError("核验记录中有无效型号 ID")
        if row.get("source") != SOURCE:
            raise ValueError("请保留原数据署名")
        if tac in rows and rows[tac] != model_id:
            raise ValueError("同一 TAC 核验到了多个型号")
        rows[tac] = model_id
    if not rows:
        raise ValueError("没有 approved=true 的核验记录")

    values = ",\n  ".join(f"({literal(tac)}, {literal(model_id)})" for tac, model_id in sorted(rows.items()))
    return f"""-- {SOURCE}
BEGIN;
SET LOCAL standard_conforming_strings = on;
CREATE TEMP TABLE reviewed_tacs (tac char(8) PRIMARY KEY, model_id varchar(60) NOT NULL) ON COMMIT DROP;
INSERT INTO reviewed_tacs (tac, model_id) VALUES
  {values};
LOCK TABLE public.tac_mappings, public.imei_open_tac_mappings IN SHARE ROW EXCLUSIVE MODE;
DO $validate$
BEGIN
  IF EXISTS (SELECT 1 FROM reviewed_tacs r LEFT JOIN public.models m ON m.id = r.model_id WHERE m.id IS NULL) THEN
    RAISE EXCEPTION '审核清单中有不存在的型号';
  END IF;
  IF EXISTS (SELECT 1 FROM reviewed_tacs r JOIN public.tac_mappings t USING (tac) WHERE r.model_id <> t.model_id) THEN
    RAISE EXCEPTION '已有 TAC 指向其他型号，请人工核对';
  END IF;
  IF EXISTS (SELECT 1 FROM reviewed_tacs r JOIN public.imei_open_tac_mappings t USING (tac) WHERE r.model_id <> t.model_id) THEN
    RAISE EXCEPTION '已导入的 TAC 指向其他型号，请人工核对';
  END IF;
END $validate$;
INSERT INTO public.imei_open_tac_mappings (tac, model_id, source)
SELECT tac, model_id, {literal(SOURCE)} FROM reviewed_tacs
ON CONFLICT (tac) DO NOTHING;
COMMIT;
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    stages = parser.add_subparsers(dest="stage", required=True)
    review = stages.add_parser("review", help="生成待人工核验的 JSON")
    review.add_argument("csv", type=Path)
    review.add_argument("catalog", type=Path)
    sql = stages.add_parser("sql", help="为已核验记录生成 SQL")
    sql.add_argument("review", type=Path)
    args = parser.parse_args()
    try:
        if args.stage == "review":
            json.dump(list(read_candidates(args.csv, args.catalog)), sys.stdout, ensure_ascii=False, indent=2)
            print()
        else:
            print(import_sql(args.review), end="")
    except (KeyError, ValueError, TypeError, OSError, csv.Error) as error:
        parser.exit(1, f"生成失败：{error}\n")


if __name__ == "__main__":
    main()
