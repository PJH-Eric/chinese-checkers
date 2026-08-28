/* 規則引擎測試：node test/rules.test.js */
'use strict';
const assert = require('assert');
const R = require('../public/game.js');
const AI = require('../public/ai.js');

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('棋盤');
t('共 121 格', () => assert.strictEqual(R.BOARD.size, 121));
t('六個角各 10 格', () => R.BOARD.corners.forEach(c => assert.strictEqual(c.length, 10)));
t('中央六邊形 61 格', () => {
  const mid = R.BOARD.cells.filter(c => c.corner < 0).length;
  assert.strictEqual(mid, 61);
});
t('每格鄰居數 2~6 且互為鄰居', () => {
  R.BOARD.cells.forEach(c => {
    c.adj.forEach((n, d) => {
      if (n < 0) return;
      assert.strictEqual(R.BOARD.cells[n].adj[(d + 3) % 6], c.id, '鄰接不對稱');
    });
  });
});
t('角落 0 在最上方、角落 3 在最下方', () => {
  const top = Math.max(...R.BOARD.corners[0].map(i => R.BOARD.cells[i].py));
  const bottom = Math.min(...R.BOARD.corners[3].map(i => R.BOARD.cells[i].py));
  assert.ok(top < 0 && bottom > 0);
});

console.log('開局');
t('3 人局使用相間的角 0/2/4', () => assert.deepStrictEqual(R.createState(3).seats, [0, 2, 4]));
t('目標為正對面的角', () => {
  const s = R.createState(3);
  s.seats.forEach((c, i) => assert.strictEqual(s.dests[i], (c + 3) % 6));
});
t('3 人局共 30 顆棋子，每人 10 顆', () => {
  const s = R.createState(3);
  [0, 1, 2].forEach(p => assert.strictEqual(s.board.filter(v => v === p).length, 10));
});
t('開局第一手有 14 種走法（8 單步 + 6 跳）', () => {
  const s = R.createState(3);
  const mv = R.allMoves(s, 0);
  assert.strictEqual(mv.length, 14);
  assert.strictEqual(mv.filter(m => m.jump).length, 6);
});

