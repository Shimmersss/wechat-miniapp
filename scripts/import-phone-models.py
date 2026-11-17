#!/usr/bin/env python3
"""
把整理好的机型 CSV 转成型号目录迁移。

  python3 scripts/import-phone-models.py <机型.csv> <输出迁移.sql> [--report 报告.json]

CSV 列：序号,品牌,系列,机型名称,代号codename,上市年份,上市月份,型号编码,存储组合数,全部存储组合,芯片,屏幕,电池
处理规则：
- 机型名称里用“ / ”并列的多个市场名拆成单独型号；同品牌下名称归一化后相同的视为同一型号，只保留第一个
  （国内系列优先于海外系列，所以“荣耀 Play / HONOR Play”保留“荣耀 Play”）。
- 品牌映射到首页入口使用的品牌值：小米下的 Redmi、POCO，vivo 下的 iQOO 单独成品牌。
- 系列名统一成中文；“XX phones”等海外汇总归入“海外机型”。
- “全部存储组合”拆出存储容量（256GB→256G）和运行内存（8GB），异常值（如 640GB、内存 128GB）丢弃并写进报告。
- 与已有型号（cloudbase/migrations/20261117010000_phone_model_catalog.sql 的目录）按同样的归一化比对：
  命中的更新名称、系列、容量和运行内存，保留型号 ID 与颜色；未命中的新建。
只读输入文件，输出 SQL 与报告，不连数据库。
"""
import csv
import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

BRANDS = {
    '苹果 Apple': ('apple', '苹果'), '华为 HUAWEI': ('huawei', '华为'), '荣耀 HONOR': ('honor', '荣耀'),
    '小米 Xiaomi': ('xiaomi', '小米'), 'OPPO': ('oppo', 'OPPO'), 'vivo': ('vivo', 'vivo'),
    '真我 realme': ('realme', 'realme'), '三星 Samsung': ('samsung', '三星'), '一加 OnePlus': ('oneplus', '一加'),
    '魅族 MEIZU': ('meizu', '魅族'), '努比亚 nubia': ('nubia', '努比亚'), '摩托罗拉 Motorola': ('motorola', '摩托罗拉'),
    '中兴 ZTE': ('zte', '中兴'), '索尼 Sony': ('sony', '索尼'), '华硕 ASUS': ('asus', '华硕'), '酷派 Coolpad': ('coolpad', '酷派'),
    '谷歌 Google': ('google', '谷歌'), '联想 Lenovo': ('lenovo', '联想'), '诺基亚 Nokia': ('nokia', '诺基亚'),
    '黑鲨 Black Shark': ('blackshark', '黑鲨'), '乐视 Letv': ('letv', '乐视'), 'Nothing': ('nothing', 'Nothing'),
}
SUB_BRANDS = {'redmi': ('redmi', 'Redmi'), 'poco': ('poco', 'POCO'), 'iqoo': ('iqoo', 'iQOO')}

