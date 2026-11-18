#!/usr/bin/env python3
"""
首页品牌入口配图：生成 design-demos/brand-icons/images/<key>.png。

  python3 design-demos/brand-icons/build.py            # 生成全部
  python3 design-demos/brand-icons/build.py apple vivo # 只生成指定品牌
  python3 design-demos/brand-icons/build.py --sheet    # 另出一张三主题底色的预览图

手机图是该品牌当前旗舰背面的原创插画，参考公开图片画摄像头布局、
机身配色与材质，不含品牌商标、logo 或官方素材：

  apple   苹果酒红参考款         通栏圆角相机岛，左二右一三摄，闪光灯、麦克风、激光雷达在右侧
  huawei  华为香槟金参考款       居中大圆模组，背板分区横竖细纹、下部哑光
  xiaomi  小米银灰参考款         通栏蓝紫背屏，左侧纵向双摄，模组下方是传感器和闪光灯
  honor   荣耀银白参考款       银色横向相机岛，左侧黑色大圆模组，右侧双镜头竖排
  oppo    OPPO 灰紫参考款       左侧黑色方形相机岛，右侧窄条内竖排两枚圆形元件
  vivo    vivo 银灰参考款       居中大圆模组，四个镜窗呈矩阵排布，闪光灯位于左上方
  samsung Galaxy S26 Ultra     左侧竖向镜头岛容纳三摄，第四颗镜头与闪光灯在右侧
  oneplus 一加白色参考款        左侧胶囊形双摄，右侧竖排独立镜头和闪光灯
  redmi   红米蓝色参考款         同色横向镜头岛，左侧四圆矩阵，右侧圆形扬声器
  iqoo    iQOO 珍珠银参考款      银白切面背板，圆角方形镜头岛，三摄左二右一
  realme  真我蓝灰参考款        左上大圆形镜头模组，上方双圆镜头，左下方形潜望镜

另有 5 张品类示意：other-phone（中性双摄手机）、tablet（平板）、accessory（充电头加数据线）、
audio（头戴耳机）、other-device（笔记本加智能手表）。

新机发布后改对应函数再运行即可。输出 240×240 透明底 PNG，单张不超过 30KB。
依赖：google-chrome（无头渲染 SVG）、Pillow。
"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "design-demos/brand-icons/images"
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


def phone(top, bottom, frame_light, frame_dark, camera, rx=22, under="", side_buttons=None, diagonal_sheen=True):
    """
    top/bottom   机身渐变
    frame_*      中框金属渐变的亮部和暗部
    camera       摄像头等画在机身之上的部分
    under        背板纹理，按机身轮廓裁切、画在中框之下
    side_buttons 自定义侧键，默认使用右侧侧键
    diagonal_sheen 是否添加背板的斜向反光
    """
    if side_buttons is None:
        side_buttons = (
            f'<rect x="{X + W - 1.5}" y="58" width="4" height="22" rx="2" fill="url(#frame)"/>'
            f'<rect x="{X + W - 1.5}" y="86" width="4" height="34" rx="2" fill="url(#frame)"/>'
        )
    reflection = (
        f'<path d="M{X - 10} {Y + 160} L{X + W + 10} {Y + 50} L{X + W + 10} {Y + 92} L{X - 10} {Y + 202}Z" fill="#fff" opacity=".07"/>'
        if diagonal_sheen else ""
    )
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
{side_buttons}
<rect x="{X}" y="{Y}" width="{W}" height="{H}" rx="{rx}" fill="url(#body)" filter="url(#shadow)"/>
<g clip-path="url(#clip)">
  {under}
  {reflection}
  <rect x="{X}" y="{Y}" width="{W}" height="40" fill="url(#sheen)" opacity=".5"/>
</g>
<rect x="{X + 1.6}" y="{Y + 1.6}" width="{W - 3.2}" height="{H - 3.2}" rx="{rx - 1.6}" fill="none" stroke="url(#frame)" stroke-width="3.2"/>
<rect x="{X + 3.6}" y="{Y + 3.6}" width="{W - 7.2}" height="{H - 7.2}" rx="{rx - 3.6}" fill="none" stroke="#000" stroke-opacity=".12" stroke-width=".8"/>
{camera}
</svg>"""


