#!/usr/bin/env node
/* 塑料回收收发货管理 — 一体化部署服务器（零依赖，仅用 Node 内置模块）
 *
 * 单进程同时提供：
 *  1) 静态前端：在 / 与 /index.html 提供单文件应用 塑料回收收发货管理.html
 *  2) 中央同步 API：/sync/* 多厂区账本（LWW 合并 + 删除墓碑）
 *
 * 这样部署后，打开 http://<服务器>:PORT 即是「带联网功能的完整网站」，
 * 前端会通过同源探测自动把同步服务器指向本机，无需手动配置。
 *
 * 运行：  node app-server.js                 (默认端口 8787，监听 0.0.0.0)
 *        PORT=8080 SYNC_KEY=xxx node app-server.js
 *
 * 接口：
 *  GET  /sync/health                        -> {ok,count}        (无需鉴权，供前端同源探测)
 *  POST /sync/push  {factory, records[], deleted[]}  -> {ok, serverTime}
 *  GET  /sync/pull?since=T                  -> {ok, records[], deleted[]}
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');

const pbkdf2Async = promisify(crypto.pbkdf2);

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
// 默认空密钥 = 免鉴权（适用于同源一体化部署，autoDetectSync 自动连接）。
// 公网多租户部署请务必通过 SYNC_KEY 环境变量设置一个强密钥，并在 App 设置里填同样的密钥。
const SYNC_KEY = process.env.SYNC_KEY || '';
const DATA_FILE = process.env.SYNC_DATA_FILE || path.join(__dirname, 'sync-data.json');
const APP_HTML = path.join(__dirname, 'index.html');
// 备份文件目录（云端备份真实落盘位置），默认与数据文件同级
const BACKUP_DIR = process.env.RF_BACKUP_DIR || path.join(path.dirname(DATA_FILE), 'backups');
// 是否把种子账号的初始明文密码打印到启动日志。默认关闭——Railway 等平台日志对团队成员可见，
// 打印等于明文泄露。需要现场首次登录时，显式设 RF_PRINT_SEED_PW=1 临时打开，登录后改密即关掉。
const PRINT_SEED_PW = process.env.RF_PRINT_SEED_PW === '1';

/* ---------- 安全响应头（全站统一） ----------
   CSP 说明：本应用是单文件内联架构，script/style 必须允许 'unsafe-inline'；
   但仍挡住了外部脚本注入、base 劫持、表单外传、iframe 嵌套与插件对象，属于务实基线。 */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    // 页面仍有 113 处字面量 onclick（参数均为常量，不含用户数据）。
    // CSP 的 'unsafe-inline' 只覆盖 <script> 块、不覆盖事件属性，不显式放行会让这些按钮全部失效。
    "script-src-attr 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    // 保留 http/https/ws：现场可能把同步服务器指向局域网 IP 或另一个域名
    "connect-src 'self' http: https: ws: wss:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ')
};

/* ---------- 状态 ---------- */
let ledger = {};        // id -> record
// 墓碑：{id, ts} 数组（ts=删除发生时间，用于增量 pull）；载入时兼容旧版纯字符串数组
let deleted = [];
let usersById = {};     // username -> user（账号主数据，跨厂区同步）
let customersById = {}; // id -> customer（客户主数据，跨厂区同步）
let deletedUsers = [];  // 已删除账号 {username, ts}（墓碑）
let deletedCustomers = []; // 已删除客户 {id, ts}（墓碑）
let financesById = {};  // id -> finance（财务主数据，跨厂区同步，支持老板全局汇总）
let deletedFinances = []; // 已删除财务 {id, ts}（墓碑）
/* —— 价格主数据 / 产品目录 / 库存校正：服务端权威持久化，使各厂独立定价与库存校正跨重启、跨设备一致 ——
   priceBy：按厂区分桶 {Sagamu:{},OPIC:{},Ikeja:{}}；products：成品种类·颜色总目录；
   priceHist：调价历史；invAdjust/invAdjustRaw/invRawEdit/invPelletEdit：库存校正覆盖。 */
let priceBy = { Sagamu: {}, OPIC: {}, Ikeja: {} };
let products = {};
let priceHist = [];
let invAdjust = {};
let invAdjustRaw = {};
let invRawEdit = {};
let invPelletEdit = {};
/* 库存删除墓碑：kind -> {key: deleteTs}。让"删除库存条目"跨设备生效、且不被合并存储复活
   （被删的键在 push 中 absent，Object.assign 合并不会移除它，必须由墓碑显式剔除）。 */
let invDeleted = { raw:{}, pellet:{} };
/* 汇率（1 CNY = ? NGN）：服务端权威，按 ts 做 LWW。
   此前汇率只存在各设备本地 settings，同一笔账在不同机器上会算出不同金额。 */
let fx = null; // {rate, ts, by, hist:[{rate,ts,by,prev}]}
/* 账号「服务端权威」主数据：username -> {username,name,role,factories,salt,passwordHash,mustChange,updatedTs,deleted}
   所有登录/改密/建号均由服务器落盘，天然跨设备一致（彻底根治党本"换设备登不上/改密不生效"）。
   注意：与 usersById 并存；usersById 保留仅用于旧版业务同步兼容，不参与登录校验。 */
let accounts = {};

