/** 将授权报表写入小程序私有目录，再由用户选择保存/分享；不包含令牌。 */
function writeReport(report) {
  return new Promise((resolve, reject) => {
    if (
      !report ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(report.id) ||
      (typeof report.csv !== "string" &&
        !(typeof report.url === "string" && /^https:\/\//.test(report.url)))
    )
      return reject(new Error("报表内容无效"));
    const fs = wx.getFileSystemManager(),
      dir = wx.env.USER_DATA_PATH + "/reports",
      filePath = dir + "/" + report.id + ".csv";
    const write = () => {
      if (typeof report.csv === "string")
        return fs.writeFile({
          filePath,
          data: report.csv,
          encoding: "utf8",
          success: () => resolve(filePath),
          fail: reject,
        });
      wx.downloadFile({
        url: report.url,
        filePath,
        success: (res) =>
          res.statusCode === 200
            ? resolve(filePath)
            : reject(new Error("报表下载失败(" + res.statusCode + ")")),
        fail: reject,
      });
    };
    fs.access({
      path: dir,
      success: write,
      fail: () =>
        fs.mkdir({
          dirPath: dir,
          recursive: true,
          success: write,
          fail: reject,
        }),
    });
  });
}
function shareReport(filePath, fileName) {
  return new Promise((resolve, reject) => {
    if (!wx.shareFileMessage)
      return reject(new Error("当前微信版本不支持文件分享，请升级后重试"));
    wx.shareFileMessage({ filePath, fileName, success: resolve, fail: reject });
  });
}
module.exports = { writeReport, shareReport };
