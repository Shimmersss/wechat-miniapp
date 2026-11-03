const { http } = require('../../utils/request');
module.exports = {
  /** fileId → { fileId, scope, mime?, size?, url }；内部凭证需要员工权限，url 为短期预览地址，可在过期后重新获取。 */
  detail: (id) => http.get(`/files/${encodeURIComponent(id)}`)
};