/* 墓碑归一化：兼容旧版 ['id1','id2'] 与新版 [{id,ts}] 两种格式，统一为对象数组 */
function normTomb(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(x => (typeof x === 'string' ? { id: x, ts: 0 } : { id: x.id, ts: x.ts || 0 }));
}
try {
  if (fs.existsSync(DATA_FILE)) {
    let raw = fs.readFileSync(DATA_FILE, 'utf8');
    if (raw.startsWith('ENC:')) raw = decryptData(raw.slice(4));
    const d = JSON.parse(raw);
    ledger = d.ledger || {};
    deleted = normTomb(d.deleted);
    usersById = d.usersById || {};
    customersById = d.customersById || {};
    deletedUsers = normTomb(d.deletedUsers);
    deletedCustomers = normTomb(d.deletedCustomers);
    financesById = d.financesById || {};
    deletedFinances = normTomb(d.deletedFinances);
    if (d.accounts && typeof d.accounts === 'object') accounts = d.accounts;
    if (d.priceBy && typeof d.priceBy === 'object') priceBy = d.priceBy;
    if (d.products && typeof d.products === 'object') products = d.products;
    if (Array.isArray(d.priceHist)) priceHist = d.priceHist;
    if (d.invAdjust && typeof d.invAdjust === 'object') invAdjust = d.invAdjust;
    if (d.invAdjustRaw && typeof d.invAdjustRaw === 'object') invAdjustRaw = d.invAdjustRaw;
    if (d.invRawEdit && typeof d.invRawEdit === 'object') invRawEdit = d.invRawEdit;
    if (d.invPelletEdit && typeof d.invPelletEdit === 'object') invPelletEdit = d.invPelletEdit;
    if (d.invDeleted && typeof d.invDeleted === 'object') invDeleted = { raw: (d.invDeleted.raw || {}), pellet: (d.invDeleted.pellet || {}) };
    if (d.fx && typeof d.fx === 'object' && d.fx.rate > 0) fx = { rate: d.fx.rate, ts: d.fx.ts || 0, by: d.fx.by || '', hist: Array.isArray(d.fx.hist) ? d.fx.hist.slice(0, 50) : [] };
    console.log('[sync] 已载入本地账本：%d 条记录，%d 条删除墓碑；账号 %d；客户 %d；财务 %d',
      Object.keys(ledger).length, deleted.length, Object.keys(usersById).length, Object.keys(customersById).length, Object.keys(financesById).length);
  }
} catch (e) { console.warn('[sync] 载入数据失败，重新开始：', e.message); }

/* ---------- 账号种子（仅首次启动写入；运行时仅存哈希） ---------- */
const SEED_ACCOUNTS = [
  { username: 'boss@xf.com',         name: '黄总（老板）', role: 'boss',         factories: ['Sagamu', 'OPIC', 'Ikeja'], pw: '8wN2JCnDhHFc54W^', mustChange: true },
  { username: 'admin.sagamu@xf.com', name: 'Sagamu 管理员', role: 'factoryAdmin', factories: ['Sagamu'], pw: '6YeiMsxBA#gU2PAD', mustChange: true },
  { username: 'admin.opic@xf.com',   name: 'OPIC 管理员',   role: 'factoryAdmin', factories: ['OPIC'],    pw: '&SFb32Y9YTBzhq#L', mustChange: true },
  { username: 'admin.ikeja@xf.com',  name: 'Ikeja 管理员',  role: 'factoryAdmin', factories: ['Ikeja'],   pw: 'G3VW%7kvh!cK4L7r', mustChange: true },
  { username: 'reg.sagamu@xf.com',   name: 'Sagamu 登记员', role: 'registrar',   factories: ['Sagamu'], pw: 'nQH4uiizAJA@Hpn^', mustChange: true },
  { username: 'auditor@xf.com',      name: '审计员',         role: 'auditor',      factories: ['Sagamu', 'OPIC', 'Ikeja'], pw: '8GaqmC3an8sK&3#B', mustChange: true },
  { username: '管理员',              name: '管理员',         role: 'devAdmin',    factories: ['Sagamu', 'OPIC', 'Ikeja'], pw: 'ZsCt##Ps3JmgwFkz', mustChange: true }
];
const PBKDF2_ITER = 60000;
const PW_V2 = '$pbkdf2$';
function genSaltHex() { return crypto.randomBytes(16).toString('hex'); }
/* 同步版：仅用于启动时的种子账号初始化（进程启动阶段无并发，不阻塞请求） */
function hashPasswordSync(pw, saltHex) {
  const d = crypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), Buffer.from(saltHex, 'hex'), PBKDF2_ITER, 32, 'sha256');
  return PW_V2 + PBKDF2_ITER + '$' + saltHex + '$' + d.toString('hex');
}
/* 异步版：登录/建号/改密等在线路径统一使用，避免 PBKDF2 阻塞事件循环被撞库放大成 DoS */
async function hashPassword(pw, saltHex) {
  const d = await pbkdf2Async(Buffer.from(pw, 'utf8'), Buffer.from(saltHex, 'hex'), PBKDF2_ITER, 32, 'sha256');
  return PW_V2 + PBKDF2_ITER + '$' + saltHex + '$' + d.toString('hex');
}
/* 恒定时间比较：避免按响应耗时逐字节试探哈希 */
function safeEqualHex(a, b) {
  try {
    const ba = Buffer.from(String(a || ''), 'hex');
    const bb = Buffer.from(String(b || ''), 'hex');
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch (e) { return false; }
}
async function verifyPassword(pw, saltHex, hashHex) {
  try {
    if (typeof hashHex === 'string' && hashHex.indexOf(PW_V2) === 0) {
      const p = hashHex.split('$');
      const iter = parseInt(p[2], 10) || PBKDF2_ITER;
      const d = await pbkdf2Async(Buffer.from(pw, 'utf8'), Buffer.from(p[3], 'hex'), iter, 32, 'sha256');
      return safeEqualHex(d.toString('hex'), p[4]);
    }
  } catch (e) {}
  return false;
}
function passwordStrong(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return false;
  if (!/[a-zA-Z]/.test(pw)) return false;
  if (!/[0-9]/.test(pw)) return false;
  return true;
}
/* 首次启动若磁盘无账号，写入种子账号（注意：业务 ledger 为空但有账号不视为 firstRun 冲突） */
function seedAccountsIfEmpty() {
  if (Object.keys(accounts).length > 0) return;
  // 生产部署请通过 SEED_PW 指定自己的初始口令；未设置时才回退到内置的默认口令。
  // 设了 SEED_PW 后日志不会打印任何明文密码，避免 Railway 日志面板泄露凭据。
  const envPw = (process.env.SEED_PW || '').trim();
  SEED_ACCOUNTS.forEach(a => {
    const salt = genSaltHex();
    accounts[a.username] = {
      username: a.username, name: a.name, role: a.role, factories: a.factories.slice(),
      salt, passwordHash: hashPasswordSync(envPw || a.pw, salt), mustChange: !!a.mustChange, updatedTs: Date.now(), deleted: false
    };
  });
  console.log('[auth] 首次启动：已初始化 %d 个默认账号（均为 mustChange，首次登录强制改密）', SEED_ACCOUNTS.length);
  if (envPw) {
    console.log('[auth] 初始口令来自环境变量 SEED_PW（日志不打印明文）');
  } else if (PRINT_SEED_PW) {
    console.warn('[auth][WARN] 正在把内置初始口令打印到日志——任何能看日志的人都能登录。请立即改密并移除 RF_PRINT_SEED_PW=1');
    SEED_ACCOUNTS.forEach(a => console.warn('       ' + a.username + '  [' + a.role + ']  初始密码: ' + a.pw));
  } else {
    console.warn('[auth] 未设 SEED_PW 且未开 RF_PRINT_SEED_PW：使用内置默认口令。');
    console.warn('[auth] 如需查看明文口令请临时设 RF_PRINT_SEED_PW=1；强烈建议改为设 SEED_PW 指定自己的口令。');
  }
  persist();
}
/* 对外返回账号（登录/me 带 verifier 供离线缓存；列表不带密码） */
function publicUser(a, withVerifier) {
  const o = { username: a.username, name: a.name, role: a.role, factories: a.factories.slice(), mustChange: !!a.mustChange };
  if (withVerifier) o.verifier = a.salt + '$' + a.passwordHash;
  return o;
}

let saveTimer = null;
let lastPersistError = null; // 最近一次落盘失败信息（由 /sync/health 上报，便于监控发现静默丢数据）
let persistFailures = 0;     // 连续失败次数
/* 落盘脱敏：配置了 SYNC_KEY 时，用 AES-256-GCM（密钥由 SYNC_KEY 派生）加密磁盘文件，
   避免明文 JSON（含账号密码哈希）意外泄露；未配置密钥则明文存储并提示风险。 */
function deriveKey() {
  if (!SYNC_KEY) return null;
  return crypto.scryptSync(SYNC_KEY, 'recycleflow-sync-v1', 32);
}
function encryptData(plain) {
  const key = deriveKey();
  if (!key) return { enc: false, data: plain };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc: true, data: iv.toString('base64') + ':' + tag.toString('base64') + ':' + enc.toString('base64') };
}
function decryptData(str) {
  const key = deriveKey();
  if (!key) return str;
  const parts = str.split(':');
  if (parts.length !== 3) return str; // 非加密内容（或旧明文）
  try {
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const enc = Buffer.from(parts[2], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (e) { return str; }
}
/* 单次落盘：先写临时文件再原子 rename，避免进程崩溃/断电时损坏数据文件 */
function writeOnce(payload, done) {
  const tmp = DATA_FILE + '.tmp.' + process.pid;
  fs.writeFile(tmp, payload, (err) => {
    if (err) { try { fs.unlinkSync(tmp); } catch (e) {} return done(err); }
    fs.rename(tmp, DATA_FILE, (e2) => {
      if (e2) { try { fs.unlinkSync(tmp); } catch (e) {} return done(e2); }
      done(null);
    });
  });
}
const PERSIST_MAX_ATTEMPTS = 3;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const plain = JSON.stringify({ ledger, deleted, usersById, customersById, deletedUsers, deletedCustomers, financesById, deletedFinances, fx, accounts, priceBy, products, priceHist, invAdjust, invAdjustRaw, invRawEdit, invPelletEdit, invDeleted }, null, 0);
    const packed = encryptData(plain);
    const payload = packed.enc ? ('ENC:' + packed.data) : plain;
    /* 落盘失败必须重试并留痕：只 console.warn 一次会造成「业务显示成功、重启后数据没了」的静默丢失 */
    const attempt = (n) => {
      writeOnce(payload, (err) => {
        if (!err) {
          if (persistFailures) console.warn('[sync] 落盘已恢复（此前连续失败 %d 次）', persistFailures);
          persistFailures = 0; lastPersistError = null;
          return;
        }
        persistFailures++;
        lastPersistError = err.message;
        console.error('[sync] 落盘失败（第 %d/%d 次）：%s', n, PERSIST_MAX_ATTEMPTS, err.message);
        if (n < PERSIST_MAX_ATTEMPTS) setTimeout(() => attempt(n + 1), 200 * Math.pow(2, n - 1));
        else console.error('[sync][严重] 连续 %d 次落盘失败，内存中的数据有丢失风险，请检查磁盘权限/空间：%s', PERSIST_MAX_ATTEMPTS, err.message);
      });
    };
    attempt(1);
  }, 300);
}

