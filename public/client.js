/* client.js — 前端：大廳、房間、棋盤互動 */
(function () {
  'use strict';

  var R = window.Rules;
  var BOARD = R.BOARD;
  var SVGNS = 'http://www.w3.org/2000/svg';

  // 角落配色（依角落編號，0=上 順時針）
  var CORNER_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#14b8a6'];
  var CORNER_NAMES = ['上方', '右上', '右下', '下方', '左下', '左上'];

  var $ = function (id) { return document.getElementById(id); };
  var el = {};
  ['view-home', 'view-invite', 'view-online', 'view-local', 'view-room', 'view-game', 'toast', 'nickname',
   'invite-code', 'invite-status', 'invite-meta', 'invite-nick', 'btn-invite-join',
   'btn-invite-spec', 'btn-invite-lobby', 'btn-copy-link', 'invite-link-text',
   'btn-mode-online', 'btn-mode-local', 'btn-online-back', 'btn-local-back', 'who-name',
   'seg-players', 'btn-create', 'join-code', 'btn-join', 'btn-spectate', 'conn-status',
   'room-code', 'btn-copy', 'seat-list', 'btn-start', 'btn-leave-room', 'room-hint',
   'spectator-box', 'spectator-list', 'spectator-count', 'spec-pill',
   'game-code', 'turn-chip', 'board', 'banner', 'players',
   'history', 'chat', 'chat-form', 'chat-input', 'btn-rules', 'btn-rules-lobby',
   'btn-rules-close', 'rules-modal', 'btn-leave', 'btn-restart',
   'rooms-list', 'rooms-count', 'chk-private',
   'seg-local-players', 'local-seats', 'btn-local-start'
  ].forEach(function (id) { el[id] = $(id); });

  /* ── 狀態 ─────────────────────────────── */
  var ws = null;
  var mySeat = -1;
  var roomCode = null;
  var room = null;        // 房間快照
  var game = null;        // 對局快照
  var selected = -1;
  var legal = [];         // 目前選中棋子的合法走法
  var wantPlayers = 3;
  var local = null;               // 本機對戰引擎；非 null 代表離線模式
  var localPlayers = 3;
  var localCfg = [];              // 每個座位的設定
  var OFFLINE = !!window.OFFLINE_ONLY;
  var animatedTurn = -1;
  var pendingMove = false;
  var spectating = false;         // 觀戰模式：沒有座位，只看不下
  var homeView = 'view-home';     // 離開房間後要回到哪一頁
  var inviteCode = null;          // 從邀請連結進來的房號
  var inviteTimer = null;         // 邀請落地頁的狀態輪詢

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.toast.hidden = true; }, 3200);
  }

  var VIEWS = ['view-home', 'view-invite', 'view-online', 'view-local', 'view-room', 'view-game'];
  function show(view) {
    VIEWS.forEach(function (v) { el[v].hidden = (v !== view); });
  }

  // 連線狀態同時顯示在首頁與線上大廳
  function setConn(text) {
    Array.prototype.forEach.call(document.querySelectorAll('.conn'), function (node) {
      node.textContent = text;
    });
  }

  function nick() { return el.nickname.value.trim(); }

  /* ── 邀請連結 ─────────────────────────── */
  // 連結長這樣：https://…/?room=ABCD
  function inviteUrl(code) {
    return location.origin + location.pathname + '?room=' + code;
  }

  function readInvite() {
    var c = '';
    try {
      c = (new URLSearchParams(location.search).get('room') || '').toUpperCase().trim();
      if (!c && location.hash.indexOf('room=') === 1) {
        c = location.hash.slice(6).toUpperCase().trim();
      }
    } catch (e) { return null; }
    return /^[A-Z0-9]{4}$/.test(c) ? c : null;
  }

  // 落地頁停留期間持續更新房間狀態，人滿或開打了按鈕就會自己變灰
  function startInvitePoll() {
    clearInterval(inviteTimer);
    inviteTimer = setInterval(function () {
      if (el['view-invite'].hidden || !inviteCode) { clearInterval(inviteTimer); inviteTimer = null; return; }
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'peek', code: inviteCode }));
    }, 3000);
  }

  function endInvite() {
    clearInterval(inviteTimer);
    inviteTimer = null;
    inviteCode = null;
    try { history.replaceState(null, '', location.origin + location.pathname); } catch (e) {}
  }

  function renderInvite(m) {
    var joinBtn = el['btn-invite-join'];
    var specBtn = el['btn-invite-spec'];

    if (!m.exists) {
      el['invite-code'].textContent = m.code || '----';
      el['invite-status'].textContent = '已關閉';
      el['invite-status'].className = 'rstatus is-dead';
      el['invite-meta'].textContent = '這個房間已經關閉，或房號有誤。';
      joinBtn.disabled = true;
      specBtn.disabled = true;
      joinBtn.textContent = '加入對戰';
      specBtn.textContent = '加入觀戰';
      return;
    }

    var info = m.info;
    var full = info.taken >= info.numPlayers;
    el['invite-code'].textContent = info.code;
    el['invite-status'].textContent = info.started ? '進行中' : '等待中';
    el['invite-status'].className = 'rstatus ' + (info.started ? 'is-live' : 'is-wait');

    var meta = info.numPlayers + ' 人局 · 已入座 ' + info.taken + '/' + info.numPlayers;
    if (info.ai) meta += '（含 ' + info.ai + ' 個電腦）';
    if (info.host) meta += ' · 房主 ' + info.host;
    if (info.spectators) meta += ' · ' + info.spectators + ' 人觀戰';
    el['invite-meta'].textContent = meta;

    joinBtn.disabled = info.started || full;
    joinBtn.textContent = info.started ? '已經開打，無法加入對戰'
      : (full ? '房間已滿，無法加入對戰' : '加入對戰');
    specBtn.disabled = false;
    specBtn.textContent = info.started ? '加入觀戰（看現場）' : '加入觀戰';
  }

  function enterFromInvite(as) {
    if (!inviteCode) return;
    var typed = el['invite-nick'].value.trim();
    if (typed) el.nickname.value = typed;
    var code = inviteCode;
    homeView = 'view-online';
    endInvite();
    joinCode(code, as);
  }

  /* ── 連線 ─────────────────────────────── */
  function connect(onOpen) {
    if (ws && ws.readyState === 1) { onOpen && onOpen(); return; }
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);

    ws.onopen = function () {
      setConn('已連線');
      var saved = load();
      if (inviteCode) {
        send({ t: 'peek', code: inviteCode });
      } else if (saved && saved.code && saved.token) {
        send({ t: 'rejoin', code: saved.code, token: saved.token });
      } else if (saved && saved.code && saved.spectator) {
        send({ t: 'spectate', code: saved.code, name: nick() });
      } else {
        send({ t: 'lobby' });          // 訂閱房間列表
      }
      onOpen && onOpen();
    };
    ws.onclose = function () {
      setConn('連線中斷，3 秒後重新連線…');
      setTimeout(function () { connect(); }, 3000);
    };
    ws.onerror = function () { setConn('連線發生問題'); };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      handle(m);
    };
  }

  function send(msg) {
    if (local) return local.send(msg);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    else toast('尚未連線，請稍候');
  }

  function save(code, tk) { try { localStorage.setItem('cc.session', JSON.stringify({ code: code, token: tk })); } catch (e) {} }
  function saveSpectate(code) { try { localStorage.setItem('cc.session', JSON.stringify({ code: code, spectator: true })); } catch (e) {} }
  function load() { try { return JSON.parse(localStorage.getItem('cc.session') || 'null'); } catch (e) { return null; } }
  function clearSaved() { try { localStorage.removeItem('cc.session'); } catch (e) {} }

  function handle(m) {
    if (m.t === 'welcome') {
      mySeat = m.seat;
      spectating = !!m.spectator;
      roomCode = m.code;
      if (spectating) saveSpectate(m.code);
      else save(m.code, m.token);
      return;
    }
    if (m.t === 'kicked') {              // 觀戰中的房間被收掉了
      toast(m.msg || '房間已關閉');
      clearSaved();
      room = null; game = null; mySeat = -1; spectating = false;
      homeView = 'view-online';
      show('view-online');
      send({ t: 'lobby' });
      return;
    }
    if (m.t === 'error') {
      toast(m.msg);
      pendingMove = false;
      if (!room) {                       // 加入失敗，回大廳繼續看列表
        if (!el['view-invite'].hidden) { endInvite(); show('view-online'); }
        send({ t: 'lobby' });
      }
      return;
    }
    if (m.t === 'rooms') { renderRooms(m.rooms); return; }
    if (m.t === 'roomInfo') { renderInvite(m); return; }
    if (m.t === 'sync') {
      room = m.room;
      game = m.game;
      render();
      return;
    }
  }

  /* ── 首頁：選模式 ─────────────────────── */
  function goOnline() {
    homeView = 'view-online';
    el['who-name'].textContent = nick() || '（未命名）';
    show('view-online');
    connect(function () { send({ t: 'lobby' }); });
  }
  function goLocal() {
    homeView = 'view-local';
    renderLocalSeats();
    show('view-local');
  }
  el['btn-invite-join'].addEventListener('click', function () { enterFromInvite('player'); });
  el['btn-invite-spec'].addEventListener('click', function () { enterFromInvite('spectator'); });
  el['btn-invite-lobby'].addEventListener('click', function () {
    var typed = el['invite-nick'].value.trim();
    if (typed) el.nickname.value = typed;
    endInvite();
    goOnline();
  });

  el['btn-mode-online'].addEventListener('click', goOnline);
  el['btn-mode-local'].addEventListener('click', goLocal);
  el['btn-online-back'].addEventListener('click', function () { homeView = 'view-home'; show('view-home'); });
  el['btn-local-back'].addEventListener('click', function () { homeView = 'view-home'; show('view-home'); });

  /* ── 線上大廳事件 ─────────────────────── */
  el['seg-players'].addEventListener('click', function (e) {
    var b = e.target.closest('.seg-btn');
    if (!b) return;
    wantPlayers = Number(b.dataset.n);
    Array.prototype.forEach.call(el['seg-players'].children, function (c) { c.classList.toggle('is-on', c === b); });
  });

  el['btn-create'].addEventListener('click', function () {
    connect(function () {
      send({ t: 'create', name: el.nickname.value, numPlayers: wantPlayers, private: el['chk-private'].checked });
    });
  });

  function joinTyped(as) {
    var code = el['join-code'].value.trim().toUpperCase();
    if (code.length !== 4) return toast('房號是 4 個字元');
    joinCode(code, as);
  }
  el['btn-join'].addEventListener('click', function () { joinTyped('player'); });
  el['btn-spectate'].addEventListener('click', function () { joinTyped('spectator'); });
  el['join-code'].addEventListener('keydown', function (e) { if (e.key === 'Enter') el['btn-join'].click(); });

  function copyText(text, okMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(okMsg); }, function () { toast(text); });
    } else {
      toast(text);
    }
  }
  el['btn-copy'].addEventListener('click', function () {
    var text = roomCode || '';
    copyText(text, '已複製房號 ' + text);
  });
  el['btn-copy-link'].addEventListener('click', function () {
    if (!roomCode) return;
    copyText(inviteUrl(roomCode), '已複製邀請連結');
  });

  el['btn-start'].addEventListener('click', function () { send({ t: 'start' }); });
  el['btn-restart'].addEventListener('click', function () { send({ t: 'restart' }); });

  function joinCode(code, as) {
    connect(function () {
      send(as === 'spectator'
        ? { t: 'spectate', code: code, name: nick() }
        : { t: 'join', code: code, name: nick() });
    });
  }

  function renderRooms(list) {
    var waiting = list.filter(function (r) { return !r.started; }).length;
    el['rooms-count'].textContent = list.length
      ? (waiting + ' 間等待中 · 共 ' + list.length + ' 間')
      : '';
    el['rooms-list'].innerHTML = '';
    if (!list.length) {
      var empty = document.createElement('li');
      empty.className = 'rooms-empty';
      empty.textContent = '目前沒有房間，建一間吧！';
      el['rooms-list'].appendChild(empty);
      return;
    }
    list.forEach(function (r) {
      var full = r.taken >= r.numPlayers;
      var li = document.createElement('li');
      li.className = 'room-card' + (r.started ? ' is-live' : '');

      var head = document.createElement('div');
      head.className = 'rc-head';
      head.innerHTML = '<span class="rcode">' + escapeHtml(r.code) + '</span>' +
        '<span class="rstatus ' + (r.started ? 'is-live' : 'is-wait') + '">' +
        (r.started ? '進行中' : '等待中') + '</span>';
      li.appendChild(head);

      var meta = document.createElement('div');
      meta.className = 'rc-meta';
      meta.textContent = r.numPlayers + ' 人局' + (r.host ? ' · 房主 ' + r.host : '');
      li.appendChild(meta);

      // 座位用小彈珠表示：真人實心、電腦琥珀色、空位空心
      var seatDots = '';
      for (var i = 0; i < r.numPlayers; i++) {
        var kind = i < r.humans ? 'human' : (i < r.humans + r.ai ? 'ai' : 'open');
        seatDots += '<i class="sdot is-' + kind + '"></i>';
      }
      var seats = document.createElement('div');
      seats.className = 'rc-seats';
      seats.innerHTML = seatDots +
        (r.spectators ? '<span class="rspec">' + r.spectators + ' 人觀戰</span>' : '') +
        '<span class="rslots">' + r.taken + '/' + r.numPlayers + '</span>';
      li.appendChild(seats);

      var acts = document.createElement('div');
      acts.className = 'ractions';

      var join = document.createElement('button');
      join.className = 'btn btn-sm btn-primary';
      join.textContent = r.started ? '已開打' : (full ? '已滿' : '加入對戰');
      join.disabled = r.started || full;
      join.onclick = function () { joinCode(r.code, 'player'); };
      acts.appendChild(join);

      var spec = document.createElement('button');
      spec.className = 'btn btn-sm';
      spec.textContent = '加入觀戰';
      spec.onclick = function () { joinCode(r.code, 'spectator'); };
      acts.appendChild(spec);

      li.appendChild(acts);
      el['rooms-list'].appendChild(li);
    });
  }

  /* ── 本機對戰設定 ─────────────────────── */
  function defaultLocalCfg(n) {
    var seats = Rules.seatsFor(n);
    return seats.map(function (_, i) {
      return i === 0 ? { kind: 'human', name: '你' }
                     : { kind: 'ai', level: 'normal', name: '電腦 ' + (i + 1) };
    });
  }

  function renderLocalSeats() {
    if (!localCfg.length || localCfg.length !== localPlayers) localCfg = defaultLocalCfg(localPlayers);
    var corners = Rules.seatsFor(localPlayers);
    el['local-seats'].innerHTML = '';
    localCfg.forEach(function (cfg, i) {
      var row = document.createElement('div');
      row.className = 'local-seat';
      row.innerHTML = '<span class="dot" style="background:' + CORNER_COLORS[corners[i]] + '"></span>' +
        '<span class="lbl">座位 ' + (i + 1) + '（' + CORNER_NAMES[corners[i]] + '）</span>';

      var sel = document.createElement('select');
      [['human', '真人（這台裝置）'], ['easy', '電腦 · 簡單'], ['normal', '電腦 · 普通'], ['hard', '電腦 · 困難']]
        .forEach(function (o) {
          var op = document.createElement('option');
          op.value = o[0];
          op.textContent = o[1];
          var cur = cfg.kind === 'human' ? 'human' : cfg.level;
          if (cur === o[0]) op.selected = true;
          sel.appendChild(op);
        });
      sel.addEventListener('change', function () {
        if (sel.value === 'human') localCfg[i] = { kind: 'human', name: '玩家 ' + (i + 1) };
        else localCfg[i] = { kind: 'ai', level: sel.value, name: '電腦 ' + (i + 1) };
        renderLocalSeats();
      });
      row.appendChild(sel);
      el['local-seats'].appendChild(row);
    });

    var humans = localCfg.filter(function (c) { return c.kind === 'human'; }).length;
    el['btn-local-start'].disabled = humans === 0;
    el['btn-local-start'].textContent = humans === 0 ? '至少要有一位真人' : '開始本機對戰';
  }

  el['seg-local-players'].addEventListener('click', function (e) {
    var b = e.target.closest('.seg-btn');
    if (!b) return;
    localPlayers = Number(b.dataset.n);
    Array.prototype.forEach.call(el['seg-local-players'].children, function (c) { c.classList.toggle('is-on', c === b); });
    localCfg = defaultLocalCfg(localPlayers);
    renderLocalSeats();
  });

  el['btn-local-start'].addEventListener('click', function () {
    var myName = nick();
    var seats = localCfg.map(function (c, i) {
      if (c.kind !== 'human') return c;
      var isFirstHuman = localCfg.findIndex(function (x) { return x.kind === 'human'; }) === i;
      return { kind: 'human', name: (isFirstHuman && myName) ? myName : ('玩家 ' + (i + 1)) };
    });
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    clearSaved();
    local = LocalEngine(handle);
    local.send({ t: 'localStart', seats: seats });
  });

  function leave() {
    clearSaved();
    if (local) { local.send({ t: 'stop' }); local = null; }
    // 主動離開要讓伺服器區分於「重新整理」，否則座位會被保留到緩衝期結束
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ t: 'leave' })); } catch (e) {}
    }
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    mySeat = -1; roomCode = null; room = null; game = null; selected = -1; spectating = false;
    setConn(OFFLINE ? '離線版：可對電腦或多人輪流同一台裝置' : '已離開房間');
    if (OFFLINE && homeView === 'view-online') homeView = 'view-home';
    show(homeView);
    renderLocalSeats();
    if (!OFFLINE) connect(function () { send({ t: 'lobby' }); });
  }
  el['btn-leave'].addEventListener('click', leave);
  el['btn-leave-room'].addEventListener('click', leave);

  [['btn-rules', true], ['btn-rules-lobby', true], ['btn-rules-close', false]].forEach(function (p) {
    el[p[0]].addEventListener('click', function () { el['rules-modal'].hidden = !p[1]; });
  });
  el['rules-modal'].addEventListener('click', function (e) { if (e.target === el['rules-modal']) el['rules-modal'].hidden = true; });

  el['chat-form'].addEventListener('submit', function (e) {
    e.preventDefault();
    var text = el['chat-input'].value.trim();
    if (!text) return;
    send({ t: 'chat', text: text });
    el['chat-input'].value = '';
  });

  /* ── 座位列表（房間畫面） ───────────────── */
  var seatSig = '';
  function renderSeats() {
    var sig = JSON.stringify([room.code, mySeat, spectating, room.started, room.seats, room.spectators]);
    if (sig === seatSig) return;
    seatSig = sig;
    el['room-code'].textContent = room.code;
    roomCode = room.code;
    el['seat-list'].innerHTML = '';

    room.seats.forEach(function (s, i) {
      var li = document.createElement('li');
      li.className = 'seat-row';

      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = CORNER_COLORS[s.corner];
      li.appendChild(dot);

      var who = document.createElement('div');
      who.className = 'who';
      var label = s.kind === 'open' ? '（等待玩家加入…）' : s.name;
      var tag = i === mySeat ? '（你）' : '';
      var offline = s.kind === 'human' && !s.connected;
      who.innerHTML = '<b>' + escapeHtml(label) + tag +
        (offline ? '<i class="offtag">斷線中</i>' : '') + '</b>' +
        '<small>' + CORNER_NAMES[s.corner] + '陣營 → ' + CORNER_NAMES[s.dest] + '陣營' +
        (s.kind === 'ai' ? ' · 電腦（' + levelName(s.level) + '）' : '') +
        (offline ? ' · 等待重新連線' : '') + '</small>';
      li.appendChild(who);

      if (mySeat === 0 && i !== 0 && !room.started) {
        if (s.kind === 'ai') {
          var sel = document.createElement('select');
          [['easy', '簡單'], ['normal', '普通'], ['hard', '困難']].forEach(function (o) {
            var op = document.createElement('option');
            op.value = o[0]; op.textContent = o[1];
            if (s.level === o[0]) op.selected = true;
            sel.appendChild(op);
          });
          sel.addEventListener('change', function () { send({ t: 'setAI', seat: i, on: true, level: sel.value }); });
          li.appendChild(sel);

          var rm = document.createElement('button');
          rm.className = 'btn btn-sm btn-ghost';
          rm.textContent = '移除';
          rm.onclick = function () { send({ t: 'setAI', seat: i, on: false }); };
          li.appendChild(rm);
        } else if (s.kind === 'open') {
          var add = document.createElement('button');
          add.className = 'btn btn-sm';
          add.textContent = '加入電腦';
          add.onclick = function () { send({ t: 'setAI', seat: i, on: true, level: 'normal' }); };
          li.appendChild(add);
        }
      }
      el['seat-list'].appendChild(li);
    });

    renderSpectators();

    var shareable = !room.local;
    el['btn-copy-link'].hidden = !shareable;
    el['invite-link-text'].hidden = !shareable;
    if (shareable) el['invite-link-text'].textContent = inviteUrl(room.code);

    var ready = room.seats.every(function (s) { return s.kind !== 'open'; });
    el['btn-start'].hidden = spectating;
    el['btn-start'].disabled = !(mySeat === 0 && ready);
    el['room-hint'].textContent = spectating
      ? '你正在觀戰。房主按下「開始遊戲」後就會看到棋盤。'
      : (mySeat === 0
        ? (ready ? '座位已滿，按「開始遊戲」就能開打。' : '等待其他玩家加入，或用「加入電腦」補位。')
        : '等待房主開始遊戲…');
  }

  function renderSpectators() {
    var list = (room && room.spectators) || [];
    el['spectator-box'].hidden = !list.length;
    el['spectator-count'].textContent = list.length ? list.length + ' 人' : '';
    el['spectator-list'].innerHTML = '';
    list.forEach(function (sp) {
      var tag = document.createElement('span');
      tag.className = 'spec-tag';
      tag.textContent = sp.name;
      el['spectator-list'].appendChild(tag);
    });
  }

  function levelName(l) { return l === 'easy' ? '簡單' : l === 'hard' ? '困難' : '普通'; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  /* ── 棋盤 ─────────────────────────────── */
  var layers = {};

  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVGNS, tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  // k < 1 變暗、k > 1 變亮，用來從主色推出漸層的亮面與暗面
  function shade(hex, k) {
    var v = parseInt(hex.slice(1), 16);
    var ch = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map(function (c) {
      return Math.max(0, Math.min(255, Math.round(c * k)));
    });
    return '#' + ch.map(function (c) { return ('0' + c.toString(16)).slice(-2); }).join('');
  }

  // 用 DOMParser 解析，避免各家瀏覽器對 SVG innerHTML 的差異。
  // 注意 importNode 是複製而非搬移，來源節點不會消失，所以要先把子節點清單拍下來再走訪。
  function svgFragment(markup) {
    var parsed = new DOMParser().parseFromString(
      '<svg xmlns="' + SVGNS + '">' + markup + '</svg>', 'image/svg+xml');
    var frag = document.createDocumentFragment();
    var kids = Array.prototype.slice.call(parsed.documentElement.childNodes);
    kids.forEach(function (node) { frag.appendChild(document.importNode(node, true)); });
    return frag;
  }

  // 棋子球體漸層、棋盤凹洞、底板
  function buildDefs() {
    var out = '';
    CORNER_COLORS.forEach(function (col, i) {
      out += '<radialGradient id="pcg' + i + '" cx="34%" cy="27%" r="78%">' +
             '<stop offset="0%" stop-color="' + shade(col, 1.7) + '"/>' +
             '<stop offset="40%" stop-color="' + col + '"/>' +
             '<stop offset="100%" stop-color="' + shade(col, 0.42) + '"/>' +
             '</radialGradient>';
    });
    out += '<radialGradient id="holeg" cx="50%" cy="32%" r="74%">' +
           '<stop offset="0%" stop-color="#070b11"/>' +
           '<stop offset="100%" stop-color="#1e2735"/></radialGradient>';
    out += '<radialGradient id="plateg" cx="50%" cy="34%" r="76%">' +
           '<stop offset="0%" stop-color="#1f2a39"/>' +
           '<stop offset="100%" stop-color="#0f151e"/></radialGradient>';
    return out;
  }
  function buildBoardSvg() {
    var svg = el.board;
    svg.innerHTML = '';

    var defs = document.createElementNS(SVGNS, 'defs');
    defs.appendChild(svgFragment(buildDefs()));
    svg.appendChild(defs);

    ['plate', 'zones', 'arrow', 'holes', 'last', 'pieces', 'hints', 'ghost'].forEach(function (name) {
      var g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', 'layer-' + name);
      svg.appendChild(g);
      layers[name] = g;
    });

    // 六角星外圍的底板，讓棋盤浮在桌面上而不是貼在背景上
    var outline = convexHull(BOARD.cells.map(function (c) { return [c.px, c.py]; }));
    layers.plate.appendChild(svgEl('polygon', {
      class: 'plate',
      points: outline.map(function (p) { return (p[0] * 1.06) + ',' + (p[1] * 1.06); }).join(' ')
    }));

    // 六個陣營底色
    for (var c = 0; c < 6; c++) {
      var pts = BOARD.corners[c].map(function (id) { return BOARD.cells[id]; });
      var hull = convexHull(pts.map(function (p) { return [p.px, p.py]; }));
      var poly = document.createElementNS(SVGNS, 'polygon');
      poly.setAttribute('points', hull.map(function (p) { return p.join(','); }).join(' '));
      poly.setAttribute('class', 'zone');
      poly.setAttribute('data-corner', c);
      poly.setAttribute('fill', 'none');
      poly.setAttribute('stroke', 'none');
      layers.zones.appendChild(poly);
    }

    BOARD.cells.forEach(function (cell) {
      var h = document.createElementNS(SVGNS, 'circle');
      h.setAttribute('cx', cell.px);
      h.setAttribute('cy', cell.py);
      h.setAttribute('r', 0.52);
      h.setAttribute('class', 'hole');
      h.dataset.corner = cell.corner;
      layers.holes.appendChild(h);
    });
  }

  // 用於畫陣營外框的簡易凸包（點數少，直接 gift wrapping）
  function convexHull(points) {
    var pts = points.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    if (pts.length < 3) return pts;
    var cross = function (o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); };
    var lower = [], upper = [], i;
    for (i = 0; i < pts.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    for (i = pts.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
      upper.push(pts[i]);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  function paintZones() {
    if (!game) return;

    Array.prototype.forEach.call(layers.zones.children, function (poly) {
      var c = Number(poly.dataset.corner);
      var destOwner = game.dests.indexOf(c);     // 這個角是誰的目標
      var startOwner = game.seats.indexOf(c);    // 這個角是誰的出發地

      poly.classList.remove('zone-mine', 'zone-dest', 'zone-start');
      if (destOwner >= 0) {
        var col = CORNER_COLORS[game.seats[destOwner]];
        poly.setAttribute('fill', col);
        poly.setAttribute('stroke', col);
        poly.classList.add(destOwner === mySeat ? 'zone-mine' : 'zone-dest');
      } else if (startOwner >= 0) {
        poly.setAttribute('fill', 'none');
        poly.setAttribute('stroke', CORNER_COLORS[game.seats[startOwner]]);
        poly.classList.add('zone-start');
      } else {
        poly.setAttribute('fill', 'none');
        poly.setAttribute('stroke', 'none');
      }
    });

    // 目標區的每個洞加上該玩家顏色的圈；自己的目標最明顯
    Array.prototype.forEach.call(layers.holes.children, function (h) {
      var corner = Number(h.dataset.corner);
      var destOwner = corner >= 0 ? game.dests.indexOf(corner) : -1;
      h.classList.remove('hole-dest', 'hole-mine');
      if (destOwner < 0) { h.setAttribute('stroke', ''); return; }
      h.setAttribute('stroke', CORNER_COLORS[game.seats[destOwner]]);
      h.classList.add(destOwner === mySeat ? 'hole-mine' : 'hole-dest');
    });

    drawArrow();
  }

  // 從自己的出發陣營指向目標陣營的箭頭，一眼看出要往哪裡走
  function drawArrow() {
    layers.arrow.innerHTML = '';
    if (mySeat < 0 || !game || game.over) return;

    var from = centroid(game.seats[mySeat]);
    var to = centroid(game.dests[mySeat]);
    var dx = to.x - from.x, dy = to.y - from.y;
    var len = Math.hypot(dx, dy) || 1;
    var ux = dx / len, uy = dy / len;
    var a = { x: from.x + ux * 2.2, y: from.y + uy * 2.2 };
    var b = { x: to.x - ux * 2.6, y: to.y - uy * 2.6 };
    var col = CORNER_COLORS[game.seats[mySeat]];

    var line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    line.setAttribute('class', 'aim-line');
    line.setAttribute('stroke', col);
    layers.arrow.appendChild(line);

    var head = document.createElementNS(SVGNS, 'polygon');
    var w = 0.55, h = 1.0;
    var px = -uy, py = ux;
    var tip = { x: b.x + ux * h, y: b.y + uy * h };
    head.setAttribute('points', [
      tip.x + ',' + tip.y,
      (b.x + px * w) + ',' + (b.y + py * w),
      (b.x - px * w) + ',' + (b.y - py * w)
    ].join(' '));
    head.setAttribute('class', 'aim-head');
    head.setAttribute('fill', col);
    layers.arrow.appendChild(head);
  }

  function centroid(corner) {
    var cells = BOARD.corners[corner].map(function (id) { return BOARD.cells[id]; });
    var x = 0, y = 0;
    cells.forEach(function (c) { x += c.px; y += c.py; });
    return { x: x / cells.length, y: y / cells.length };
  }

  /**
   * 一顆棋子＝桌面落影 + 漸層球體 + 主高光 + 反射光，看起來像玻璃彈珠。
   * 位移放在外層 g 的 transform 屬性，縮放放在內層 .pc-in 交給 CSS，兩者才不會打架。
   */
  function pieceNode(corner) {
    var g = document.createElementNS(SVGNS, 'g');
    g.appendChild(svgEl('ellipse', { cx: 0, cy: 0.3, rx: 0.55, ry: 0.16, class: 'pc-shadow' }));
    var inner = svgEl('g', { class: 'pc-in' });
    inner.appendChild(svgEl('circle', { r: 0.62, class: 'pc-body', fill: 'url(#pcg' + corner + ')' }));
    inner.appendChild(svgEl('ellipse', {
      cx: -0.2, cy: -0.25, rx: 0.24, ry: 0.15, class: 'pc-gloss', transform: 'rotate(-30 -0.2 -0.25)'
    }));
    inner.appendChild(svgEl('circle', { cx: 0.19, cy: 0.25, r: 0.11, class: 'pc-bounce' }));
    g.appendChild(inner);
    return g;
  }

  function drawPieces() {
    layers.pieces.innerHTML = '';
    if (!game) return;
    var hideId = (animateJob && animateJob.to);
    game.board.forEach(function (owner, id) {
      if (owner < 0) return;
      var cell = BOARD.cells[id];
      var g = pieceNode(game.seats[owner]);
      g.setAttribute('class', 'piece' +
        (owner === mySeat && isMyTurn() ? ' mine' : '') + (id === selected ? ' sel' : ''));
      g.setAttribute('transform', 'translate(' + cell.px + ' ' + cell.py + ')');
      g.dataset.id = id;
      if (id === hideId) g.setAttribute('opacity', '0');
      layers.pieces.appendChild(g);
    });
  }

  function drawLastMove() {
    layers.last.innerHTML = '';
    if (!game || !game.lastMove || !game.lastMove.path) return;
    var d = game.lastMove.path.map(function (id, i) {
      var c = BOARD.cells[id];
      return (i ? 'L' : 'M') + c.px.toFixed(3) + ' ' + c.py.toFixed(3);
    }).join(' ');
    var p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('class', 'lastline');
    layers.last.appendChild(p);

    var end = BOARD.cells[game.lastMove.to];
    var ring = document.createElementNS(SVGNS, 'circle');
    ring.setAttribute('cx', end.px);
    ring.setAttribute('cy', end.py);
    ring.setAttribute('r', 0.78);
    ring.setAttribute('class', 'lastring');
    ring.setAttribute('stroke', CORNER_COLORS[game.seats[game.lastMove.player]]);
    layers.last.appendChild(ring);
  }

  function drawHints() {
    layers.hints.innerHTML = '';
    if (selected < 0) return;
    legal.forEach(function (mv) {
      var cell = BOARD.cells[mv.to];
      var g = svgEl('g', {
        class: 'target' + (mv.jump ? ' jump' : ''),
        transform: 'translate(' + cell.px + ' ' + cell.py + ')'
      });
      // 隱形點擊區半徑取格距的一半，手指點得到又不會蓋到隔壁格
      g.appendChild(svgEl('circle', { r: 0.52, class: 't-hit' }));
      g.appendChild(svgEl('circle', { r: 0.3, class: 't-dot' }));
      g.dataset.to = mv.to;
      g.addEventListener('mouseenter', function () { showPath(mv.path); });
      g.addEventListener('mouseleave', clearPath);
      layers.hints.appendChild(g);
    });
  }

  var pathEl = null;
  function showPath(path) {
    clearPath();
    if (!path || path.length < 2) return;
    var d = path.map(function (id, i) {
      var c = BOARD.cells[id];
      return (i ? 'L' : 'M') + c.px.toFixed(3) + ' ' + c.py.toFixed(3);
    }).join(' ');
    pathEl = document.createElementNS(SVGNS, 'path');
    pathEl.setAttribute('d', d);
    pathEl.setAttribute('class', 'pathline');
    layers.hints.insertBefore(pathEl, layers.hints.firstChild);
  }
  function clearPath() { if (pathEl && pathEl.parentNode) pathEl.parentNode.removeChild(pathEl); pathEl = null; }

  function isMyTurn() {
    if (spectating) return false;    // 觀戰只看不下
    if (pendingMove) return false;   // 已送出走法，等伺服器確認前先鎖住
    if (local) return !!(game && !game.over && room.seats[game.turn].kind === 'human');
    return !!(game && !game.over && game.turn === mySeat && game.finished.indexOf(mySeat) < 0);
  }

  el.board.addEventListener('click', function (e) {
    if (!game) return;
    var t = e.target.closest('.target');
    if (t) {
      var to = Number(t.dataset.to);
      pendingMove = true;
      send({ t: 'move', from: selected, to: to });
      selected = -1; legal = []; clearPath();
      drawHints(); drawPieces();
      return;
    }
    var p = e.target.closest('.piece');
    if (p && p.classList.contains('mine')) {
      var id = Number(p.dataset.id);
      selected = (selected === id) ? -1 : id;
      legal = selected < 0 ? [] : R.movesFrom(gameState(), selected);
      clearPath();
      drawHints(); drawPieces();
      return;
    }
    selected = -1; legal = []; clearPath(); drawHints(); drawPieces();
  });

  // 把伺服器快照包成規則引擎可用的 state
  function gameState() {
    return {
      numPlayers: room.numPlayers,
      seats: game.seats,
      dests: game.dests,
      blocked: buildBlocked(game.seats, game.dests),
      board: game.board,
      turn: game.turn,
      finished: game.finished,
      over: game.over
    };
  }
  function buildBlocked(seats, dests) {
    return seats.map(function (_, p) {
      var b = [false, false, false, false, false, false];
      seats.forEach(function (c, q) { if (q !== p) { b[c] = true; b[dests[q]] = true; } });
      b[seats[p]] = false; b[dests[p]] = false;
      return b;
    });
  }

  /* ── 走子動畫 ─────────────────────────── */
  var animateJob = null;
  function animateLastMove() {
    if (!game || !game.lastMove || !game.lastMove.path) return;
    if (game.turnCount === animatedTurn) return;
    animatedTurn = game.turnCount;

    var lm = game.lastMove;
    animateJob = { to: lm.to };
    drawPieces();

    var ghost = pieceNode(game.seats[lm.player]);
    ghost.setAttribute('class', 'piece ghost');
    layers.ghost.appendChild(ghost);

    var pts = lm.path.map(function (id) { return BOARD.cells[id]; });
    var perLeg = lm.jump ? 150 : 180;
    var t0 = performance.now();
    var total = perLeg * (pts.length - 1);

    function frame(now) {
      var k = Math.max(0, Math.min(1, (now - t0) / total));
      var f = k * (pts.length - 1);
      var i = Math.min(pts.length - 2, Math.floor(f));
      var u = f - i;
      var a = pts[i], b = pts[i + 1];
      var x = a.px + (b.px - a.px) * u;
      var y = a.py + (b.py - a.py) * u;
      var lift = lm.jump ? Math.sin(u * Math.PI) : 0;
      if (lift) y -= lift * 0.55;                        // 跳躍弧線
      // 騰空時球稍微放大、影子縮小，跳起來才有重量感
      ghost.setAttribute('transform',
        'translate(' + x + ' ' + y + ') scale(' + (1 + lift * 0.1) + ')');
      ghost.style.setProperty('--lift', String(lift));
      if (k < 1) requestAnimationFrame(frame);
      else {
        layers.ghost.innerHTML = '';
        animateJob = null;
        drawPieces();
      }
    }
    requestAnimationFrame(frame);
  }

  /* ── 面板 ─────────────────────────────── */
  function renderPanel() {
    el['game-code'].textContent = room.code;
    el['spec-pill'].hidden = !spectating;
    var chatBox = document.querySelector('.chat-box');
    if (chatBox) chatBox.hidden = !!room.local;

    el.players.innerHTML = '';
    room.seats.forEach(function (s, i) {
      var col = CORNER_COLORS[s.corner];
      var rank = game ? game.finished.indexOf(i) : -1;
      var d = document.createElement('div');
      d.className = 'pcard' + (game && !game.over && game.turn === i ? ' is-turn' : '');
      d.innerHTML =
        '<span class="dot" style="background:' + col + '"></span>' +
        '<span class="nm"><b>' + escapeHtml(s.name || '空位') + (i === mySeat ? '（你）' : '') + '</b>' +
        '<small>' + (s.kind === 'ai' ? 'AI·' + levelName(s.level) : (s.connected ? '線上' : '離線')) +
        ' → ' + CORNER_NAMES[s.dest] + '</small></span>' +
        (rank >= 0 ? '<span class="rank">第 ' + (rank + 1) + ' 名</span>' : '') +
        '<span class="bar"><i style="width:' + (s.home * 10) + '%;background:' + col + '"></i></span>' +
        '<span class="cnt">' + s.home + '/10</span>';

      if (mySeat === 0 && game && !game.over && s.kind === 'human' && !s.connected) {
        var b = document.createElement('button');
        b.className = 'btn btn-sm';
        b.textContent = 'AI 接手';
        b.onclick = function () { send({ t: 'takeover', seat: i, level: 'normal' }); };
        d.appendChild(b);
      }
      el.players.appendChild(d);
    });

    if (room.spectators && room.spectators.length) {
      var sp = document.createElement('div');
      sp.className = 'pcard pcard-spec';
      sp.innerHTML = '<span class="nm"><b>觀戰 ' + room.spectators.length + ' 人</b><small>' +
        escapeHtml(room.spectators.map(function (x) { return x.name; }).join('、')) + '</small></span>';
      el.players.appendChild(sp);
    }

    el.history.innerHTML = '';
    if (!(room.history || []).length) {
      var em = document.createElement('li');
      em.className = 'history-empty';
      em.textContent = '尚無棋步';
      el.history.appendChild(em);
    }
    (room.history || []).slice(-40).forEach(function (h) {
      var seat = room.seats[h.seat] || {};
      var li = document.createElement('li');
      var what = h.jump ? ('跳 ' + (h.hops || 1) + ' 次') : '走一步';
      li.innerHTML = '<i class="hdot" style="background:' + CORNER_COLORS[seat.corner] + '"></i>' +
        '<b>' + h.n + '</b> ' + escapeHtml(seat.name || ('玩家' + (h.seat + 1))) +
        ' <em>' + what + '</em>';
      el.history.appendChild(li);
    });
    el.history.scrollTop = el.history.scrollHeight;

    el.chat.innerHTML = '';
    (room.chat || []).forEach(function (c) {
      var d = document.createElement('div');
      if (c.spec) d.className = 'spec';
      d.innerHTML = '<span>' + escapeHtml(c.name || '') + (c.spec ? '（觀眾）' : '') + '：</span>' +
        escapeHtml(c.text);
      el.chat.appendChild(d);
    });
    el.chat.scrollTop = el.chat.scrollHeight;

    if (game) {
      if (game.over) {
        el['turn-chip'].textContent = '棋局結束';
      } else {
        var cur = room.seats[game.turn] || {};
        if (room.local) {
          var who = room.seats[game.turn];
          el['turn-chip'].innerHTML = who.kind === 'ai'
            ? '<b>' + escapeHtml(who.name) + '</b> 思考中…'
            : '輪到 <b>' + escapeHtml(who.name) + '</b>';
        } else if (game.finished.indexOf(mySeat) >= 0) {
          el['turn-chip'].innerHTML = '<b>你已達陣</b> · 其餘玩家比名次中';
        } else {
          el['turn-chip'].innerHTML = game.turn === mySeat
            ? '<b>輪到你了</b>'
            : '等待 <b>' + escapeHtml(cur.name || '') + '</b> ' + (cur.kind === 'ai' ? '思考中…' : '出手');
        }
      }
    }

    el['btn-restart'].hidden = !(mySeat === 0 && game && game.over);

    if (game && game.over) {
      var order = game.finished.map(function (p, i) {
        var seat = room.seats[p] || {};
        return '<li><span class="dot" style="background:' + CORNER_COLORS[seat.corner] + '"></span>' +
          '第 ' + (i + 1) + ' 名 · ' + escapeHtml(seat.name || '') + '</li>';
      }).join('');
      el.banner.innerHTML = '<h2>' + (game.finished[0] === mySeat ? '你贏了！' : '棋局結束') + '</h2><ol class="rankings">' + order + '</ol>';
      if (mySeat === 0) {
        var again = document.createElement('button');
        again.className = 'btn btn-primary';
        again.textContent = '再來一局';
        again.onclick = function () { send({ t: 'restart' }); };
        el.banner.appendChild(again);
      }
      el.banner.hidden = false;
    } else {
      el.banner.hidden = true;
    }
  }

  /* ── 主渲染 ───────────────────────────── */
  function render() {
    if (!room) { show(homeView); return; }
    if (!room.started || !game) {
      show('view-room');
      renderSeats();
      return;
    }
    show('view-game');
    if (!layers.holes) buildBoardSvg();
    if (game.turnCount < animatedTurn) animatedTurn = -1;   // 重新開局，重置動畫記錄
    if (local) mySeat = local.activeSeat();
    if (selected >= 0 && game.board[selected] !== mySeat) { selected = -1; legal = []; }
    if (pendingMove) { pendingMove = false; }
    paintZones();
    drawLastMove();
    animateLastMove();
    drawPieces();
    drawHints();
    renderPanel();
  }

  // 測試輔助（自動化對局用）
  window.__state = function () { return (room && game) ? gameState() : null; };
  window.__mySeat = function () { return mySeat; };

  renderLocalSeats();
  document.querySelectorAll('[data-online]').forEach(function (n) { n.hidden = OFFLINE; });
  buildBoardSvg();
  if (!OFFLINE) {
    inviteCode = readInvite();
    if (inviteCode) {
      el['invite-code'].textContent = inviteCode;
      show('view-invite');
      startInvitePoll();
    }
    connect();
  } else {
    setConn('離線版：可對電腦或多人輪流同一台裝置');
  }
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { selected = -1; legal = []; clearPath(); drawHints(); drawPieces(); el['rules-modal'].hidden = true; }
  });
})();
