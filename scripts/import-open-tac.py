#!/usr/bin/env python3
"""Import the MoazEb TAC CSV as public reference data in the selected CloudBase PG environment."""

import argparse
import csv
import json
import re
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from importlib import import_module
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

matcher = import_module("prepare-tac-mappings")
SOURCE = "MoazEb/tac-database | https://github.com/MoazEb/tac-database | MIT"
REGION = re.compile(r"\s*\((?:china|global|india|japan|korea|europe|us|usa)\)\s*$", re.I)


def model_index(models):
    prefixes = defaultdict(set)
    index = defaultdict(set)
    for alias, brand in matcher.BRAND_ALIASES.items():
        prefixes[brand].add(alias)
    for model in models:
        brand = model["brand"]
        prefixes[brand].update(matcher.name_key(value) for value in (brand, model["brand_label"]))
    for model in models:
        brand = model["brand"]
        for name in model_keys(model["name"], prefixes[brand]):
            index[brand, name].add(model["id"])
    return index, prefixes


def model_keys(name, prefixes):
    key = matcher.name_key(REGION.sub("", name))
    yield key
    for prefix in prefixes:
        if prefix and key.startswith(prefix) and len(key) > len(prefix):
            yield key[len(prefix):]


def read_catalog(csv_path, models):
    index, prefixes = model_index(models)
    grouped, skipped = defaultdict(set), Counter()
    with csv_path.open(encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        if set(reader.fieldnames or ()) != {"Brand", "TAC", "SPECS"}:
            raise ValueError("CSV 列名需为 Brand、TAC、SPECS")
        for record in reader:
            tac = record["TAC"].strip()
            brand, description = (record[key].strip() for key in ("Brand", "SPECS"))
            if re.fullmatch("[0-9]{8}", tac) is None:
                skipped["invalid_length"] += 1
                continue
            if not brand or not description or re.search(r"(?<!\d)\d{15,16}(?!\d)", description):
                skipped["invalid_description"] += 1
                continue
            grouped[tac].add((brand, description))
    rows = []
    for tac, labels in sorted(grouped.items()):
        if len(labels) != 1:
            skipped["conflicting_tac"] += 1
            continue
        brand, description = next(iter(labels))
        brand_id = matcher.brand_key(brand)
        matches = set()
        for segment in description.split(","):
            for name in model_keys(segment.strip(), prefixes[brand_id]):
                matches.update(index.get((brand_id, name), ()))
        rows.append({
            "tac": tac, "brand": brand, "description": description, "source": SOURCE,
            "model_id": next(iter(matches)) if len(matches) == 1 else None,
        })
    return rows, skipped


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv", type=Path)
    parser.add_argument("--env-id", required=True)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    env = dict(line.strip().split("=", 1) for line in args.env_file.read_text().splitlines()
               if re.match(r"^[A-Z_]+=", line))
    if not re.fullmatch("[a-z0-9-]+", args.env_id) or (env.get("CLOUDBASE_DATA_ENV_ID") or env.get("CLOUDBASE_ENV_ID")) != args.env_id:
        parser.error("目标环境与私有配置不一致")
    base = f"https://{args.env_id}.api.tcloudbasegateway.com/v1/rdb/rest/"
    auth = {"Authorization": "Bearer " + env["CLOUDBASE_API_KEY"]}

    def call(path, body=None):
        headers = dict(auth)
        if body is not None:
            headers.update({
                "Content-Type": "application/json",
                "Prefer": "resolution=ignore-duplicates,return=minimal",
            })
        for attempt in range(4):
            try:
                with closing(urlopen(Request(base + path, data=body, headers=headers), timeout=35)) as response:
                    data = response.read()
                    return json.loads(data) if data else None
            except HTTPError as error:
                response = error.read().decode(errors="replace")
                if error.code not in (429, 500, 502, 503, 504) or attempt == 3:
                    raise RuntimeError(f"PG 网关 HTTP {error.code} {response[:500]}") from None
            except (TimeoutError, URLError):
                if attempt == 3:
                    raise
            time.sleep(2 ** attempt)

    models = []
    while True:
        page = call(f"models?select=id,brand,brand_label,name&category_id=in.(phone,tablet)&order=id&limit=500&offset={len(models)}")
        models.extend(page)
        if len(page) < 500:
            break
    rows, skipped = read_catalog(args.csv, models)
    print(json.dumps({"tacs": len(rows), "matchedModels": sum(bool(row["model_id"]) for row in rows),
                      "skipped": skipped, "examples": [row for row in rows if row["tac"] in ("86229507", "86383808")]},
                     ensure_ascii=False), flush=True)
    if not args.apply:
        return

    def send(batch):
        call("imei_open_tac_catalog?on_conflict=tac",
             json.dumps(batch, separators=(",", ":"), ensure_ascii=False).encode())

    batch_size = 1200
    with ThreadPoolExecutor(max_workers=5) as pool:
        batches = (rows[i:i + batch_size] for i in range(0, len(rows), batch_size))
        for number, _ in enumerate(pool.map(send, batches), 1):
            if number % 25 == 0:
                print(f"已处理 {min(number * batch_size, len(rows))} 条", flush=True)
    print(f"已处理 {len(rows)} 条", flush=True)


if __name__ == "__main__":
    main()