/* ---------- 工具 ---------- */
/* CORS 限源：仅允许与服务器同 Host 的来源（即由本服务器托管的页面），
   阻断任意第三方网站跨站读取/写入同步数据；可用 SYNC_CORS_ORIGIN 显式放行额外源。 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  let o; try { o = new URL(origin); } catch (e) { return null; }
  if (o.protocol !== 'http:' && o.protocol !== 'https:') return null;
  const hostHdr = (req.headers.host || '').toLowerCase();
  const oHost = o.host.toLowerCase();
  if (oHost && hostHdr && oHost === hostHdr) return origin;
  const list = (process.env.SYNC_CORS_ORIGIN || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (list.includes(origin.toLowerCase()) || list.includes(oHost)) return origin;
  return null;
}
function sendJSON(res, code, obj, req) {
  const origin = req ? originAllowed(req) : null;
  const body = JSON.stringify(obj);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin',
    'Cache-Control': 'no-store' // 禁止缓存同步 API 响应，避免 /sync/pull 返回陈旧数据导致"清缓存前数据不同步"
  };
  // 同源/白名单来源才回显；否则置 'null' 由浏览器拒绝跨站访问
  headers['Access-Control-Allow-Origin'] = origin || 'null';
  headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Api-Key, Authorization';
  headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
  Object.assign(headers, SECURITY_HEADERS);
  res.writeHead(code, headers);
  res.end(body);
}
/* 同步写接口鉴权（/sync/push、/sync/pull）
   两条放行路径，命中其一即可：
   1) 配置了 SYNC_KEY → 请求头 X-Api-Key 必须完全匹配（公网/跨机多厂区部署的正确姿势）。
   2) 未配置 SYNC_KEY → 只放行同源请求（带 Origin 且与 Host 一致）。
      为什么必须加这条：CORS 只约束浏览器，curl/脚本直接打接口照样能读写账本。
      加上同源校验后，无 Origin 或 Origin 与 Host 不符的直连请求一律拒绝，
      而浏览器从本站页面发起的 fetch POST 会带同源 Origin，零配置体验不受影响。
   逃生开关：极少数代理会剥离 Origin 头导致误拒，此时设 RF_ALLOW_NO_ORIGIN=1 回退旧行为
   （并强烈建议同时配置 SYNC_KEY，别让账本裸奔）。 */
