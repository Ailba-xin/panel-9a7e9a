// Q币余额表 · 独立手机版 —— 交易数据抓取
//
// 为什么要这个脚本：腾讯的交易明细接口浏览器跨域访问不了，所以用 GitHub Actions
// 在服务器侧定时抓取，生成 data.json 放到 GitHub Pages（同源，手机能直接读）。
//
// CK 从环境变量 QBCKS 读取（存在 GitHub Secret 里，加密保存，日志里也不会打印）。
// 输出 data.json 结构：{ ts, updated, accounts: { "<uin>": { nick, wx7, wx7sum, risk, why, retry, wx:[...], trades:[...] } } }

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const OFFER = '1450000186';
const GREEN_MAX = 4;          // 7 天内最多 4 笔，超过就锁风险（和电脑版一致）
const DAY = 86400;
const TRADE_DAYS = 60;        // 抓最近 60 天（风险锁定可能很久前触发，要足够长才能识别）

const cks = JSON.parse(process.env.QBCKS || '[]');
if (!Array.isArray(cks) || cks.length === 0) {
  console.error('QBCKS 为空或格式不对');
  process.exit(1);
}

const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const now = Math.floor(Date.now() / 1000);
const begin = now - TRADE_DAYS * DAY;

function ts2str(t) {
  // 用北京时间（GitHub Actions 默认是 UTC，会差 8 小时）
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date(t * 1000)).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

async function fetchTrades(a) {
  // 自动翻页（每页 50 条），最多 5 页（250 条，足够 60 天）
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const url = `https://api.unipay.qq.com/v1/r/${OFFER}/trade_record_query`
      + `?CmdCode=query2&SubCmdCode=default&PageNum=${page}&BeginUnixTime=${begin}&EndUnixTime=${now}`
      + `&PageSize=50&SystemType=portal`
      + `&openid=${encodeURIComponent(a.openid)}&openkey=${encodeURIComponent(a.openkey)}`
      + `&session_id=openid&session_type=kp_accesstoken&qq_appid=101502376`;
    const r = await fetch(url, { headers: { 'User-Agent': ua, 'Referer': 'https://pay.qq.com/h5/trade-record/' } });
    const txt = await r.text();
    let j;
    try { j = JSON.parse(txt); } catch { return { ok: false, err: 'parse: ' + txt.slice(0, 80) }; }
    if (j.ret !== 0 && j.ret !== '0') return { ok: false, err: (j.msg || ('ret=' + j.ret)) };
    const part = j.WaterList || [];
    all.push(...part);
    if (part.length < 50) break;          // 最后一页
    await new Promise(r2 => setTimeout(r2, 900));   // 翻页之间也等一下，避开风控
  }
  const list = all;
  const trades = list.map(x => ({
    t: Number(x.PayTime || 0),
    amt: Number(x.PayAmt || 0) / 100,
    ch: String(x.PayChannel || ''),
    sub: String(x.PayChannelSubId || ''),
    show: String(x.ShowName || x.ProductName || ''),
    sn: String(x.SerialNo || ''),
  })).filter(x => x.t > 0).sort((p, q) => q.t - p.t);
  return { ok: true, trades };
}

function isWx(t) { return t.ch === 'wechat' || t.ch === 'weixin'; }

// 查询余额（用于记录"变动后的余额"快照）
async function fetchBalance(a) {
  const url = `https://api.unipay.qq.com/v1/r/${OFFER}/wechat_query`
    + `?cmd=4&pf=vip_m-pay_html5-html5&pfkey=pfkey&from_h5=1&from_https=1&format=jsonp__getQBBalance`
    + `&openid=${encodeURIComponent(a.openid)}&openkey=${encodeURIComponent(a.openkey)}`
    + `&session_id=openid&session_type=kp_accesstoken&qq_appid=101502376`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': ua } });
    const txt = await r.text();
    if (!/"ret"\s*:\s*0/.test(txt)) return null;
    const m = /"qb_balance"\s*:\s*(\d+)/.exec(txt);
    return m ? Number(m[1]) / 100 : null;
  } catch (e) { return null; }
}

