/** 门店确认前仅为意向，不锁价、不锁库存。实际授权与状态流转由服务端执行。 */
const LABELS={new:'待跟进',contacted:'已联系',confirmed:'已确认预约',completed:'已完成',closed:'已结束',cancelled:'已取消'};
const TRANSITIONS={consult:{new:['contacted','closed','cancelled'],contacted:['closed','cancelled'],closed:[],cancelled:[]},appointment:{new:['confirmed','cancelled'],confirmed:['completed','cancelled'],completed:[],cancelled:[]}};
module.exports={LABELS,TRANSITIONS,ACTIVE:['new','contacted','confirmed'],DEFAULT_SLOTS:['上午（门店确认）','下午（门店确认）','晚间（门店确认）']};