function authOk(req) {
  const originOk = originAllowed(req);
  if (SYNC_KEY) {
    const k = req.headers['x-api-key'];
    // 命中正确密钥：跨机/跨域可信客户端放行
    if (typeof k === 'string' && k === SYNC_KEY) return true;
    // 同源第一方页面（由本服务器托管 index.html）同样放行：SYNC_KEY 只挡「跨域脚本/curl 裸奔」，
    // 同源浏览器请求本就受 CORS + Origin 约束，放行不会扩大暴露面，反而让免密同源同步可用。
    if (originOk) return true;
    return false;
  }
  if (process.env.RF_ALLOW_NO_ORIGIN === '1') return true;
  return !!originOk;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 32 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml' };
/* 静态路由只服务前端资源，绝不托管数据文件。
   否则 GET /sync-data.json 会把整份账本（含全部账号的密码哈希、客户资料、财务记录）
   直接下载走——此前这正是可行的，属于最严重的一处信息泄露。
   .json 只允许通过 /api/backup/<name> 专用接口下载（带登录态 + 归属校验）。 */
/* 不放行 .js：前端是单文件内联 HTML，根目录不该有任何前端脚本，
   白名单里留 .js 只会把 app-server.js 这类后端源码挂出去给人读。
   若将来确需前端脚本，请放到 assets/ 子目录并在白名单里单独放开。 */
const STATIC_EXT_OK = { '.html': 1, '.htm': 1, '.css': 1, '.ico': 1, '.png': 1, '.svg': 1, '.jpg': 1, '.jpeg': 1, '.webp': 1, '.woff2': 1 };
/* 无论扩展名，这些文件名一律不对外服务（数据与配置本体） */
const STATIC_DENY_NAMES = { 'sync-data.json': 1, 'package.json': 1, 'package-lock.json': 1, 'railway.json': 1, '.env': 1, '.gitignore': 1 };

/* ---------- 合并逻辑（LWW：ts 大者胜；相同则 rev 大者胜） ----------
   墓碑优先：一旦 id 进入 deleted（含老板/开发管理员删除），任何后续推送都
   不得将其复活——这是修复「老板删除后被同步复原」的关键。 */
function mergeRecord(rec) {
  if (!rec || rec.id == null) return;
  // 墓碑中的记录永不复活；deleted 为 {id,ts} 对象数组，必须用 some 匹配（早先用 indexOf 对对象数组恒为 -1，导致删除被同步复活）
  if (deleted.some(t => t.id === rec.id)) return;
  rec._srv = Date.now(); // 服务端接收时间戳：增量拉取基线（与 serverTime 同钟，避免客户端时钟偏差导致漏拉）
  const cur = ledger[rec.id];
  const ts = rec.ts || 0, rev = rec.rev || 0;
  const cts = cur ? (cur.ts || 0) : -1, crev = cur ? (cur.rev || 0) : -1;
  if (!cur || ts > cts || (ts === cts && rev > crev)) {
    ledger[rec.id] = rec;
  }
}
/* 账号合并：按 username 做 LWW（updatedTs 大者胜），使新账号可在任意设备登录 */
function mergeUser(u) {
  if (!u || u.username == null) return;
  if (deletedUsers.some(t => t.id === u.username)) return;
  u._srv = Date.now();
  const cur = usersById[u.username];
  if (!cur || (u.updatedTs || 0) > (cur.updatedTs || 0)) usersById[u.username] = u;
}
/* 客户合并：按 id 做 LWW（updatedTs 大者胜），使分厂客户可在老板账号查看 */
function mergeCustomer(c) {
  if (!c || c.id == null) return;
  if (deletedCustomers.some(t => t.id === c.id)) return;
  c._srv = Date.now();
  const cur = customersById[c.id];
  if (!cur || (c.updatedTs || 0) > (cur.updatedTs || 0)) customersById[c.id] = c;
}
/* 财务合并：按 id 做 LWW（ts 大者胜），使三厂财务可在老板账号全局汇总 */
function mergeFinance(f) {
  if (!f || f.id == null) return;
  if (deletedFinances.some(t => t.id === f.id)) return;
  f._srv = Date.now();
  const cur = financesById[f.id];
  if (!cur || (f.ts || 0) > (cur.ts || 0)) financesById[f.id] = f;
}
/* 库存合并（带删除墓碑拦截）：等价于 Object.assign 的"加/覆盖"，但跳过已被 invDeleted 标记删除的键，
   确保某设备在被删后、尚未拉取墓碑前再次 push 旧键时，服务端不会将其复活。 */
function mergeInv(target, src, kind) {
  if (!src || typeof src !== 'object') return;
  Object.keys(src).forEach(function (k) {
    if (invDeleted[kind] && (invDeleted[kind][k] || 0) > 0) return;
    target[k] = src[k];
  });
}

/* ---------- 登录限流（内存滑动窗口） ----------
   不限流的登录接口 = 敞开撞库；PBKDF2 又是 CPU 密集型，并发撞库会直接拖垮单进程事件循环。
   按「IP + 用户名」计数：5 分钟内 10 次失败即锁定 15 分钟。 */
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginAttempts = new Map(); // key -> {hits:[ts], lockedUntil}
function clientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function loginGate(key) {
  const now = Date.now();
  const rec = loginAttempts.get(key) || { hits: [], lockedUntil: 0 };
  if (rec.lockedUntil > now) return { ok: false, retryAfter: Math.ceil((rec.lockedUntil - now) / 1000) };
  rec.hits = rec.hits.filter(t => now - t < LOGIN_WINDOW_MS);
  if (rec.hits.length >= LOGIN_MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOGIN_LOCK_MS;
    rec.hits = [];
    loginAttempts.set(key, rec);
    console.warn('[auth] 登录失败过多，已锁定 15 分钟：%s', key);
    return { ok: false, retryAfter: Math.ceil(LOGIN_LOCK_MS / 1000) };
  }
  rec.hits.push(now);
  loginAttempts.set(key, rec);
  return { ok: true };
}
function loginClear(key) { loginAttempts.delete(key); }
/* 定期清理过期条目，避免 Map 只增不减 */
const loginGcTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginAttempts) {
    const expired = (v.lockedUntil && v.lockedUntil < now) || !v.hits.some(t => now - t < LOGIN_WINDOW_MS);
    if (expired) loginAttempts.delete(k);
  }
}, 60 * 60 * 1000);
if (typeof loginGcTimer.unref === 'function') loginGcTimer.unref();

