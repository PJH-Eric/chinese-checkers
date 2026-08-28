/*
 * ai.js — 電腦對手（Node 與瀏覽器共用）
 * 以單層搜尋 + 位置評估選步：
 *   1. 貪婪指派：把目標三角形「最深的格子」配給距離它最近的棋子，
 *      總距離為 0 時剛好全部歸位 —— 殘局才有明確梯度，不會卡在 8/10 來回震盪
 *   2. 鼓勵離開出發角、進入終點，已歸位的棋子少動
 *   3. 難度決定隨機擾動幅度
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./game.js'));
  } else {
    root.AI = factory(root.Rules);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Rules) {
  'use strict';

  var BOARD = Rules.BOARD;

  var LEVELS = {
    easy:   { noise: 6.0, top: 6 },
    normal: { noise: 1.5, top: 3 },
    hard:   { noise: 0.0, top: 1 }
  };

  // 距離棋盤中心越遠 = 目標三角形越深處，優先填滿以免堵住入口
  function depth(cellId) {
    var c = BOARD.cells[cellId];
    return (Math.abs(c.x) + Math.abs(c.y) + Math.abs(c.z)) / 2;
  }

  function hexDist(a, b) {
    return (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z)) / 2;
  }

  function evaluate(state, p) {
    var slots = BOARD.corners[state.dests[p]]
      .slice()
      .sort(function (a, b) { return depth(b) - depth(a); })
      .map(function (id) { return BOARD.cells[id]; });

    var pieces = [];
    for (var i = 0; i < state.board.length; i++) {
      if (state.board[i] === p) pieces.push(BOARD.cells[i]);
    }

    var used = new Array(pieces.length).fill(false);
    var sum = 0;
    for (var s = 0; s < slots.length; s++) {
      var bestIdx = -1, bestDist = Infinity;
      for (var j = 0; j < pieces.length; j++) {
        if (used[j]) continue;
        var d = hexDist(pieces[j], slots[s]);
        if (d < bestDist) { bestDist = d; bestIdx = j; }
      }
      if (bestIdx < 0) break;
      used[bestIdx] = true;
      sum += bestDist;
    }
    return -sum;
  }

  /**
   * 選出一步棋。回傳 { from, to, path, jump } 或 null。
   * lastMoveByPlayer 用來避免來回震盪，可省略。
   */
  function chooseMove(state, p, level, lastMoveByPlayer) {
    var cfg = LEVELS[level] || LEVELS.normal;
    var moves = Rules.allMoves(state, p);
    if (!moves.length) return null;

    var avoid = lastMoveByPlayer && lastMoveByPlayer[p];
    var scored = moves.map(function (m) {
      var board = state.board.slice();
      board[m.from] = -1;
      board[m.to] = p;
      var trial = {
        numPlayers: state.numPlayers, seats: state.seats, dests: state.dests,
        blocked: state.blocked, board: board
      };
      var sc = evaluate(trial, p);

      var fromCorner = BOARD.cells[m.from].corner;
      if (fromCorner === state.seats[p]) sc += 1.2;                    // 盡早清空出發角
      if (BOARD.cells[m.to].corner === state.dests[p]) sc += 1.5;      // 進入終點加分
      if (fromCorner === state.dests[p]) sc -= 2.5;                    // 已歸位的少動
      if (avoid && avoid.from === m.to && avoid.to === m.from) sc -= 8; // 別走回頭路
      if (m.jump) sc += 0.3;                                           // 連跳通常較有效率

      return { move: m, score: sc + Math.random() * cfg.noise };
    });

    scored.sort(function (a, b) { return b.score - a.score; });
    var pool = scored.slice(0, Math.max(1, Math.min(cfg.top, scored.length)));
    return pool[Math.floor(Math.random() * pool.length)].move;
  }

  return { chooseMove: chooseMove, evaluate: evaluate, LEVELS: Object.keys(LEVELS) };
});
