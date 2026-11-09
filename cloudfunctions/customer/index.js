const started = process.hrtime.bigint();
const { createHandler } = require("./shared/gateway");
const { handle } = require("./shared/customer-handler");
const routes = [
  ["GET", "/shop/contact-options", "options"],
  ["POST", "/shop/consults", "consult.create"],
  ["POST", "/shop/appointments", "appointment.create"],
  ["POST", "/shop/orders", "order.create"],
  ["GET", "/shop/requests", "list"],
  ["GET", "/shop/requests/:id", "get"],
  ["PATCH", "/shop/requests/:id/cancel", "cancel"],
  ["GET", "/customer-requests", "staff.list"],
  ["GET", "/customer-requests/:id", "staff.get"],
  ["PATCH", "/customer-requests/:id/status", "staff.status"],
  ["POST", "/visits/batch", "visits"],
];
exports.main = require("./shared/startup-timing")(
  createHandler(
    routes.map(([method, path, action]) => [
      method,
      path,
      (ctx) => handle(action, ctx),
    ]),
  ),
  started,
);
