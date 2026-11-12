#!/usr/bin/env python3
"""
首页品牌入口配图：生成 miniprogram/assets/brands/<key>.png。

  python3 design-demos/brand-icons/build.py            # 生成全部
  python3 design-demos/brand-icons/build.py apple vivo # 只生成指定品牌
  python3 design-demos/brand-icons/build.py --sheet    # 另出一张三主题底色的预览图

每张图是该品牌当前旗舰（2026 年秋季发布）背面的原创插画，参考公开图片画摄像头布局、
机身配色与材质，不含品牌商标、logo 或官方素材：

  apple   iPhone 18 Pro        通栏摄像头平台，三摄三角排布，闪光灯、麦克风、激光雷达在右侧
  huawei  Mate 90 Pro          居中星环，三摄环绕中心圆盘，背板上部条纹、下部哑光
  xiaomi  小米 18 Pro          横向大矩阵：左侧镜头组，右侧背屏
  honor   Magic9 Pro           电影机转塔式模组：左侧大圆主摄带滚花圈，右侧两颗小圆竖排
  oppo    Find X10 Pro Max     横向阶梯状圆角镜头岛，三摄加一枚独立圆形元件
  vivo    X500 Pro             居中大圆模组，背板向模组斜坡过渡
  samsung Galaxy S26 Ultra     左侧竖向镜头岛容纳三摄，第四颗镜头与闪光灯在右侧
  oneplus 一加 16              方形镜头模组，星光配色背板带灯效

新机发布后改对应函数再运行即可。输出 240×240 透明底 PNG，单张不超过 30KB。
依赖：google-chrome（无头渲染 SVG）、Pillow。
"""
import math
import os
import random
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "miniprogram/assets/brands"
SIZE = 240
SCALE = 4  # 先放大渲染再缩小，边缘更干净
LIMIT = 30 * 1024

# 机身：宽 106、高 220，居中
X, Y, W, H = 67, 10, 106, 220
CX = X + W / 2


def n(v):
    """坐标转短字符串，减小 SVG 体积"""
    return f"{v:.2f}".rstrip("0").rstrip(".")


def lens(cx, cy, r, tint=None, tint_opacity=0.55):
    """镜头：金属圈（可叠机身色）+ 黑色镜筒 + 镀膜玻璃 + 瞳孔 + 两处高光"""
    hx, hy = cx - r * 0.24, cy - r * 0.26
    tinted = f'<circle cx="{n(cx)}" cy="{n(cy)}" r="{n(r)}" fill="{tint}" opacity="{tint_opacity}"/>' if tint else ""
    return (
        f'<circle cx="{n(cx)}" cy="{n(cy + r * 0.07)}" r="{n(r * 1.04)}" fill="#000" opacity=".25"/>'
        f'<circle cx="{n(cx)}" cy="{n(cy)}" r="{n(r)}" fill="url(#bezel)"/>{tinted}'
        f'<circle cx="{n(cx)}" cy="{n(cy)}" r="{n(r * 0.84)}" fill="#0A0B0E"/>'
        f'<circle cx="{n(cx)}" cy="{n(cy)}" r="{n(r * 0.64)}" fill="url(#glass)"/>'
        f'<circle cx="{n(cx)}" cy="{n(cy)}" r="{n(r * 0.6)}" fill="none" stroke="#4E6FA8" stroke-width="{n(r * 0.07)}" opacity=".55"/>'
        f'<circle cx="{n(cx)}" cy="{n(cy)}" r="{n(r * 0.28)}" fill="#04060A"/>'
        f'<ellipse cx="{n(hx)}" cy="{n(hy)}" rx="{n(r * 0.17)}" ry="{n(r * 0.11)}" fill="#fff" opacity=".75" transform="rotate(-35 {n(hx)} {n(hy)})"/>'
        f'<circle cx="{n(cx + r * 0.22)}" cy="{n(cy + r * 0.24)}" r="{n(r * 0.06)}" fill="#9FC2FF" opacity=".55"/>'
    )


