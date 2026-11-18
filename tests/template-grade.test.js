const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('自定义成色排在选项之后并回显保存的值', () => {
  let component;
  global.Component = definition => { component = definition; };
  require('../miniprogram/components/template-fields/index');
  const instance = {
    data: { custom: {} },
    setData(update) { Object.assign(this.data, update); },
  };
  const grade = { key: 'grade', type: 'select', allowCustom: true, options: ['99新', '8成新'] };
  const observe = component.observers['fields, values'].bind(instance);
  observe([grade], { grade: '99新无划痕' });
  assert.equal(instance.data.customLabels.grade, '自定义：99新无划痕');
  observe([grade], { grade: '99新' });
  assert.equal(instance.data.customLabels.grade, '自定义');
  const markup = fs.readFileSync('miniprogram/components/template-fields/index.wxml', 'utf8');
  assert.ok(markup.indexOf('wx:for="{{item.options}}"') < markup.indexOf('bindtap="chooseCustom"'));
});
