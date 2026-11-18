const test = require('node:test');
const assert = require('node:assert/strict');

test('维修结单表单渲染后定位并聚焦，不影响补充资料', () => {
  const pageModule = require('../miniprogram/utils/page');
  const createPage = pageModule.createPage;
  let page;
  pageModule.createPage = definition => { page = definition; };
  try {
    require('../miniprogram/packages/staff/repair/detail');
  } finally {
    pageModule.createPage = createPage;
  }
  const scrolls = [];
  global.wx = { pageScrollTo: options => scrolls.push(options) };
  const instance = {
    ...page,
    data: { detail: { canCash: true, canManage: true }, active: true },
    setData(update, done) { Object.assign(this.data, update); done?.(); },
  };
  for (const mode of ['update', 'close']) instance.onOpen({ currentTarget: { dataset: { mode } } });
  assert.deepEqual(scrolls, [{ selector: '#close-editor', offsetTop: -16, duration: 200 }]);
  assert.equal(instance.data.focusAmount, true);
  instance.onAmountBlur();
  assert.equal(instance.data.focusAmount, false);
});
