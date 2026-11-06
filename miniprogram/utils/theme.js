/**
 * 主题管理：浅色 / 深色 / 跟随系统
 *
 * 为什么需要这个模块：小程序的 <page> 无法动态加 class，
 * 所以不能用 `page {}` 上的 CSS 变量做主题切换。
 * 变量改挂在 .theme-root / .theme-dark 上，由 theme-shell 组件包住页面内容。
 * 换主题 = 换容器的类名，页面其余样式一行都不用改。
 *
 * 对外接口：
 *   get()          当前生效的 'light' | 'dark'
 *   getPreference() 用户偏好 'light' | 'dark' | 'retail'
 *   set(pref)      切换，广播 'theme:changed'
 *   toggle()       在 light / dark 之间直接切
 *   onChange(fn)   订阅，返回取消函数
 */
const events = require('./events');

const KEY = 'xm_theme';          // 用户偏好
const DEFAULT = 'light';         // 默认浅色（不再提供「跟随系统」）

/** 用户偏好：light / dark / retail（零售绿） */
const NAMED = ['light', 'dark', 'retail'];

function getPreference() {
  try {
    const v = wx.getStorageSync(KEY);
    // 旧版本存过 'system'，升级后统一回落到浅色，避免出现无法识别的值
    return NAMED.includes(v) ? v : DEFAULT;
  } catch (e) {
    return DEFAULT;
  }
}

/** 解析成实际生效的主题（三者都是显式选择，不再跟随系统） */
function resolve(pref) {
  return NAMED.includes(pref) ? pref : DEFAULT;
}

/** 当前生效主题 */
function get() {
  return resolve(getPreference());
}

/** 供 theme-shell 生成类名 */
function classes(theme) {
  if (theme === 'dark') return 'theme-root theme-dark';
  if (theme === 'retail') return 'theme-root theme-retail';
  return 'theme-root';
}

/**
 * 设置用户偏好。改变时广播，所有已挂载的 theme-shell 会自己重绘。
 * @param {'light'|'dark'|'retail'} pref
 */
function set(pref) {
  const next = NAMED.includes(pref) ? pref : DEFAULT;
  const before = get();
  try {
    wx.setStorageSync(KEY, next);
  } catch (e) {
    // 存储失败不影响本次切换，只是下次启动会回到默认
  }
  const after = get();
  syncNativeChrome(after);
  if (before !== after || next !== getPreference()) {
    events.emit('theme:changed', { theme: after, preference: next });
  }
  return after;
}

/** 在浅色 / 深色之间切换（会写死偏好，不再跟随系统） */
function toggle() {
  return set(get() === 'dark' ? 'light' : 'dark');
}

/** 订阅主题变化，返回取消函数 */
function onChange(fn) {
  return events.on('theme:changed', fn);
}

/**
 * 同步原生外壳的配色：页面底色、导航栏、tabBar。
 * 这几个地方由客户端绘制，吃不到 CSS 变量，只能走 API。
 */
function syncNativeChrome(theme) {
  const dark = theme === 'dark';
  const retail = theme === 'retail';
  const bg = dark ? '#0B0C0F' : retail ? '#F7F8F7' : '#F2F3F5';
  const fg = dark ? '#F5F6F8' : retail ? '#1C2B20' : '#111215';

  try {
    wx.setBackgroundColor({ backgroundColor: bg, backgroundColorTop: bg, backgroundColorBottom: bg });
  } catch (e) { /* 低版本可能不支持 */ }

  try {
    wx.setNavigationBarColor({
      frontColor: dark ? '#ffffff' : '#000000',
      backgroundColor: bg,
      animation: { duration: 0, timingFunc: 'linear' }
    });
  } catch (e) { /* 自定义导航栏的页面会忽略 */ }

  try {
    wx.setTabBarStyle({
      color: dark ? '#828792' : '#9599A1',
      selectedColor: fg,
      backgroundColor: bg,
      borderStyle: dark ? 'black' : 'white'
    });
  } catch (e) { /* 非 tabBar 页会报错，忽略 */ }
}

/** 初始化：同步原生外壳配色。由 app.js 在 onLaunch 调用一次。
 * 三个主题都是用户显式选择，不跟随系统明暗，所以不需要监听 onThemeChange。 */
function init() {
  syncNativeChrome(get());
  return get();
}

module.exports = { get, getPreference, set, toggle, onChange, classes, init, syncNativeChrome };
