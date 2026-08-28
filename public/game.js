/*
 * game.js — 中國跳棋（六角星 121 格）共用規則引擎
 * 同時可在 Node（伺服器 / AI）與瀏覽器（前端預覽）中使用。
 *
 * 座標：立方座標 (x, y, z)，x + y + z = 0
 *   六角星 = 兩個邊長 13 的大三角形聯集
 *     三角形 A: x<=4 && y<=4 && z<=4      (91 格)
 *     三角形 B: x>=-4 && y>=-4 && z>=-4   (91 格)
 *     交集為半徑 4 的正六邊形               (61 格)
 *     91 + 91 - 61 = 121 格
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Rules = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 六個相鄰方向（立方座標）
  var DIRS = [
    [1, -1, 0], [1, 0, -1], [0, 1, -1],
    [-1, 1, 0], [-1, 0, 1], [0, -1, 1]
  ];

  var PIECES_PER_PLAYER = 10;

  /* 角落編號依畫面角度排序：
   * 0 = 正上、1 = 右上、2 = 右下、3 = 正下、4 = 左下、5 = 左上
   * 對面角 = (i + 3) % 6
   */
  function cornerOf(x, y, z) {
    if (z <= -5) return 0;
    if (x >= 5) return 1;
    if (y <= -5) return 2;
    if (z >= 5) return 3;
    if (x <= -5) return 4;
    if (y >= 5) return 5;
    return -1;
  }

  function buildBoard() {
    var raw = [];
    for (var x = -8; x <= 8; x++) {
      for (var y = -8; y <= 8; y++) {
        var z = -x - y;
        if (z < -8 || z > 8) continue;
        var inA = (x <= 4 && y <= 4 && z <= 4);
        var inB = (x >= -4 && y >= -4 && z >= -4);
        if (!inA && !inB) continue;
        raw.push({ x: x, y: y, z: z });
      }
    }

    // 由上而下、由左而右排序，讓 id 的順序在視覺上是自然的
    raw.forEach(function (c) {
      c.px = Math.sqrt(3) * (c.x + c.z / 2);
      c.py = 1.5 * c.z;
    });
    raw.sort(function (a, b) {
      if (a.py !== b.py) return a.py - b.py;
      return a.px - b.px;
    });

    var cells = [];
    var index = Object.create(null);
    raw.forEach(function (c, i) {
      var cell = {
        id: i,
        x: c.x, y: c.y, z: c.z,
        px: c.px, py: c.py,
        corner: cornerOf(c.x, c.y, c.z),
        adj: null,
        jump: null
      };
      cells.push(cell);
      index[c.x + ',' + c.y + ',' + c.z] = i;
    });

    function at(x, y, z) {
      var v = index[x + ',' + y + ',' + z];
      return v === undefined ? -1 : v;
    }

    cells.forEach(function (c) {
      c.adj = DIRS.map(function (d) { return at(c.x + d[0], c.y + d[1], c.z + d[2]); });
      c.jump = DIRS.map(function (d) { return at(c.x + 2 * d[0], c.y + 2 * d[1], c.z + 2 * d[2]); });
    });

    var corners = [[], [], [], [], [], []];
    cells.forEach(function (c) { if (c.corner >= 0) corners[c.corner].push(c.id); });

    return { cells: cells, corners: corners, size: cells.length, at: at };
  }

  var BOARD = buildBoard();

  // 依人數挑選出發角：一律取「相間」的角，
  // 這樣每個人的目標三角形都是空的，不會是別人的出發陣營。
  function seatsFor(n) {
    switch (n) {
      case 2: return [0, 2];
      case 3: return [0, 2, 4];
      case 4: return [0, 1, 3, 4];
      case 6: return [0, 1, 2, 3, 4, 5];
      default: throw new Error('不支援的人數: ' + n);
    }
  }

  function opposite(corner) { return (corner + 3) % 6; }

  function createState(numPlayers) {
    var seats = seatsFor(numPlayers);
    var dests = seats.map(opposite);
    var board = new Array(BOARD.size).fill(-1);

    seats.forEach(function (corner, p) {
      BOARD.corners[corner].forEach(function (cellId) { board[cellId] = p; });
    });

    // 每位玩家不得進入的角落：其他玩家的出發角或目標角
    var blocked = seats.map(function (_, p) {
      var b = [false, false, false, false, false, false];
      seats.forEach(function (c, q) {
        if (q === p) return;
        b[c] = true;
        b[dests[q]] = true;
      });
      b[seats[p]] = false;
      b[dests[p]] = false;
      return b;
    });

    return {
      numPlayers: numPlayers,
      seats: seats,
      dests: dests,
      blocked: blocked,
      board: board,
      turn: 0,
      turnCount: 0,
      finished: [],      // 已達陣玩家的名次順序
      lastMove: null,
      over: false
    };
  }

  /**
   * 可否「經過」某格（連跳途中的中繼落點）。
   * 其他玩家的陣營可以自由穿越，只是不能停在裡面。
   */
  function canPass(state, p, cellId, homeLock) {
    if (homeLock) return BOARD.cells[cellId].corner === state.dests[p];
    return true;
  }

  /** 可否「停」在某格（一步棋的最終落點） */
  function canStop(state, p, cellId, homeLock) {
    var c = BOARD.cells[cellId];
    if (homeLock) return c.corner === state.dests[p];
    if (c.corner < 0) return true;
    return !state.blocked[p][c.corner];
  }

  /**
   * 取得某顆棋子所有合法終點。
   * 回傳 [{ from, to, path:[cellId...], jump:Boolean }]
   * 單步與連跳不可混用（符合標準規則）。
   */
  function movesFrom(state, from) {
    var res = [];
    var p = state.board[from];
    if (p < 0) return res;
    var cell = BOARD.cells[from];
    var homeLock = (cell.corner === state.dests[p]); // 進入終點後不得再離開

    // 1) 單步（單步等同直接停在該格）
    for (var d = 0; d < 6; d++) {
      var n = cell.adj[d];
      if (n < 0 || state.board[n] >= 0) continue;
      if (!canStop(state, p, n, homeLock)) continue;
      res.push({ from: from, to: n, path: [from, n], jump: false });
    }

    // 2) 連跳（BFS；起點視為空格，因棋子已被提起）
    var prev = Object.create(null);
    var seen = Object.create(null);
    seen[from] = true;
    var queue = [from];
    while (queue.length) {
      var cur = queue.shift();
      var cc = BOARD.cells[cur];
      for (var k = 0; k < 6; k++) {
        var mid = cc.adj[k], land = cc.jump[k];
        if (mid < 0 || land < 0) continue;
        if (mid === from) continue;              // 起點是空的，跳不過去
        if (state.board[mid] < 0) continue;      // 中間必須有子（敵我皆可）
        if (land === from || seen[land]) continue;
        if (state.board[land] >= 0) continue;    // 落點必須是空格
        if (!canPass(state, p, land, homeLock)) continue;
        seen[land] = true;
        prev[land] = cur;
        queue.push(land);                        // 可繼續往下跳（穿越他人陣營）

        if (!canStop(state, p, land, homeLock)) continue;   // 但不能停在他人陣營

        var path = [land], step = land;
        while (step !== from) { step = prev[step]; path.push(step); }
        path.reverse();
        res.push({ from: from, to: land, path: path, jump: true });
      }
    }
    return res;
  }

  function allMoves(state, p) {
    var out = [];
    for (var i = 0; i < state.board.length; i++) {
      if (state.board[i] === p) out = out.concat(movesFrom(state, i));
    }
    return out;
  }

  function findMove(state, from, to) {
    var list = movesFrom(state, from);
    for (var i = 0; i < list.length; i++) if (list[i].to === to) return list[i];
    return null;
  }

  function hasWon(state, p) {
    var dest = BOARD.corners[state.dests[p]];
    var own = 0, filled = 0;
    for (var i = 0; i < dest.length; i++) {
      var v = state.board[dest[i]];
      if (v >= 0) filled++;
      if (v === p) own++;
    }
    if (own === PIECES_PER_PLAYER) return true;
    // 若終點被對手卡住，填滿且至少有一子屬於自己亦算達陣
    return filled === dest.length && own >= 1;
  }

  function nextTurn(state) {
    if (state.finished.length >= state.numPlayers - 1) {
      state.over = true;
      for (var p = 0; p < state.numPlayers; p++) {
        if (state.finished.indexOf(p) < 0) state.finished.push(p);
      }
      return;
    }
    var t = state.turn;
    do { t = (t + 1) % state.numPlayers; } while (state.finished.indexOf(t) >= 0);
    state.turn = t;
  }

  /**
   * 執行一步棋。合法則回傳 { ok:true, move }，否則 { ok:false, error }
   */
  function applyMove(state, p, from, to) {
    if (state.over) return { ok: false, error: '棋局已結束' };
    if (p !== state.turn) return { ok: false, error: '還沒輪到你' };
    if (state.board[from] !== p) return { ok: false, error: '那不是你的棋子' };
    var move = findMove(state, from, to);
    if (!move) return { ok: false, error: '不合法的走法' };

    state.board[from] = -1;
    state.board[to] = p;
    state.turnCount++;
    state.lastMove = { player: p, from: from, to: to, path: move.path, jump: move.jump };

    if (hasWon(state, p) && state.finished.indexOf(p) < 0) state.finished.push(p);
    nextTurn(state);
    return { ok: true, move: state.lastMove };
  }

  // 該玩家到終點的總距離（越小越好），供 AI 與進度條使用
  function distanceScore(state, p) {
    var destCells = BOARD.corners[state.dests[p]].map(function (id) { return BOARD.cells[id]; });
    var total = 0;
    for (var i = 0; i < state.board.length; i++) {
      if (state.board[i] !== p) continue;
      var c = BOARD.cells[i];
      var best = Infinity;
      for (var j = 0; j < destCells.length; j++) {
        var d = destCells[j];
        var dist = (Math.abs(c.x - d.x) + Math.abs(c.y - d.y) + Math.abs(c.z - d.z)) / 2;
        if (dist < best) best = dist;
      }
      total += best;
    }
    return total;
  }

  function progress(state, p) {
    var dest = BOARD.corners[state.dests[p]];
    var own = 0;
    for (var i = 0; i < dest.length; i++) if (state.board[dest[i]] === p) own++;
    return own;
  }

  return {
    BOARD: BOARD,
    DIRS: DIRS,
    PIECES_PER_PLAYER: PIECES_PER_PLAYER,
    seatsFor: seatsFor,
    opposite: opposite,
    createState: createState,
    movesFrom: movesFrom,
    allMoves: allMoves,
    findMove: findMove,
    applyMove: applyMove,
    hasWon: hasWon,
    distanceScore: distanceScore,
    progress: progress
  };
});