// 电脑版同款风险算法（滑动 7 天窗口 + 锁定）：
//   1) 当前 7 天窗口内的微信笔数 = wx7
//   2) 历史上任意一个"7 天窗口"超过 4 笔 = 超限；取**最后一次**超限窗口
//   3) 如果超限之后没有再出现过新的微信支付 → 锁「账号风险」，重试时间 = 触发窗口最后那笔 + 30 天
//   4) 一旦有新的微信支付进来（说明解封）→ 自动解除
function computeRisk(wxAll, n) {
  const out = { wx7: n, wx7sum: 0, risk: 0, why: '', retry: '', from: 0, to: 0 };
  const asc = wxAll.slice().sort((a, b) => a.t - b.t);
  let lastOver = 0, overFrom = 0, overTo = 0, overCount = 0;
  for (let i = 0; i < asc.length; i++) {
    let c = 0;
    for (let j = i; j < asc.length; j++) {
      if (asc[j].t - asc[i].t <= 7 * DAY) c++; else break;
    }
    if (c > GREEN_MAX) {
      overFrom = asc[i].t; overTo = asc[i].t; overCount = c;
      for (let j = i; j < asc.length; j++) { if (asc[j].t - asc[i].t <= 7 * DAY) overTo = asc[j].t; else break; }
      lastOver = overTo;   // ★ 关键：必须记窗口**结束**那笔的时间，才能和"最新一笔微信"比较
    }
  }
  const latest = asc.length ? asc[asc.length - 1].t : 0;
  if (lastOver > 0 && latest <= lastOver) {
    out.risk = 1;
    out.from = overFrom; out.to = overTo;
    out.retry = ts2str(overTo + 30 * DAY).slice(0, 16);
    out.why = `历史 ${ts2str(overFrom).slice(5, 10)}~${ts2str(overTo).slice(5, 10)} 这 ${overCount} 笔里超过 ${GREEN_MAX} 笔，之后没有新的微信支付进来`;
  }
  return out;
}

const out = { ts: now, updated: ts2str(now), accounts: {} };
// 读上一次的数据文件（为了累积余额快照历史）
let oldData = { accounts: {} };
try { oldData = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data.json'), 'utf8')); } catch (e) {}
for (const a of cks) {
  const key = String(a.uin || '');
  if (!key) continue;
  try {
    const res = await fetchTrades(a);
    if (!res.ok) {
      out.accounts[key] = { nick: a.nick || '', uin: key, err: res.err, trades: [], wx: [] };
      console.log(`${a.nick || key}: 失败 ${res.err}`);
      continue;
    }
    const trades = res.trades;
    const wxAll = trades.filter(isWx);
    const wx7 = wxAll.filter(t => t.t >= now - 7 * DAY);
    const r = computeRisk(wxAll, wx7.length);
    r.wx7sum = Math.round(wx7.reduce((s, t) => s + t.amt, 0) * 100) / 100;
    r.wx = wxAll.slice(0, 30).map(t => ({ t: t.t, amt: t.amt, ch: t.ch }));
    // 余额快照：每次运行记一条（时间 + 余额），累积起来就能算出"每笔变动后的余额"
    const prevHist = (oldData.accounts && oldData.accounts[key] && Array.isArray(oldData.accounts[key].hist)) ? oldData.accounts[key].hist : [];
    const qbNow = await fetchBalance(a);
    const hist = (qbNow === null ? prevHist : prevHist.concat([[now, qbNow]])).slice(-400);
    out.accounts[key] = { nick: a.nick || '', uin: key, ...r, trades: trades.slice(0, 40), qb: qbNow, hist };
    console.log(`${a.nick || key}: ${trades.length} 笔, 微信 7 天内 ${wx7.length} 笔, 风险=${r.risk}`);
  } catch (e) {
    out.accounts[key] = { nick: a.nick || '', uin: key, err: String(e.message || e), trades: [], wx: [] };
    console.log(`${a.nick || key}: 异常 ${e.message || e}`);
  }
  await new Promise(r => setTimeout(r, 1200));   // 账号之间拉开间隔，避开腾讯风控
}

// 写一份刷新状态，手机页面用它提示"数据多久没更新 / 哪些号失败"
const errList = Object.values(out.accounts).filter(x => x && x.err).map(x => (x.uin || '') + ':' + x.err);
const status = {
  ts: now,
  iso: new Date().toISOString(),
  ok: errList.length === 0,
  accounts: Object.keys(out.accounts).length,
  errCount: errList.length,
  error: errList.slice(0, 3).join(' | ')
};
fs.writeFileSync(path.join(process.cwd(), 'status.json'), JSON.stringify(status), 'utf8');
console.log('status.json ok=' + status.ok + ' errCount=' + status.errCount);

const p = path.join(process.cwd(), 'data.json');
// ★ 加密：公网上 data.json 只是一串乱码，只有持有钥匙的手机能解开
const keyHex = (process.env.QBKEY || '').trim();
if (keyHex.length === 64) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(out), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = { v: 1, iv: iv.toString('base64'), ct: Buffer.concat([enc, tag]).toString('base64') };
  fs.writeFileSync(p, JSON.stringify(payload), 'utf8');
  console.log('已写入加密数据 ' + p + '，账号数 ' + Object.keys(out.accounts).length);
} else {
  fs.writeFileSync(p, JSON.stringify(out), 'utf8');
  console.log('⚠ 没有 QBKEY，写入明文（不安全）');
}