/* ---------- 账号权威：Token 与鉴权 ---------- */
const tokens = {}; // token -> {username, exp}
function issueToken(username) {
  const t = crypto.randomBytes(24).toString('hex');
  tokens[t] = { username, exp: Date.now() + 12 * 3600 * 1000 };
  return t;
}
function authUser(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return null;
  const info = tokens[m[1]];
  if (!info || info.exp < Date.now()) { delete tokens[m[1]]; return null; }
  return accounts[info.username] && !accounts[info.username].deleted ? accounts[info.username] : null;
}
/* 角色权限（最小集，仅用于后端接口保护；前端 RBAC 仍以前端 ROLE_PERMS 为准） */
const ROLE_PERMS = {
  boss: ['account.manage'], devAdmin: ['account.manage'],
  factoryAdmin: ['account.manage'], registrar: [], auditor: []
};
function can(role, perm) { return (ROLE_PERMS[role] || []).includes(perm); }

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // CORS 预检
  if (req.method === 'OPTIONS') { sendJSON(res, 204, {}, req); return; }

  // 健康检查（无需鉴权，供前端同源探测自动启用同步）
  if (p === '/sync/health' && req.method === 'GET') {
    // 不暴露账号规模；persistOk 便于运维/监控发现「落盘失败但服务还活着」的静默丢数据状态
    sendJSON(res, 200, { ok: true, count: Object.keys(ledger).length, key: !!SYNC_KEY, persistOk: !lastPersistError }, req);
    return;
  }

  /* ================= 账号「服务端权威」API ================= */
  // 登录（服务器校验，天然跨设备一致）
  if (p === '/api/login' && req.method === 'POST') {
    let b; try { b = await readBody(req); } catch (e) { sendJSON(res, 400, { ok: false, error: 'bad json' }, req); return; }
    const uname = (b.username || '').trim();
    // 先过限流再校验凭据：账号不存在也计数，避免被拿来枚举用户名
    const gate = loginGate(clientIp(req) + '|' + uname);
    if (!gate.ok) { sendJSON(res, 429, { ok: false, error: 'rate_limited', retryAfter: gate.retryAfter }, req); return; }
    const u = accounts[uname];
    if (!u || u.deleted) { sendJSON(res, 401, { ok: false, error: 'bad_credentials' }, req); return; }
    if (!(await verifyPassword(b.password || '', u.salt, u.passwordHash))) { sendJSON(res, 401, { ok: false, error: 'bad_credentials' }, req); return; }
    loginClear(clientIp(req) + '|' + uname);
    const token = issueToken(u.username);
    sendJSON(res, 200, { ok: true, token, user: publicUser(u, true) }, req);
    return;
  }
  // 当前账号信息（带 verifier 供离线缓存）
  if (p === '/api/me' && req.method === 'GET') {
    const a = authUser(req);
    if (!a) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    sendJSON(res, 200, { ok: true, user: publicUser(a, true) }, req);
    return;
  }
  // 改密（已认证会话；mustChange 时可免旧密码）
  if (p === '/api/change-password' && req.method === 'POST') {
    const a = authUser(req);
    if (!a) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    let b; try { b = await readBody(req); } catch (e) { sendJSON(res, 400, { ok: false, error: 'bad json' }, req); return; }
    if (!a.mustChange && !(await verifyPassword(b.oldPassword || '', a.salt, a.passwordHash))) { sendJSON(res, 400, { ok: false, error: 'old_wrong' }, req); return; }
    if (!passwordStrong(b.newPassword || '')) { sendJSON(res, 400, { ok: false, error: 'weak' }, req); return; }
    const salt = genSaltHex();
    a.salt = salt; a.passwordHash = await hashPassword(b.newPassword, salt); a.mustChange = false; a.updatedTs = Date.now();
    persist();
    const token = issueToken(a.username);
    sendJSON(res, 200, { ok: true, token, user: publicUser(a, true) }, req);
    return;
  }
  // 账号列表（需 account.manage）
  if (p === '/api/accounts' && req.method === 'GET') {
    const a = authUser(req);
    if (!a) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    if (!can(a.role, 'account.manage')) { sendJSON(res, 403, { ok: false, error: 'forbidden' }, req); return; }
    const list = Object.values(accounts).filter(x => !x.deleted).map(x => ({
      username: x.username, name: x.name, role: x.role, factories: x.factories.slice(), mustChange: !!x.mustChange
    }));
    sendJSON(res, 200, { ok: true, accounts: list }, req);
    return;
  }
  // 新建/注册账号（需 account.manage；或系统尚无任何账号时自助注册首账号=老板）
  if (p === '/api/accounts' && req.method === 'POST') {
    let a = authUser(req);
    let b; try { b = await readBody(req); } catch (e) { sendJSON(res, 400, { ok: false, error: 'bad json' }, req); return; }
    const firstRun = Object.values(accounts).filter(x => !x.deleted).length === 0;
    if (!firstRun) {
      if (!a) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
      if (!can(a.role, 'account.manage')) { sendJSON(res, 403, { ok: false, error: 'forbidden' }, req); return; }
    }
    const username = (b.username || '').trim();
    const name = (b.name || '').trim();
    const role = b.role || 'registrar';
    const factories = Array.isArray(b.factories) ? b.factories : [];
    if (!username || !name) { sendJSON(res, 400, { ok: false, error: 'missing' }, req); return; }
    if (!['boss', 'devAdmin', 'factoryAdmin', 'registrar', 'auditor'].includes(role)) { sendJSON(res, 400, { ok: false, error: 'bad_role' }, req); return; }
    if (factories.length === 0) { sendJSON(res, 400, { ok: false, error: 'no_factory' }, req); return; }
    if (accounts[username] && !accounts[username].deleted && !b.forceOverwrite) { sendJSON(res, 409, { ok: false, error: 'exists' }, req); return; }
    if (!b.password || !passwordStrong(b.password)) { sendJSON(res, 400, { ok: false, error: 'weak' }, req); return; }
    const salt = genSaltHex();
    accounts[username] = {
      username, name, role, factories: factories.slice(), salt,
      passwordHash: await hashPassword(b.password, salt),
      mustChange: firstRun ? false : true, updatedTs: Date.now(), deleted: false
    };
    persist();
    sendJSON(res, 200, { ok: true, user: publicUser(accounts[username]) }, req);
    return;
  }
  // 删除账号（需 account.manage；仅保护最后一个老板/开发管理员，避免账号系统锁死）
  if (p.startsWith('/api/accounts/') && req.method === 'DELETE') {
    const a = authUser(req);
    if (!a) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    if (!can(a.role, 'account.manage')) { sendJSON(res, 403, { ok: false, error: 'forbidden' }, req); return; }
    const target = decodeURIComponent(p.slice('/api/accounts/'.length));
    const t = accounts[target];
    if (!t || t.deleted) { sendJSON(res, 404, { ok: false, error: 'not_found' }, req); return; }
    // 仅当该角色（boss/devAdmin）仅剩最后一位时才阻止删除；其余（含新建的老板账号）均允许删除
    if ((t.role === 'boss' || t.role === 'devAdmin') && Object.values(accounts).filter(x => !x.deleted && x.role === t.role).length <= 1) {
      sendJSON(res, 400, { ok: false, error: 'protected_last' }, req); return;
    }
    t.deleted = true; t.updatedTs = Date.now();
    persist();
    sendJSON(res, 200, { ok: true }, req);
    return;
  }
  // 更新账号（需 account.manage；老板赋权/改密，服务端权威，确保换设备即时同步）
  if (p.startsWith('/api/accounts/') && req.method === 'PUT') {
    const a = authUser(req);
    if (!a) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    if (!can(a.role, 'account.manage')) { sendJSON(res, 403, { ok: false, error: 'forbidden' }, req); return; }
    const target = decodeURIComponent(p.slice('/api/accounts/'.length));
    const t = accounts[target];
    if (!t || t.deleted) { sendJSON(res, 404, { ok: false, error: 'not_found' }, req); return; }
    let b; try { b = await readBody(req); } catch (e) { sendJSON(res, 400, { ok: false, error: 'bad json' }, req); return; }
    if (b.role && b.role !== t.role) {
      if ((t.role === 'boss' || t.role === 'devAdmin') && Object.values(accounts).filter(x => !x.deleted && x.role === t.role).length <= 1) {
        sendJSON(res, 400, { ok: false, error: 'protected_last' }, req); return;
      }
      if (!['boss', 'devAdmin', 'factoryAdmin', 'registrar', 'auditor'].includes(b.role)) { sendJSON(res, 400, { ok: false, error: 'bad_role' }, req); return; }
      t.role = b.role;
    }
    if (b.name != null && ('' + b.name).trim()) t.name = ('' + b.name).trim();
    if (Array.isArray(b.factories) && b.factories.length) t.factories = b.factories.slice();
    if (b.password) {
      if (!passwordStrong(b.password)) { sendJSON(res, 400, { ok: false, error: 'weak' }, req); return; }
      const salt = genSaltHex();
      t.salt = salt; t.passwordHash = await hashPassword(b.password, salt); t.mustChange = true;
    }
    t.updatedTs = Date.now();
    persist();
    sendJSON(res, 200, { ok: true, user: publicUser(t) }, req);
    return;
  }

  /* ================= 云端备份（真实落盘，替代前端「只弹提示不上传」的空壳实现） ================= */
  const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
  const MAX_BACKUPS_PER_USER = 10;
  function ensureBackupDir() {
    try { if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true }); return true; }
    catch (e) { console.error('[backup] 备份目录不可用：%s -> %s', BACKUP_DIR, e.message); return false; }
  }
  function backupPrefix(username) {
    return String(username).replace(/[^A-Za-z0-9._@-]/g, '_').slice(0, 64) + '__';
  }
  function listBackups(username) {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    const prefix = backupPrefix(username);
    try {
      return fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
        .map(f => {
          const st = fs.statSync(path.join(BACKUP_DIR, f));
          return { name: f, size: st.size, ts: st.mtimeMs, time: new Date(st.mtimeMs).toISOString() };
        })
        .sort((x, y) => y.ts - x.ts);
    } catch (e) { return []; }
  }
  /* 每个账号只保留最近 N 份，避免备份目录无限膨胀把磁盘吃满 */
  function pruneBackups(username) {
    const list = listBackups(username);
    if (list.length <= MAX_BACKUPS_PER_USER) return;
    list.slice(MAX_BACKUPS_PER_USER).forEach(x => { try { fs.unlinkSync(path.join(BACKUP_DIR, x.name)); } catch (e) {} });
  }
  // 列出当前账号的云端备份
  if (p === '/api/backup' && req.method === 'GET') {
    const a = authUser(req);
    if (!a) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    sendJSON(res, 200, { ok: true, backups: listBackups(a.username) }, req);
    return;
  }
  // 上传一份云端备份
  if (p === '/api/backup' && req.method === 'POST') {
    const a = authUser(req);
    if (!a) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    let b; try { b = await readBody(req); } catch (e) { sendJSON(res, 400, { ok: false, error: 'bad json' }, req); return; }
    let payload;
    try { payload = JSON.stringify(b); } catch (e) { sendJSON(res, 400, { ok: false, error: 'bad payload' }, req); return; }
    const size = Buffer.byteLength(payload);
    if (size > MAX_BACKUP_BYTES) { sendJSON(res, 413, { ok: false, error: 'too_large', maxBytes: MAX_BACKUP_BYTES }, req); return; }
    if (!ensureBackupDir()) { sendJSON(res, 500, { ok: false, error: 'backup_dir_unavailable' }, req); return; }
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    const name = backupPrefix(a.username) + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.json';
    fs.writeFile(path.join(BACKUP_DIR, name), payload, 'utf8', (err) => {
      if (err) { console.error('[backup] 写入失败：', err.message); sendJSON(res, 500, { ok: false, error: 'write_failed' }, req); return; }
      pruneBackups(a.username);
      sendJSON(res, 200, { ok: true, name, size }, req);
    });
    return;
  }
  // 下载指定备份（先校验归属，防止越权读取他人备份；文件名白名单校验防止目录穿越）
  if (p.startsWith('/api/backup/') && req.method === 'GET') {
    const a = authUser(req);
    if (!a) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    const name = decodeURIComponent(p.slice('/api/backup/'.length));
    if (!/^[A-Za-z0-9._@-]+__\d{8}-\d{6}\.json$/.test(name)) { sendJSON(res, 400, { ok: false, error: 'bad_name' }, req); return; }
    if (!listBackups(a.username).some(x => x.name === name)) { sendJSON(res, 404, { ok: false, error: 'not_found' }, req); return; }
    serveFile(res, path.join(BACKUP_DIR, name), req);
    return;
  }

  // 推送
  if (p === '/sync/push' && req.method === 'POST') {
    if (!authOk(req)) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    let body;
    try { body = await readBody(req); } catch (e) { sendJSON(res, 400, { ok: false, error: 'bad json' }, req); return; }
    const del = Array.isArray(body.deleted) ? body.deleted : [];
    const now = Date.now();
    /* 先落墓碑再合并记录：同一批次里「记录 + 它的删除墓碑」同时到达时，记录根本进不去。
       旧版顺序相反，若中途抛异常或记录 id 与墓碑 id 类型不一致，就会把已删记录重新写回 ledger。 */
    del.forEach(id => {
      if (id == null) return;
      delete ledger[id];
      if (deleted.findIndex(t => t.id === id) < 0) deleted.push({ id, ts: now });
    });
    (Array.isArray(body.records) ? body.records : []).forEach(mergeRecord);
    /* 汇率：按 ts 做 LWW，谁最新听谁的（通常由老板账号写入） */
    if (body.fx && typeof body.fx === 'object' && body.fx.rate > 0) {
      const incTs = body.fx.ts || 0;
      if (!fx || incTs > (fx.ts || 0)) {
        fx = { rate: body.fx.rate, ts: incTs || now, by: body.fx.by || '', hist: Array.isArray(body.fx.hist) ? body.fx.hist.slice(0, 50) : (fx && fx.hist ? fx.hist : []) };
      }
    }
    // 账号同步
    (Array.isArray(body.users) ? body.users : []).forEach(mergeUser);
    (Array.isArray(body.deletedUsers) ? body.deletedUsers : []).forEach(un => {
      if (un == null) return;
      delete usersById[un];
      if (deletedUsers.findIndex(t => t.id === un) < 0) deletedUsers.push({ id: un, ts: now });
    });
    // 客户同步
    (Array.isArray(body.customers) ? body.customers : []).forEach(mergeCustomer);
    (Array.isArray(body.deletedCustomers) ? body.deletedCustomers : []).forEach(cid => {
      if (cid == null) return;
      delete customersById[cid];
      if (deletedCustomers.findIndex(t => t.id === cid) < 0) deletedCustomers.push({ id: cid, ts: now });
    });
    // 财务同步
    (Array.isArray(body.finances) ? body.finances : []).forEach(mergeFinance);
    (Array.isArray(body.deletedFinances) ? body.deletedFinances : []).forEach(fid => {
      if (fid == null) return;
      delete financesById[fid];
      if (deletedFinances.findIndex(t => t.id === fid) < 0) deletedFinances.push({ id: fid, ts: now });
    });
    /* 价格主数据（按厂区分别并入，Object.assign 合并避免跨厂互相覆盖/清空） */
    if (body.priceBy && typeof body.priceBy === 'object') {
      ['Sagamu', 'OPIC', 'Ikeja'].forEach(fac => {
        if (!priceBy[fac]) priceBy[fac] = {};
        if (body.priceBy[fac] && typeof body.priceBy[fac] === 'object') priceBy[fac] = Object.assign(priceBy[fac], body.priceBy[fac]);
      });
    }
    if (body.products && typeof body.products === 'object' && Object.keys(body.products).length) products = body.products;
    if (Array.isArray(body.priceHist)) priceHist = body.priceHist;
    /* 库存删除墓碑：被删的键在 push body 中 absent，Object.assign 合并不会移除它，
       故先依据 invDeleted 显式剔除（删除时间戳>0 才生效，取较新者），并阻止后续合并重新加回。 */
    const incInvDeleted = (body.invDeleted && typeof body.invDeleted === 'object') ? body.invDeleted : {};
    ['raw', 'pellet'].forEach(function (kind) {
      const rk = incInvDeleted[kind] || {};
      Object.keys(rk).forEach(function (key) {
        const ts = rk[key] || 0;
        invDeleted[kind] = invDeleted[kind] || {};
        if (ts <= 0) {
          /* 客户端显式解除墓碑（重新入库/编辑时发 ts=0 标记）：清除服务端墓碑与残留键，
             随后由下方 mergeInv 用 body 中的新值将该键重新加回。仅此显式信号才允许复活，
             普通同步（body 不含该键的墓碑）不会清除墓碑，从而防止陈旧推送复活已删条目。 */
          if (invDeleted[kind][key]) delete invDeleted[kind][key];
          if (kind === 'raw') { delete invAdjustRaw[key]; delete invRawEdit[key]; }
          else { delete invAdjust[key]; delete invPelletEdit[key]; }
          return;
        }
        if (kind === 'raw') { delete invAdjustRaw[key]; delete invRawEdit[key]; if (body.invAdjustRaw) delete body.invAdjustRaw[key]; if (body.invRawEdit) delete body.invRawEdit[key]; }
        else { delete invAdjust[key]; delete invPelletEdit[key]; if (body.invAdjust) delete body.invAdjust[key]; if (body.invPelletEdit) delete body.invPelletEdit[key]; }
        if ((invDeleted[kind][key] || 0) < ts) invDeleted[kind][key] = ts;
      });
    });
    if (body.invAdjust && typeof body.invAdjust === 'object') mergeInv(invAdjust, body.invAdjust, 'pellet');
    if (body.invAdjustRaw && typeof body.invAdjustRaw === 'object') mergeInv(invAdjustRaw, body.invAdjustRaw, 'raw');
    if (body.invRawEdit && typeof body.invRawEdit === 'object') mergeInv(invRawEdit, body.invRawEdit, 'raw');
    if (body.invPelletEdit && typeof body.invPelletEdit === 'object') mergeInv(invPelletEdit, body.invPelletEdit, 'pellet');
    persist();
    sendJSON(res, 200, { ok: true, serverTime: Date.now(), count: Object.keys(ledger).length }, req);
    return;
  }

  // 拉取（增量：since 之后的变更才返回，避免数据增长后每次全量下发）
  if (p === '/sync/pull' && req.method === 'GET') {
    if (!authOk(req)) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    let since = parseInt(url.searchParams.get('since') || '0', 10);
    if (!(since > 0)) since = 0;
    const srvTime = Date.now();
    // 增量基线用服务端接收时间戳 _srv（与 since=serverTime 同钟）；旧数据缺 _srv 时回退 srvTime 保证全量包含
    const incRecords = Object.values(ledger).filter(r => (r._srv || srvTime) > since);
    const incUsers = Object.values(usersById).filter(u => (u._srv || srvTime) > since);
    const incCustomers = Object.values(customersById).filter(c => (c._srv || srvTime) > since);
    const incFinances = Object.values(financesById).filter(f => (f._srv || srvTime) > since);
    // 墓碑：仅返回删除时间晚于 since 的（首次 since=0 全量下发，保证历史清理一致）
    const incDeleted = deleted.filter(t => t.ts > since).map(t => t.id);
    const incDelUsers = deletedUsers.filter(t => t.ts > since).map(t => t.id);
    const incDelCustomers = deletedCustomers.filter(t => t.ts > since).map(t => t.id);
    const incDelFinances = deletedFinances.filter(t => t.ts > since).map(t => t.id);
    sendJSON(res, 200, {
      ok: true,
      serverTime: srvTime,
      since,
      records: incRecords,
      deleted: incDeleted,
      users: incUsers,
      customers: incCustomers,
      deletedUsers: incDelUsers,
      deletedCustomers: incDelCustomers,
      finances: incFinances,
      deletedFinances: incDelFinances,
      priceBy: priceBy,
      products: products,
      priceHist: priceHist,
      invAdjust: invAdjust,
      invAdjustRaw: invAdjustRaw,
      invRawEdit: invRawEdit,
      invPelletEdit: invPelletEdit,
      invDeleted: invDeleted,
      fx: fx
    }, req);
    return;
  }

  // 静态前端（优先 index.html，兼容标准托管平台；回退到原始文件名）
  if (p === '/' || p === '/index.html') {
    const idx = path.join(__dirname, 'index.html');
    serveFile(res, fs.existsSync(idx) ? idx : APP_HTML, req);
    return;
  }
  // 其它静态文件（可选）
  if (req.method === 'GET') {
    const cand = path.resolve(__dirname, '.' + path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    /* 目录穿越双重校验：只用 startsWith(__dirname) 会被 /app-secrets 这类「同前缀不同目录」绕过，
       必须改为「规范化后的相对路径既不以 .. 开头、也不是绝对路径」才算在根目录内。 */
    const rel = path.relative(__dirname, cand);
    const inRoot = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    const ext = path.extname(cand).toLowerCase();
    const base = path.basename(cand).toLowerCase();
    const allowed = inRoot && !!STATIC_EXT_OK[ext] && !STATIC_DENY_NAMES[base];
    if (allowed && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      serveFile(res, cand, req);
      return;
    }
  }

  sendJSON(res, 404, { ok: false, error: 'not found' }, req);
});

