/** Newtrition V8.4 hardened authentication. */
const crypto = require('crypto');
const SESSION_DAYS = 7;
const SCRYPT_KEYLEN = 64;
const MIN_PASSWORD = 10;
const MAX_FAILED_ACCOUNT = 8;
const MAX_FAILED_IP = 30;
const WINDOW_MINUTES = 15;
const COOKIE = 'nt_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key  = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${key}`;
}
function verifyPassword(password, stored) {
  try {
    const [scheme, salt, key] = String(stored).split('$');
    if (scheme !== 'scrypt' || !salt || !key) return false;
    const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    const expected = Buffer.from(key, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch { return false; }
}
const DUMMY_PASSWORD_HASH = hashPassword('newtrition-dummy-password-constant');
function passwordProblem(password) {
  if (!password || password.length < MIN_PASSWORD) return `كلمة المرور لازم تكون ${MIN_PASSWORD} حروف على الأقل`;
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return 'كلمة المرور لازم تحتوي على حروف وأرقام';
  return null;
}
const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
async function createSession(pool, clinicianId, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await pool.query(`INSERT INTO session (clinician_id, token_hash, user_agent, ip, expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [clinicianId, sha256(token), (req.headers['user-agent'] || '').slice(0,300), clientIp(req), expires]);
  return {token, expires};
}
async function readSession(pool, token) {
  if (!token) return null;
  const {rows} = await pool.query(`SELECT s.id AS session_id, c.id, c.email, c.full_name, c.role, c.organization_id
    FROM session s JOIN clinician c ON c.id=s.clinician_id
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND c.is_active`, [sha256(token)]);
  return rows[0] || null;
}
async function revokeSession(pool, token) {
  if (token) await pool.query('UPDATE session SET revoked_at=now() WHERE token_hash=$1',[sha256(token)]);
}
async function tooManyFailures(pool, email, ip) {
  const {rows} = await pool.query(`SELECT
    (SELECT count(*)::int FROM login_attempt WHERE lower(email)=lower($1) AND NOT successful AND attempted_at>now()-($3||' minutes')::interval) AS account_n,
    (SELECT count(*)::int FROM login_attempt WHERE ip=$2 AND NOT successful AND attempted_at>now()-($3||' minutes')::interval) AS ip_n`,
    [email, ip, WINDOW_MINUTES]);
  return rows[0].account_n >= MAX_FAILED_ACCOUNT || rows[0].ip_n >= MAX_FAILED_IP;
}
const recordAttempt = (pool, email, ip, ok) => pool.query('INSERT INTO login_attempt (email, ip, successful) VALUES ($1,$2,$3)',[email,ip,ok]);
function clientIp(req){return ((req?.headers?.['x-forwarded-for'])||'').split(',')[0].trim()||req?.socket?.remoteAddress||null;}
function parseCookies(req){const out={};(req.headers.cookie||'').split(';').forEach(part=>{const i=part.indexOf('=');if(i>0){try{out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());}catch{}}});return out;}
function setSessionCookie(res,token,expires){const secure=process.env.NODE_ENV==='production'?'; Secure':'';res.setHeader('Set-Cookie',`${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Expires=${expires.toUTCString()}${secure}`);}
function clearSessionCookie(res){res.setHeader('Set-Cookie',`${COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);}
function attachUser(pool){return async(req,res,next)=>{try{req.cookies=parseCookies(req);req.user=await readSession(pool,req.cookies[COOKIE]);}catch{req.user=null;}next();};}
const requireAuth=(req,res,next)=>req.user?next():res.status(401).json({error:'auth_required'});
const requireRole=(...roles)=>(req,res,next)=>{if(!req.user)return res.status(401).json({error:'auth_required'});if(!roles.includes(req.user.role))return res.status(403).json({error:'forbidden'});next();};
function requireCsrfHeader(req,res,next){if(req.get('X-Requested-With')!=='newtrition')return res.status(403).json({error:'csrf_check_failed'});next();}
const audit=(pool,req,action,target,detail)=>pool.query('INSERT INTO audit_log (clinician_id, action, target, detail, ip) VALUES ($1,$2,$3,$4,$5)',[req.user?.id||null,action,target||null,detail||null,clientIp(req)]);
module.exports={COOKIE,MIN_PASSWORD,DUMMY_PASSWORD_HASH,hashPassword,verifyPassword,passwordProblem,createSession,readSession,revokeSession,tooManyFailures,recordAttempt,clientIp,parseCookies,setSessionCookie,clearSessionCookie,attachUser,requireAuth,requireRole,requireCsrfHeader,audit};
