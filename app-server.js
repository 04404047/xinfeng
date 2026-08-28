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

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
// 默认空密钥 = 免鉴权（适用于同源一体化部署，autoDetectSync 自动连接）。
// 公网多租户部署请务必通过 SYNC_KEY 环境变量设置一个强密钥，并在 App 设置里填同样的密钥。
const SYNC_KEY = process.env.SYNC_KEY || '';
const DATA_FILE = process.env.SYNC_DATA_FILE || path.join(__dirname, 'sync-data.json');
const APP_HTML = path.join(__dirname, '塑料回收收发货管理.html');
const BACKUP_DIR = process.env.RF_BACKUP_DIR || path.join(path.dirname(DATA_FILE), 'backups');
/* 静态文件白名单：默认不放行 .json/.env 等数据配置文件。
   此前任何位于项目目录内的文件都能被 GET 下来——sync-data.json（整本账目 + 账号哈希）
   就躺在同一目录，等于把账本挂在网上任人下载。 */
/* 不放行 .js：前端是单文件内联 HTML，根目录不该有任何前端脚本，
   白名单里留 .js 只会把 app-server.js 这类后端源码挂出去给人读。
   若将来确需前端脚本，请放到 assets/ 子目录并在白名单里单独放开。 */
const STATIC_EXT_OK = { '.html': 1, '.htm': 1, '.css': 1, '.ico': 1, '.png': 1, '.svg': 1, '.jpg': 1, '.jpeg': 1, '.webp': 1, '.woff2': 1 };
const STATIC_DENY_NAMES = { 'sync-data.json': 1, 'package.json': 1, 'package-lock.json': 1, 'railway.json': 1, '.env': 1, '.gitignore': 1 };
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
const MAX_BACKUPS_PER_SOURCE = 24;

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
/* 库存校正覆盖（与 recycleflow-server 后端保持一致的持久化 + 删除墓碑）：
   invAdjust/invAdjustRaw/invRawEdit/invPelletEdit + invDeleted（kind->{key:ts}）。 */
let invAdjust = {};
let invAdjustRaw = {};
let invRawEdit = {};
let invPelletEdit = {};
let invDeleted = { raw: {}, pellet: {} };
/* 汇率（1 CNY = ? NGN）：服务端权威，按 ts 做 LWW。
   此前汇率只存在各设备本地 settings，同一笔账在不同机器上会算出不同金额。 */
let fx = null; // {rate, ts, by, hist:[{rate,ts,by,prev}]}

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