SERIES_MAP = {
    'HUAWEI Mate 系列': 'Mate 系列', 'HUAWEI Mate Series': 'Mate 系列',
    'HUAWEI nova 系列': 'nova 系列', 'HUAWEI nova Series': 'nova 系列',
    'HUAWEI P / Pura 系列': 'P / Pura 系列', 'HUAWEI P/Pura Series': 'P / Pura 系列',
    'HUAWEI Y Series': 'Y 系列（海外）', 'HUAWEI 麦芒系列': '麦芒系列', 'HUAWEI G 系列': 'G 系列', 'HUAWEI Pocket 系列': 'Pocket 系列',
    '荣耀数字系列 (HONOR 系列 / N 系列)': '荣耀数字系列', '荣耀 V 系列 (Vera 系列 / View 系列)': '荣耀 V 系列',
    'HONOR phones (Honor)': '海外机型', 'HONOR phones (Huawei)': '海外机型',
    '红米 / REDMI Note 系列': 'Redmi Note 系列', '红米 / REDMI 数字系列': 'Redmi 数字系列', 'REDMI K 系列': 'Redmi K 系列',
    'REDMI Turbo 系列': 'Redmi Turbo 系列', 'Redmi X 系列': 'Redmi X 系列', 'REDMI phones': 'Redmi 其他', '其他 REDMI 手机': 'Redmi 其他',
    'Xiaomi phones': '海外机型', 'POCO 手机': 'POCO 系列',
    'iQOO Smartphones': '海外机型', 'iQOO 旗舰系列': 'iQOO 数字系列',
    'OnePlus Phones': '海外机型', 'MEIZU Phones': '魅族手机', 'Phones': 'Pixel 系列',
    'Number series': '数字系列', 'ROG Phones': 'ROG 游戏手机', 'Zenfone Series': 'Zenfone 系列',
    'Galaxy A': 'Galaxy A 系列', 'Galaxy M': 'Galaxy M 系列', 'Galaxy F': 'Galaxy F 系列', 'Galaxy S': 'Galaxy S 系列', 'Galaxy Note': 'Galaxy Note 系列',
}
EMPTY_SERIES = {'sony': 'Xperia 系列', 'zte': '中兴手机', 'coolpad': '酷派手机', 'blackshark': '黑鲨手机', 'letv': '乐视手机',
                'nothing': 'Nothing Phone', 'asus': 'ROG 游戏手机'}
# 归一化时去掉的品牌词（名称里带不带品牌都算同一型号）
BRAND_WORDS = ['porsche design', 'black shark', 'huawei', '华为', 'honor', '荣耀', 'xiaomi', '小米', 'redmi', '红米', 'oneplus', '一加',
               'realme', '真我', 'meizu', '魅族', 'samsung', '三星', 'nubia', '努比亚', 'zte', '中兴', '黑鲨', 'letv', '乐视',
               'asus', '华硕', 'nokia', '诺基亚', 'motorola', '摩托罗拉', 'lenovo', '联想', 'coolpad', '酷派', 'apple', '苹果', 'vivo', 'oppo']
STORAGE_OK = {'4GB': '4G', '8GB': '8G', '16GB': '16G', '32GB': '32G', '64GB': '64G', '128GB': '128G', '256GB': '256G',
              '512GB': '512G', '1TB': '1T', '2TB': '2T'}
STORAGE_ORDER = ['4G', '8G', '16G', '32G', '64G', '128G', '256G', '512G', '1T', '2T']


def norm_text(s):
    return unicodedata.normalize('NFKC', s).strip()


def key_of(brand, name):
    s = norm_text(name).lower()
    s = s.replace('第二代', '第2代').replace('第三代', '第3代')
    for w in BRAND_WORDS:
        s = re.sub(r'(^|\s)' + re.escape(w) + r'(?=\s|$|\d)', ' ', s)
    s = re.sub(r'^mi\s+', ' ', s.strip())
    s = re.sub(r'\b5g\b', ' ', s)
    s = s.replace('+', 'plus')
    s = re.sub(r'[\s\-_.()（）·]', '', s)
    return brand + ':' + s


def brand_of(row):
    base = BRANDS[row['品牌']]
    series = row['系列']
    if base[0] == 'xiaomi':
        if re.search(r'redmi|红米', series, re.I):
            return SUB_BRANDS['redmi']
        if 'POCO' in series:
            return SUB_BRANDS['poco']
    if base[0] == 'vivo' and series.startswith('iQOO'):
        return SUB_BRANDS['iqoo']
    return base


def series_of(brand, series):
    series = norm_text(series)
    if not series:
        return EMPTY_SERIES.get(brand, '其他')
    if series in SERIES_MAP:
        return SERIES_MAP[series]
    series = re.sub(r'\s+[Ss]eries$', ' 系列', series)
    return series[:50]


def overseas(series):
    """英文系列名来自海外汇总，排在国内系列之后处理，去重时国内名称优先"""
    return not re.search(r'[一-鿿]', series)


