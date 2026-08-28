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
  ['view-lobby', 'view-room', 'view-game', 'toast', 'nickname', 'seg-players', 'btn-create',
   'join-code', 'btn-join', 'conn-status', 'room-code', 'btn-copy', 'seat-list', 'btn-start',
   'btn-leave-room', 'room-hint', 'game-code', 'turn-chip', 'board', 'banner', 'players',
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

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.toast.hidden = true; }, 3200);
  }

  function show(view) {
    ['view-lobby', 'view-room', 'view-game'].forEach(function (v) { el[v].hidden = (v !== view); });
  }

  /* ── 連線 ─────────────────────────────── */
  function connect(onOpen) {
    if (ws && ws.readyState === 1) { onOpen && onOpen(); return; }
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);

    ws.onopen = function () {
      el['conn-status'].textContent = '已連線';
      var saved = load();
      if (saved && saved.code && saved.token) {
        send({ t: 'rejoin', code: saved.code, token: saved.token });
      } else {
        send({ t: 'lobby' });          // 訂閱公開房間列表
      }
      onOpen && onOpen();
    };
    ws.onclose = function () {
      el['conn-status'].textContent = '連線中斷，3 秒後重新連線…';
      setTimeout(function () { connect(); }, 3000);
    };
    ws.onerror = function () { el['conn-status'].textContent = '連線發生問題'; };
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
  function load() { try { return JSON.parse(localStorage.getItem('cc.session') || 'null'); } catch (e) { return null; } }
  function clearSaved() { try { localStorage.removeItem('cc.session'); } catch (e) {} }

  function handle(m) {
    if (m.t === 'welcome') {
      mySeat = m.seat;
      roomCode = m.code;
      save(m.code, m.token);
      return;
    }
    if (m.t === 'error') {
      toast(m.msg);
      pendingMove = false;
      if (!room) send({ t: 'lobby' });   // 加入失敗，回大廳繼續看列表
      return;
    }
    if (m.t === 'rooms') { renderRooms(m.rooms); return; }
    if (m.t === 'sync') {
      room = m.room;
      game = m.game;
      render();
      return;
    }
  }

  /* ── 大廳事件 ─────────────────────────── */
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

  el['btn-join'].addEventListener('click', function () {
    var code = el['join-code'].value.trim().toUpperCase();
    if (code.length !== 4) return toast('房號是 4 個字元');
    joinCode(code);
  });
  el['join-code'].addEventListener('keydown', function (e) { if (e.key === 'Enter') el['btn-join'].click(); });

  el['btn-copy'].addEventListener('click', function () {
    var text = roomCode || '';
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast('已複製房號 ' + text); });
    else toast('房號：' + text);
  });

  el['btn-start'].addEventListener('click', function () { send({ t: 'start' }); });
  el['btn-restart'].addEventListener('click', function () { send({ t: 'restart' }); });

  function joinCode(code) {
    connect(function () { send({ t: 'join', code: code, name: el.nickname.value }); });
  }

  function renderRooms(list) {
    el['rooms-count'].textContent = list.length ? list.length + ' 間等待中' : '';
    el['rooms-list'].innerHTML = '';
    if (!list.length) {
      var empty = document.createElement('li');
      empty.className = 'rooms-empty';
      empty.textContent = '目前沒有等待中的房間，建一間吧！';
      el['rooms-list'].appendChild(empty);
      return;
    }
    list.forEach(function (r) {
      var li = document.createElement('li');
      var info = r.numPlayers + ' 人局';
      if (r.ai) info += ' · 含 ' + r.ai + ' 個電腦';
      if (r.host) info += ' · 房主 ' + r.host;
      li.innerHTML = '<span class="rcode">' + escapeHtml(r.code) + '</span>' +
        '<span class="rinfo">' + escapeHtml(info) + '</span>' +
        '<span class="rslots">' + r.taken + '/' + r.numPlayers + '</span>';
      var b = document.createElement('button');
      b.className = 'btn btn-sm';
      b.textContent = r.taken >= r.numPlayers ? '已滿' : '加入';
      b.disabled = r.taken >= r.numPlayers;
      b.onclick = function () { joinCode(r.code); };
      li.appendChild(b);
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
    var nick = el.nickname.value.trim();
    var seats = localCfg.map(function (c, i) {
      if (c.kind !== 'human') return c;
      var isFirstHuman = localCfg.findIndex(function (x) { return x.kind === 'human'; }) === i;
      return { kind: 'human', name: (isFirstHuman && nick) ? nick : ('玩家 ' + (i + 1)) };
    });
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    clearSaved();
    local = LocalEngine(handle);
    local.send({ t: 'localStart', seats: seats });
  });

  function leave() {
    clearSaved();
    if (local) { local.send({ t: 'stop' }); local = null; }
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    mySeat = -1; roomCode = null; room = null; game = null; selected = -1;
    el['conn-status'].textContent = OFFLINE ? '離線版：可對電腦或多人輪流同一台裝置' : '已離開房間';
    show('view-lobby');
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
    var sig = JSON.stringify([room.code, mySeat, room.started, room.seats]);
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
      who.innerHTML = '<b>' + escapeHtml(label) + tag + '</b>' +
        '<small>' + CORNER_NAMES[s.corner] + '陣營 → ' + CORNER_NAMES[s.dest] + '陣營' +
        (s.kind === 'ai' ? ' · 電腦（' + levelName(s.level) + '）' : '') + '</small>';
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

    var ready = room.seats.every(function (s) { return s.kind !== 'open'; });
    el['btn-start'].disabled = !(mySeat === 0 && ready);
    el['room-hint'].textContent = mySeat === 0
      ? (ready ? '座位已滿，可以開始了。' : '等待其他玩家加入，或用「加入電腦」補位。')
      : '等待房主開始遊戲…';
  }

  function levelName(l) { return l === 'easy' ? '簡單' : l === 'hard' ? '困難' : '普通'; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  /* ── 棋盤 ─────────────────────────────── */
  var layers = {};
  function buildBoardSvg() {
    var svg = el.board;
    svg.innerHTML = '';
    ['zones', 'arrow', 'holes', 'last', 'pieces', 'hints', 'ghost'].forEach(function (name) {
      var g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', 'layer-' + name);
      svg.appendChild(g);
      layers[name] = g;
    });

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

  function drawPieces() {
    layers.pieces.innerHTML = '';
    if (!game) return;
    var hideId = (animateJob && animateJob.to);
    game.board.forEach(function (owner, id) {
      if (owner < 0) return;
      var cell = BOARD.cells[id];
      var g = document.createElementNS(SVGNS, 'circle');
      g.setAttribute('cx', cell.px);
      g.setAttribute('cy', cell.py);
      g.setAttribute('r', 0.62);
      g.setAttribute('fill', CORNER_COLORS[game.seats[owner]]);
      var cls = 'piece' + (owner === mySeat && isMyTurn() ? ' mine' : '') + (id === selected ? ' sel' : '');
      g.setAttribute('class', cls);
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
      var t = document.createElementNS(SVGNS, 'circle');
      t.setAttribute('cx', cell.px);
      t.setAttribute('cy', cell.py);
      t.setAttribute('r', 0.3);
      t.setAttribute('class', 'target' + (mv.jump ? ' jump' : ''));
      t.dataset.to = mv.to;
      t.addEventListener('mouseenter', function () { showPath(mv.path); });
      t.addEventListener('mouseleave', clearPath);
      layers.hints.appendChild(t);
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

    var ghost = document.createElementNS(SVGNS, 'circle');
    ghost.setAttribute('r', 0.62);
    ghost.setAttribute('fill', CORNER_COLORS[game.seats[lm.player]]);
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
      if (lm.jump) y -= Math.sin(u * Math.PI) * 0.55;   // 跳躍弧線
      ghost.setAttribute('cx', x);
      ghost.setAttribute('cy', y);
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
      d.innerHTML = '<span>' + escapeHtml(c.name || '') + '：</span>' + escapeHtml(c.text);
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
    if (!room) { show('view-lobby'); return; }
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
  if (!OFFLINE) connect();
  else el['conn-status'].textContent = '離線版：可對電腦或多人輪流同一台裝置';
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { selected = -1; legal = []; clearPath(); drawHints(); drawPieces(); el['rules-modal'].hidden = true; }
  });
})();