def apple():
    # 酒红参考款的相机岛约占背面上方四分之一，三摄左二右一。
    island = """<defs>
  <linearGradient id="apple-island" x2=".87" y2="1">
    <stop stop-color="#895560"/><stop offset=".55" stop-color="#693D47"/><stop offset="1" stop-color="#472731"/>
  </linearGradient>
  <linearGradient id="apple-rim" x2=".74" y2="1">
    <stop stop-color="#C78E99"/><stop offset=".42" stop-color="#82535E"/><stop offset="1" stop-color="#2B161D"/>
  </linearGradient>
  <linearGradient id="apple-panel" x2=".78" y2="1">
    <stop stop-color="#6F424D"/><stop offset=".55" stop-color="#5B343E"/><stop offset="1" stop-color="#482631"/>
  </linearGradient>
  <radialGradient id="apple-flash" cx=".4" cy=".38" r=".66">
    <stop stop-color="#FDFCF9"/><stop offset=".65" stop-color="#D9D6D4"/><stop offset="1" stop-color="#969095"/>
  </radialGradient>
</defs>
<rect x="70" y="12.5" width="100" height="57" rx="18" fill="#341B23" filter="url(#soft)"/>
<rect x="70.2" y="12.4" width="99.6" height="56.3" rx="17.8" fill="url(#apple-island)" stroke="url(#apple-rim)" stroke-width="1.5"/>
<path d="M72.5 30Q72.5 14.4 88.5 14.4H151.8Q164.8 14.4 167 24.2" fill="none" stroke="#F1BAC4" stroke-opacity=".32" stroke-width=".9"/>
<path d="M75 60Q78 66.6 88 66.6H153.2Q162.5 66.6 165.5 60" fill="none" stroke="#D094A0" stroke-opacity=".27" stroke-width=".8"/>"""
    lenses = (
        lens(86.5, 29.1, 11.4, "#6E414A", .82)
        + lens(86.5, 55.2, 11.4, "#6E414A", .82)
        + lens(111.2, 42.1, 11.4, "#6E414A", .82)
    )
    sensors = (
        '<circle cx="154.2" cy="28.7" r="4.7" fill="url(#apple-flash)" stroke="#CDB6BB" stroke-width=".65"/>'
        + dot(154.2, 42.1, .92, "#35202A")
        + '<circle cx="154.2" cy="55.5" r="4.65" fill="#1C171D" stroke="#79535C" stroke-width=".5"/>'
    )
    panel = '<rect x="72.2" y="75.5" width="95.6" height="149.3" rx="14.8" fill="url(#apple-panel)" stroke="#301921" stroke-opacity=".44" stroke-width=".85"/>'
    button = '<rect x="65.9" y="73" width="2.8" height="24" rx="1.1" fill="url(#frame)"/>'
    seams = '<path d="M67 31.5h3m100 0h3M67 208h3m100 0h3" fill="none" stroke="#342026" stroke-opacity=".72" stroke-width="1.15"/>'
    return phone(
        "#7C4C57", "#4B2833", "#BC8490", "#603641", island + lenses + sensors + seams,
        rx=20, under=panel, side_buttons=button, diagonal_sheen=False,
    )


def huawei():
    # 左上、右下是横纹，另两区是竖纹，底部为香槟金哑光面。
    under = """<defs>
  <clipPath id="huawei-panel"><rect x="69" y="11" width="102" height="167" rx="15"/></clipPath>
  <linearGradient id="huawei-texture" x2=".85" y2="1">
    <stop stop-color="#817970"/><stop offset=".56" stop-color="#61564D"/><stop offset="1" stop-color="#81746A"/>
  </linearGradient>
  <pattern id="huawei-h" width="2.3" height="2.3" patternUnits="userSpaceOnUse">
    <path d="M0 .58h2.3" stroke="#F5E9D8" stroke-width=".72" opacity=".73"/>
    <path d="M0 1.65h2.3" stroke="#241D1A" stroke-width=".37" opacity=".4"/>
  </pattern>
  <pattern id="huawei-v" width="2.3" height="2.3" patternUnits="userSpaceOnUse">
    <path d="M.58 0v2.3" stroke="#F5E9D8" stroke-width=".72" opacity=".73"/>
    <path d="M1.65 0v2.3" stroke="#241D1A" stroke-width=".37" opacity=".4"/>
  </pattern>
</defs>
<g clip-path="url(#huawei-panel)">
  <rect x="69" y="11" width="102" height="167" fill="url(#huawei-texture)"/>
  <path d="M69 11h51v48H69zM120 59h51v119h-51z" fill="url(#huawei-h)"/>
  <path d="M120 11h51v48h-51zM69 59h51v119H69z" fill="url(#huawei-v)"/>
  <path d="M120 11v167M69 59h102" stroke="#E3D6C4" stroke-width=".6" opacity=".55"/>
</g>"""
    ring = (
        """<defs>
  <linearGradient id="huawei-metal" x2=".65" y2="1">
    <stop stop-color="#F4E8D3"/><stop offset=".38" stop-color="#B09B85"/>
    <stop offset=".66" stop-color="#EEE1CA"/><stop offset="1" stop-color="#786351"/>
  </linearGradient>
  <linearGradient id="huawei-glass" x2="1" y2="1">
    <stop stop-color="#172826"/><stop offset="1" stop-color="#061413"/>
  </linearGradient>
  <linearGradient id="huawei-center" x2=".8" y2="1">
    <stop stop-color="#7C8983"/><stop offset="1" stop-color="#58655F"/>
  </linearGradient>
  <linearGradient id="huawei-periscope" x2=".7" y2="1">
    <stop stop-color="#101B19"/><stop offset=".63" stop-color="#25413A"/><stop offset="1" stop-color="#43736A"/>
  </linearGradient>
</defs>
<circle cx="120" cy="57" r="42" fill="#463B33" filter="url(#soft)"/>
<circle cx="120" cy="56" r="41.8" fill="url(#huawei-metal)" stroke="#F1E1CB" stroke-width=".55"/>
<circle cx="120" cy="56" r="39" fill="url(#huawei-glass)" stroke="#6F665B" stroke-width=".8"/>
<circle cx="120" cy="56" r="18.7" fill="url(#huawei-center)" stroke="#43504C" stroke-width="1.3"/>"""
        + lens(92, 56, 8.4, "#4D685D", .78)
        + lens(120, 29.4, 5.4, "#435D53", .88)
        + dot(106, 29, 2.1, "#66776D") + dot(134, 29.8, 1.8, "#4D635C")
        + '<rect x="141" y="47" width="13.5" height="18" rx="4" fill="#33483F" stroke="#597166" stroke-width=".7"/>'
        + '<rect x="143.1" y="49" width="9.3" height="13.7" rx="2.5" fill="url(#huawei-periscope)"/>'
        + '<rect x="115.4" y="82" width="9.2" height="4" rx="2" fill="url(#flash)"/>'
    )
    return phone(
        "#E1D5C3", "#B8A792", "#F3E7D5", "#898070", ring,
        rx=17, under=under, diagonal_sheen=False,
    )


