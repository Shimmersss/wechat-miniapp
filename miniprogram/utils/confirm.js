/**
 * 敏感操作二次确认（框架文档 十一）：退款、改价、导出、代理收益标记转账、权限变更。
 * 点击操作后再点一次弹窗“确认”即可，不再要求手动输入文字。
 * needReason 的操作以弹窗标题作为原因随请求提交，由服务端写入审计日志。
 * @returns {Promise<{ confirmed: boolean, reason: string }>}
 */
function confirmSensitive({ title = '请确认操作', content = '', needReason = false, confirmText = '确认' } = {}) {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content: needReason ? describe(content) : content,
      confirmText,
      confirmColor: '#1D1D1F',
      success: (res) => resolve(res.confirm ? { confirmed: true, reason: needReason ? title : '' } : { confirmed: false, reason: '' }),
      fail: () => resolve({ confirmed: false, reason: '' })
    });
  });
}

/** 去掉原提示里“填写…”的输入要求，只保留说明；没有说明时提示会记日志 */
function describe(content) {
  const text = String(content || '')
    .split(/[，,。；;]/)
    .map((s) => s.trim())
    .filter((s) => s && !/填写|^如[:：]/.test(s))
    .join('，');
  return text || '确认后将记录到操作日志';
}

module.exports = { confirmSensitive, describe };