/* 压缩结果缓存：key=文件路径，命中条件为 mtime 与 size 均未变（重新部署会自动失效）。
   399KB 的 index.html 每次请求都 gzip 一遍会白白烧 CPU，缓存后只有首访与更新后各压一次。 */
const gzipCache = new Map(); // file -> {key, buf}  key 为内容级 ETag（html/js/css）或 mtimeMs-size（其它）
function writeFileBody(res, file, ext, data, headers, req, cacheKey) {
  const compressible = ext === '.html' || ext === '.js' || ext === '.css' || ext === '.json' || ext === '.svg';
  const acceptGzip = compressible && data.length > 1024 && /gzip/i.test(req.headers['accept-encoding'] || '');
  if (!acceptGzip) { res.writeHead(200, headers); res.end(data); return; }
  const cached = gzipCache.get(file);
  if (cached && cached.key === cacheKey) {
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = cached.buf.length;
    res.writeHead(200, headers);
    res.end(cached.buf);
    return;
  }
  zlib.gzip(data, (gzErr, gz) => {
    if (gzErr) { res.writeHead(200, headers); res.end(data); return; }
    gzipCache.set(file, { key: cacheKey, buf: gz });
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = gz.length;
    res.writeHead(200, headers);
    res.end(gz);
  });
}

