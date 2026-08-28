/*
 * local.js — 本機對戰引擎（純前端）
 *
 * 對 client.js 而言，它跟連線伺服器長得一模一樣：吃同樣的訊息、
 * 吐同樣的 sync 快照。因此 GitHub Pages 這種只能放靜態檔的環境，
 * 也能用同一套 UI 玩「對電腦」或「同一台裝置輪流」。
 */
(function (root) {
  'use strict';
  var Rules = root.Rules;
  var AI = root.AI;

  root.LocalEngine = function (emit) {
    var seats = [];         // { kind:'human'|'ai', name, level }
    var state = null;
    var history = [];
    var lastAiMove = {};
    var timer = null;
    var mySeat = 0;
    var AI_DELAY = 500;

    function publicSeats() {
      return seats.map(function (s, i) {
        return {
          index: i,
          kind: s.kind,
          name: s.name,
          level: s.level,
          connected: true,
          corner: state ? state.seats[i] : Rules.seatsFor(seats.length)[i],
          dest: state ? state.dests[i] : Rules.opposite(Rules.seatsFor(seats.length)[i]),
          home: state ? Rules.progress(state, i) : 0
        };
      });
    }

    function snapshot() {
      return {
        t: 'sync',
        room: {
          code: '本機',
          local: true,
          numPlayers: seats.length,
          started: !!state,
          seats: publicSeats(),
          chat: [],
          history: history.slice(-60)
        },
        game: state ? {
          board: state.board,
          turn: state.turn,
          turnCount: state.turnCount,
          finished: state.finished,
          over: state.over,
          seats: state.seats,
          dests: state.dests,
          lastMove: state.lastMove
        } : null
      };
    }

    function sync() { emit(snapshot()); }

    function record(seatIndex, move) {
      history.push({
        seat: seatIndex,
        from: move.from,
        to: move.to,
        jump: move.jump,
        hops: move.path ? move.path.length - 1 : 1,
        n: state.turnCount
      });
    }

    function scheduleAI() {
      clearTimeout(timer);
      if (!state || state.over) return;
      if (seats[state.turn].kind !== 'ai') return;
      timer = setTimeout(playAI, AI_DELAY);
    }

    function playAI() {
      if (!state || state.over) return;
      var p = state.turn;
      if (seats[p].kind !== 'ai') return;
      var move = AI.chooseMove(state, p, seats[p].level, lastAiMove);
      if (!move) { sync(); return; }
      lastAiMove[p] = { from: move.from, to: move.to };
      var res = Rules.applyMove(state, p, move.from, move.to);
      if (res.ok) record(p, res.move);
      sync();
      scheduleAI();
    }

    /**
     * 「同一台裝置輪流」時，目前輪到誰，前端就把誰當成自己，
     * 這樣點擊與提示邏輯完全沿用連線版。
     */
    function activeSeat() {
      if (!state || state.over) return mySeat;
      return seats[state.turn].kind === 'human' ? state.turn : mySeat;
    }

    function start(cfg) {
      seats = cfg.seats.map(function (s, i) {
        return {
          kind: s.kind === 'ai' ? 'ai' : 'human',
          name: s.name || (s.kind === 'ai' ? '電腦 ' + (i + 1) : '玩家 ' + (i + 1)),
          level: s.level || 'normal'
        };
      });
      mySeat = seats.findIndex(function (s) { return s.kind === 'human'; });
      if (mySeat < 0) mySeat = 0;
      state = Rules.createState(seats.length);
      history = [];
      lastAiMove = {};
      emit({ t: 'welcome', code: '本機', seat: mySeat, token: null, hostSeat: 0, local: true });
      sync();
      scheduleAI();
    }

    return {
      isLocal: true,
      activeSeat: activeSeat,
      send: function (msg) {
        switch (msg.t) {
          case 'localStart':
            start(msg);
            break;

          case 'move': {
            if (!state) return emit({ t: 'error', msg: '對局尚未開始' });
            var p = state.turn;
            if (seats[p].kind !== 'human') return emit({ t: 'error', msg: '現在是電腦的回合' });
            var res = Rules.applyMove(state, p, Number(msg.from), Number(msg.to));
            if (!res.ok) return emit({ t: 'error', msg: res.error });
            record(p, res.move);
            sync();
            scheduleAI();
            break;
          }

          case 'restart':
            if (!seats.length) return;
            state = Rules.createState(seats.length);
            history = [];
            lastAiMove = {};
            emit({ t: 'welcome', code: '本機', seat: mySeat, token: null, hostSeat: 0, local: true });
            sync();
            scheduleAI();
            break;

          case 'stop':
            clearTimeout(timer);
            state = null;
            seats = [];
            break;
        }
      }
    };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