def parse_storage(text, anomalies, name):
    storage, ram = set(), set()
    for part in text.split('/'):
        part = norm_text(part)
        if not part:
            continue
        m = re.fullmatch(r'(?:(\d+(?:\.\d+)?)GB\+)?(\d+(?:GB|TB))', part)
        if not m:
            anomalies.append({'name': name, 'value': part, 'reason': '格式无法识别'})
            continue
        r, s = m.group(1), m.group(2)
        if s in STORAGE_OK:
            storage.add(STORAGE_OK[s])
        else:
            anomalies.append({'name': name, 'value': part, 'reason': '存储容量异常，已忽略'})
        if r is not None:
            if float(r) <= 32:
                ram.add(r + 'GB')
            else:
                anomalies.append({'name': name, 'value': part, 'reason': '运行内存异常，已忽略'})
    return storage, ram


def ram_sort(v):
    return float(v[:-2])


def load_existing():
    """已上线的型号目录（由 20261117010000 迁移生成）"""
    sys.path.insert(0, str(Path(__file__).parent))
    src = (ROOT / 'cloudbase/migrations/20261117010000_phone_model_catalog.sql').read_text(encoding='utf-8')
    existing = []
    for m in re.finditer(r"\('([^']+)','([^']+)','([^']+)','([^']+)','([^']+)','(\{[^']*\})'::jsonb\)", src):
        mid, brand, label, series, name, specs = m.groups()
        existing.append({'id': mid, 'brand': brand, 'label': label, 'series': series, 'name': name, 'specs': json.loads(specs)})
    if len(existing) < 100:
        sys.exit('未能解析已有型号目录')
    return existing


def slug(text):
    s = norm_text(text).lower().replace('+', '-plus')
    s = re.sub(r'[^a-z0-9]+', '-', s).strip('-')
    return s


