/**
 * 敏感操作二次确认（框架文档 十一）：退款、改价、导出、代理收益标记转账、权限变更。
 * 需要原因的操作会弹出可编辑输入框，原因随请求提交，由服务端写入审计日志。
 * @returns {Promise<{ confirmed: boolean, reason: string }>}
 */
function confirmSensitive({ title = '请确认操作', content = '', needReason = false, confirmText = '确认' } = {}) {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content: needReason ? '' : content,
      editable: needReason,
      placeholderText: needReason ? content || '请填写操作原因（将记录在操作日志）' : '',
      confirmText,
      confirmColor: '#1D1D1F',
      success: (res) => {
        if (!res.confirm) return resolve({ confirmed: false, reason: '' });
        const reason = (res.content || '').trim();
        if (needReason && !reason) {
          wx.showToast({ title: '请填写操作原因', icon: 'none' });
          return resolve({ confirmed: false, reason: '' });
        }
        resolve({ confirmed: true, reason });
      },
      fail: () => resolve({ confirmed: false, reason: '' })
    });
  });
}

module.exports = { confirmSensitive };
