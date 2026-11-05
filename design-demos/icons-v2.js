/* 夏目数码 · 多彩手绘 SVG 图标库 v2
 * 每个图标 3～5 种颜色、多个结构层次（主体 + 高光 + 配件 + 细节）。
 * 深色描边 + 实色填充，模拟参考图那种「小图标但内容很满」的质感。
 * 注入方式：<script src="../icons-v2.js"></script>
 */
document.write(`<svg width="0" height="0" style="position:absolute;left:-9999px;top:0" aria-hidden="true"><defs>
<linearGradient id="g-warm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFB03A"/><stop offset="1" stop-color="#F5602F"/></linearGradient>
<linearGradient id="g-blue" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7CC8F8"/><stop offset="1" stop-color="#2F7FCB"/></linearGradient>
<linearGradient id="g-green" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#86E0A8"/><stop offset="1" stop-color="#2E9E4F"/></linearGradient>
<linearGradient id="g-purple" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#C4B0FF"/><stop offset="1" stop-color="#7C5CE0"/></linearGradient>
<linearGradient id="g-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFE07A"/><stop offset="1" stop-color="#F5A623"/></linearGradient>
<linearGradient id="g-pink" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFB0C8"/><stop offset="1" stop-color="#E84E7E"/></linearGradient>
<linearGradient id="g-teal" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8FE8DC"/><stop offset="1" stop-color="#2A9E8F"/></linearGradient>
<linearGradient id="g-slate" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#C4CFE0"/><stop offset="1" stop-color="#7A8AA3"/></linearGradient>
</defs>

<!-- ============ 店铺设置：雨棚 + 招牌 + 门店 ============ -->
<symbol id="i-shop" viewBox="0 0 48 48">
  <path d="M6.2 15.4 9.6 7.6a2 2 0 0 1 1.85-1.2h25.1a2 2 0 0 1 1.85 1.2l3.4 7.8z" fill="#F0602F"/>
  <path d="M11.4 15.4l2-8.9h5.3l-1.5 8.9z" fill="#FFD9C6"/>
  <path d="M21 15.4l1-8.9h5.3l-.6 8.9z" fill="#FFD9C6"/>
  <path d="M30.4 15.4l-.6-8.9h5.3l1.7 8.9z" fill="#FFD9C6"/>
  <rect x="7.6" y="17.2" width="32.8" height="5.6" rx="1.8" fill="#FFC94A"/>
  <path d="M8.4 22.8h31.2v14.5a2.8 2.8 0 0 1-2.8 2.8H11.2a2.8 2.8 0 0 1-2.8-2.8z" fill="#F7EAD6"/>
  <rect x="19.6" y="27.4" width="9" height="12.7" rx="1.8" fill="#2FA8A0"/>
  <rect x="21" y="29" width="6.2" height="5" rx="1.1" fill="#8FE8DC"/>
  <circle cx="26.8" cy="34" r="1.05" fill="#FFF6D8"/>
  <rect x="12.2" y="26" width="5.4" height="6" rx="1.3" fill="#FFD24A"/>
  <rect x="30.4" y="26" width="5.4" height="6" rx="1.3" fill="#FFD24A"/>
  <path d="M13 26v6M33 26v6" stroke="#F5A623" stroke-width="1" opacity=".7"/>
</symbol>

<!-- ============ 员工：两个人像 ============ -->
<symbol id="i-users" viewBox="0 0 48 48">
  <circle cx="33.6" cy="17.4" r="6.1" fill="#B9A0FF"/>
  <path d="M25.6 35.2a8.1 8.1 0 0 1 16.1 0 1.9 1.9 0 0 1-1.9 2.1h-12.3a1.9 1.9 0 0 1-1.9-2.1z" fill="#8B6CEA"/>
  <circle cx="33.6" cy="15.6" r="2.1" fill="#FFE0C4"/>
  <circle cx="17.6" cy="16.2" r="7.3" fill="#FFD3AE"/>
  <path d="M16.2 6.4a7.6 7.6 0 0 1 7.4 8.4c-.5 1.1-1.4.3-1.6-.8-.3-1.7-2.6-1.9-4.6-1.9-2.4 0-4.4.6-4.4 2.4 0 .9-.9 1.3-1.3.6a7.6 7.6 0 0 1 4.5-8.7z" fill="#4A3B32"/>
  <path d="M7.4 36.4a10.3 10.3 0 0 1 20.5 0 2 2 0 0 1-2 2.2H9.4a2 2 0 0 1-2-2.2z" fill="#4A9FE8"/>
  <path d="M12.2 30.8c1.9-2.3 8.6-2.4 10.6 0-1.5 1.6-9.1 1.6-10.6 0z" fill="#2F7FCB"/>
  <circle cx="15.2" cy="15.4" r="1.5" fill="#fff" opacity=".55"/>
</symbol>

<!-- ============ 门店：楼宇 + 招牌 + 玻璃幕墙 ============ -->
<symbol id="i-store" viewBox="0 0 48 48">
  <path d="M6.6 15.4 10.4 6.8a2 2 0 0 1 1.9-1.2h23.4a2 2 0 0 1 1.9 1.2l3.8 8.6z" fill="#FF8A4C"/>
  <path d="M12.6 15.4l1.8-9.6h3.2l-1 9.6zM21.4 15.4l.4-9.6h3.2l.2 9.6zM30 15.4l-.8-9.6h3.2l1.6 9.6z" fill="#FFF0D4"/>
  <rect x="7.6" y="17.2" width="32.8" height="23.4" rx="3.2" fill="#F7FBFF"/>
  <rect x="7.6" y="17.2" width="32.8" height="4.4" rx="2" fill="#FFC94A"/>
  <rect x="11.4" y="24.4" width="8.4" height="7.4" rx="1.4" fill="#7CC8F8"/>
  <rect x="28.2" y="24.4" width="8.4" height="7.4" rx="1.4" fill="#7CC8F8"/>
  <rect x="11.4" y="24.4" width="8.4" height="3.2" rx="1.4" fill="#A8DCFF"/>
  <rect x="28.2" y="24.4" width="8.4" height="3.2" rx="1.4" fill="#A8DCFF"/>
  <rect x="20.8" y="24.4" width="6.4" height="16.2" rx="1.6" fill="#3FB8B0"/>
  <circle cx="25.4" cy="32.6" r="1" fill="#FFF6D8"/>
  <rect x="11.4" y="34.4" width="8.4" height="3" rx="1.2" fill="#FFC94A"/>
  <rect x="28.2" y="34.4" width="8.4" height="3" rx="1.2" fill="#FFC94A"/>
</symbol>

<!-- ============ 手机 ============ -->
<symbol id="i-phone" viewBox="0 0 48 48">
  <rect x="11.5" y="4.5" width="25" height="39" rx="5.4" fill="#4A5568"/>
  <rect x="14.4" y="8.4" width="19.2" height="29.4" rx="2.6" fill="#A8DCFF"/>
  <path d="M14.4 8.4h19.2v12.6c-6.4 2.6-12.8 2.6-19.2 0z" fill="#7CC8F8"/>
  <rect x="20" y="6" width="8" height="2.4" rx="1.2" fill="#2E3744"/>
  <circle cx="24" cy="40.8" r="1.9" fill="#8FE8DC"/>
  <rect x="20.8" y="26" width="6.4" height="6.4" rx="1.6" fill="#FFC94A"/>
</symbol>

<!-- ============ 更换手机：手机 + 循环箭头 ============ -->
<symbol id="i-phoneswap" viewBox="0 0 48 48">
  <rect x="8.5" y="10.5" width="16" height="26" rx="4" fill="#4A9FE8"/>
  <rect x="11.2" y="14.4" width="10.6" height="17.4" rx="1.8" fill="#D8EEFF"/>
  <circle cx="16.5" cy="33.4" r="1.3" fill="#fff" opacity=".8"/>
  <g fill="none" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M35.6 16.6a9.6 9.6 0 0 0-6.6-5.4" stroke="#F0602F"/>
    <path d="M31.4 7.2l4.6 3.9-1.7 5.6" stroke="#F0602F"/>
    <path d="M12.4 31.4a9.6 9.6 0 0 0 6.6 5.4" stroke="#3FC8B4"/>
    <path d="M16.6 40.8l-4.6-3.9 1.7-5.6" stroke="#3FC8B4"/>
  </g>
</symbol>

<!-- ============ 分享：纸飞机 ============ -->
<symbol id="i-share" viewBox="0 0 48 48">
  <path d="M40.4 7.4 6.6 21.6a1.4 1.4 0 0 0 .3 2.6l12.9 3.2 3.3 13.1a1.4 1.4 0 0 0 2.6.3z" fill="#4A9FE8"/>
  <path d="M40.4 7.4 19.8 27.4l3.3 13.1z" fill="#2F7FCB"/>
  <path d="M40.4 7.4 19.8 27.4" stroke="#C8E6FF" stroke-width="1.6"/>
  <circle cx="9" cy="38.6" r="2.5" fill="#FFC94A"/>
  <circle cx="16.4" cy="42.6" r="1.6" fill="#FF8A4C" opacity=".85"/>
  <circle cx="6.4" cy="31.4" r="1.5" fill="#8FE8DC" opacity=".9"/>
</symbol>

<!-- ============ 虚拟账户：钱包 + 卡 + 金币 ============ -->
<symbol id="i-wallet" viewBox="0 0 48 48">
  <path d="M12.6 15.4v-2.2a3.4 3.4 0 0 1 3.4-3.4h14" fill="none" stroke="#F5A623" stroke-width="3.6" stroke-linecap="round"/>
  <rect x="5.6" y="14.6" width="36.8" height="24.4" rx="5.8" fill="url(#g-warm)"/>
  <path d="M5.6 20.2h36.8v4.4H5.6z" fill="#F0602F" opacity=".42"/>
  <rect x="27.6" y="22.6" width="14.6" height="10" rx="3.4" fill="#FFF0D4"/>
  <circle cx="35" cy="27.6" r="2.6" fill="#F5A623"/>
  <circle cx="35" cy="27.6" r="1.1" fill="#FFF6D8"/>
  <circle cx="12.4" cy="19.4" r="1.7" fill="#FFE0B8" opacity=".85"/>
</symbol>

<!-- ============ 代理结算：双色循环 + 金币 ============ -->
<symbol id="i-settle" viewBox="0 0 48 48">
  <path d="M11.6 24a12.4 12.4 0 0 1 20.6-9.4" fill="none" stroke="#3FC8B4" stroke-width="4.6" stroke-linecap="round"/>
  <path d="M36.4 24a12.4 12.4 0 0 1-20.6 9.4" fill="none" stroke="#A78BFA" stroke-width="4.6" stroke-linecap="round"/>
  <path d="M33.4 8.4v6.8h-6.8" fill="none" stroke="#2FA89A" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M14.6 39.6v-6.8h6.8" fill="none" stroke="#8B6CEA" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="24" cy="24" r="7.6" fill="#FFF0D4"/>
  <circle cx="24" cy="24" r="6.4" fill="#FFC94A"/>
  <circle cx="24" cy="24" r="6.4" fill="none" stroke="#F5A623" stroke-width="1.4"/>
  <path d="M22.4 21.6h3.2M22.4 26.4h3.2M24 20.4v7.2M22.4 24h4" stroke="#8A5A08" stroke-width="1.4" stroke-linecap="round"/>
</symbol>

<!-- ============ 对账：账簿 + 三色柱 ============ -->
<symbol id="i-ledger" viewBox="0 0 48 48">
  <rect x="8.6" y="7.6" width="30.8" height="32.8" rx="4" fill="#4A9FE8"/>
  <rect x="12.2" y="11.2" width="23.6" height="25.6" rx="2.4" fill="#F7FBFF"/>
  <rect x="8.6" y="7.6" width="5.4" height="32.8" rx="2.6" fill="#2F7FCB"/>
  <rect x="15.4" y="26.4" width="4.6" height="8.4" rx="1.5" fill="#FFC94A"/>
  <rect x="21.8" y="21.6" width="4.6" height="13.2" rx="1.5" fill="#F0602F"/>
  <rect x="28.2" y="16.4" width="4.6" height="18.4" rx="1.5" fill="#3FC8B4"/>
  <path d="M15.4 15.4h12.4" stroke="#C6DDF2" stroke-width="2" stroke-linecap="round"/>
</symbol>

<!-- ============ 闲鱼：鱼 ============ -->
<symbol id="i-fish" viewBox="0 0 48 48">
  <path d="M12.6 24c0-6.4 6.2-11.6 13.8-11.6 5 0 9.4 2.4 11.9 6l5.9-3.9a1.1 1.1 0 0 1 1.7.9v17.2a1.1 1.1 0 0 1-1.7.9l-5.9-3.9c-2.5 3.6-6.9 6-11.9 6-7.6 0-13.8-5.2-13.8-11.6z" fill="#FFC94A"/>
  <path d="M12.6 24c0-6.4 6.2-11.6 13.8-11.6 3.6 0 6.9 1.3 9.3 3.4-6.6 1.4-11.5 4.5-13.6 8.2-2.1 3.7-1.9 7.6.5 10.9-5.9-1.1-10-5.5-10-10.9z" fill="#F5A623"/>
  <circle cx="18.4" cy="20.4" r="2.3" fill="#fff"/>
  <circle cx="19" cy="20.6" r="1.2" fill="#3A2A10"/>
  <path d="M22.6 26.6c1.7 1.5 4.2 1.5 5.9 0" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" opacity=".9"/>
  <circle cx="40.6" cy="14.4" r="2" fill="#7CC8F8"/>
  <circle cx="43.4" cy="9.6" r="1.3" fill="#7CC8F8" opacity=".7"/>
</symbol>

<!-- ============ 转转：双色换向 ============ -->
<symbol id="i-recycle" viewBox="0 0 48 48">
  <path d="M11.4 24a12.6 12.6 0 0 1 20.4-9.5" fill="none" stroke="#E84E7E" stroke-width="4.4" stroke-linecap="round"/>
  <path d="M31.2 8.2v6.6h-6.6" fill="none" stroke="#E84E7E" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M36.6 24a12.6 12.6 0 0 1-20.4 9.5" fill="none" stroke="#4A9FE8" stroke-width="4.4" stroke-linecap="round"/>
  <path d="M16.8 39.8v-6.6h6.6" fill="none" stroke="#4A9FE8" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="24" cy="24" r="3.2" fill="#FFC94A"/>
</symbol>

<!-- ============ 上下游货盘：云 + 货箱 ============ -->
<symbol id="i-cloudbox" viewBox="0 0 48 48">
  <path d="M12.4 24.6a7.8 7.8 0 0 1 .9-15.2 10.4 10.4 0 0 1 19.7 2.6 6.9 6.9 0 0 1 .6 12.6z" fill="#B9C6D8"/>
  <path d="M12.4 24.6a7.8 7.8 0 0 1 .9-15.2 10.4 10.4 0 0 1 6.4-2.6c-3.2 2.6-4.6 6.2-4.2 10 .4 3.8 2.6 6.4 6.6 7.8z" fill="#8FA2BC"/>
  <rect x="15.2" y="26.4" width="18.4" height="12.8" rx="2.8" fill="#FF8A4C"/>
  <path d="M15.2 30.6h18.4" stroke="#F0602F" stroke-width="1.6" opacity=".7"/>
  <rect x="22.2" y="26.4" width="4.4" height="12.8" fill="#FFD9C6" opacity=".9"/>
  <circle cx="38.4" cy="32.4" r="5.4" fill="#3FC8B4"/>
  <path d="M36.2 32.4h4.4M38.4 30.2v4.4" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/>
</symbol>

<!-- ============ 进货渠道：托盘 + 箭头 + 货箱 ============ -->
<symbol id="i-inbox" viewBox="0 0 48 48">
  <path d="M24 6.6v12.8" stroke="#F0602F" stroke-width="4.2" stroke-linecap="round"/>
  <path d="M17.4 13.4 24 20l6.6-6.6" fill="none" stroke="#F0602F" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="14.6" y="23.4" width="18.8" height="9.6" rx="2.2" fill="#FFC94A"/>
  <path d="M14.6 26.6h18.8" stroke="#F5A623" stroke-width="1.5" opacity=".75"/>
  <path d="M7.4 30.4h9.2l2.6 4.4h9.6l2.6-4.4h9.2v8.6a3 3 0 0 1-3 3H10.4a3 3 0 0 1-3-3z" fill="#4A9FE8"/>
  <path d="M7.4 30.4h9.2l2.6 4.4h9.6l2.6-4.4h9.2" fill="none" stroke="#2F7FCB" stroke-width="1.8"/>
</symbol>

<!-- ============ 销售渠道：人 + 价签 ============ -->
<symbol id="i-sale" viewBox="0 0 48 48">
  <circle cx="16.4" cy="15.8" r="6.4" fill="#FFD3AE"/>
  <path d="M15 6.2a6.8 6.8 0 0 1 6.6 7.6c-.5 1-1.3.3-1.5-.7-.3-1.6-2.3-1.8-4.1-1.8-2.1 0-3.9.6-3.9 2.2 0 .8-.8 1.2-1.2.6A6.8 6.8 0 0 1 15 6.2z" fill="#4A3B32"/>
  <path d="M6.4 36a10 10 0 0 1 20 0 1.9 1.9 0 0 1-1.9 2.1H8.3A1.9 1.9 0 0 1 6.4 36z" fill="#4A9FE8"/>
  <path d="M33.4 12.4h9.8a1.6 1.6 0 0 1 1.6 1.6v9.4L34.6 33.6 23.4 22.4l10-10z" fill="#E84E7E"/>
  <circle cx="39.4" cy="17.6" r="2.1" fill="#FFF0D4"/>
  <path d="M27.4 25.4l5.6 5.6" stroke="#C43A66" stroke-width="1.6" opacity=".7"/>
  <circle cx="41.4" cy="30.4" r="4.2" fill="#FFC94A"/>
  <path d="M40.2 28.6h2.4M40.2 32.2h2.4M41.4 28.6v5.2" stroke="#7A4208" stroke-width="1.2" stroke-linecap="round"/>
</symbol>

<!-- ============ 打印机 ============ -->
<symbol id="i-printer" viewBox="0 0 48 48">
  <rect x="12.6" y="5.6" width="22.8" height="11.4" rx="2.4" fill="#DCE9F7"/>
  <path d="M16 8.4h16M16 12h11M16 15.4h14" stroke="#9FB6CE" stroke-width="1.5" stroke-linecap="round"/>
  <rect x="5.6" y="17.2" width="36.8" height="15.4" rx="4" fill="#4A9FE8"/>
  <rect x="5.6" y="17.2" width="36.8" height="5.4" rx="3" fill="#2F7FCB"/>
  <rect x="12.6" y="27.4" width="22.8" height="14.4" rx="2.4" fill="#FFFDF6"/>
  <path d="M17 32.4h11M17 36.4h7.4" stroke="#9FB6CE" stroke-width="1.8" stroke-linecap="round"/>
  <circle cx="35.6" cy="22.4" r="2.2" fill="#86E0A8"/>
  <rect x="36.6" y="32.2" width="9" height="6.6" rx="1.6" fill="#FFC94A"/>
</symbol>

<!-- ============ 打印模板：文档 + 折角 + 印章 ============ -->
<symbol id="i-template" viewBox="0 0 48 48">
  <path d="M10.4 7.4h15.8l11 11v22.2a2.8 2.8 0 0 1-2.8 2.8H10.4a2.8 2.8 0 0 1-2.8-2.8V10.2a2.8 2.8 0 0 1 2.8-2.8z" fill="#F7FBFF"/>
  <path d="M10.4 7.4h15.8l11 11H13.2a2.8 2.8 0 0 1-2.8-2.8z" fill="#4A9FE8"/>
  <path d="M26.2 7.4v8.2a2.8 2.8 0 0 0 2.8 2.8h8.2z" fill="#F5A623"/>
  <path d="M14.6 24h12.6M14.6 29.4h17.2M14.6 34.8h10.4" stroke="#B8CBDF" stroke-width="2.1" stroke-linecap="round"/>
  <circle cx="33.4" cy="36.4" r="5.6" fill="#E84E7E"/>
  <circle cx="33.4" cy="36.4" r="3.8" fill="none" stroke="#fff" stroke-width="1.3" opacity=".8"/>
</symbol>

<!-- ============ 偏好设置：齿轮 ============ -->
<symbol id="i-settings" viewBox="0 0 48 48">
  <g fill="#8FA2BC">
    <rect x="20.4" y="3.2" width="7.2" height="10" rx="2.6"/>
    <rect x="20.4" y="34.8" width="7.2" height="10" rx="2.6"/>
    <rect x="3.2" y="20.4" width="10" height="7.2" rx="2.6"/>
    <rect x="34.8" y="20.4" width="10" height="7.2" rx="2.6"/>
    <rect x="20.4" y="3.2" width="7.2" height="10" rx="2.6" transform="rotate(45 24 24)"/>
    <rect x="20.4" y="3.2" width="7.2" height="10" rx="2.6" transform="rotate(-45 24 24)"/>
    <rect x="20.4" y="34.8" width="7.2" height="10" rx="2.6" transform="rotate(45 24 24)"/>
    <rect x="20.4" y="34.8" width="7.2" height="10" rx="2.6" transform="rotate(-45 24 24)"/>
  </g>
  <circle cx="24" cy="24" r="13.6" fill="url(#g-slate)"/>
  <circle cx="24" cy="24" r="9.6" fill="#A8B7CC"/>
  <circle cx="24" cy="24" r="5.6" fill="#FFC94A"/>
  <circle cx="24" cy="24" r="2.4" fill="#E8A020"/>
  <path d="M17 17.4a9 9 0 0 1 5-3.4" stroke="#fff" stroke-width="1.8" stroke-linecap="round" opacity=".55" fill="none"/>
</symbol>

<!-- ============ 使用教程：灯泡 ============ -->
<symbol id="i-bulb" viewBox="0 0 48 48">
  <g stroke="#FFC94A" stroke-width="2.8" stroke-linecap="round">
    <path d="M24 3v3.8M38.4 8.6l-2.7 2.7M9.6 8.6l2.7 2.7M43 22.4h-3.8M8.8 22.4H5"/>
  </g>
  <circle cx="24" cy="21.6" r="11.4" fill="#FFE066"/>
  <path d="M24 10.2a11.4 11.4 0 0 0-9.6 17.2c1.6-2.4 2.4-5.4 2.4-8.6 0-4.6 2.6-7.8 7.2-8.6z" fill="#FFD24A" opacity=".75"/>
  <path d="M19 31.4h10l-1 3.4a2.4 2.4 0 0 1-2.3 1.7h-3.4a2.4 2.4 0 0 1-2.3-1.7z" fill="#A8B7CC"/>
  <path d="M20.2 38.6h7.6" stroke="#8FA2BC" stroke-width="2.8" stroke-linecap="round"/>
  <path d="M21.8 18.6c0-2.4 1.4-4.2 3.4-4.8" fill="none" stroke="#F5A623" stroke-width="2" stroke-linecap="round"/>
  <ellipse cx="20" cy="17" rx="3" ry="2.1" fill="#fff" opacity=".6" transform="rotate(-25 20 17)"/>
</symbol>

<!-- ============ 客服：耳机 ============ -->
<symbol id="i-headset" viewBox="0 0 48 48">
  <path d="M10.6 27.4v-3a13.4 13.4 0 0 1 26.8 0v3" fill="none" stroke="#4A9FE8" stroke-width="4.6" stroke-linecap="round"/>
  <path d="M10.6 27.4v-3a13.4 13.4 0 0 1 8.4-12.4" fill="none" stroke="#2F7FCB" stroke-width="4.6" stroke-linecap="round"/>
  <rect x="5.2" y="24.2" width="9.8" height="13.4" rx="4.6" fill="#2F7FCB"/>
  <rect x="33" y="24.2" width="9.8" height="13.4" rx="4.6" fill="#2F7FCB"/>
  <rect x="7.2" y="26.6" width="5.8" height="8.6" rx="2.9" fill="#7CC8F8"/>
  <rect x="35" y="26.6" width="5.8" height="8.6" rx="2.9" fill="#7CC8F8"/>
  <path d="M37.9 37.6v2.6a4.4 4.4 0 0 1-4.4 4.4h-5" fill="none" stroke="#F0602F" stroke-width="3" stroke-linecap="round"/>
  <circle cx="25.6" cy="44.6" r="2.5" fill="#F0602F"/>
</symbol>

<!-- ============ 成为代理：多切面钻石 ============ -->
<symbol id="i-diamond" viewBox="0 0 48 48">
  <path d="M14.6 8.6h18.8l7.4 11.2L24 42.4 7.2 19.8z" fill="#7BE0E8"/>
  <path d="M14.6 8.6h9.4L24 19.8H7.2z" fill="#4AB8E8"/>
  <path d="M24 8.6h9.4l7.4 11.2H24z" fill="#A78BFA"/>
  <path d="M7.2 19.8H24l10.8 0L24 42.4z" fill="#5FC9DC"/>
  <path d="M24 19.8 33.4 8.6 40.8 19.8z" fill="#8B6CEA"/>
  <path d="M14.6 8.6 7.2 19.8h16.8z" fill="#3A9FD8"/>
  <path d="M24 19.8 7.2 19.8 24 42.4z" fill="#3FC8B4" opacity=".85"/>
  <path d="M24 19.8 40.8 19.8 24 42.4z" fill="#2FA89A" opacity=".7"/>
  <path d="M14.6 8.6 24 19.8l9.4-11.2" fill="none" stroke="#fff" stroke-width="1.4" opacity=".6"/>
  <path d="M39 5.4l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z" fill="#FFE066"/>
</symbol>

<!-- ============ 需求反馈：信封 ============ -->
<symbol id="i-mail" viewBox="0 0 48 48">
  <rect x="5.6" y="11.4" width="36.8" height="25.2" rx="3.8" fill="#4FBF6A"/>
  <path d="M7.4 13.6 24 26 40.6 13.6v-2.2H7.4z" fill="#86E0A8"/>
  <path d="M7.4 13.6 24 26l16.6-12.4" fill="none" stroke="#2E9E4F" stroke-width="1.4" opacity=".55"/>
  <path d="M5.6 36.6 17.4 26M42.4 36.6 30.6 26" stroke="#2E9E4F" stroke-width="1.6" opacity=".5"/>
  <circle cx="24" cy="26" r="5.2" fill="#FFC94A"/>
  <circle cx="24" cy="26" r="3.4" fill="#F5A623"/>
  <path d="M22.4 24.4h3.2M22.4 27.6h3.2M24 23.4v5.2" stroke="#7A4208" stroke-width="1.2" stroke-linecap="round"/>
</symbol>

<!-- ============ 邀请好友：三色节点网络 ============ -->
<symbol id="i-invite" viewBox="0 0 48 48">
  <path d="M24 24l-9.4-8.6M24 24l9.6-8M24 24v10.6" stroke="#B9C6D8" stroke-width="2.4" stroke-linecap="round"/>
  <circle cx="24" cy="24" r="6.4" fill="#4A9FE8"/>
  <circle cx="24" cy="24" r="3.4" fill="#A8DCFF"/>
  <circle cx="13.6" cy="14.4" r="5.4" fill="#FF8A4C"/>
  <circle cx="34.6" cy="15" r="5" fill="#3FC8B4"/>
  <circle cx="24" cy="36" r="4.6" fill="#A78BFA"/>
  <circle cx="36.4" cy="9.4" r="4.6" fill="#FFC94A" stroke="#fff" stroke-width="1.8"/>
  <path d="M36.4 6.8v5.2M33.8 9.4h5.2" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>
</symbol>

<!-- ============ 抹除数据：垃圾桶 + 星屑 ============ -->
<symbol id="i-trash" viewBox="0 0 48 48">
  <path d="M13 15.4h22l-2 23.4a3.4 3.4 0 0 1-3.4 3.1H18.4a3.4 3.4 0 0 1-3.4-3.1z" fill="#4FBF6A"/>
  <path d="M13 15.4h11.4l1 26.9h-6.9a3.4 3.4 0 0 1-3.4-3.1z" fill="#2E9E4F"/>
  <rect x="9.6" y="9.4" width="28.8" height="6" rx="2.8" fill="#2E9E4F"/>
  <rect x="18.6" y="5.4" width="10.8" height="4.4" rx="2.2" fill="#86E0A8"/>
  <path d="M19.8 21.6v13.8M24 21.6v13.8M28.2 21.6v13.8" stroke="#C8F0D4" stroke-width="2.1" stroke-linecap="round"/>
  <path d="M37.4 8.6l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" fill="#FFE066"/>
  <circle cx="9.4" cy="24.4" r="1.6" fill="#FFC94A"/>
</symbol>

<!-- ============ 库存：立体货箱 ============ -->
<symbol id="i-stock" viewBox="0 0 48 48">
  <path d="M6.6 16 24 6.4 41.4 16v16L24 41.6 6.6 32z" fill="#FF8A4C"/>
  <path d="M6.6 16 24 25.6 41.4 16v16L24 41.6 6.6 32z" fill="#F0602F"/>
  <path d="M6.6 16 24 25.6 41.4 16" fill="none" stroke="#FFD9C6" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="M24 25.6v16" stroke="#FFD9C6" stroke-width="1.8"/>
  <path d="M15.6 11.2 33 20.8v4.6L15.6 15.8z" fill="#FFC94A"/>
  <path d="M9.6 21.6l4.6 2.6v4.4l-4.6-2.6z" fill="#FFF0D4" opacity=".55"/>
</symbol>

<!-- ============ 维修：扳手 + 螺丝刀 ============ -->
<symbol id="i-wrench" viewBox="0 0 48 48">
  <path d="M35.4 5.6a12.4 12.4 0 0 0-15 15.6L5.8 35.8a5.5 5.5 0 0 0 7.8 7.8l14.6-14.6a12.4 12.4 0 0 0 13.6-19.4l-7.2 7.2-5.6-1.4-1.4-5.6z" fill="url(#g-slate)"/>
  <path d="M35.4 5.6a12.4 12.4 0 0 0-15 15.6L5.8 35.8a5.5 5.5 0 0 0 7.8 7.8l3-3-6.4-6.4 15-15-1.4-1.6A12.4 12.4 0 0 1 35.4 5.6z" fill="#7A8AA3"/>
  <circle cx="37" cy="10.4" r="2.8" fill="#E4ECF6" opacity=".8"/>
  <path d="M30.6 17.4 15.4 32.6" stroke="#E4ECF6" stroke-width="1.6" opacity=".6" stroke-linecap="round"/>
  <rect x="28.4" y="34.4" width="4.6" height="12.4" rx="2.2" transform="rotate(-42 30.7 40.6)" fill="#F0602F"/>
  <rect x="32.4" y="29.4" width="6.4" height="6" rx="2" transform="rotate(-42 35.6 32.4)" fill="#FFC94A"/>
</symbol>

<!-- ============ 配件：齿轮 ============ -->
<symbol id="i-parts" viewBox="0 0 48 48">
  <g fill="#FF8A4C">
    <rect x="20.6" y="3" width="6.8" height="42" rx="2.8"/>
    <rect x="3" y="20.6" width="42" height="6.8" rx="2.8"/>
    <rect x="20.6" y="3" width="6.8" height="42" rx="2.8" transform="rotate(45 24 24)"/>
    <rect x="3" y="20.6" width="42" height="6.8" rx="2.8" transform="rotate(45 24 24)"/>
  </g>
  <circle cx="24" cy="24" r="13" fill="#F0602F"/>
  <circle cx="24" cy="24" r="11.4" fill="none" stroke="#FFD9C6" stroke-width="1.8" opacity=".7"/>
  <circle cx="24" cy="24" r="5.6" fill="#4A9FE8"/>
  <circle cx="24" cy="24" r="2.6" fill="#D8EEFF"/>
  <path d="M16 16.6a11 11 0 0 1 6-3.6" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" opacity=".5"/>
</symbol>

<!-- ============ 收银：收银机 ============ -->
<symbol id="i-cash" viewBox="0 0 48 48">
  <rect x="7.6" y="10.6" width="32.8" height="23.8" rx="3.6" fill="#6E7B91"/>
  <rect x="11.4" y="14" width="25.2" height="8.6" rx="2" fill="#9FE8C0"/>
  <path d="M14 17.2h9.6M14 19.8h6.4" stroke="#2E9E4F" stroke-width="1.4" stroke-linecap="round" opacity=".7"/>
  <g fill="#FFF0D4">
    <rect x="11.4" y="25.4" width="5.6" height="5.2" rx="1.4"/>
    <rect x="19" y="25.4" width="5.6" height="5.2" rx="1.4"/>
    <rect x="26.6" y="25.4" width="5.6" height="5.2" rx="1.4"/>
  </g>
  <rect x="34.2" y="25.4" width="2.6" height="5.2" rx="1.2" fill="#FFC94A"/>
  <path d="M7.6 34.4h32.8v4.2a2.6 2.6 0 0 1-2.6 2.6H10.2a2.6 2.6 0 0 1-2.6-2.6z" fill="#FFC94A"/>
  <path d="M15.4 37.6h17.2" stroke="#F5A623" stroke-width="1.8" stroke-linecap="round"/>
</symbol>

<!-- ============ 统计：三色柱 + 折线 ============ -->
<symbol id="i-trend" viewBox="0 0 48 48">
  <rect x="6.6" y="27.4" width="8" height="15" rx="2.4" fill="#7CC8F8"/>
  <rect x="17.4" y="20.4" width="8" height="22" rx="2.4" fill="#4A9FE8"/>
  <rect x="28.2" y="13.4" width="8" height="29" rx="2.4" fill="#2F7FCB"/>
  <path d="M8.6 22.4 19.4 16l10.8 4.4 10-9.6" fill="none" stroke="#F0602F" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="40.2" cy="10.8" r="3.6" fill="#FFC94A"/>
  <circle cx="40.2" cy="10.8" r="1.6" fill="#F5A623"/>
</symbol>

<!-- ============ 文档 ============ -->
<symbol id="i-doc" viewBox="0 0 48 48">
  <path d="M11.4 7h15.4l10.4 10.4v23a2.8 2.8 0 0 1-2.8 2.8H11.4a2.8 2.8 0 0 1-2.8-2.8V9.8A2.8 2.8 0 0 1 11.4 7z" fill="#F7FBFF"/>
  <path d="M11.4 7h15.4l10.4 10.4H14.2A2.8 2.8 0 0 1 11.4 7z" fill="#4A9FE8"/>
  <path d="M26.4 7v7.6a2.8 2.8 0 0 0 2.8 2.8h8z" fill="#FFC94A"/>
  <path d="M14.6 23.6h13M14.6 29h17M14.6 34.4h11" stroke="#B8CBDF" stroke-width="2.2" stroke-linecap="round"/>
  <path d="M14.6 38.6h7" stroke="#3FC8B4" stroke-width="2.2" stroke-linecap="round"/>
</symbol>

<!-- ============ 购物袋 ============ -->
<symbol id="i-cart" viewBox="0 0 48 48">
  <path d="M10.4 16.4h27.2l-2.6 24a3 3 0 0 1-3 2.6H16a3 3 0 0 1-3-2.6z" fill="#FF8A4C"/>
  <path d="M10.4 16.4h13.8v26.6H16a3 3 0 0 1-3-2.6z" fill="#F0602F"/>
  <path d="M17.4 19.4v-6.6a6.6 6.6 0 0 1 13.2 0v6.6" fill="none" stroke="#C98A3A" stroke-width="3.2" stroke-linecap="round"/>
  <circle cx="24" cy="27" r="4.6" fill="#FFE066"/>
  <path d="M22.6 25.2h2.8M22.6 28.8h2.8M24 24v6.4" stroke="#A06A10" stroke-width="1.2" stroke-linecap="round"/>
</symbol>

<!-- ============ 盾牌 ============ -->
<symbol id="i-shield" viewBox="0 0 48 48">
  <path d="M24 4.4 40.4 10v11.6c0 9.6-6.6 16.6-16.4 19.6C14.2 38.2 7.6 31.2 7.6 21.6V10z" fill="#4FBF6A"/>
  <path d="M24 4.4 40.4 10v11.6c0 9.6-6.6 16.6-16.4 19.6z" fill="#2E9E4F"/>
  <path d="M24 4.4 7.6 10v8.6L24 13.2z" fill="#86E0A8" opacity=".7"/>
  <path d="M16.4 23.6 22 29.2l10-10" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
</symbol>

<!-- ============ 订单：夹板 ============ -->
<symbol id="i-order" viewBox="0 0 48 48">
  <rect x="9.4" y="8.6" width="29.2" height="33.8" rx="3.4" fill="#C89A6A"/>
  <rect x="12.6" y="14.6" width="22.8" height="25" rx="2" fill="#FFFDF6"/>
  <rect x="16.4" y="4.4" width="15.2" height="7.6" rx="2.6" fill="#8A6540"/>
  <path d="M18.4 21.4h11.2M18.4 26.4h11.2M18.4 31.4h6.4" stroke="#D4C2AC" stroke-width="2" stroke-linecap="round"/>
  <circle cx="31.4" cy="33.4" r="5.4" fill="#4FBF6A"/>
  <path d="M29 33.6l1.8 1.8 3.2-3.6" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
</symbol>

<!-- ============ 卡车 ============ -->
<symbol id="i-truck" viewBox="0 0 48 48">
  <rect x="3.6" y="13.4" width="23.4" height="16.6" rx="2.4" fill="#4A9FE8"/>
  <rect x="3.6" y="13.4" width="23.4" height="5" rx="2.2" fill="#2F7FCB"/>
  <path d="M27 18.6h8.6l6.8 8.2v7.2H27z" fill="#7CC8F8"/>
  <path d="M29.4 21h5.2l4.4 5.4h-9.6z" fill="#D8EEFF"/>
  <rect x="7.4" y="21.4" width="9.4" height="5.6" rx="1.2" fill="#FFC94A"/>
  <circle cx="13" cy="33.4" r="4.6" fill="#4A5568"/>
  <circle cx="13" cy="33.4" r="2" fill="#A8B7CC"/>
  <circle cx="34.4" cy="33.4" r="4.6" fill="#4A5568"/>
  <circle cx="34.4" cy="33.4" r="2" fill="#A8B7CC"/>
</symbol>

<!-- ============ 礼包 ============ -->
<symbol id="i-gift" viewBox="0 0 48 48">
  <rect x="6.6" y="17.4" width="34.8" height="7.2" rx="2.4" fill="#A78BFA"/>
  <rect x="9.4" y="24.6" width="29.2" height="17.4" rx="2.8" fill="#8B6CEA"/>
  <rect x="20.6" y="17.4" width="6.8" height="24.6" fill="#FFD24A"/>
  <path d="M24 17.4c-4.6-8.4-13.2-7.2-11-2 .8 1.9 5.6 2.2 11 2z" fill="#FF8A4C"/>
  <path d="M24 17.4c4.6-8.4 13.2-7.2 11-2-.8 1.9-5.6 2.2-11 2z" fill="#FFA96B"/>
  <circle cx="24" cy="17.4" r="2.6" fill="#F5A623"/>
</symbol>

<!-- ============ 星星 ============ -->
<symbol id="i-star" viewBox="0 0 48 48">
  <path d="M24 5 30.6 18.2l14.6 2.1-10.6 10.3 2.5 14.6L24 38.4 10.9 45.2l2.5-14.6L2.8 20.3l14.6-2.1z" fill="#FFC94A"/>
  <path d="M24 5 30.6 18.2l14.6 2.1-10.6 10.3L24 38.4z" fill="#F5A623"/>
  <path d="M24 12.6 27.8 21l9 1.3-6 5.8 1.4 8.3-6.2-3.9z" fill="#FFE07A" opacity=".75"/>
</symbol>

<!-- ============ 预警铃铛 ============ -->
<symbol id="i-bell" viewBox="0 0 48 48">
  <path d="M36 20.6a12 12 0 1 0-24 0c0 10.6-4.6 13-4.6 13h33.2S36 31.2 36 20.6z" fill="#FFC94A"/>
  <path d="M36 20.6a12 12 0 0 0-12-12v25h17.2S36 31.2 36 20.6z" fill="#F5A623"/>
  <path d="M12 33.6h24" stroke="#E8A020" stroke-width="1.8" stroke-linecap="round" opacity=".7"/>
  <path d="M20.2 37.6a4.2 4.2 0 0 0 7.6 0z" fill="#E84E7E"/>
  <circle cx="24" cy="6.4" r="3.2" fill="#E84E7E"/>
  <circle cx="24" cy="6.4" r="1.3" fill="#FFB0C8"/>
</symbol>

<!-- ============ 双向箭头 ============ -->
<symbol id="i-swap" viewBox="0 0 48 48">
  <path d="M7.4 17.6h26.2l-7.4-7.4" fill="none" stroke="#3FC8B4" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M40.6 30.4H14.4l7.4 7.4" fill="none" stroke="#4A9FE8" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="24" cy="24" r="3.4" fill="#FFC94A"/>
</symbol>

<!-- ============ 云 ============ -->
<symbol id="i-cloud" viewBox="0 0 48 48">
  <path d="M13.6 36.4a9.4 9.4 0 0 1-1-18.8A12.6 12.6 0 0 1 37.4 20a8.4 8.4 0 0 1-1.4 16.4z" fill="#B9C6D8"/>
  <path d="M13.6 36.4a9.4 9.4 0 0 1-1-18.8 12.6 12.6 0 0 1 7.4-3.2c-3.8 3-5.4 7.4-4.8 12 .6 4.6 3.2 7.8 8 10z" fill="#8FA2BC"/>
  <circle cx="35.4" cy="11" r="5" fill="#7CC8F8"/>
  <path d="M34 8.8a4 4 0 0 1 3.4 1.8" fill="none" stroke="#D8EEFF" stroke-width="1.6" stroke-linecap="round"/>
</symbol>

<!-- ============ 文件夹 ============ -->
<symbol id="i-record" viewBox="0 0 48 48">
  <path d="M4.6 13.4a3 3 0 0 1 3-3h10.2l4.2 5h18.4a3 3 0 0 1 3 3v19.2a3 3 0 0 1-3 3H7.6a3 3 0 0 1-3-3z" fill="#FFC94A"/>
  <path d="M4.6 18.4h38.8v19.2a3 3 0 0 1-3 3H7.6a3 3 0 0 1-3-3z" fill="#FFB03A"/>
  <path d="M11.4 24.4h10.4M11.4 29.4h7" stroke="#FFF0D4" stroke-width="2" stroke-linecap="round" opacity=".85"/>
  <circle cx="34.4" cy="27.4" r="4.4" fill="#F0602F"/>
  <path d="M32.6 27.4h3.6M34.4 25.6v3.6" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>
</symbol>

<!-- ============ 链接网络 ============ -->
<symbol id="i-link" viewBox="0 0 48 48">
  <path d="M14.4 19.4 33.6 10M14.4 28.6l19.2 9.4" stroke="#B9C6D8" stroke-width="2.8" stroke-linecap="round"/>
  <circle cx="10.4" cy="24" r="6.4" fill="#4A9FE8"/>
  <circle cx="10.4" cy="24" r="3" fill="#D8EEFF"/>
  <circle cx="36.6" cy="8.6" r="6.2" fill="#F0602F"/>
  <circle cx="36.6" cy="8.6" r="2.8" fill="#FFD9C6"/>
  <circle cx="36.6" cy="39.4" r="6.2" fill="#3FC8B4"/>
  <circle cx="36.6" cy="39.4" r="2.8" fill="#D8FFF6"/>
</symbol>

<!-- ============ 标签 ============ -->
<symbol id="i-tag" viewBox="0 0 48 48">
  <path d="M9.4 6.6h14.2a2 2 0 0 1 1.4.6l18 18a2 2 0 0 1 0 2.8L28.4 42.6a2 2 0 0 1-2.8 0l-18-18a2 2 0 0 1-.6-1.4V9a2.4 2.4 0 0 1 2.4-2.4z" fill="#F0602F"/>
  <path d="M9.4 6.6h14.2L42.4 25.4 28.4 39.4 9.4 20.4z" fill="#FF8A4C"/>
  <circle cx="17.4" cy="14.6" r="4.2" fill="#FFF0D4"/>
  <circle cx="17.4" cy="14.6" r="1.9" fill="#F5A623"/>
  <path d="M24 22.4 33.4 31.8" stroke="#FFD9C6" stroke-width="1.8" stroke-linecap="round" opacity=".65"/>
</symbol>

<!-- ============ 扫码 ============ -->
<symbol id="i-scan" viewBox="0 0 48 48">
  <g fill="none" stroke-width="3.8" stroke-linecap="round">
    <path d="M7.4 16.4V11a3.6 3.6 0 0 1 3.6-3.6h5.4" stroke="#4A9FE8"/>
    <path d="M31.6 7.4H37a3.6 3.6 0 0 1 3.6 3.6v5.4" stroke="#3FC8B4"/>
    <path d="M40.6 31.6V37a3.6 3.6 0 0 1-3.6 3.6h-5.4" stroke="#FF8A4C"/>
    <path d="M16.4 40.6H11a3.6 3.6 0 0 1-3.6-3.6v-5.4" stroke="#FFC94A"/>
  </g>
  <path d="M8.4 24h31.2" stroke="#E84E7E" stroke-width="3.6" stroke-linecap="round"/>
  <circle cx="24" cy="24" r="2.2" fill="#fff"/>
</symbol>

<!-- ============ 小图形（导航用，单色） ============ -->
<symbol id="i-search" viewBox="0 0 48 48"><circle cx="21" cy="21" r="11.5" fill="none" stroke="currentColor" stroke-width="3.8"/><path d="m30 30 9.5 9.5" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></symbol>
<symbol id="i-chev" viewBox="0 0 48 48"><path d="m18 10 14 14-14 14" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-eye" viewBox="0 0 48 48"><path d="M4 24s7.2-13 20-13 20 13 20 13-7.2 13-20 13S4 24 4 24Z" fill="none" stroke="currentColor" stroke-width="3.2"/><circle cx="24" cy="24" r="5.6" fill="currentColor"/></symbol>
<symbol id="i-plus" viewBox="0 0 48 48"><path d="M24 10v28M10 24h28" stroke="currentColor" stroke-width="5" stroke-linecap="round"/></symbol>
<symbol id="i-logout" viewBox="0 0 48 48"><g fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M29 7.4h6a4 4 0 0 1 4 4v25.2a4 4 0 0 1-4 4h-6"/><path d="M19 33 28 24l-9-9"/><path d="M28 24H7"/></g></symbol>
<symbol id="i-tab-home" viewBox="0 0 48 48"><g fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 21 24 7l17 14"/><path d="M11 18.8V38a3 3 0 0 0 3 3h6.4v-11h7.2v11H34a3 3 0 0 0 3-3V18.8"/></g></symbol>
<symbol id="i-tab-chart" viewBox="0 0 48 48"><g fill="currentColor"><rect x="7" y="26" width="7.4" height="14" rx="2.4"/><rect x="20.3" y="15" width="7.4" height="25" rx="2.4"/><rect x="33.6" y="8" width="7.4" height="32" rx="2.4"/></g></symbol>
<symbol id="i-tab-box" viewBox="0 0 48 48"><g fill="none" stroke="currentColor" stroke-width="3.4" stroke-linejoin="round"><path d="M7 16.5 24 7l17 9.5V33L24 42.5 7 33z"/><path d="M7 16.5 24 26l17-9.5M24 26v16.5"/></g></symbol>
<symbol id="i-tab-my" viewBox="0 0 48 48"><g fill="none" stroke="currentColor" stroke-width="3.8"><circle cx="24" cy="17" r="7.2"/><path d="M11 40.4a13 13 0 0 1 26 0" stroke-linecap="round"/></g></symbol>
<symbol id="i-tab-ledger" viewBox="0 0 48 48"><g fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="6" width="30" height="36" rx="3.4"/><path d="M15.4 16h17.2M15.4 24h17.2M15.4 32h10"/></g></symbol>
<symbol id="i-tab-grid" viewBox="0 0 48 48"><g fill="none" stroke="currentColor" stroke-width="3.4"><rect x="7" y="7" width="14" height="14" rx="3"/><rect x="27" y="7" width="14" height="14" rx="3"/><rect x="7" y="27" width="14" height="14" rx="3"/><rect x="27" y="27" width="14" height="14" rx="3"/></g></symbol>
<symbol id="i-signal" viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1" fill="currentColor"/><rect x="5" y="5.5" width="3" height="6.5" rx="1" fill="currentColor"/><rect x="10" y="3" width="3" height="9" rx="1" fill="currentColor"/><rect x="15" y="0" width="3" height="12" rx="1" fill="currentColor"/></symbol>
<symbol id="i-batt" viewBox="0 0 26 12"><rect x=".7" y=".7" width="21" height="10.6" rx="3.2" fill="none" stroke="currentColor" stroke-width="1" opacity=".4"/><rect x="2.4" y="2.4" width="16.5" height="7.2" rx="1.9" fill="currentColor"/><path d="M23.4 4.3v3.4" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".45"/></symbol>

<!-- ============ 补充：兼容旧引用的别名图标 ============ -->
<symbol id="i-user" viewBox="0 0 48 48">
  <circle cx="24" cy="17.4" r="8.4" fill="#FFD3AE"/>
  <path d="M16.4 9.4a8.6 8.6 0 0 1 15.4 5.4c0 .9-1 1-1.4.2-1.2-2.4-4-3.4-7-3.4-3.4 0-6 1.2-6 3.6 0 .9-.9 1.2-1.3.5a8.6 8.6 0 0 1 .3-6.3z" fill="#4A3B32"/>
  <path d="M9.6 40.6a14.4 14.4 0 0 1 28.8 0 2 2 0 0 1-2 2.2H11.6a2 2 0 0 1-2-2.2z" fill="#4A9FE8"/>
  <circle cx="20.8" cy="16.6" r="1.6" fill="#fff" opacity=".6"/>
</symbol>

<symbol id="i-box" viewBox="0 0 48 48">
  <path d="M6.6 16 24 6.4 41.4 16v16L24 41.6 6.6 32z" fill="#FF8A4C"/>
  <path d="M6.6 16 24 25.6 41.4 16v16L24 41.6 6.6 32z" fill="#F0602F"/>
  <path d="M6.6 16 24 25.6 41.4 16" fill="none" stroke="#FFD9C6" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="M24 25.6v16" stroke="#FFD9C6" stroke-width="1.8"/>
  <path d="M15.6 11.2 33 20.8v4.6L15.6 15.8z" fill="#FFC94A"/>
</symbol>

<symbol id="i-chart" viewBox="0 0 48 48">
  <rect x="6.6" y="27.4" width="8" height="15" rx="2.4" fill="#7CC8F8"/>
  <rect x="17.4" y="20.4" width="8" height="22" rx="2.4" fill="#4A9FE8"/>
  <rect x="28.2" y="13.4" width="8" height="29" rx="2.4" fill="#2F7FCB"/>
  <path d="M8.6 22.4 19.4 16l10.8 4.4 10-9.6" fill="none" stroke="#F0602F" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="40.2" cy="10.8" r="3.6" fill="#FFC94A"/>
</symbol>

<symbol id="i-home" viewBox="0 0 48 48">
  <path d="M7 21 24 7l17 14" fill="none" stroke="#4A9FE8" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M11 18.8V38a3 3 0 0 0 3 3h20a3 3 0 0 0 3-3V18.8" fill="#FFC94A"/>
  <rect x="19.4" y="28.4" width="9.2" height="12.6" rx="1.6" fill="#F0602F"/>
  <circle cx="26.6" cy="34.6" r="1.1" fill="#FFF0D4"/>
  <rect x="13.4" y="25.4" width="4.6" height="5.4" rx="1.2" fill="#7CC8F8"/>
  <rect x="30" y="25.4" width="4.6" height="5.4" rx="1.2" fill="#7CC8F8"/>
</symbol>

<symbol id="i-grid" viewBox="0 0 48 48">
  <rect x="7" y="7" width="14.6" height="14.6" rx="3.4" fill="#4A9FE8"/>
  <rect x="26.4" y="7" width="14.6" height="14.6" rx="3.4" fill="#3FC8B4"/>
  <rect x="7" y="26.4" width="14.6" height="14.6" rx="3.4" fill="#FFC94A"/>
  <rect x="26.4" y="26.4" width="14.6" height="14.6" rx="3.4" fill="#FF8A4C"/>
</symbol>

<symbol id="i-me" viewBox="0 0 48 48">
  <circle cx="24" cy="17" r="7.2" fill="none" stroke="currentColor" stroke-width="3.8"/>
  <path d="M11 40.4a13 13 0 0 1 26 0" fill="none" stroke="currentColor" stroke-width="3.8" stroke-linecap="round"/>
</symbol>

<symbol id="i-list" viewBox="0 0 48 48">
  <rect x="9" y="7" width="30" height="34" rx="3.6" fill="#4A9FE8"/>
  <rect x="13" y="11" width="22" height="26" rx="2.4" fill="#F7FBFF"/>
  <path d="M17 17.6h14M17 23.4h14M17 29.2h8.4" stroke="#9FB6CE" stroke-width="2" stroke-linecap="round"/>
  <circle cx="32.4" cy="32.4" r="6" fill="#FFC94A"/>
  <path d="M29.8 32.4l1.8 1.9 3.1-3.7" fill="none" stroke="#7A4208" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
</symbol>

<symbol id="i-inbound" viewBox="0 0 48 48">
  <path d="M24 6.6v12.8" stroke="#F0602F" stroke-width="4.2" stroke-linecap="round"/>
  <path d="M17.4 13.4 24 20l6.6-6.6" fill="none" stroke="#F0602F" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="14.6" y="23.4" width="18.8" height="9.6" rx="2.2" fill="#FFC94A"/>
  <path d="M7.4 30.4h9.2l2.6 4.4h9.6l2.6-4.4h9.2v8.6a3 3 0 0 1-3 3H10.4a3 3 0 0 1-3-3z" fill="#4A9FE8"/>
</symbol>

<symbol id="i-transfer" viewBox="0 0 48 48">
  <path d="M7.4 17.6h26.2l-7.4-7.4" fill="none" stroke="#3FC8B4" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M40.6 30.4H14.4l7.4 7.4" fill="none" stroke="#F0602F" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/>
</symbol>

<symbol id="i-broom" viewBox="0 0 48 48">
  <path d="M32.6 6.4 42 15.8" stroke="#8A6540" stroke-width="4.6" stroke-linecap="round"/>
  <path d="M30.4 8.6c-2.2 2.2-3 5-2 7.6L16.4 28.2 8.6 39.4l-3-3 8.4-10.6L26.4 13c2.6 1 5.4.2 7.6-2z" fill="#FFC94A"/>
  <path d="M16.4 28.2 8.6 39.4 4.6 35.4l9.8-9.8z" fill="#F0602F"/>
  <path d="M12.4 32.6l3 3M16.6 28.4l3 3" stroke="#FFD9C6" stroke-width="1.8" stroke-linecap="round"/>
</symbol>

<symbol id="i-wifi" viewBox="0 0 16 12">
  <path d="M1 4.2a10.5 10.5 0 0 1 14 0M3.6 7a7 7 0 0 1 8.8 0M6.3 9.6a3.4 3.4 0 0 1 3.4 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
  <circle cx="8" cy="11" r=".9" fill="currentColor"/>
</symbol>
</defs></svg>`);