def q(v):
    return "'" + str(v).replace("'", "''") + "'"


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    report_path = Path(sys.argv[sys.argv.index('--report') + 1]) if '--report' in sys.argv else None
    rows = list(csv.DictReader(src.open(encoding='utf-8-sig')))
    unknown = sorted({r['品牌'] for r in rows if r['品牌'] not in BRANDS})
    if unknown:
        sys.exit('未映射的品牌：' + '、'.join(unknown))

    anomalies, models = [], {}
    order = sorted(range(len(rows)), key=lambda i: (overseas(rows[i]['系列']), i))
    for i in order:
        r = rows[i]
        brand, label = brand_of(r)
        series = series_of(brand, r['系列'])
        storage, ram = parse_storage(r['全部存储组合'], anomalies, r['机型名称'])
        year = r['上市年份'].strip()
        for alias in [norm_text(a) for a in r['机型名称'].split(' / ') if norm_text(a)]:
            k = key_of(brand, alias)
            if k in models:
                models[k]['storage'] |= storage
                models[k]['ram'] |= ram
                models[k]['aliases'].append(alias)
                continue
            models[k] = {'brand': brand, 'label': label, 'series': series, 'name': alias[:100], 'storage': set(storage),
                         'ram': set(ram), 'year': year, 'aliases': []}

    existing = load_existing()
    by_key = {key_of(e['brand'], e['name']): e for e in existing}
    updates, inserts, kept = [], [], []
    used_names = {}
    for k, m in models.items():
        e = by_key.pop(k, None)
        m['id'] = e['id'] if e else None
        (updates if e else inserts).append(m)
    kept = list(by_key.values())

    # 名称全局唯一：撞名时在后面补品牌
    final_names = {e['name'] for e in kept}
    for m in updates + inserts:
        name = m['name']
        if name in final_names or name in used_names:
            name = f"{name}（{m['label']}）"[:100]
        used_names[name] = True
        final_names.add(name)
        m['name'] = name

    # 新型号 ID：品牌-名称拼音无法生成时用摘要
    taken = {e['id'] for e in existing}
    for m in inserts:
        base = slug(m['name'])
        cand = f"{m['brand']}-{base}"[:60] if base and not re.search(r'[一-鿿]', m['name']) else ''
        if not cand or cand in taken:
            cand = f"{m['brand']}-{hashlib.sha1(m['name'].encode()).hexdigest()[:10]}"
        taken.add(cand)
        m['id'] = cand

    def specs(m, color=None):
        return json.dumps({'storage': sorted(m['storage'], key=STORAGE_ORDER.index), 'color': color or [],
                           'ram': sorted(m['ram'], key=ram_sort)}, ensure_ascii=False)

    upd = []
    for m in updates:
        upd.append(f"({q(m['id'])},{q(m['name'])},{q(m['series'])},{q(specs(m))}::jsonb)")
    ins = []
    for m in inserts:
        ins.append(f"({q(m['id'])},{q(m['brand'])},{q(m['label'])},{q(m['series'])},{q(m['name'])},{q(specs(m))}::jsonb)")

    sql = f"""-- 机型库导入：来自店方整理的《近十年机型_2016-2026.csv》（{len(rows)} 行），由 scripts/import-phone-models.py 生成，不要手改。
-- 新增 {len(inserts)} 个型号；更新已有型号 {len(updates)} 个（名称、系列、存储容量、运行内存，保留 ID 与颜色）；
-- 保留未出现在 CSV 中的已有型号 {len(kept)} 个。一行多名已拆成单独型号，同品牌同名只保留一个。
DO $$
DECLARE tpl text;
BEGIN
  SELECT template_id INTO tpl FROM categories WHERE id='phone';
  IF tpl IS NULL THEN RAISE NOTICE '没有手机分类或模板，跳过机型库导入'; RETURN; END IF;

  -- 已有型号：先挪开名称，避免批量改名时互相撞唯一约束
  UPDATE models m SET name = m.id || ' #' || md5(m.name) FROM (VALUES
    {(','+chr(10)+'    ').join(upd) or "(NULL,NULL,NULL,NULL::jsonb)"}
  ) AS v(id,name,series,specs) WHERE m.id=v.id AND m.category_id='phone';
  UPDATE models m SET name=v.name, series=v.series,
    specs=jsonb_build_object('storage', CASE WHEN jsonb_array_length(v.specs->'storage')>0 THEN v.specs->'storage' ELSE coalesce(m.specs->'storage','[]') END,
                             'color', coalesce(m.specs->'color','[]'),
                             'ram', CASE WHEN jsonb_array_length(v.specs->'ram')>0 THEN v.specs->'ram' ELSE coalesce(m.specs->'ram','[]') END)
  FROM (VALUES
    {(','+chr(10)+'    ').join(upd) or "(NULL,NULL,NULL,NULL::jsonb)"}
  ) AS v(id,name,series,specs) WHERE m.id=v.id AND m.category_id='phone';

  INSERT INTO models(id,category_id,brand,brand_label,series,name,template_id,specs)
  SELECT v.id,'phone',v.brand,v.brand_label,v.series,v.name,tpl,v.specs
  FROM (VALUES
    {(','+chr(10)+'    ').join(ins)}
  ) AS v(id,brand,brand_label,series,name,specs)
  ON CONFLICT DO NOTHING;
END $$;
"""
    out.write_text(sql, encoding='utf-8')
    report = {
        'csvRows': len(rows), 'models': len(models), 'inserted': len(inserts), 'updated': len(updates),
        'keptExisting': [e['name'] for e in kept], 'mergedAliases': sum(len(m['aliases']) for m in models.values()),
        'withStorage': sum(1 for m in models.values() if m['storage']), 'withRam': sum(1 for m in models.values() if m['ram']),
        'anomalies': anomalies,
        'byBrand': {b: sum(1 for m in models.values() if m['label'] == b) for b in sorted({m['label'] for m in models.values()})},
        'renamed': [{'id': m['id'], 'name': m['name']} for m in updates],
    }
    if report_path:
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k not in ('anomalies', 'renamed', 'keptExisting')}, ensure_ascii=False))
    print('anomalies', len(anomalies), '| kept existing', len(kept))


if __name__ == '__main__':
    main()
