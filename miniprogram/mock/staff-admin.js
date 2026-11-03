/** 员工与权限 mock：与服务端同规则（老板角色不可改、非老板不能动老板、不能停用自己、改动需原因并记日志）。
 * mock 中角色权限与字段可见性直接改写共享常量，使模拟身份立即按新配置生效（仅开发调试环境）。 */
const {PERM,ROLE_LABELS,ROLE_PERMISSIONS,STAFF_ROLES,SENSITIVE_FIELDS}=require('../constants/roles');
const {isPhone}=require('../utils/validate');
module.exports=function(db,{fail,currentRole,requirePermission,paginate,clone}){
 const staff=db.staff,versions=db.roleVersions=db.roleVersions||{};let seq=0;
 const ALL=Object.values(PERM),FIELDS=Object.keys(SENSITIVE_FIELDS);
 const manager=()=>{requirePermission(PERM.STAFF_MANAGE);if(!STAFF_ROLES.includes(currentRole()))fail(403,'仅员工可操作');};
 const reason=d=>{if(!d.reason||!String(d.reason).trim()||String(d.reason).length>500)fail(400,'请填写调整原因');return String(d.reason).trim();};
 const note=(action,detail,why)=>db.auditLogs.unshift({id:'log_'+Date.now()+'_'+ ++seq,time:new Date().toISOString(),operator:currentRole(),action,detail,reason:why});
 const view=s=>clone({id:s.id,isSelf:s.userId==='mock_'+currentRole(),name:s.name,phone:s.phone,roleKey:s.role,roleLabel:ROLE_LABELS[s.role]||s.role,status:s.status,wechatBound:!!s.wechatBound,lastLoginAt:null,createdAt:s.createdAt||null,version:s.version||1});
 const find=id=>staff.find(s=>s.id===id)||fail(404,'员工不存在');
 const self=s=>s.userId==='mock_'+currentRole();
 const fieldsOf=role=>role==='boss'?FIELDS:FIELDS.filter(k=>SENSITIVE_FIELDS[k].includes(role));
 function roleView(key){return{key,label:ROLE_LABELS[key],permissions:key==='boss'?ALL:ROLE_PERMISSIONS[key].slice(),visibleFields:fieldsOf(key),editable:key!=='boss',staffCount:staff.filter(s=>s.role===key&&s.status==='active').length,version:versions[key]||1};}
 return[
 ['GET','/staff',d=>{manager();let rows=staff.slice();if(d.status)rows=rows.filter(s=>s.status===d.status);if(d.roleKey)rows=rows.filter(s=>s.role===d.roleKey);if(d.keyword)rows=rows.filter(s=>(s.name+s.phone).includes(d.keyword));return paginate(rows.map(view),d);}],
 ['POST','/staff',d=>{manager();const why=reason(d);if(!d.name||!String(d.name).trim())fail(400,'请填写姓名');if(!isPhone(d.phone))fail(400,'请填写11位手机号');if(!STAFF_ROLES.includes(d.roleKey))fail(400,'角色无效');if(d.roleKey==='boss'&&currentRole()!=='boss')fail(403,'仅老板可添加老板账号');if(staff.some(s=>s.phone===d.phone))fail(409,'该手机号已是员工');const s={id:'st_'+Date.now()+'_'+ ++seq,userId:null,name:String(d.name).trim(),phone:d.phone,role:d.roleKey,wechatBound:false,status:'active',version:1,createdAt:new Date().toISOString()};staff.push(s);note('新增员工',s.id,why);return view(s);}],
 ['PATCH','/staff/:id',(d,h,p)=>{manager();const why=reason(d),s=find(p.id);if((s.version||1)!==d.version)fail(409,'员工资料已更新，请刷新');const role=d.roleKey===undefined?s.role:d.roleKey,status=d.status===undefined?s.status:d.status;if(!STAFF_ROLES.includes(role))fail(400,'角色无效');if(!['active','disabled'].includes(status))fail(400,'员工状态无效');if(currentRole()!=='boss'&&(s.role==='boss'||role==='boss'))fail(403,'仅老板可修改老板账号或授予老板角色');if(self(s)&&(role!==s.role||status!=='active'))fail(400,'不能停用或更改自己的角色');if(s.role==='boss'&&s.status==='active'&&(role!=='boss'||status!=='active')&&staff.filter(x=>x.role==='boss'&&x.status==='active').length<=1)fail(409,'至少保留一名在职老板');const changed=status!==s.status;if(d.name!==undefined)s.name=String(d.name).trim();Object.assign(s,{role,status,version:(s.version||1)+1});note(changed?(status==='active'?'恢复员工':'停用员工'):'调整员工资料或角色',s.id,why);return view(s);}],
 ['POST','/staff/:id/unbind',(d,h,p)=>{manager();const why=reason(d),s=find(p.id);if((s.version||1)!==d.version)fail(409,'员工资料已更新，请刷新');if(!s.wechatBound)fail(409,'该员工尚未绑定微信');if(self(s))fail(400,'不能解绑自己的微信');if(s.role==='boss'&&currentRole()!=='boss')fail(403,'仅老板可解绑老板账号');Object.assign(s,{wechatBound:false,userId:null,version:(s.version||1)+1});note('解绑员工微信',s.id,why);return view(s);}],
 ['GET','/roles',()=>{manager();return{list:STAFF_ROLES.map(roleView),canEdit:currentRole()==='boss'};}],
 ['PUT','/roles/:key',(d,h,p)=>{
  manager();if(currentRole()!=='boss')fail(403,'仅老板可调整角色权限');const why=reason(d),key=p.key;if(!STAFF_ROLES.includes(key))fail(404,'角色不存在');if(key==='boss')fail(400,'老板角色固定拥有全部权限，不能编辑');
  if(!Array.isArray(d.permissions)||d.permissions.some(x=>!ALL.includes(x))||!Array.isArray(d.visibleFields)||d.visibleFields.some(x=>!FIELDS.includes(x)))fail(400,'权限点或字段无效');if((versions[key]||1)!==d.version)fail(409,'角色已被他人修改，请刷新');
  ROLE_PERMISSIONS[key].splice(0,ROLE_PERMISSIONS[key].length,...new Set(d.permissions));
  FIELDS.forEach(f=>{const list=SENSITIVE_FIELDS[f],i=list.indexOf(key),on=d.visibleFields.includes(f);if(on&&i<0)list.push(key);if(!on&&i>=0)list.splice(i,1);});
  versions[key]=(versions[key]||1)+1;note('调整角色权限与字段可见性',key,why);return roleView(key);
 }],
 ['GET','/audit-logs/filters',()=>{requirePermission(PERM.AUDIT_VIEW);return{actions:[...new Set(db.auditLogs.map(a=>a.action))],actors:staff.filter(s=>s.userId).map(s=>({id:s.userId,name:s.name}))};}],
 ['GET','/audit-logs',d=>{
  requirePermission(PERM.AUDIT_VIEW);if(!STAFF_ROLES.includes(currentRole()))fail(403,'仅员工可查看');
  let rows=db.auditLogs.map(a=>{const actor=staff.find(s=>s.userId==='mock_'+a.operator);return{id:a.id,action:a.action,objectId:a.detail||'',actorId:actor?actor.userId:'mock_'+a.operator,actorName:actor?actor.name:ROLE_LABELS[a.operator]||a.operator,actorRole:ROLE_LABELS[a.operator]||null,before:null,after:null,reason:a.reason||'',ip:'127.0.0.1',requestId:a.id,createdAt:/^\d{4}-/.test(a.time)?a.time:null,timeText:/^\d{4}-/.test(a.time)?null:a.time};});
  if(d.action)rows=rows.filter(a=>a.action===d.action);if(d.actorId)rows=rows.filter(a=>a.actorId===d.actorId);if(d.objectId)rows=rows.filter(a=>a.objectId===d.objectId);
  for(const k of ['from','to'])if(d[k]&&!/^\d{4}-\d{2}-\d{2}$/.test(d[k]))fail(400,'日期格式无效');
  if(d.from)rows=rows.filter(a=>!a.createdAt||a.createdAt>=new Date(d.from+'T00:00:00+08:00').toISOString());if(d.to)rows=rows.filter(a=>!a.createdAt||Date.parse(a.createdAt)<Date.parse(d.to+'T00:00:00+08:00')+86400000);
  return paginate(rows,d);
 }]
 ];
};
