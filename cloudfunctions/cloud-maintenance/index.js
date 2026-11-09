const cloud = require("wx-server-sdk");
const { run } = require("./shared/maintenance-runtime");
exports.main = (event) => run(event, cloud.getWXContext());
