const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROLE_PERMISSIONS } = require('../miniprogram/constants/roles');
const tools = require('../miniprogram/packages/staff/dashboard/tools');
const forRole = role => tools.allowedTools(perm => [].concat(perm).some(p => ROLE_PERMISSIONS[role].includes(p)));
const keys = list => list.map(t => t.key);

test('每个工具都有图标，入口按角色权限过滤', () => {
  const dir = path.join(__dirname, '../miniprogram/packages/staff/dashboard/tools');
  tools.TOOLS.forEach(t => assert.ok(fs.existsSync(path.join(dir, t.key + '.svg')), t.key));
  assert.equal(forRole('boss').length, 14);
  assert.equal(forRole('manager').length, 13);
  assert.deepEqual(keys(forRole('engineer')), ['inventory', 'repair']);
  assert.ok(!keys(forRole('sales')).includes('agentSettle'));
});

test('默认布局：工具不超过 8 个全部常用，超过时放 7 个并留更多', () => {
  const boss = tools.resolveLayout(forRole('boss'), null);
  assert.equal(boss.pinned.length, 7);
  assert.equal(boss.more.length, 7);
  const sales = tools.resolveLayout(forRole('sales'), null);
  assert.equal(sales.pinned.length, 5);
  assert.equal(sales.more.length, 0);
});

test('保存的布局：保持顺序，权限收回的工具被剔除，新开通的进更多', () => {
  const layout = tools.resolveLayout(forRole('sales'), ['share', 'audit', 'scan', 'scan', 'removed-tool']);
  assert.deepEqual(keys(layout.pinned), ['share', 'scan']);
  assert.deepEqual(keys(layout.more), ['inventory', 'consult', 'agentOrders']);
  assert.equal(tools.resolveLayout(forRole('sales'), []).pinned.length, 0);
});

test('拖动换位：位置换算不越界，顺序不丢工具', () => {
  assert.deepEqual(tools.moveKey(['a', 'b', 'c', 'd'], 'a', 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(tools.moveKey(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b']);
  assert.deepEqual(tools.moveKey(['a', 'b', 'c'], 'a', 99), ['b', 'c', 'a']);
  assert.equal(tools.indexAt(1, 1, 10), 5);
  assert.equal(tools.indexAt(-3, -2, 10), 0);
  assert.equal(tools.indexAt(9, 0, 10), 3);
  assert.equal(tools.indexAt(3, 5, 6), 5);
});

test('待办角标按工具汇总，零项不显示，库龄预警不计入，超期维修不重复计数', () => {
  const todos = [
    { key: 'repairOverdue', count: 1 }, { key: 'repairActive', count: 6 }, { key: 'inboundDraft', count: 0 },
    { key: 'customerRequests', count: 120 }, { key: 'ageing', count: 30 }
  ];
  assert.deepEqual(tools.toolBadges(todos), { repair: '6', consult: '99+' });
  assert.deepEqual(keys(tools.pendingTodos(todos)), ['repairOverdue', 'repairActive', 'customerRequests', 'ageing']);
  // 只有超期计数时（如旧服务端未返回维修中），仍按超期显示
  assert.deepEqual(tools.toolBadges([{ key: 'repairOverdue', count: 2 }]), { repair: '2' });
});

test('待办总数：超期维修含在维修中，库龄预警不计入', () => {
  const { total } = require('../miniprogram/utils/dashboard-todos');
  assert.equal(total([
    { key: 'customerRequests', count: 4 }, { key: 'agentApplications', count: 2 }, { key: 'agentEarnings', count: 1 },
    { key: 'loanOverdue', count: 1 }, { key: 'repairOverdue', count: 1 }, { key: 'repairActive', count: 6 },
    { key: 'ageing', count: 30 }
  ]), 14);
  assert.equal(total([{ key: 'repairOverdue', count: 2 }]), 2);
  assert.equal(total([]), 0);
});

test('问候语随时间变化，日期显示星期', () => {
  assert.equal(tools.greeting(9), '早上好');
  assert.equal(tools.greeting(15), '下午好');
  assert.equal(tools.dateText(new Date(2026, 10, 7)), '11月7日 星期六');
});
