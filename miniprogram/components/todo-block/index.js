const config = require('../../config/index');

/**
 * 开发占位：列出该页面待实现的功能点（来自框架文档）。
 * 只在开发版显示；某个页面功能完成后直接删除该组件即可。
 */
Component({
  properties: {
    title: { type: String, value: '待实现' },
    items: { type: Array, value: [] }
  },
  data: { visible: config.env === 'develop' }
});
