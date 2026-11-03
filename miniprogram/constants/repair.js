/** 服务端执行同一状态图；报价授权、顾客确认、收退款另行校验。 */
const TRANSITIONS={pending_check:['checking','cancelled'],checking:['pending_confirm','cancelled'],pending_confirm:['repairing','checking','cancelled'],repairing:['pending_pickup'],pending_pickup:['completed'],completed:[],cancelled:[]};
const PAYMENT_TYPES={receipt:'收款',refund:'退款',expense:'维修费用',expense_refund:'费用退回'};
module.exports={TRANSITIONS,PAYMENT_TYPES};
