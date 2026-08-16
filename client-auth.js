'use strict';
const crypto=require('crypto');
const SESSION_DAYS=7;
const COOKIE='nt_client_session';
const MIN_PASSWORD=10;
const sha256=v=>crypto.createHash('sha256').update(v).digest('hex');
function hashPassword(password){const salt=crypto.randomBytes(16).toString('hex');const key=crypto.scryptSync(password,salt,64).toString('hex');return `scrypt$${salt}$${key}`;}
function verifyPassword(password,stored){try{const [scheme,salt,key]=String(stored).split('$');if(scheme!=='scrypt'||!salt||!key)return false;const c=crypto.scryptSync(password,salt,64);const e=Buffer.from(key,'hex');return c.length===e.length&&crypto.timingSafeEqual(c,e);}catch{return false;}}
function passwordProblem(password){if(!password||password.length<MIN_PASSWORD)return `كلمة المرور لازم تكون ${MIN_PASSWORD} حروف على الأقل`;return null;}
async function createSession(pool,clientAccountId,clientId,req){const token=crypto.randomBytes(32).toString('base64url');const expires=new Date(Date.now()+SESSION_DAYS*864e5);await pool.query(`INSERT INTO client_session(client_account_id,client_id,token_hash,user_agent,ip,expires_at) VALUES($1,$2,$3,$4,$5,$6)`,[clientAccountId,clientId,sha256(token),(req.headers['user-agent']||'').slice(0,300),clientIp(req),expires]);return{token,expires};}
async function readSession(pool,token){if(!token)return null;const {rows}=await pool.query(`SELECT s.id AS session_id, ca.id AS account_id, ca.client_id, ca.email, c.full_name FROM client_session s JOIN client_account ca ON ca.id=s.client_account_id JOIN client c ON c.id=ca.client_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND ca.is_active`,[sha256(token)]);return rows[0]||null;}
async function revokeSession(pool,token){if(token)await pool.query('UPDATE client_session SET revoked_at=now() WHERE token_hash=$1',[sha256(token)]);}
function clientIp(req){return ((req?.headers?.['x-forwarded-for'])||'').split(',')[0].trim()||req?.socket?.remoteAddress||null;}
function parseCookies(req){const out={};(req.headers.cookie||'').split(';').forEach(part=>{const i=part.indexOf('=');if(i>0)out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());});return out;}
function setSessionCookie(res,token,expires){const secure=process.env.NODE_ENV==='production'?'; Secure':'';res.setHeader('Set-Cookie',`${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Expires=${expires.toUTCString()}${secure}`);}
function clearSessionCookie(res){res.setHeader('Set-Cookie',`${COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);}
function attachClient(pool){return async(req,res,next)=>{try{req.clientCookies=parseCookies(req);req.clientUser=await readSession(pool,req.clientCookies[COOKIE]);}catch{req.clientUser=null;}next();};}
const requireClientAuth=(req,res,next)=>req.clientUser?next():res.status(401).json({error:'client_auth_required'});
const csrf=(req,res,next)=>req.get('X-Requested-With')==='newtrition-client'?next():res.status(403).json({error:'csrf_check_failed'});
module.exports={COOKIE,hashPassword,verifyPassword,passwordProblem,createSession,readSession,revokeSession,parseCookies,setSessionCookie,clearSessionCookie,attachClient,requireClientAuth,csrf,clientIp};