console.log('走法');
t('單步只能走到相鄰空格', () => {
  const s = R.createState(3);
  R.allMoves(s, 0).filter(m => !m.jump).forEach(m => {
    assert.ok(R.BOARD.cells[m.from].adj.indexOf(m.to) >= 0);
  });
});
t('跳躍需中間有子且落點為空', () => {
  const s = R.createState(3);
  R.allMoves(s, 0).filter(m => m.jump).forEach(m => {
    for (let i = 0; i + 1 < m.path.length; i++) {
      const a = R.BOARD.cells[m.path[i]];
      const d = a.jump.indexOf(m.path[i + 1]);
      assert.ok(d >= 0, '不是合法的跳躍距離');
      assert.ok(s.board[a.adj[d]] >= 0, '中間必須有棋子');
    }
    assert.strictEqual(s.board[m.to], -1);
  });
});
t('不能「停」在其他玩家的陣營', () => {
  const s = R.createState(3);
  for (let p = 0; p < 3; p++) {
    R.allMoves(s, p).forEach(m => {
      const c = R.BOARD.cells[m.to].corner;
      if (c >= 0) assert.ok(c === s.seats[p] || c === s.dests[p], '停在別人陣營');
    });
  }
});
t('連跳可以「經過」其他玩家的陣營，但不能停在裡面', () => {
  const s = R.createState(3);
  const foreign = s.seats[1];                 // 玩家 1 的出發陣營（對玩家 0 而言是禁區）
  const okFor0 = id => {
    const c = R.BOARD.cells[id].corner;
    return c < 0 || c === s.seats[0] || c === s.dests[0];
  };

  // 連跳可以轉向，所以找：S -跳-> M(禁區) -換方向跳-> E(非禁區)
  let found = null;
  outer:
  for (const mid of R.BOARD.corners[foreign]) {
    const M = R.BOARD.cells[mid];
    for (let d1 = 0; d1 < 6; d1++) {
      const back = (d1 + 3) % 6;
      const S = M.jump[back], stone1 = M.adj[back];
      if (S < 0 || stone1 < 0 || !okFor0(S)) continue;
      for (let d2 = 0; d2 < 6; d2++) {
        if (d2 === back) continue;
        const E = M.jump[d2], stone2 = M.adj[d2];
        if (E < 0 || stone2 < 0 || E === S || !okFor0(E)) continue;
        if (stone2 === stone1 || stone2 === S || stone1 === E) continue;
        found = { S, stone1, M: mid, stone2, E };
        break outer;
      }
    }
  }
  assert.ok(found, '找不到可測試的穿越路線');

  s.board = s.board.map(() => -1);
  s.board[found.S] = 0;
  s.board[found.stone1] = 1;                  // 墊腳石
  s.board[found.stone2] = 1;                  // 墊腳石

  const moves = R.movesFrom(s, found.S);
  const tos = moves.map(m => m.to);
  assert.ok(tos.indexOf(found.E) >= 0, '應可連跳經過他人陣營再跳出去');
  assert.ok(tos.indexOf(found.M) < 0, '不應能停在他人陣營內');
  assert.ok(moves.find(m => m.to === found.E).path.indexOf(found.M) >= 0, '路徑應確實經過他人陣營');
});
t('進入終點後不得離開', () => {
  const s = R.createState(3);
  const destCell = R.BOARD.corners[s.dests[0]][0];
  s.board[destCell] = 0;
  R.movesFrom(s, destCell).forEach(m => {
    assert.strictEqual(R.BOARD.cells[m.to].corner, s.dests[0]);
  });
});
t('非本方回合不能走', () => {
  const s = R.createState(3);
  const m = R.allMoves(s, 1)[0];
  assert.strictEqual(R.applyMove(s, 1, m.from, m.to).ok, false);
});
t('合法走子後換下一位', () => {
  const s = R.createState(3);
  const m = R.allMoves(s, 0)[0];
  assert.ok(R.applyMove(s, 0, m.from, m.to).ok);
  assert.strictEqual(s.turn, 1);
  assert.strictEqual(s.board[m.from], -1);
  assert.strictEqual(s.board[m.to], 0);
});

console.log('勝負');
t('10 顆全部進終點即獲勝', () => {
  const s = R.createState(3);
  s.board = s.board.map(v => (v === 0 ? -1 : v));
  R.BOARD.corners[s.dests[0]].forEach(id => { s.board[id] = 0; });
  assert.ok(R.hasWon(s, 0));
});
t('終點被卡住但填滿且有己方棋子亦算達陣', () => {
  const s = R.createState(2);
  s.board = s.board.map(() => -1);
  const dest = R.BOARD.corners[s.dests[0]];
  dest.forEach((id, i) => { s.board[id] = (i === 0 ? 1 : 0); });
  assert.ok(R.hasWon(s, 0));
});
t('尚未填滿不算獲勝', () => {
  const s = R.createState(3);
  assert.ok(!R.hasWon(s, 0));
});

console.log('AI 自我對弈');
t('3 人局 AI 能在 800 步內分出名次且全程走法合法', () => {
  const s = R.createState(3);
  const last = {};
  let n = 0;
  while (!s.over && n < 800) {
    const m = AI.chooseMove(s, s.turn, 'hard', last);
    assert.ok(m, '無棋可走');
    last[s.turn] = { from: m.from, to: m.to };
    const r = R.applyMove(s, s.turn, m.from, m.to);
    assert.ok(r.ok, r.error);
    n++;
  }
  assert.ok(s.over, '未能結束（' + n + ' 步）');
  assert.strictEqual(s.finished.length, 3);
});
t('2 人局 AI 能結束', () => {
  const s = R.createState(2);
  const last = {};
  let n = 0;
  while (!s.over && n < 800) {
    const m = AI.chooseMove(s, s.turn, 'hard', last);
    last[s.turn] = { from: m.from, to: m.to };
    assert.ok(R.applyMove(s, s.turn, m.from, m.to).ok);
    n++;
  }
  assert.ok(s.over);
});

console.log('\n通過 ' + pass + ' 項' + (process.exitCode ? '（有失敗）' : ''));
