/* 大廳 / 房間 / 觀戰 的伺服器端測試：node test/lobby.test.js */
'use strict';
process.env.PORT = process.env.TEST_PORT || '31711';
process.env.AI_DELAY_MS = '10';

const WebSocket = require('ws');
const { server } = require('../server.js');

const URL = 'ws://127.0.0.1:' + process.env.PORT;
let pass = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    process.exitCode = 1;
    console.error('  ✗ ' + name + (extra === undefined ? '' : '\n    ' + JSON.stringify(extra)));
  }
}

/** 一條測試用連線：所有收到的訊息都留著，可等待符合條件的那一則 */
function client(label) {
  const ws = new WebSocket(URL);
  const c = { ws, msgs: [], waiters: [] };
  ws.on('message', buf => {
    const m = JSON.parse(buf.toString());
    c.msgs.push(m);
    c.waiters = c.waiters.filter(w => (w.match(m) ? (w.resolve(m), false) : true));
  });
  c.send = o => ws.send(JSON.stringify(o));
  c.wait = (match, ms = 3000) => new Promise((resolve, reject) => {
    const hit = c.msgs.find(match);
    if (hit) return resolve(hit);
    const w = { match, resolve };
    c.waiters.push(w);
    setTimeout(() => {
      if (!c.waiters.includes(w)) return;
      c.waiters = c.waiters.filter(x => x !== w);
      reject(new Error(label + ' 等不到訊息，收到過：' + c.msgs.map(x => x.t).join(',')));
    }, ms);
  });
  c.last = type => [...c.msgs].reverse().find(m => m.t === type);
  c.clear = () => { c.msgs.length = 0; };
  c.open = () => new Promise(r => ws.on('open', r));
  return c;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('建房與大廳列表');
  const host = client('host');
  await host.open();
  host.send({ t: 'create', name: '房主小明', numPlayers: 3 });
  const welcome = await host.wait(m => m.t === 'welcome');
  const code = welcome.code;
  t('建房者拿到座位 0', welcome.seat === 0, welcome);
  t('房號為 4 碼', /^[A-Z0-9]{4}$/.test(code), code);

  const browser = client('browser');
  await browser.open();
  browser.send({ t: 'lobby' });
  const rooms1 = await browser.wait(m => m.t === 'rooms');
  const r1 = rooms1.rooms.find(r => r.code === code);
  t('大廳列出這間房', !!r1, rooms1.rooms);
  t('狀態為等待中', r1 && r1.started === false, r1);
  t('回報已入座人數與上限', r1 && r1.taken === 1 && r1.numPlayers === 3, r1);
  t('回報房主暱稱', r1 && r1.host === '房主小明', r1);

  console.log('邀請連結查詢');
  browser.send({ t: 'peek', code });
  const peek1 = await browser.wait(m => m.t === 'roomInfo');
  t('peek 查得到房間', peek1.exists === true, peek1);
  t('peek 回報未開打且未滿', peek1.info.started === false && peek1.info.taken < peek1.info.numPlayers, peek1.info);

  browser.clear();
  browser.send({ t: 'peek', code: 'ZZZZ' });
  const peek0 = await browser.wait(m => m.t === 'roomInfo');
  t('不存在的房號回報 exists:false', peek0.exists === false, peek0);

  console.log('加入對戰與觀戰');
  const p2 = client('p2');
  await p2.open();
  p2.send({ t: 'join', code, name: '阿華' });
  const w2 = await p2.wait(m => m.t === 'welcome');
  t('加入者拿到座位 1', w2.seat === 1 && !w2.spectator, w2);

  const spec = client('spec');
  await spec.open();
  spec.send({ t: 'spectate', code, name: '路人甲' });
  const w3 = await spec.wait(m => m.t === 'welcome');
  t('觀戰者座位為 -1 並標記 spectator', w3.seat === -1 && w3.spectator === true, w3);

  host.clear();
  await sleep(80);
  const syncH = host.last('sync');
  t('房內看得到觀戰名單', syncH && syncH.room.spectators.length === 1, syncH && syncH.room.spectators);
  t('觀戰者名稱正確', syncH && syncH.room.spectators[0].name === '路人甲', syncH && syncH.room.spectators);

  spec.clear();
  spec.send({ t: 'move', from: 0, to: 1 });
  const err1 = await spec.wait(m => m.t === 'error');
  t('觀戰者不能走子', /觀戰/.test(err1.msg), err1);

  console.log('房主按開始才開局');
  host.clear();
  host.send({ t: 'start' });
  const err2 = await host.wait(m => m.t === 'error');
  t('座位沒補滿時開始會被擋', /補滿/.test(err2.msg), err2);

  host.send({ t: 'setAI', seat: 2, on: true, level: 'normal' });
  await sleep(60);
  host.clear();
  host.send({ t: 'start' });
  const started = await host.wait(m => m.t === 'sync' && m.room.started === true);
  t('補滿座位後房主可以開始', !!started.game, started.room);

  const specGame = await spec.wait(m => m.t === 'sync' && m.game);
  t('觀戰者同步得到棋盤', Array.isArray(specGame.game.board), Object.keys(specGame.game || {}));

  console.log('開打之後');
  browser.clear();
  browser.send({ t: 'lobby' });
  const rooms2 = await browser.wait(m => m.t === 'rooms');
  const r2 = rooms2.rooms.find(r => r.code === code);
  t('進行中的房間仍列在大廳供觀戰', !!r2, rooms2.rooms);
  t('狀態標記為進行中', r2 && r2.started === true, r2);
  t('回報觀戰人數', r2 && r2.spectators === 1, r2);

  browser.clear();
  browser.send({ t: 'peek', code });
  const peek2 = await browser.wait(m => m.t === 'roomInfo');
  t('peek 回報已開打（落地頁據此停用「加入對戰」）', peek2.info.started === true, peek2.info);

  const late = client('late');
  await late.open();
  late.send({ t: 'join', code, name: '遲到的人' });
  const err3 = await late.wait(m => m.t === 'error');
  t('開打後不能加入對戰，並提示改觀戰', /觀戰/.test(err3.msg), err3);

  late.send({ t: 'spectate', code, name: '遲到的人' });
  const w4 = await late.wait(m => m.t === 'welcome');
  t('開打後仍可加入觀戰', w4.spectator === true, w4);

  console.log('觀戰者聊天與離開');
  host.clear();
  spec.send({ t: 'chat', text: '加油啊' });
  await sleep(80);
  const syncChat = host.last('sync');
  const line = syncChat && syncChat.room.chat.find(c => c.text === '加油啊');
  t('觀戰者的發言會傳進房內', !!line, syncChat && syncChat.room.chat);
  t('發言標記為觀眾', line && line.spec === true && line.seat === -1, line);

  host.clear();
  spec.ws.close();
  await sleep(150);
  const syncOut = host.last('sync');
  t('觀戰者離線後從名單移除', syncOut && syncOut.room.spectators.length === 1, syncOut && syncOut.room.spectators);
  t('觀戰者離開不影響對局進行', syncOut && syncOut.room.started === true);

  console.log('沒有真人就關房');
  // 此時房內：座位 0/1 是真人、座位 2 是 AI，late 在觀戰
  host.ws.close();
  await sleep(120);
  browser.clear();
  browser.send({ t: 'peek', code });
  const still = await browser.wait(m => m.t === 'roomInfo');
  t('還有一位真人在線時房間留著', still.exists === true, still);

  p2.ws.close();                       // 最後一位真人也離開
  const kicked = await late.wait(m => m.t === 'kicked');
  t('真人全數離線後觀戰者被請出房間', /關閉/.test(kicked.msg), kicked);

  const checker = client('checker');
  await checker.open();
  checker.send({ t: 'peek', code });
  const gone = await checker.wait(m => m.t === 'roomInfo');
  t('房間已被回收（只剩 AI 與觀戰者不算數）', gone.exists === false, gone);

  checker.send({ t: 'lobby' });
  const roomsEnd = await checker.wait(m => m.t === 'rooms');
  t('大廳列表也不再出現該房', !roomsEnd.rooms.some(r => r.code === code), roomsEnd.rooms);

  console.log('\n通過 ' + pass + ' 項' + (process.exitCode ? '（有失敗）' : ''));
  [browser, late, checker].forEach(c => c.ws.close());
  server.close();
})().catch(e => {
  console.error('\n測試中斷：' + e.message);
  process.exitCode = 1;
  server.close();
});