def flash(cx, cy, r=3.4):
    return (
        f'<circle cx="{n(cx)}" cy="{n(cy)}" r="{n(r + 0.9)}" fill="url(#bezel)"/>'
        f'<circle cx="{n(cx)}" cy="{n(cy)}" r="{n(r)}" fill="url(#flash)"/>'
    )


def dot(cx, cy, r=1.3, fill="#1E2026"):
    """麦克风孔、传感器等小元件"""
    return f'<circle cx="{n(cx)}" cy="{n(cy)}" r="{n(r)}" fill="{fill}"/>'


def phone(top, bottom, frame_light, frame_dark, camera, rx=22, under=""):
    """
    top/bottom   机身渐变
    frame_*      中框金属渐变的亮部和暗部
    camera       摄像头等画在机身之上的部分
    under        背板纹理，按机身轮廓裁切、画在中框之下
    """
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}" width="{SIZE}" height="{SIZE}">
<defs>
  <linearGradient id="body" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="{top}"/><stop offset="1" stop-color="{bottom}"/>
  </linearGradient>
  <linearGradient id="frame" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="{frame_light}"/><stop offset=".45" stop-color="{frame_dark}"/>
    <stop offset=".7" stop-color="{frame_light}"/><stop offset="1" stop-color="{frame_dark}"/>
  </linearGradient>
  <linearGradient id="bezel" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#F4F5F7"/><stop offset=".5" stop-color="#8D9098"/><stop offset="1" stop-color="#D9DBE0"/>
  </linearGradient>
  <radialGradient id="glass" cx=".32" cy=".28" r=".85">
    <stop offset="0" stop-color="#6F86AE"/><stop offset=".35" stop-color="#2A3650"/><stop offset=".75" stop-color="#121722"/><stop offset="1" stop-color="#07090D"/>
  </radialGradient>
  <radialGradient id="flash" cx=".4" cy=".35" r=".7">
    <stop offset="0" stop-color="#FFFDF4"/><stop offset=".6" stop-color="#F4E6B8"/><stop offset="1" stop-color="#C9B67F"/>
  </radialGradient>
  <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
  </linearGradient>
  <clipPath id="clip"><rect x="{X}" y="{Y}" width="{W}" height="{H}" rx="{rx}"/></clipPath>
  <filter id="shadow" x="-30%" y="-10%" width="160%" height="130%">
    <feDropShadow dx="0" dy="3.5" stdDeviation="3.4" flood-color="#000" flood-opacity=".24"/>
  </filter>
  <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="1.6" stdDeviation="1.6" flood-color="#000" flood-opacity=".28"/>
  </filter>
</defs>
<rect x="{X + W - 1.5}" y="58" width="4" height="22" rx="2" fill="url(#frame)"/>
<rect x="{X + W - 1.5}" y="86" width="4" height="34" rx="2" fill="url(#frame)"/>
<rect x="{X}" y="{Y}" width="{W}" height="{H}" rx="{rx}" fill="url(#body)" filter="url(#shadow)"/>
<g clip-path="url(#clip)">
  {under}
  <path d="M{X - 10} {Y + 160} L{X + W + 10} {Y + 50} L{X + W + 10} {Y + 92} L{X - 10} {Y + 202}Z" fill="#fff" opacity=".07"/>
  <rect x="{X}" y="{Y}" width="{W}" height="40" fill="url(#sheen)" opacity=".5"/>