def xiaomi():
    # 银灰参考款：蓝紫背屏横贯镜头岛，左侧双摄，下方另有传感器与闪光灯。
    waves = "".join(
        f'<path d="M{n(75 - i * 1.4)} {n(35 + i * 3.8)} '
        f'C{n(107 - i * .6)} {n(17 + i * 3.3)} {n(147 - i * 1.75)} {n(19 + i * 4.7)} '
        f'{n(169 - i * .7)} {n(45 + i * 3.85)}" '
        f'stroke="url(#xiaomi-wave)" stroke-width="{n(4.7 - i * .13)}" opacity="{n(.86 - i * .024)}"/>'
        for i in range(15)
    )
    deck = (
        '<defs>'
        '<linearGradient id="xiaomi-metal" x1="0" y1="0" x2=".9" y2="1">'
        '<stop stop-color="#E5E7EB"/><stop offset=".46" stop-color="#878D97"/>'
        '<stop offset="1" stop-color="#3B3F46"/>'
        '</linearGradient>'
        '<linearGradient id="xiaomi-screen" x1="0" y1="1" x2="1" y2="0">'
        '<stop stop-color="#33232A"/><stop offset=".42" stop-color="#111B3B"/>'
        '<stop offset="1" stop-color="#28114E"/>'
        '</linearGradient>'
        '<linearGradient id="xiaomi-wave" gradientUnits="userSpaceOnUse" x1="76" y1="0" x2="162" y2="0">'
        '<stop stop-color="#E2A879"/><stop offset=".24" stop-color="#83587C"/>'
        '<stop offset=".51" stop-color="#4396F4"/><stop offset=".73" stop-color="#6753F4"/>'
        '<stop offset=".96" stop-color="#BA4EF5"/>'
        '</linearGradient>'
        '<clipPath id="xiaomi-display"><rect x="76" y="21" width="88" height="73" rx="13"/></clipPath>'
        '</defs>'
        '<rect x="72" y="17" width="96" height="82" rx="17" fill="url(#xiaomi-metal)" filter="url(#soft)"/>'
        '<rect x="74" y="19" width="92" height="77" rx="15" fill="#0C0D12" stroke="#B1B5BD" stroke-width=".6"/>'
        '<rect x="76" y="21" width="88" height="73" rx="13" fill="url(#xiaomi-screen)"/>'
        '<g clip-path="url(#xiaomi-display)" fill="none" stroke-linecap="round">'
        + waves
        + '</g>'
        + lens(92, 40, 13.4, "#1F2634", .86)
        + lens(92, 73, 13.4, "#1F2634", .86)
        + '<rect x="80" y="104" width="23" height="10" rx="5" fill="#151820" stroke="#666C76" stroke-width=".55"/>'
        + dot(86, 109, 2.3, "#343D4D")
        + dot(85.5, 108.5, .75, "#65738C")
        + flash(111, 109, 3.6)
    )
    buttons = (
        f'<rect x="{X - 2}" y="81" width="3.5" height="33" rx="2" fill="url(#frame)"/>'
        f'<rect x="{X - 2}" y="120" width="3.5" height="19" rx="2" fill="url(#frame)"/>'
    )
    return phone("#ADB1BA", "#343840", "#DEE0E5", "#595E69", deck, rx=20, side_buttons=buttons)


def honor():
    # 左侧大圆的黑色盖板内有闪光灯和偏右的小方镜窗。
    island = (
        """<defs>
  <linearGradient id="honor-silver" x2=".87" y2="1">
    <stop stop-color="#F4F5F3"/><stop offset=".58" stop-color="#C5C9C9"/><stop offset="1" stop-color="#A8ACAD"/>
  </linearGradient>
  <linearGradient id="honor-rim" x2=".86" y2="1">
    <stop stop-color="#FFF"/><stop offset=".38" stop-color="#969DA0"/>
    <stop offset=".65" stop-color="#E4E7E6"/><stop offset="1" stop-color="#555C60"/>
  </linearGradient>
  <linearGradient id="honor-glass" x2=".85" y2="1">
    <stop stop-color="#4A5053"/><stop offset=".5" stop-color="#24282C"/><stop offset="1" stop-color="#0B0E11"/>
  </linearGradient>
  <linearGradient id="honor-panel" x2="1" y2=".8">
    <stop stop-color="#C9CCC8"/><stop offset="1" stop-color="#9DA2A4"/>
  </linearGradient>
</defs>
<rect x="72" y="14.5" width="96" height="65" rx="21" fill="#737879" filter="url(#soft)"/>
<rect x="72.5" y="14" width="95" height="64" rx="20" fill="url(#honor-silver)" stroke="#E6E8E5" stroke-width="1"/>
<circle cx="105" cy="47.4" r="29.7" fill="url(#honor-rim)" stroke="#C9CDCC" stroke-width=".75"/>
<circle cx="105" cy="47.4" r="27.3" fill="url(#honor-glass)" stroke="#DFE1DF" stroke-width=".65"/>
<path d="M82.7 60.9a26.1 26.1 0 0 1 36.2-36z" fill="#E2E5E6" opacity=".07"/>
<rect x="113.4" y="40.9" width="13.1" height="13.1" rx="3.1" fill="#151C1D" stroke="#596563" stroke-width=".55"/>
<circle cx="120" cy="47.4" r="4.2" fill="#193F3D"/>
<circle cx="118.8" cy="46" r="1.4" fill="#6DA59B" opacity=".76"/>"""
        + flash(103.5, 27.4, 3)
        + lens(150, 34, 10.9, "#717C80", .34)
        + lens(150, 61.2, 10.9, "#717C80", .34)
    )
    panel = '<rect x="73" y="85" width="94" height="140" rx="13.5" fill="url(#honor-panel)" stroke="#A2A7A8" stroke-width=".65"/>'
    return phone(
        "#D0D3D0", "#A2A7A9", "#E9ECE8", "#818689", island,
        rx=18, under=panel, diagonal_sheen=False,
    )


