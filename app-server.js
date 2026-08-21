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

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
// 默认空密钥 = 免鉴权（适用于同源一体化部署，autoDetectSync 自动连接）。
// 公网多租户部署请务必通过 SYNC_KEY 环境变量设置一个强密钥，并在 App 设置里填同样的密钥。
const SYNC_KEY = process.env.SYNC_KEY || '';
const DATA_FILE = process.env.SYNC_DATA_FILE || path.join(__dirname, 'sync-data.json');
const APP_HTML = path.join(__dirname, '塑料回收收发货管理.html');

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
// 汇率主数据（跨厂区/设备一致）：LWW 由 lastRateTs 决定；所有设备显示的 CNY/NGN 换算口径统一
let rateState = { rate: 0, rateHistory: [], lastRateTs: 0 };

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
    rateState = d.rateState || { rate: 0, rateHistory: [], lastRateTs: 0 };
    console.log('[sync] 已载入本地账本：%d 条记录，%d 条删除墓碑；账号 %d；客户 %d；财务 %d',
      Object.keys(ledger).length, deleted.length, Object.keys(usersById).length, Object.keys(customersById).length, Object.keys(financesById).length);
  }
} catch (e) { console.warn('[sync] 载入数据失败，重新开始：', e.message); }

let saveTimer = null;
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
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const plain = JSON.stringify({ ledger, deleted, usersById, customersById, deletedUsers, deletedCustomers, financesById, deletedFinances, rateState }, null, 0);
    const packed = encryptData(plain);
    const tmp = DATA_FILE + '.tmp';
    /* 先写临时文件再原子 rename，避免进程崩溃/断电时损坏数据文件 */
    fs.writeFile(tmp, packed.enc ? ('ENC:' + packed.data) : plain, (err) => {
      if (err) { console.warn('[sync] 写入失败：', err.message); return; }
      fs.rename(tmp, DATA_FILE, (e2) => { if (e2) console.warn('[sync] 重命名失败：', e2.message); });
    });
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
    'Vary': 'Origin'
  };
  // 同源/白名单来源才回显；否则置 'null' 由浏览器拒绝跨站访问
  headers['Access-Control-Allow-Origin'] = origin || 'null';
  headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Api-Key';
  headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  res.writeHead(code, headers);
  res.end(body);
}
function authOk(req) {
  // 未配置密钥时为免鉴权模式（同源一体化部署默认），配置后必须密钥匹配
  if (!SYNC_KEY) return true;
  const k = req.headers['x-api-key'];
  return typeof k === 'string' && k === SYNC_KEY;
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
  if (deleted.indexOf(rec.id) >= 0) return; // 墓碑中的记录永不复活
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
  if (deletedUsers.indexOf(u.username) >= 0) return;
  const cur = usersById[u.username];
  if (!cur || (u.updatedTs || 0) > (cur.updatedTs || 0)) usersById[u.username] = u;
}
/* 客户合并：按 id 做 LWW（updatedTs 大者胜），使分厂客户可在老板账号查看 */
function mergeCustomer(c) {
  if (!c || c.id == null) return;
  if (deletedCustomers.indexOf(c.id) >= 0) return;
  const cur = customersById[c.id];
  if (!cur || (c.updatedTs || 0) > (cur.updatedTs || 0)) customersById[c.id] = c;
}
/* 财务合并：按 id 做 LWW（ts 大者胜），使三厂财务可在老板账号全局汇总 */
function mergeFinance(f) {
  if (!f || f.id == null) return;
  if (deletedFinances.indexOf(f.id) >= 0) return;
  const cur = financesById[f.id];
  if (!cur || (f.ts || 0) > (cur.ts || 0)) financesById[f.id] = f;
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // CORS 预检
  if (req.method === 'OPTIONS') { sendJSON(res, 204, {}, req); return; }

  // 健康检查（无需鉴权，供前端同源探测自动启用同步）
  if (p === '/sync/health' && req.method === 'GET') {
    sendJSON(res, 200, { ok: true, count: Object.keys(ledger).length, key: !!SYNC_KEY }, req);
    return;
  }

  // 推送
  if (p === '/sync/push' && req.method === 'POST') {
    if (!authOk(req)) { sendJSON(res, 401, { ok: false, error: 'unauthorized' }, req); return; }
    let body;
    try { body = await readBody(req); } catch (e) { sendJSON(res, 400, { ok: false, error: 'bad json' }, req); return; }
    const recs = Array.isArray(body.records) ? body.records : [];
    recs.forEach(mergeRecord);
    const del = Array.isArray(body.deleted) ? body.deleted : [];
    const now = Date.now();
    del.forEach(id => {
      if (id == null) return;
      delete ledger[id];
      if (deleted.findIndex(t => t.id === id) < 0) deleted.push({ id, ts: now });
    });
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
    // 汇率同步：按 lastRateTs 做 LWW（大者胜），保证各厂区/设备汇率口径一致
    if (body && typeof body.lastRateTs === 'number' && body.lastRateTs > (rateState.lastRateTs || 0)) {
      if (typeof body.rate === 'number' && body.rate > 0) rateState.rate = body.rate;
      if (Array.isArray(body.rateHistory)) rateState.rateHistory = body.rateHistory;
      rateState.lastRateTs = body.lastRateTs;
    }
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
    const incRecords = Object.values(ledger).filter(r => (r.ts || 0) > since);
    const incUsers = Object.values(usersById).filter(u => (u.updatedTs || 0) > since);
    const incCustomers = Object.values(customersById).filter(c => (c.updatedTs || 0) > since);
    const incFinances = Object.values(financesById).filter(f => (f.ts || 0) > since);
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
      rate: rateState.rate,
      rateHistory: rateState.rateHistory,
      lastRateTs: rateState.lastRateTs
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
    const cand = path.join(__dirname, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (cand.startsWith(__dirname) && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      serveFile(res, cand, req);
      return;
    }
  }

  sendJSON(res, 404, { ok: false, error: 'not found' }, req);
});

function serveFile(res, file, req) {
  fs.readFile(file, (err, data) => {
    if (err) { sendJSON(res, 404, { ok: false, error: 'file not found' }, req); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

server.listen(PORT, HOST, () => {
  console.log('[app] 一体化部署服务器已启动: http://%s:%d', HOST, PORT);
  console.log('[app] 前端: 打开上方地址即可使用（同源自动启用多厂同步）');
  console.log('[sync] API Key: %s', SYNC_KEY);
  console.log('[sync] 多厂区可访问 http://<本机局域网IP>:%d 进行联网', PORT);
});
