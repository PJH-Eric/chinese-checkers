/*
 * server.js — 中國跳棋連線伺服器
 * Express 提供靜態前端，ws 處理房間配對與權威式對局狀態。
 * 所有走法都由伺服器用 public/game.js 驗證，前端只負責顯示與提示。
 */
'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const Rules = require('./public/game.js');
const AI = require('./public/ai.js');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const AI_DELAY_MS = Number(process.env.AI_DELAY_MS || 700);
// 房裡沒有任何真人玩家連線時關閉房間，但保留一段緩衝，
// 讓「重新整理／網路瞬斷」的玩家還能憑 token 回到原座位。
// 按「離開」是主動退出，會立刻釋出座位、不吃這段緩衝。
const ROOM_GRACE_MS = Number(process.env.ROOM_GRACE_MS || 45000);
const SWEEP_MS = Math.min(5000, Math.max(250, Math.floor(ROOM_GRACE_MS / 2)));
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 500);   // 同時存在的房間上限
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const app = express();
const ALLOWED_ORIGINS = String(process.env.GAME_ALLOWED_ORIGIN || '*')
  .split(',').map(s => s.trim()).filter(Boolean);
const allowAllOrigins = ALLOWED_ORIGINS.includes('*');

function originAllowed(origin) {
  return allowAllOrigins || !origin || ALLOWED_ORIGINS.includes(origin);
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', allowAllOrigins ? '*' : origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size, maxRooms: MAX_ROOMS }));
app.get('/api/rooms', (_req, res) => res.json({ rooms: roomList(), total: rooms.size }));
app.get('/api/presence', (_req, res) => {
  const players = [...rooms.values()].reduce((total, room) => total + room.seats.filter((seat) => seat.kind === 'human' && seat.connected).length, 0);
  const spectators = [...rooms.values()].reduce((total, room) => total + [...room.spectators].filter((socket) => socket.readyState === 1).length, 0);
  const activeRooms = [...rooms.values()].filter((room) => room.humansConnected() || room.spectators.size > 0).length;
  res.json({
    gameId: 'chinese-checkers',
    online: wss.clients.size,
    players,
    spectators,
    lobby: lobbyClients.size,
    rooms: activeRooms,
    updatedAt: new Date().toISOString()
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** @type {Map<string, Room>} */
const rooms = new Map();

/** 停留在大廳、需要接收房間列表推播的連線 */
const lobbyClients = new Set();

function roomList() {
  const list = [];
  for (const r of rooms.values()) {
    if (r.private) continue;                 // 不公開房間只能靠房號進入
    if (!r.humansConnected()) continue;      // 全員斷線中的房間先不列，等它回來或被回收
    const taken = r.seats.filter(s => s.kind !== 'open').length;
    if (taken === 0) continue;
    list.push({
      code: r.code,
      numPlayers: r.numPlayers,
      taken: taken,
      humans: r.seats.filter(s => s.kind === 'human').length,
      ai: r.seats.filter(s => s.kind === 'ai').length,
      host: r.seats[0].name || '',
      started: r.started,                    // 進行中的房間仍可加入觀戰
      spectators: r.spectators.size,
      createdAt: r.createdAt
    });
  }
  // 還沒開打的排前面，同組再依建立時間由新到舊
  list.sort((a, b) => (a.started - b.started) || (b.createdAt - a.createdAt));
  return list.slice(0, 50);
}

function broadcastLobby() {
  if (!lobbyClients.size) return;
  const raw = JSON.stringify({ t: 'rooms', rooms: roomList() });
  for (const ws of lobbyClients) if (ws.readyState === 1) ws.send(raw);
}

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const token = () => crypto.randomBytes(12).toString('hex');
const now = () => Date.now();

class Room {
  constructor(numPlayers) {
    this.code = newCode();
    this.numPlayers = numPlayers;
    this.seats = Array.from({ length: numPlayers }, () => ({
      kind: 'open',            // open | human | ai
      name: '',
      level: 'normal',
      token: null,
      connected: false,
      socket: null,
      offSince: 0              // 斷線起始時間，0 代表沒斷線
    }));
    this.state = null;
    this.started = false;
    this.history = [];         // [{ seat, from, to, jump, n }]
    this.chat = [];
    this.lastAiMove = {};      // 防止 AI 來回震盪
    this.aiTimer = null;
    this.emptySince = now();
    this.createdAt = now();
    this.private = false;
    this.spectators = new Set();   // 只看不下的連線
    rooms.set(this.code, this);
  }

  seatOf(socket) { return this.seats.findIndex(s => s.socket === socket); }

  humansConnected() { return this.seats.some(s => s.kind === 'human' && s.connected); }

  publicSeats() {
    return this.seats.map((s, i) => ({
      index: i,
      kind: s.kind,
      name: s.kind === 'ai' ? (s.name || `電腦 ${i + 1}`) : s.name,
      level: s.level,
      connected: s.kind === 'ai' ? true : s.connected,
      corner: this.state ? this.state.seats[i] : Rules.seatsFor(this.numPlayers)[i],
      dest: this.state ? this.state.dests[i] : Rules.opposite(Rules.seatsFor(this.numPlayers)[i]),
      home: this.state ? Rules.progress(this.state, i) : 0
    }));
  }

  snapshot() {
    return {
      t: 'sync',
      room: {
        code: this.code,
        numPlayers: this.numPlayers,
        started: this.started,
        seats: this.publicSeats(),
        spectators: [...this.spectators].map(w => ({ name: w.specName || '觀眾' })),
        chat: this.chat.slice(-40),
        history: this.history.slice(-60)
      },
      game: this.state ? {
        board: this.state.board,
        turn: this.state.turn,
        turnCount: this.state.turnCount,
        finished: this.state.finished,
        over: this.state.over,
        seats: this.state.seats,
        dests: this.state.dests,
        lastMove: this.state.lastMove
      } : null
    };
  }

  broadcast(msg) {
    const raw = JSON.stringify(msg);
    for (const s of this.seats) {
      if (s.socket && s.socket.readyState === 1) s.socket.send(raw);
    }
    for (const w of this.spectators) {
      if (w.readyState === 1) w.send(raw);
    }
  }

  addSpectator(ws, name) {
    detach(ws);
    ws.roomCode = this.code;
    ws.seatIndex = -1;
    ws.spectator = true;
    ws.specName = name;
    this.spectators.add(ws);
    lobbyClients.delete(ws);
    send(ws, { t: 'welcome', code: this.code, seat: -1, token: null, hostSeat: 0, spectator: true });
    this.sync();
  }

  sync() { this.broadcast(this.snapshot()); broadcastLobby(); }

  start() {
    if (this.seats.some(s => s.kind === 'open')) return '還有空位尚未補滿';
    this.state = Rules.createState(this.numPlayers);
    this.started = true;
    this.history = [];
    this.lastAiMove = {};
    this.sync();
    this.scheduleAI();
    return null;
  }

  scheduleAI() {
    clearTimeout(this.aiTimer);
    if (!this.state || this.state.over) return;
    const seat = this.seats[this.state.turn];
    if (!seat || seat.kind !== 'ai') return;
    this.aiTimer = setTimeout(() => this.playAI(), AI_DELAY_MS);
  }

  playAI() {
    if (!this.state || this.state.over) return;
    const p = this.state.turn;
    const seat = this.seats[p];
    if (!seat || seat.kind !== 'ai') return;
    const move = AI.chooseMove(this.state, p, seat.level, this.lastAiMove);
    if (!move) { // 理論上不會發生；保險起見跳過該回合
      this.state.turn = (this.state.turn + 1) % this.numPlayers;
      this.sync();
      return this.scheduleAI();
    }
    this.lastAiMove[p] = { from: move.from, to: move.to };
    const res = Rules.applyMove(this.state, p, move.from, move.to);
    if (res.ok) this.recordMove(p, res.move);
    this.sync();
    this.scheduleAI();
  }

  recordMove(seatIndex, move) {
    this.history.push({
      seat: seatIndex,
      from: move.from,
      to: move.to,
      jump: move.jump,
      hops: (move.path ? move.path.length - 1 : 1),
      n: this.state.turnCount
    });
    if (this.history.length > 300) this.history.splice(0, this.history.length - 300);
  }

  /**
   * 房主（座位 0）不在線且尚未開局時，把還在線上的玩家遞補為房主。
   * 用「交換」而不是覆蓋，斷線中的原房主才能保住 token 回到自己那一席。
   * 開局後座位索引已經綁定顏色與棋子，不能再動。
   */
  reassignHost() {
    if (this.started) return false;
    if (this.seats[0].connected) return false;
    const idx = this.seats.findIndex((s, i) => i > 0 && s.kind === 'human' && s.connected);
    if (idx < 0) return false;
    const tmp = this.seats[0];
    this.seats[0] = this.seats[idx];
    this.seats[idx] = tmp;
    [0, idx].forEach(i => {
      const seat = this.seats[i];
      if (seat.socket) {
        seat.socket.seatIndex = i;
        send(seat.socket, { t: 'welcome', code: this.code, seat: i, token: seat.token, hostSeat: 0 });
      }
    });
    return true;
  }

  dispose() {
    clearTimeout(this.aiTimer);
    for (const w of this.spectators) {
      w.roomCode = null;
      w.spectator = false;
      send(w, { t: 'kicked', msg: '房間已關閉' });
    }
    this.spectators.clear();
    rooms.delete(this.code);
    broadcastLobby();
  }
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
const fail = (ws, msg) => send(ws, { t: 'error', msg });

/** 入座或換房前，先把這條連線從原本的觀戰席移除 */
function detach(ws) {
  if (!ws.spectator) return;
  const prev = ws.roomCode ? rooms.get(ws.roomCode) : null;
  ws.spectator = false;
  ws.specName = null;
  if (prev && prev.spectators.delete(ws)) prev.sync();
}

function attach(ws, room, seatIndex, name, tk) {
  detach(ws);
  const seat = room.seats[seatIndex];
  seat.kind = 'human';
  seat.name = name;
  seat.token = tk;
  seat.connected = true;
  seat.socket = ws;
  seat.offSince = 0;
  ws.roomCode = room.code;
  ws.seatIndex = seatIndex;
  lobbyClients.delete(ws);
  send(ws, { t: 'welcome', code: room.code, seat: seatIndex, token: tk, hostSeat: 0 });
  room.sync();
}

function cleanName(v, fallback) {
  const s = String(v || '').trim().slice(0, 16);
  return s || fallback;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    const seatIndex = ws.seatIndex;

    switch (m.t) {
      case 'create': {
        if (rooms.size >= MAX_ROOMS) return fail(ws, '目前房間數已達上限，請稍後再試');
        const n = m.numPlayers === 2 ? 2 : 3;
        const r = new Room(n);
        r.private = !!m.private;
        attach(ws, r, 0, cleanName(m.name, '房主'), token());
        break;
      }

      case 'lobby': {
        detach(ws);
        lobbyClients.add(ws);
        send(ws, { t: 'rooms', rooms: roomList() });
        break;
      }

      case 'peek': {           // 邀請連結落地頁查詢房間狀態
        const code = String(m.code || '').toUpperCase().trim();
        const r = rooms.get(code);
        if (!r) return send(ws, { t: 'roomInfo', code: code, exists: false });
        send(ws, {
          t: 'roomInfo',
          exists: true,
          info: {
            code: r.code,
            numPlayers: r.numPlayers,
            taken: r.seats.filter(s => s.kind !== 'open').length,
            ai: r.seats.filter(s => s.kind === 'ai').length,
            host: r.seats[0].name || '',
            started: r.started,
            spectators: r.spectators.size
          }
        });
        break;
      }

      case 'spectate': {
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) return fail(ws, '找不到這個房間代碼');
        if (r.spectators.has(ws)) return;
        r.addSpectator(ws, cleanName(m.name, '觀眾'));
        break;
      }

      case 'join': {
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) return fail(ws, '找不到這個房間代碼');
        if (r.started) return fail(ws, '這局已經開始了，可以改用「加入觀戰」');
        const idx = r.seats.findIndex(s => s.kind === 'open');
        if (idx < 0) return fail(ws, '房間已滿，可以改用「加入觀戰」');
        attach(ws, r, idx, cleanName(m.name, `玩家 ${idx + 1}`), token());
        break;
      }

      case 'rejoin': {
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) return fail(ws, '房間已不存在');
        const idx = r.seats.findIndex(s => s.token && s.token === m.token);
        if (idx < 0) return fail(ws, '無法回到原座位');
        detach(ws);
        const seat = r.seats[idx];
        if (seat.socket && seat.socket !== ws && seat.socket.readyState === 1) {
          seat.socket.close(4001, '同一座位在別處重新連線');
        }
        seat.kind = 'human';
        seat.connected = true;
        seat.socket = ws;
        seat.offSince = 0;
        ws.roomCode = r.code;
        ws.seatIndex = idx;
        lobbyClients.delete(ws);
        send(ws, { t: 'welcome', code: r.code, seat: idx, token: seat.token, hostSeat: 0 });
        r.sync();
        r.scheduleAI();
        break;
      }

      case 'setAI': {
        if (!room || seatIndex !== 0) return fail(ws, '只有房主可以調整座位');
        if (room.started) return fail(ws, '對局進行中無法調整座位');
        const i = Number(m.seat);
        if (!Number.isInteger(i) || i <= 0 || i >= room.numPlayers) return fail(ws, '座位編號不正確');
        const seat = room.seats[i];
        if (seat.kind === 'human' && seat.connected) return fail(ws, '該座位已有玩家');
        if (m.on) {
          const level = AI.LEVELS.includes(m.level) ? m.level : 'normal';
          Object.assign(seat, { kind: 'ai', level, name: `電腦 ${i + 1}`, token: null, socket: null, connected: false });
        } else {
          Object.assign(seat, { kind: 'open', name: '', token: null, socket: null, connected: false });
        }
        room.sync();
        break;
      }

      case 'takeover': {  // 讓 AI 接手斷線玩家
        if (!room || seatIndex !== 0) return fail(ws, '只有房主可以操作');
        const i = Number(m.seat);
        const seat = room.seats[i];
        if (!seat) return fail(ws, '座位編號不正確');
        if (seat.connected) return fail(ws, '該玩家仍在線上');
        seat.kind = 'ai';
        seat.level = AI.LEVELS.includes(m.level) ? m.level : 'normal';
        seat.name = `電腦 ${i + 1}（接手）`;
        seat.socket = null;
        room.sync();
        room.scheduleAI();
        break;
      }

      case 'start': {
        if (!room || seatIndex !== 0) return fail(ws, '只有房主可以開始遊戲');
        if (room.started) return fail(ws, '對局已經開始');
        const err = room.start();
        if (err) fail(ws, err);
        break;
      }

      case 'restart': {
        if (!room || seatIndex !== 0) return fail(ws, '只有房主可以重新開局');
        room.started = false;
        room.state = null;
        clearTimeout(room.aiTimer);
        const err = room.start();
        if (err) fail(ws, err);
        break;
      }

      case 'move': {
        if (ws.spectator) return fail(ws, '觀戰中不能走子');
        if (!room || !room.state) return fail(ws, '對局尚未開始');
        if (seatIndex !== room.state.turn) return fail(ws, '還沒輪到你');
        const res = Rules.applyMove(room.state, seatIndex, Number(m.from), Number(m.to));
        if (!res.ok) return fail(ws, res.error);
        room.recordMove(seatIndex, res.move);
        room.sync();
        room.scheduleAI();
        break;
      }

      case 'chat': {
        if (!room) return;
        const text = String(m.text || '').trim().slice(0, 200);
        if (!text) return;
        const spec = !!ws.spectator;
        const who = spec ? (ws.specName || '觀眾') : room.seats[seatIndex].name;
        room.chat.push({ seat: spec ? -1 : seatIndex, name: who, text, at: now(), spec: spec });
        if (room.chat.length > 100) room.chat.shift();
        room.sync();
        break;
      }

      // 按下「離開」＝主動退出，跟斷線不同：立刻釋出座位，房間該關就關
      case 'leave': {
        if (ws.spectator) { detach(ws); lobbyClients.add(ws); break; }
        if (!room) { lobbyClients.add(ws); break; }
        const seat = room.seats[seatIndex];
        if (seat && seat.socket === ws) {
          if (room.started) {
            // 對局進行中不能把座位變空位，棋子還在盤上；交給房主用 AI 接手
            Object.assign(seat, { connected: false, socket: null, token: null, offSince: now() });
          } else {
            Object.assign(seat, {
              kind: 'open', name: '', token: null, socket: null, connected: false, offSince: 0
            });
          }
        }
        ws.roomCode = null;
        ws.seatIndex = -1;
        lobbyClients.add(ws);
        if (!room.humansConnected()) room.dispose();
        else { room.reassignHost(); room.sync(); }
        break;
      }

      case 'ping':
        send(ws, { t: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    lobbyClients.delete(ws);
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (!room) return;
    if (ws.spectator) {
      ws.spectator = false;
      if (room.spectators.delete(ws)) room.sync();
      return;
    }
    const seat = room.seats[ws.seatIndex];
    if (seat && seat.socket === ws) {
      // 非主動離開（重新整理、網路瞬斷、關掉分頁）：座位與 token 都留著，
      // 等 ROOM_GRACE_MS 過了還沒回來，才由回收器釋出或關房。
      seat.connected = false;
      seat.socket = null;
      seat.offSince = now();
    }
    if (!room.humansConnected()) {
      room.emptySince = now();
      if (ROOM_GRACE_MS <= 0) { room.dispose(); return; }
    } else {
      room.reassignHost();
    }
    room.sync();
  });
});

// 心跳：清掉斷線的 socket
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000).unref();

// 回收器：緩衝期一過，釋出回不來的座位、關掉沒有真人的房間
setInterval(() => {
  const cutoff = now() - ROOM_GRACE_MS;
  for (const room of rooms.values()) {
    // 未開局的房間，斷線太久的座位讓出來給別人
    if (!room.started) {
      let freed = false;
      for (const seat of room.seats) {
        if (seat.kind === 'human' && !seat.connected && seat.offSince && seat.offSince <= cutoff) {
          Object.assign(seat, {
            kind: 'open', name: '', token: null, socket: null, connected: false, offSince: 0
          });
          freed = true;
        }
      }
      if (freed) { room.reassignHost(); room.sync(); }
    }
    if (room.humansConnected()) { room.emptySince = now(); continue; }
    if (room.emptySince <= cutoff) room.dispose();
  }
}, SWEEP_MS).unref();

server.listen(PORT, HOST, () => {
  console.log(`跳棋伺服器已啟動： http://localhost:${PORT}`);
});

module.exports = { app, server, rooms };