let saveTimer = null;
/* 落盘脱敏：配置了 SYNC_KEY 时，用 AES-256-GCM（密钥由 SYNC_KEY 派生）加密磁盘文件，
   避免明文 JSON（含账号密码哈希）意外泄露；未配置密钥则明文存储并提示风险。 */
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
let persistFailures = 0;      // 连续落盘失败次数
let lastPersistError = null;  // 最近一次失败原因（由 /sync/health 上报，便于发现静默丢数据）
const PERSIST_MAX_ATTEMPTS = 3;
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
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const plain = JSON.stringify({ ledger, deleted, usersById, customersById, deletedUsers, deletedCustomers, financesById, deletedFinances, fx, invAdjust, invAdjustRaw, invRawEdit, invPelletEdit, invDeleted }, null, 0);
    const packed = encryptData(plain);
    const payload = packed.enc ? ('ENC:' + packed.data) : plain;
    /* 落盘失败必须重试并留痕：只 warn 一次会造成「业务显示成功、重启后数据没了」的静默丢失 */
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
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    // 页面仍有大量字面量 onclick（参数均为常量，不含用户数据）。
    // CSP 的 'unsafe-inline' 只覆盖 <script> 块、不覆盖事件属性，不显式放行会让这些按钮全部失效。
    "script-src-attr 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    // 保留 http/https/ws：现场可能把同步服务器指向局域网 IP
    "connect-src 'self' http: https: ws: wss:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ')
};
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
  headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Api-Key';
  headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  Object.assign(headers, SECURITY_HEADERS);
  res.writeHead(code, headers);
  res.end(body);
}
function authOk(req) {
  if (SYNC_KEY) {
    const k = req.headers['x-api-key'];
    return typeof k === 'string' && k === SYNC_KEY;
  }
  // 未配密钥时退化为「仅放行同源页面」：CORS 只挡浏览器，挡不住 curl，
  // 但至少不再是完全裸奔；公网部署必须设 SYNC_KEY。
  if (process.env.RF_ALLOW_NO_ORIGIN === '1') return true;
  return !!originAllowed(req);
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

/* ---------- 合并逻辑（LWW：ts 大者胜；相同则 rev 大者胜） ----------
   墓碑优先：一旦 id 进入 deleted（含老板/开发管理员删除），任何后续推送都
   不得将其复活——这是修复「老板删除后被同步复原」的关键。 */
function mergeRecord(rec) {
  if (!rec || rec.id == null) return;
  if (deleted.some(t => t.id === rec.id)) return; // 墓碑中的记录永不复活
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

/* ---------- 云端备份（本副本无账号体系，按来源 IP 归档） ---------- */
function ensureBackupDir() {
  try { if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true }); return true; }
  catch (e) { console.error('[backup] 目录不可用：', e.message); return false; }
}
function clientTag(req) {
  const ip = ((req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || 'local').trim();
  return ip.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) + '__';
}
function pruneBackups(tag) {
  try {
    const mine = fs.readdirSync(BACKUP_DIR).filter(f => f.indexOf(tag) === 0).sort();
    while (mine.length > MAX_BACKUPS_PER_SOURCE) { try { fs.unlinkSync(path.join(BACKUP_DIR, mine.shift())); } catch (e) {} }
  } catch (e) {}
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // CORS 预检
  if (req.method === 'OPTIONS') { sendJSON(res, 204, {}, req); return; }

  // 健康检查（无需鉴权，供前端同源探测自动启用同步）
  if (p === '/sync/health' && req.method === 'GET') {
    sendJSON(res, 200, {
      ok: true, count: Object.keys(ledger).length, key: !!SYNC_KEY,
      persistFailures, persistError: lastPersistError,
      backupsDir: BACKUP_DIR
    }, req);
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
    /* 库存校正覆盖：合并存储（多设备各自校正累计）；删除墓碑让"删除库存条目"跨设备生效且不被复活 */
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

  // 云端备份：上传整份本地快照（POST）/ 列出历史（GET）
  if (p === '/sync/backup' && req.method === 'POST') {
    if (!authOk(req)) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    let b; try { b = await readBody(req); } catch (e) { sendJSON(res, 400, { ok: false, error: 'bad json' }, req); return; }
    let payload;
    try { payload = JSON.stringify(b); } catch (e) { sendJSON(res, 400, { ok: false, error: 'bad payload' }, req); return; }
    const size = Buffer.byteLength(payload);
    if (size > MAX_BACKUP_BYTES) { sendJSON(res, 413, { ok: false, error: 'too_large', maxBytes: MAX_BACKUP_BYTES }, req); return; }
    if (!ensureBackupDir()) { sendJSON(res, 500, { ok: false, error: 'backup_dir_unavailable' }, req); return; }
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    const name = clientTag(req) + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.json';
    fs.writeFile(path.join(BACKUP_DIR, name), payload, 'utf8', (err) => {
      if (err) { console.error('[backup] 写入失败：', err.message); sendJSON(res, 500, { ok: false, error: 'write_failed' }, req); return; }
      pruneBackups(clientTag(req));
      sendJSON(res, 200, { ok: true, name, size }, req);
    });
    return;
  }
  if (p === '/sync/backup' && req.method === 'GET') {
    if (!authOk(req)) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    let list = [];
    try {
      list = fs.readdirSync(BACKUP_DIR).filter(f => /^[A-Za-z0-9._-]+__\d{8}-\d{6}\.json$/.test(f))
        .sort().reverse().slice(0, 50)
        .map(f => { let st; try { st = fs.statSync(path.join(BACKUP_DIR, f)); } catch (e) { return null; }
          return { name: f, size: st.size, time: new Date(st.mtimeMs).toISOString() }; }).filter(Boolean);
    } catch (e) {}
    sendJSON(res, 200, { ok: true, backups: list }, req);
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

/* 400KB 的 index.html 每次请求都 gzip 一遍会白白烧 CPU，缓存后只有首访与更新后各压一次 */
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
  console.log('[app] 一体化部署服务器已启动: http://%s:%d', HOST, PORT);
  console.log('[app] 前端: 打开上方地址即可使用（同源自动启用多厂同步）');
  // 关键：不要把 SYNC_KEY 本身打进日志——平台日志面板对团队成员可见，打印等于泄露密钥
  console.log('[sync] API Key: %s', SYNC_KEY ? ('已配置（长度 ' + SYNC_KEY.length + '）') : '未配置（写接口仅放行同源请求）');
  if (!SYNC_KEY) console.warn('[sync][建议] 公网/多机部署请设置 SYNC_KEY 强密钥；若确需回退宽松模式请设 RF_ALLOW_NO_ORIGIN=1，但账本将不受保护');
  console.log('[sync] 数据文件: %s', DATA_FILE);
  console.log('[sync] 备份目录: %s', BACKUP_DIR);
  console.log('[sync] 多厂区可访问 http://<本机局域网IP>:%d 进行联网', PORT);
});