def oppo():
    # 灰紫机背的通栏平台上，黑色镜窗与右侧窄条分别凸起。
    island = (
        """<defs>
  <linearGradient id="oppo-deck" x2=".87" y2="1">
    <stop stop-color="#D3C6CE"/><stop offset="1" stop-color="#A494A0"/>
  </linearGradient>
  <linearGradient id="oppo-rim" x2=".9" y2="1">
    <stop stop-color="#F3E9EE"/><stop offset=".47" stop-color="#A594A1"/>
    <stop offset=".73" stop-color="#E5D8E0"/><stop offset="1" stop-color="#796D77"/>
  </linearGradient>
  <linearGradient id="oppo-glass" x2="1" y2="1">
    <stop stop-color="#202127"/><stop offset=".58" stop-color="#0C0D11"/><stop offset="1" stop-color="#17171C"/>
  </linearGradient>
  <linearGradient id="oppo-upper" x2="0" y2="1">
    <stop stop-color="#7C272B"/><stop offset=".45" stop-color="#AD4041"/>
    <stop offset=".56" stop-color="#F6EDF0"/><stop offset="1" stop-color="#DED5D9"/>
  </linearGradient>
</defs>
<rect x="70.5" y="13.5" width="99" height="80" rx="17.5" fill="url(#oppo-deck)" stroke="#9B8B98" stroke-width=".85"/>
<rect x="74" y="18" width="65" height="71" rx="18" fill="#584D56" filter="url(#soft)"/>
<rect x="74.4" y="17.3" width="64.2" height="70.8" rx="17.6" fill="url(#oppo-rim)"/>
<rect x="76.4" y="19.5" width="60.2" height="66.3" rx="15.7" fill="url(#oppo-glass)" stroke="#E9DFE5" stroke-width=".5"/>"""
        + lens(93, 38, 8.1, "#24242B", .92)
        + lens(121, 38, 8.1, "#24242B", .92)
        + '<rect x="86.8" y="60.2" width="12.4" height="11.7" rx="2.8" fill="#1D1F25" stroke="#373840" stroke-width=".6"/>'
        + '<rect x="89.2" y="62.1" width="7.6" height="7.9" rx="1.7" fill="url(#glass)"/>'
        + '<rect x="142.8" y="21.3" width="20.6" height="57" rx="10.3" fill="url(#oppo-deck)" stroke="url(#oppo-rim)" stroke-width="1.15"/>'
        + '<circle cx="153.1" cy="34.5" r="5.5" fill="url(#oppo-upper)" stroke="#796C77" stroke-width=".65"/>'
        + '<circle cx="153.1" cy="66.2" r="5.4" fill="url(#flash)" stroke="#90828B" stroke-width=".8"/>'
    )
    return phone("#D2C3CD", "#968794", "#E9DDE5", "#81717D", island, rx=18, diagonal_sheen=False)


