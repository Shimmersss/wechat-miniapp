/** 咨询/预约在门店确认前仅为意向，不锁价、不锁库存；代理链接下单（order）短时锁库，由门店收银确认成交。实际授权与状态流转由服务端执行。 */
const LABELS={new:'待跟进',contacted:'已联系',confirmed:'已确认预约',completed:'已完成',closed:'已结束',cancelled:'已取消'};
const TRANSITIONS={consult:{new:['contacted','closed','cancelled'],contacted:['closed','cancelled'],closed:[],cancelled:[]},appointment:{new:['confirmed','cancelled'],confirmed:['completed','cancelled'],completed:[],cancelled:[]},order:{new:['contacted','closed','cancelled'],contacted:['closed','cancelled'],closed:[],cancelled:[]}};
const KIND_LABELS={consult:'咨询',appointment:'到店预约',order:'代理下单'};
module.exports={LABELS,KIND_LABELS,TRANSITIONS,ACTIVE:['new','contacted','confirmed'],DEFAULT_SLOTS:['上午（门店确认）','下午（门店确认）','晚间（门店确认）']};
