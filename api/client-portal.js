'use strict';
const A=require('./client-auth');
const crypto=require('crypto');
async function audit(pool,user,action,target,detail){await pool.query('INSERT INTO client_audit_log(client_id,action,target,detail,ip) VALUES($1,$2,$3,$4,$5)',[user?.client_id||null,action,target||null,detail||null,A.clientIp(user?._req||{})]);}
function ownerId(req){return req.clientUser?.client_id||null;}
module.exports={A,audit,ownerId};