def vivo():
    # 银灰背板上部带织纹，圆盘内的四个镜窗围绕中心蓝色铭牌。
    panel = """<defs>
  <linearGradient id="vivo-panel" x2="1" y2=".9">
    <stop stop-color="#D5DCE1"/><stop offset="1" stop-color="#9DA6AF"/>
  </linearGradient>
  <pattern id="vivo-weave" width="2" height="2" patternUnits="userSpaceOnUse">
    <path d="M0 .5h2M.5 0v2" stroke="#FFF" stroke-width=".45" opacity=".47"/>
    <path d="M0 1.5h2M1.5 0v2" stroke="#7A838A" stroke-width=".25" opacity=".3"/>
  </pattern>
</defs>
<rect x="67" y="10" width="106" height="89" fill="url(#vivo-panel)"/>
<rect x="67" y="10" width="106" height="89" fill="url(#vivo-weave)"/>"""
    module = (
        """<defs>
  <linearGradient id="vivo-rim" x2=".86" y2="1">
    <stop stop-color="#F6F9FA"/><stop offset=".37" stop-color="#848D94"/>
    <stop offset=".64" stop-color="#EFF2F3"/><stop offset="1" stop-color="#666C74"/>
  </linearGradient>
  <linearGradient id="vivo-glass" x2=".86" y2="1">
    <stop stop-color="#272B30"/><stop offset=".6" stop-color="#0B0D0F"/><stop offset="1" stop-color="#07080A"/>
  </linearGradient>
</defs>
<circle cx="120" cy="56" r="40.5" fill="#666C74" filter="url(#soft)"/>
<circle cx="120" cy="56" r="40.2" fill="url(#vivo-rim)" stroke="#747D84" stroke-width=".75"/>
<circle cx="120" cy="56" r="37.5" fill="url(#vivo-glass)" stroke="#D6DBDE" stroke-width=".7"/>
<circle cx="136" cy="42" r="9.9" fill="#14191E" stroke="#34383D" stroke-width=".72"/>
<rect x="129.2" y="35.2" width="13.6" height="13.6" rx="4.7" fill="url(#glass)" stroke="#202E39" stroke-width=".65"/>
<circle cx="138.6" cy="43.4" r="1.15" fill="#87BEDF" opacity=".75"/>
<rect x="116.6" y="52.7" width="6.8" height="6.6" rx=".7" fill="#355B9D"/>
<path d="M117.7 54.6h4.5" stroke="#BCD2FF" stroke-width=".7" opacity=".55"/>"""
        + lens(104.1, 42, 9.8, "#2F3339", .87)
        + lens(107, 70.4, 9.8, "#2B3036", .87)
        + lens(133.5, 70.4, 9.8, "#2B3036", .87)
        + flash(80, 23, 4)
    )
    buttons = """
<rect x="65.7" y="48" width="2.8" height="28" rx="1.3" fill="url(#frame)"/>
<rect x="65.7" y="83" width="2.8" height="16" rx="1.3" fill="url(#frame)"/>"""
    return phone(
        "#CCD3DA", "#98A3AE", "#E1E7EC", "#818993", module,
        rx=17, under=panel, side_buttons=buttons, diagonal_sheen=False,
    )


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
    # 白色背板上方的浅银相机岛，左侧双摄共用一片黑色胶囊盖板。
    module = (
        """<defs>
  <linearGradient id="oneplus-plate" x2=".86" y2="1">
    <stop stop-color="#E3E6E2"/><stop offset="1" stop-color="#B4BCB8"/>
  </linearGradient>
  <linearGradient id="oneplus-window" x2=".7" y2="1">
    <stop stop-color="#151A21"/><stop offset=".51" stop-color="#080B10"/><stop offset="1" stop-color="#101820"/>
  </linearGradient>
  <radialGradient id="oneplus-flash" cx=".4" cy=".38" r=".68">
    <stop stop-color="#FBFAF1"/><stop offset=".62" stop-color="#D9E1E0"/><stop offset="1" stop-color="#A5B5B9"/>
  </radialGradient>
</defs>
<rect x="73" y="17.6" width="62.2" height="64.5" rx="17.2" fill="#8F9A96" filter="url(#soft)"/>
<rect x="73.3" y="17.3" width="61.6" height="64.2" rx="17" fill="url(#oneplus-plate)" stroke="#C4CBC7" stroke-width=".75"/>
<rect x="78.2" y="21.7" width="26.1" height="55.3" rx="13.05" fill="url(#oneplus-window)" stroke="#5D6667" stroke-width=".6"/>
<circle cx="118.8" cy="33.6" r="10.65" fill="url(#oneplus-window)" stroke="#66716F" stroke-width=".55"/>
<circle cx="118.8" cy="65.1" r="10.55" fill="url(#oneplus-window)" stroke="#66716F" stroke-width=".55"/>
<circle cx="118.8" cy="65.1" r="4.1" fill="url(#oneplus-flash)"/>"""
        + lens(91.2, 35.8, 7.8, "#282E35", .94)
        + lens(91.2, 63.9, 7.8, "#253136", .94)
        + lens(118.8, 33.6, 8.1, "#252C36", .94)
    )
    return phone("#E1E6E2", "#BCC6C6", "#EEF2EE", "#919DA3", module, rx=17, diagonal_sheen=False)



def redmi():
    # 参考蓝色实机背面：左侧四个黑圆，右侧独立的同色圆形扬声器。
    grille = "".join(
        dot(x, y, 0.55, "#17456F")
        for y in (47, 49, 51, 53, 55)
        for x in range(137 + (y % 4 == 1), 156, 2)
        if (x - 146) ** 2 + (y - 45) ** 2 < 111
    )
    island = (
        '<defs>'
        '<linearGradient id="redmi-island" x2="1" y2="1">'
        '<stop stop-color="#81C7F3"/><stop offset="1" stop-color="#3F86BF"/>'
        '</linearGradient>'
        '<linearGradient id="redmi-speaker" x2="0" y2="1">'
        '<stop stop-color="#92D0F4"/><stop offset="1" stop-color="#579DD3"/>'
        '</linearGradient>'
        '</defs>'
        '<rect x="76" y="17" width="91" height="59" rx="17" fill="#1D537D" filter="url(#soft)"/>'
        '<rect x="76" y="16" width="91" height="57" rx="17" fill="url(#redmi-island)" stroke="#5599CA" stroke-width=".8"/>'
        '<path d="M79 30Q81 18 94 18H147" fill="none" stroke="#A0D7FC" stroke-width=".9" opacity=".69"/>'
        + lens(92, 31, 10.8, "#153247", .9)
        + lens(116, 31, 10.8, "#153247", .9)
        + lens(92, 56, 10.8, "#153247", .9)
        + '<circle cx="116" cy="56.6" r="10.8" fill="#0C2B44" opacity=".42"/>'
        + '<circle cx="116" cy="56" r="10.6" fill="#080D13" stroke="#244A64" stroke-width=".8"/>'
        + '<circle cx="116" cy="56" r="2.3" fill="url(#flash)"/>'
        + '<circle cx="146" cy="45.7" r="13.8" fill="#286695" opacity=".65"/>'
        + '<circle cx="146" cy="45" r="13.1" fill="url(#redmi-speaker)" stroke="#80BCE6" stroke-width=".75"/>'
        + grille
    )
    buttons = (
        f'<rect x="{X - 2}" y="65" width="3.5" height="31" rx="2" fill="url(#frame)"/>'
        f'<rect x="{X - 2}" y="102" width="3.5" height="17" rx="2" fill="url(#frame)"/>'
    )
    return phone("#66AFE4", "#245B95", "#A4DFFF", "#275F94", island, rx=21, side_buttons=buttons)