function serveFile(res, file, req) {
  /* 先读字节再判缓存：ETag 由真实内容算出，杜绝 stat/read 两次系统调用之间的错配 */
  fs.readFile(file, (err, data) => {
    if (err) { sendJSON(res, 404, { ok: false, error: 'file not found' }, req); return; }
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Vary': 'Accept-Encoding' };
    Object.assign(headers, SECURITY_HEADERS);
    if (ext === '.html' || ext === '.js' || ext === '.css') {
      /* SPA 外壳禁止强缓存，每次都回源校验。
         校验器用内容级强 ETag（sha1 + 字节长度）而不是 Last-Modified：
         Last-Modified 只有秒精度，重新部署若落在同一秒会被误判为未变更而回 304，
         用户就会看到"部署了新文件但页面还是旧的"。内容级 ETag 只要字节变了就一定不等。 */
      headers['Cache-Control'] = 'no-cache';
      const etag = '"' + crypto.createHash('sha1').update(data).digest('hex').slice(0, 27) + '-' + data.length.toString(16) + '"';
      headers['ETag'] = etag;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
      fs.stat(file, (e3, st) => {
        if (!e3) headers['Last-Modified'] = st.mtime.toUTCString();
        writeFileBody(res, file, ext, data, headers, req, etag);
      });
      return;
    }
    /* 图片等静态资源内容通常不随部署变化，可短期强缓存 */
    headers['Cache-Control'] = 'public, max-age=86400';
    fs.stat(file, (e3, st) => {
      writeFileBody(res, file, ext, data, headers, req, e3 ? ('nos-' + data.length) : (st.mtimeMs + '-' + st.size));
    });
  });
}

server.listen(PORT, HOST, () => {
  seedAccountsIfEmpty();
  console.log('[app] 一体化部署服务器已启动: http://%s:%d', HOST, PORT);
  console.log('[app] 前端: 打开上方地址即可使用（账号服务端权威，天然跨设备一致）');
  // 关键：不要把 SYNC_KEY 本身打进日志——平台日志面板对团队成员可见，打印等于泄露密钥
  console.log('[sync] API Key: %s', SYNC_KEY ? ('已配置（长度 ' + SYNC_KEY.length + '）') : '未配置（写接口仅放行同源请求）');
  if (!SYNC_KEY) console.warn('[sync][建议] 公网/多机部署请设置 SYNC_KEY 强密钥；若确需回退宽松模式请设 RF_ALLOW_NO_ORIGIN=1，但账本将不受保护');
  console.log('[sync] 数据文件: %s', DATA_FILE);
  console.log('[sync] 备份目录: %s', BACKUP_DIR);
  console.log('[sync] 多厂区可访问 http://<本机局域网IP>:%d 进行联网', PORT);
});