</g>
<rect x="{X + 1.6}" y="{Y + 1.6}" width="{W - 3.2}" height="{H - 3.2}" rx="{rx - 1.6}" fill="none" stroke="url(#frame)" stroke-width="3.2"/>
<rect x="{X + 3.6}" y="{Y + 3.6}" width="{W - 7.2}" height="{H - 7.2}" rx="{rx - 3.6}" fill="none" stroke="#000" stroke-opacity=".12" stroke-width=".8"/>
{camera}
</svg>"""


def apple():
    # iPhone 18 Pro 深樱桃色：通栏平台，三摄三角排布；右侧闪光灯、麦克风、激光雷达；下方背板玻璃区
    plateau = (
        f'<path d="M{X + 2} {Y + 22} Q{X + 2} {Y + 2} {X + 22} {Y + 2} H{X + W - 22} Q{X + W - 2} {Y + 2} {X + W - 2} {Y + 22} '
        f'V{Y + 80} Q{X + W - 2} {Y + 92} {X + W - 14} {Y + 92} H{X + 14} Q{X + 2} {Y + 92} {X + 2} {Y + 80}Z" '
        'fill="#7C2C3A" filter="url(#soft)"/>'
        f'<path d="M{X + 4} {Y + 22} Q{X + 4} {Y + 4} {X + 22} {Y + 4} H{X + W - 22} Q{X + W - 4} {Y + 4} {X + W - 4} {Y + 22}" '
        'fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="1.2"/>'
    )
    lenses = lens(90, 34, 13, "#7C2C3A") + lens(90, 70, 13, "#7C2C3A") + lens(118, 52, 13, "#7C2C3A")
    right = flash(151, 30, 4) + dot(151, 48, 1.1) + dot(151, 66, 5, "#0E0F12") + dot(151, 66, 2.4, "#262A33")
    under = f'<rect x="{X + 8}" y="{Y + 100}" width="{W - 16}" height="{H - 110}" rx="14" fill="#6A2231" opacity=".55"/>'
    return phone("#8E3646", "#5A1A27", "#C8798A", "#5A1E2A", plateau + lenses + right, under=under)


def huawei():
    # Mate 90 Pro 晶钻白：居中星环，三摄环绕中心圆盘，背板上部竖条纹、下部哑光
    stripes = "".join(
        f'<line x1="{x}" y1="{Y}" x2="{x}" y2="{Y + 158}" stroke="#B9BCC4" stroke-width=".55" opacity="{(0.35, 0.47, 0.6)[x % 3]}"/>'
        for x in range(X + 2, X + W, 2)
    )
    under = (
        stripes
        + f'<path d="M{X} {Y + 150} Q{CX} {Y + 140} {X + W} {Y + 150} V{Y + H} H{X}Z" fill="#ECEDEF"/>'
        + f'<path d="M{X} {Y + 150} Q{CX} {Y + 140} {X + W} {Y + 150}" fill="none" stroke="#fff" stroke-width="1"/>'
    )
    ring = (
        f'<circle cx="{CX}" cy="62" r="39" fill="#D8D9DD" filter="url(#soft)"/>'
        f'<circle cx="{CX}" cy="62" r="38" fill="none" stroke="url(#frame)" stroke-width="4"/>'
        f'<circle cx="{CX}" cy="62" r="35" fill="#101114"/>'
        f'<circle cx="{CX}" cy="62" r="33" fill="none" stroke="#2A2C31" stroke-width="1"/>'
        f'<circle cx="{CX}" cy="62" r="14" fill="#E7E7EA"/>'
        f'<circle cx="{CX}" cy="62" r="11" fill="none" stroke="#C9CAD0" stroke-width=".8"/>'
        f'<circle cx="{CX}" cy="62" r="6.5" fill="none" stroke="#C9CAD0" stroke-width=".8"/>'
        + lens(CX - 23, 62, 8) + lens(CX + 23, 62, 8) + lens(CX, 85, 8)
        + f'<rect x="{CX - 6}" y="34" width="12" height="5" rx="2.5" fill="url(#flash)" stroke="#6D6F76" stroke-width=".6"/>'
    )
    return phone("#F6F6F7", "#D6D7DB", "#F2F2F4", "#9A9CA3", ring, under=under)


def xiaomi():
    # 小米 18 Pro 冰川青：横向大矩阵，左侧镜头组，右侧背屏显示时间与卡片
    deck = (
        f'<rect x="{X + 5}" y="{Y + 6}" width="{W - 10}" height="84" rx="17" fill="#121317" filter="url(#soft)"/>'
        f'<rect x="{X + 5.6}" y="{Y + 6.6}" width="{W - 11.2}" height="82.8" rx="16.4" fill="none" stroke="#5A5E66" stroke-width="1.2"/>'
    )
    lenses = lens(91, 36, 12.5) + lens(91, 66, 12.5) + flash(104, 86, 2.6) + dot(78, 86, 1.1, "#3A3D44")
    screen = (
        '<defs><linearGradient id="wall" x1="0" y1="0" x2="1" y2="1">'
        '<stop offset="0" stop-color="#3E7BF2"/><stop offset=".55" stop-color="#7A5CF0"/><stop offset="1" stop-color="#E86FB0"/>'
        '</linearGradient></defs>'
        '<rect x="110" y="21" width="51" height="73" rx="9" fill="#000"/>'
        '<rect x="112" y="23" width="47" height="69" rx="7.5" fill="url(#wall)"/>'
        '<text x="135.5" y="45" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="13" font-weight="600" fill="#fff">09:41</text>'
        '<text x="135.5" y="54" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="5" fill="#fff" opacity=".85">11月12日 周四</text>'
        '<rect x="116" y="61" width="19" height="26" rx="4" fill="#fff" opacity=".22"/>'
        '<rect x="137" y="61" width="19" height="12" rx="4" fill="#fff" opacity=".22"/>'
        '<rect x="137" y="75" width="19" height="12" rx="4" fill="#fff" opacity=".22"/>'
        '<circle cx="125.5" cy="74" r="5" fill="none" stroke="#fff" stroke-width="1.6" opacity=".9"/>'
        '<path d="M125.5 69 A5 5 0 0 1 130.5 74" fill="none" stroke="#7CF0C5" stroke-width="1.6"/>'
        '<path d="M112 30 Q112 23 119 23 L152 23 Q159 23 159 30 L159 33 Q137 40 112 34Z" fill="#fff" opacity=".12"/>'
    )
    return phone("#CFEFE7", "#8FCFC3", "#E8F7F3", "#7FB3AA", deck + lenses + screen)


def honor():
    # Magic9 Pro 苔青：电影机转塔式模组，左侧大圆主摄带滚花圈，右侧两颗小圆竖排
    knurl = "".join(
        f'<line x1="{n(98 + 25.5 * math.cos(a))}" y1="{n(52 + 25.5 * math.sin(a))}" '
        f'x2="{n(98 + 28.6 * math.cos(a))}" y2="{n(52 + 28.6 * math.sin(a))}" stroke="#C8D2CD" stroke-width="1" opacity=".75"/>'
        for a in (i / 40 * 2 * math.pi for i in range(40))
    )
    turret = (
        f'<rect x="{X + 4}" y="{Y + 10}" width="{W - 12}" height="72" rx="36" fill="#26332E" filter="url(#soft)"/>'
        f'<rect x="{X + 4.6}" y="{Y + 10.6}" width="{W - 13.2}" height="70.8" rx="35.4" fill="none" stroke="url(#frame)" stroke-width="1.6"/>'
        '<circle cx="98" cy="52" r="29.5" fill="#151A18"/>'
        + knurl
        + '<circle cx="98" cy="52" r="24.5" fill="none" stroke="url(#frame)" stroke-width="1.6"/>'
        + lens(98, 52, 17)
        + flash(130, 52, 2.4)
        + lens(144, 36, 10.5) + lens(144, 68, 10.5)
    )
    return phone("#6E8F82", "#3E5A4F", "#B8CEC5", "#4B6458", turret)


def oppo():
    # Find X10 Pro Max 暖橙：横向阶梯镜头岛，三摄加一枚独立圆形元件
    island = (
        f'<rect x="{X + 5}" y="{Y + 7}" width="{W - 10}" height="70" rx="20" fill="#E9894A" filter="url(#soft)"/>'
        f'<rect x="{X + 5.6}" y="{Y + 7.6}" width="{W - 11.2}" height="68.8" rx="19.4" fill="none" stroke="#FFD2B0" stroke-width="1.1"/>'
        f'<rect x="{X + 9}" y="{Y + 11}" width="66" height="62" rx="17" fill="#1A1B1F"/>'
        f'<rect x="{X + 9.6}" y="{Y + 11.6}" width="64.8" height="60.8" rx="16.4" fill="none" stroke="url(#frame)" stroke-width="1.4"/>'
        + lens(93, 35, 11.5) + lens(121, 35, 11.5) + lens(93, 63, 11.5)
        + dot(121, 63, 6, "#2B2D33") + dot(121, 63, 2.6, "#0C0D10")
        + '<circle cx="154" cy="42" r="10.5" fill="#1A1B1F" stroke="url(#frame)" stroke-width="1.4"/>'
        + flash(154, 42, 4.2)
    )
    return phone("#F6A26A", "#D9642E", "#FFD4B3", "#B5562A", island)


def vivo():
    # X500 Pro 钛灰：居中大圆模组，背板向模组斜坡过渡
    slope = (
        '<defs><radialGradient id="slope" cx=".5" cy=".5" r=".5">'
        '<stop offset=".72" stop-color="#5E6168" stop-opacity="0"/><stop offset=".86" stop-color="#2E3035" stop-opacity=".45"/>'
        '<stop offset="1" stop-color="#5E6168" stop-opacity="0"/></radialGradient></defs>'
        f'<circle cx="{CX}" cy="66" r="50" fill="url(#slope)"/>'
    )
    module = (
        f'<circle cx="{CX}" cy="66" r="40" fill="#3B3E44" filter="url(#soft)"/>'
        f'<circle cx="{CX}" cy="66" r="39" fill="none" stroke="url(#frame)" stroke-width="3"/>'
        f'<circle cx="{CX}" cy="66" r="36" fill="#0E0F12"/>'
        f'<circle cx="{CX}" cy="66" r="34" fill="none" stroke="#2F3238" stroke-width=".8"/>'
        + lens(CX, 50, 13) + lens(CX - 16, 79, 9.5) + lens(CX + 16, 79, 9.5)
        + flash(CX + 22, 46, 2.8) + dot(CX - 22, 46, 2, "#24262C")
        + f'<circle cx="{CX}" cy="50" r="15.5" fill="none" stroke="#3E8FE0" stroke-width=".8" opacity=".75"/>'
    )
    return phone("#80848C", "#4B4E55", "#C9CCD2", "#5C6068", module, under=slope)


def samsung():
    # Galaxy S26 Ultra 钴蓝：左侧竖向镜头岛容纳三摄，第四颗镜头、闪光灯与激光对焦在右侧；机身更方
    island = (
        f'<rect x="{X + 6}" y="{Y + 8}" width="34" height="90" rx="17" fill="#2E3B5C" filter="url(#soft)"/>'
        f'<rect x="{X + 6.6}" y="{Y + 8.6}" width="32.8" height="88.8" rx="16.4" fill="none" stroke="url(#frame)" stroke-width="1.6"/>'
        + lens(90, 35, 12, "#2E3B5C", .3) + lens(90, 61, 12, "#2E3B5C", .3) + lens(90, 87, 12, "#2E3B5C", .3)
        + lens(118, 52, 7.5) + flash(118, 31, 3.2) + dot(118, 70, 2.4, "#1C2233")
    )
    return phone("#4F6390", "#2A3656", "#B6C2DD", "#3A4A72", island, rx=14)


def oneplus():
    # 一加 16 星光：方形镜头模组，背板星点与灯效光晕
    rnd = random.Random(16)
    stars = "".join(
        f'<circle cx="{rnd.uniform(X + 4, X + W - 4):.1f}" cy="{rnd.uniform(Y + 88, Y + H - 4):.1f}" '
        f'r="{rnd.uniform(.35, .95):.2f}" fill="#E8EEFF" opacity="{rnd.uniform(.35, .9):.2f}"/>'
        for _ in range(46)
    )
    glow = (
        '<defs><radialGradient id="glow" cx=".5" cy=".5" r=".5">'
        '<stop offset="0" stop-color="#8FB4FF" stop-opacity=".55"/><stop offset="1" stop-color="#8FB4FF" stop-opacity="0"/></radialGradient></defs>'
        f'<ellipse cx="{CX + 8}" cy="{Y + 150}" rx="46" ry="34" fill="url(#glow)"/>'
    )
    module = (
        f'<rect x="{X + 6}" y="{Y + 8}" width="64" height="64" rx="18" fill="#1E2436" filter="url(#soft)"/>'
        f'<rect x="{X + 6.6}" y="{Y + 8.6}" width="62.8" height="62.8" rx="17.4" fill="none" stroke="url(#frame)" stroke-width="1.8"/>'
        f'<rect x="{X + 6}" y="{Y + 8}" width="64" height="64" rx="18" fill="none" stroke="#9DB8FF" stroke-width=".8" opacity=".55"/>'
        + lens(91, 32, 11) + lens(119, 32, 11) + lens(91, 60, 11) + flash(119, 60, 4.2)
    )
    return phone("#2B3352", "#11152A", "#C3CCE6", "#4A5578", module, under=glow + stars)


BRANDS = {
    "apple": apple,
    "huawei": huawei,
    "xiaomi": xiaomi,
    "honor": honor,
    "oppo": oppo,
    "vivo": vivo,
    "samsung": samsung,
    "oneplus": oneplus,
}


def render(svg, png):
    """无头 Chrome 把 SVG 渲染成透明底 PNG"""
    with tempfile.TemporaryDirectory() as tmp:
        html = Path(tmp) / "icon.html"
        html.write_text(
            "<!doctype html><meta charset=utf-8>"
            "<style>html,body{margin:0;background:transparent}svg{display:block}</style>" + svg,
            encoding="utf-8",
        )
        raw = Path(tmp) / "raw.png"
        subprocess.run(
            [
                "google-chrome", "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-sandbox",
                "--disable-dev-shm-usage", "--default-background-color=00000000",
                f"--force-device-scale-factor={SCALE}", f"--window-size={SIZE},{SIZE}",
                f"--screenshot={raw}", html.as_uri(),
            ],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            # Chrome 的进程间套接字建在 TMPDIR 下，路径太长会直接崩溃，这里让它用系统默认目录
            env={k: v for k, v in os.environ.items() if k != "TMPDIR"},
        )
        image = Image.open(raw).convert("RGBA").resize((SIZE, SIZE), Image.LANCZOS)
    image.save(png, optimize=True)
    if png.stat().st_size > LIMIT:
        # 超过体积上限才减色，保留透明通道
        image.quantize(colors=256, method=Image.FASTOCTREE).save(png, optimize=True)
    return image


def sheet(images, target):
    """浅色、深色、零售绿三种页面底色下的预览，检查机身与背景是否分得开"""
    backgrounds = ["#F2F3F5", "#0B0C0F", "#EEF3EF"]
    cell = 140
    board = Image.new("RGB", (cell * len(images), cell * len(backgrounds)))
    for row, colour in enumerate(backgrounds):
        for col, image in enumerate(images):
            tile = Image.new("RGBA", (cell, cell), colour)
            small = image.resize((112, 112), Image.LANCZOS)
            tile.alpha_composite(small, (14, 14))
            board.paste(tile.convert("RGB"), (col * cell, row * cell))
    board.save(target)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    keys = args or list(BRANDS)
    unknown = [k for k in keys if k not in BRANDS]
    if unknown:
        sys.exit("未知品牌：" + "、".join(unknown))
    OUT.mkdir(parents=True, exist_ok=True)
    images = []
    for key in keys:
        target = OUT / f"{key}.png"
        images.append(render(BRANDS[key](), target))
        size = target.stat().st_size
        print(f"{key:8s} {size / 1024:5.1f} KB" + ("  超过 30KB！" if size > LIMIT else ""))
    if "--sheet" in sys.argv:
        target = Path(tempfile.gettempdir()) / "brand-icons-sheet.png"
        sheet(images, target)
        print("预览图：", target)


if __name__ == "__main__":
    main()