def iqoo():
    # 珍珠银参考款：背板几何切面，左二右一的三摄和模组外的闪光灯。
    facets = (
        '<defs><linearGradient id="iqoo-facet" x1="0" y1="1" x2="1" y2="0">'
        '<stop stop-color="#DCCDBF"/><stop offset=".58" stop-color="#C6C1BE"/>'
        '<stop offset="1" stop-color="#738990"/>'
        '</linearGradient></defs>'
        '<path d="M66 13H148L165 34Z" fill="#FFF3E0"/>'
        '<path d="M67 18L165 34 113 57Z" fill="url(#iqoo-facet)" opacity=".64"/>'
        '<path d="M67 86L173 52V106L145 119Z" fill="#FFF9EF" opacity=".63"/>'
        '<path d="M67 123L145 119 67 165Z" fill="url(#iqoo-facet)" opacity=".8"/>'
        '<path d="M145 119L126 155 118 230 67 165Z" fill="#FFF5E8" opacity=".75"/>'
        '<path d="M145 119L173 108V151L126 155Z" fill="#E8DACC" opacity=".8"/>'
        '<path d="M126 155L173 151 168 186 118 230Z" fill="#DCCFC3" opacity=".63"/>'
        '<path d="M67 212L168 186 126 233 67 233Z" fill="url(#iqoo-facet)" opacity=".88"/>'
        '<path d="M168 186L174 231H126Z" fill="#BCBEC0" opacity=".83"/>'
        '<path d="M67 123L145 119M67 212L168 186M67 18L165 34" fill="none" stroke="#FFF9EE" stroke-width=".7" opacity=".82"/>'
    )
    module = (
        '<rect x="73" y="20" width="73" height="72" rx="21" fill="#536870" filter="url(#soft)"/>'
        '<rect x="74.2" y="20.5" width="70.6" height="69.6" rx="19.6" fill="#D7D8D4" stroke="#A9B7B9" stroke-width="1.1"/>'
        '<rect x="77" y="23" width="65" height="64.2" rx="17" fill="none" stroke="#697C82" stroke-width="1"/>'
        '<path d="M83 42Q83 28 96 30L132 46Q145 54 134 64L96 83Q83 86 83 73Z" fill="#EEEAE4" stroke="#929B9D" stroke-width=".8"/>'
        + lens(96, 42, 12.1, "#5B6871", .35)
        + lens(96, 71, 12.1, "#5B6871", .35)
        + lens(125, 56.5, 12.1, "#5B6871", .35)
        + dot(116, 29.5, 1.05, "#A95558")
        + flash(156, 25, 3.8)
    )
    return phone("#FFF3E1", "#C8C2BA", "#CBD8DB", "#6E7D84", module, rx=20, under=facets)


def realme():
    # 蓝灰参考款：浅色金属圆盘内，上方双圆镜头，下方有独立的潜望镜面板。
    module = (
        '<defs><linearGradient id="realme-disc" x1="0" y1="0" x2="1" y2="1">'
        '<stop stop-color="#C7DAEF"/><stop offset=".52" stop-color="#9FB7D1"/>'
        '<stop offset="1" stop-color="#718AA7"/>'
        '</linearGradient></defs>'
        '<circle cx="108" cy="51.5" r="35.7" fill="#253A54" filter="url(#soft)"/>'
        '<circle cx="108" cy="51" r="34.5" fill="url(#realme-disc)" stroke="#38506C" stroke-width="1"/>'
        '<circle cx="108" cy="51" r="33.2" fill="none" stroke="#C1D6EB" stroke-width=".7" opacity=".65"/>'
        '<rect x="84.2" y="51.4" width="47.6" height="23.6" rx="4.7" fill="#9CB3CC" stroke="#657C98" stroke-width=".7"/>'
        '<rect x="87" y="54" width="15.8" height="18" rx="2.4" fill="#0B111B"/>'
        '<rect x="90" y="58" width="9.8" height="10" rx="1" fill="url(#glass)" stroke="#2E4056" stroke-width=".7"/>'
        '<path d="M91.7 60.7l2.2-1 .8 1.1-2.1 1.1Z" fill="#A2D0EF" opacity=".72"/>'
        + lens(95.4, 38.5, 10.9, "#1E3448", .64)
        + lens(120.6, 38.5, 10.9, "#1E3448", .64)
        + flash(79.1, 47.2, 2.25) + flash(136.9, 47.2, 2.25)
        + dot(79.1, 55, 2.5, "url(#bezel)") + dot(136.9, 55, 2.5, "url(#bezel)")
        + dot(79.1, 55, 1.25, "#5C6C7D") + dot(136.9, 55, 1.25, "#5C6C7D")
    )
    buttons = (
        f'<rect x="{X - 2}" y="58" width="3.5" height="28" rx="1.6" fill="url(#frame)"/>'
        f'<rect x="{X - 2}" y="95" width="3.5" height="14" rx="1.6" fill="url(#frame)"/>'
    )
    return phone("#7188A3", "#4B607D", "#BBCCE1", "#223B56", module, rx=18, side_buttons=buttons)


def other_phone():
    # 其他手机：中性银灰机身，简单的双摄方形模组，不对应具体品牌
    module = (
        f'<rect x="{X + 9}" y="{Y + 10}" width="52" height="62" rx="16" fill="#C9CCD2" filter="url(#soft)"/>'
        f'<rect x="{X + 9.6}" y="{Y + 10.6}" width="50.8" height="60.8" rx="15.4" fill="none" stroke="url(#frame)" stroke-width="1.4"/>'
        + lens(X + 35, Y + 27, 10) + lens(X + 35, Y + 55, 10) + flash(X + 52, Y + 41, 2.6)
    )
    return phone("#E3E5EA", "#B6BAC2", "#F4F5F7", "#8F939B", module)


def scene(content, extra_defs=""):
    """非手机图标的画布：共用镜头、闪光灯、阴影等定义"""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}" width="{SIZE}" height="{SIZE}">
<defs>
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
    <stop offset="0" stop-color="#fff" stop-opacity=".3"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
  </linearGradient>
  <filter id="shadow" x="-30%" y="-20%" width="160%" height="150%">
    <feDropShadow dx="0" dy="3.5" stdDeviation="3.4" flood-color="#000" flood-opacity=".24"/>
  </filter>
  <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="1.6" stdDeviation="1.6" flood-color="#000" flood-opacity=".28"/>
  </filter>
  {extra_defs}
</defs>
{content}
</svg>"""


def tablet():
    # 平板：深空灰，比例明显宽于手机，左上单摄加闪光灯，铝合金侧边
    defs = (
        '<linearGradient id="slab" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7C8089"/><stop offset="1" stop-color="#454850"/></linearGradient>'
        '<linearGradient id="edge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#D3D6DC"/><stop offset=".5" stop-color="#5E626B"/><stop offset="1" stop-color="#B5B9C1"/></linearGradient>'
    )
    x, y, w, h = 36, 22, 168, 196
    body = (
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="16" fill="url(#slab)" filter="url(#shadow)"/>'
        f'<rect x="{x + 1.4}" y="{y + 1.4}" width="{w - 2.8}" height="{h - 2.8}" rx="14.6" fill="none" stroke="url(#edge)" stroke-width="2.8"/>'
        f'<path d="M{x} {y + 150} L{x + w} {y + 40} L{x + w} {y + 80} L{x} {y + 190}Z" fill="#fff" opacity=".06"/>'
        f'<rect x="{x + 4}" y="{y + 4}" width="{w - 8}" height="34" rx="12" fill="url(#sheen)" opacity=".4"/>'
        f'<rect x="{x + 10}" y="{y + 10}" width="34" height="34" rx="11" fill="#3B3E45" filter="url(#soft)"/>'
        f'<rect x="{x + 10.6}" y="{y + 10.6}" width="32.8" height="32.8" rx="10.4" fill="none" stroke="url(#edge)" stroke-width="1.2"/>'
        + lens(x + 23, y + 23, 8) + flash(x + 36, y + 35, 2.2)
        + f'<rect x="{x + w / 2 - 14}" y="{y + h - 8}" width="28" height="3" rx="1.5" fill="#2E3036" opacity=".7"/>'
    )
    return scene(body, defs)


def accessory():
    # 配件：白色充电头（扁插脚）加编织数据线和 USB-C 接头
    defs = (
        '<linearGradient id="brick" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#D5D9E0"/></linearGradient>'
        '<linearGradient id="pin" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#E8EAEE"/><stop offset=".5" stop-color="#8C9099"/><stop offset="1" stop-color="#D2D5DB"/></linearGradient>'
        '<linearGradient id="cable" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5B8DEF"/><stop offset="1" stop-color="#2F5FC4"/></linearGradient>'
    )
    body = (
        '<rect x="62" y="30" width="9" height="24" rx="2" fill="url(#pin)"/><rect x="99" y="30" width="9" height="24" rx="2" fill="url(#pin)"/>'
        '<rect x="44" y="50" width="82" height="96" rx="20" fill="url(#brick)" filter="url(#shadow)"/>'
        '<rect x="46" y="52" width="78" height="30" rx="16" fill="url(#sheen)" opacity=".7"/>'
        '<rect x="70" y="128" width="30" height="9" rx="4.5" fill="#2A2D33"/><rect x="74" y="131" width="22" height="3" rx="1.5" fill="#5A5E66"/>'
        '<path d="M85 146 C85 196 128 208 150 182 C168 160 150 128 172 112 C184 103 196 108 198 116" fill="none" stroke="url(#cable)" stroke-width="7" stroke-linecap="round"/>'
        '<path d="M85 146 C85 196 128 208 150 182 C168 160 150 128 172 112 C184 103 196 108 198 116" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="2" stroke-dasharray="3 4" stroke-linecap="round"/>'
        '<rect x="186" y="80" width="24" height="40" rx="7" fill="url(#brick)" filter="url(#soft)" transform="rotate(20 198 100)"/>'
        '<rect x="191" y="62" width="14" height="22" rx="4" fill="url(#pin)" transform="rotate(20 198 100)"/>'
        '<rect x="194" y="66" width="8" height="4" rx="2" fill="#3A3D44" transform="rotate(20 198 100)"/>'
    )
    return scene(body, defs)


def audio():
    # 耳机耳麦：雾蓝头戴式耳机，头梁加两只耳罩
    defs = (
        '<linearGradient id="cup" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9CC3E6"/><stop offset="1" stop-color="#4C7FB0"/></linearGradient>'
        '<linearGradient id="pad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3B4656"/><stop offset="1" stop-color="#1D232C"/></linearGradient>'
        '<linearGradient id="band" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#D7E6F3"/><stop offset="1" stop-color="#7EA6CB"/></linearGradient>'
    )
    body = (
        '<path d="M48 128 C48 52 192 52 192 128" fill="none" stroke="url(#band)" stroke-width="14" stroke-linecap="round" filter="url(#soft)"/>'
        '<path d="M58 118 C62 66 178 66 182 118" fill="none" stroke="#2C3440" stroke-width="5" stroke-linecap="round" opacity=".55"/>'
        '<rect x="42" y="112" width="12" height="30" rx="6" fill="url(#bezel)"/><rect x="186" y="112" width="12" height="30" rx="6" fill="url(#bezel)"/>'
        '<rect x="22" y="128" width="54" height="80" rx="26" fill="url(#cup)" filter="url(#shadow)"/>'
        '<rect x="164" y="128" width="54" height="80" rx="26" fill="url(#cup)" filter="url(#shadow)"/>'
        '<rect x="62" y="136" width="18" height="64" rx="9" fill="url(#pad)"/><rect x="160" y="136" width="18" height="64" rx="9" fill="url(#pad)"/>'
        '<rect x="26" y="132" width="40" height="26" rx="13" fill="url(#sheen)" opacity=".8"/><rect x="174" y="132" width="40" height="26" rx="13" fill="url(#sheen)" opacity=".8"/>'
        + dot(36, 190, 2.2, "#E8F1FA")
    )
    return scene(body, defs)


def other_device():
    # 其他设备：笔记本电脑在后，智能手表在前
    defs = (
        '<linearGradient id="lid" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#D9DCE2"/><stop offset="1" stop-color="#9DA2AB"/></linearGradient>'
        '<linearGradient id="screen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2C3F66"/><stop offset=".55" stop-color="#5A4C8E"/><stop offset="1" stop-color="#C36B8B"/></linearGradient>'
        '<linearGradient id="strap" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#F08A5D"/><stop offset="1" stop-color="#D4613A"/></linearGradient>'
    )
    body = (
        '<rect x="22" y="46" width="160" height="104" rx="8" fill="url(#lid)" filter="url(#shadow)"/>'
        '<rect x="29" y="53" width="146" height="90" rx="4" fill="url(#screen)"/>'
        '<path d="M29 120 L120 53 H150 L29 143Z" fill="#fff" opacity=".07"/>'
        '<path d="M8 152 H196 L188 164 Q186 168 180 168 H24 Q18 168 16 164Z" fill="url(#lid)" filter="url(#soft)"/>'
        '<rect x="84" y="152" width="36" height="4" rx="2" fill="#7D828C"/>'
        '<rect x="168" y="96" width="30" height="124" rx="12" fill="url(#strap)"/>'
        '<rect x="152" y="126" width="62" height="70" rx="20" fill="url(#bezel)" filter="url(#shadow)"/>'
        '<rect x="157" y="131" width="52" height="60" rx="16" fill="#0B0D12"/>'
        '<circle cx="183" cy="161" r="18" fill="none" stroke="#3FD39A" stroke-width="4" stroke-dasharray="80 120" transform="rotate(-90 183 161)"/>'
        '<circle cx="183" cy="161" r="11" fill="none" stroke="#5BA8FF" stroke-width="4" stroke-dasharray="44 80" transform="rotate(-90 183 161)"/>'
        '<rect x="214" y="150" width="4" height="14" rx="2" fill="url(#bezel)"/>'
    )
    return scene(body, defs)


BRANDS = {
    "apple": apple,
    "huawei": huawei,
    "xiaomi": xiaomi,
    "honor": honor,
    "oppo": oppo,
    "vivo": vivo,
    "samsung": samsung,
    "oneplus": oneplus,
    "redmi": redmi,
    "iqoo": iqoo,
    "realme": realme,
    "other-phone": other_phone,
    "tablet": tablet,
    "accessory": accessory,
    "audio": audio,
    "other-device": other_device,
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
        print(f"{key:13s} {size / 1024:5.1f} KB" + ("  超过 30KB！" if size > LIMIT else ""))
    if "--sheet" in sys.argv:
        target = Path(tempfile.gettempdir()) / "brand-icons-sheet.png"
        sheet(images, target)
        print("预览图：", target)


if __name__ == "__main__":
    main()
