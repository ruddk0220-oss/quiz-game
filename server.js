// ============================================================
//  실시간 퀴즈 게임 서버 (교실용) - 개인전 방식
//  점수: 정답이면 기본 100점 + 속도 보너스(최대 100점)
// ============================================================
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function makePin() {
  let pin;
  do { pin = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms[pin]);
  return pin;
}

function calcScore(isCorrect, elapsedMs, limitMs) {
  if (!isCorrect) return 0;
  const base = 100;
  const remain = Math.max(0, limitMs - elapsedMs);
  const speedBonus = Math.round((remain / limitMs) * 100);
  return base + speedBonus;
}

function leaderboard(room) {
  return Object.values(room.players)
    .map((p) => ({ name: p.name, score: p.score, progress: p.currentIndex, done: p.done || false }))
    .sort((a, b) => b.score - a.score);
}

function normalize(str) {
  return String(str).trim().toLowerCase().replace(/\s+/g, '');
}

function sendQuestionToPlayer(room, sid) {
  const player = room.players[sid];
  if (!player) return;
  const idx = player.currentIndex;
  if (idx >= room.quiz.questions.length) {
    player.done = true;
    io.to(sid).emit('player:finished', { score: player.score });
    pushLeaderboard(room);
    return;
  }
  const q = room.quiz.questions[idx];
  player.questionStartAt = Date.now();
  player.answered = false;
  io.to(sid).emit('player:question', {
    index: idx,
    total: room.quiz.questions.length,
    question: q.q,
    type: q.type,
    options: (q.options || []).map((o, i) => ({ i, text: o })),
    time: q.time || 20,
  });
}

function pushLeaderboard(room) {
  io.to(room.hostId).emit('host:leaderboard', {
    leaderboard: leaderboard(room),
    total: room.quiz.questions.length,
  });
}

io.on('connection', (socket) => {
  socket.on('host:create', (quiz, cb) => {
    const pin = makePin();
    rooms[pin] = {
      pin, hostId: socket.id, players: {},
      quiz: quiz && quiz.questions ? quiz : { title: '퀴즈', questions: [] },
      state: 'lobby',
    };
    socket.join(pin);
    socket.data.pin = pin;
    socket.data.role = 'host';
    cb && cb({ ok: true, pin });
  });

  socket.on('player:join', ({ pin, name }, cb) => {
    const room = rooms[pin];
    if (!room) return cb && cb({ ok: false, error: '존재하지 않는 방 번호입니다.' });
    if (room.state !== 'lobby') return cb && cb({ ok: false, error: '이미 시작된 게임입니다.' });
    const clean = String(name || '').trim().slice(0, 12) || '학생';
    room.players[socket.id] = { name: clean, score: 0, currentIndex: 0, answered: false, done: false, questionStartAt: 0 };
    socket.join(pin);
    socket.data.pin = pin;
    socket.data.role = 'player';
    cb && cb({ ok: true, name: clean });
    io.to(room.hostId).emit('host:players', {
      count: Object.keys(room.players).length,
      names: Object.values(room.players).map((p) => p.name),
    });
  });

  socket.on('host:start', () => {
    const pin = socket.data.pin;
    const room = rooms[pin];
    if (!room || room.hostId !== socket.id) return;
    room.state = 'playing';
    Object.keys(room.players).forEach((sid) => {
      room.players[sid].currentIndex = 0;
      sendQuestionToPlayer(room, sid);
    });
    pushLeaderboard(room);
  });

  socket.on('player:answer', ({ answer }, cb) => {
    const pin = socket.data.pin;
    const room = rooms[pin];
    if (!room || room.state !== 'playing') return;
    const player = room.players[socket.id];
    if (!player || player.answered || player.done) return;
    const q = room.quiz.questions[player.currentIndex];
    if (!q) return;
    const limit = (q.time || 20) * 1000;
    const elapsed = Date.now() - player.questionStartAt;
    let isCorrect = false;
    if (q.type === 'mc') {
      isCorrect = Number(answer) === Number(q.answer);
    } else {
      const accepts = Array.isArray(q.answer) ? q.answer : [q.answer];
      isCorrect = accepts.some((a) => normalize(a) === normalize(answer));
    }
    const gain = calcScore(isCorrect, elapsed, limit);
    player.score += gain;
    player.answered = true;
    cb && cb({ ok: true, correct: isCorrect, gain, score: player.score });
    setTimeout(() => {
      const r = rooms[pin];
      if (!r || !r.players[socket.id]) return;
      r.players[socket.id].currentIndex += 1;
      sendQuestionToPlayer(r, socket.id);
      pushLeaderboard(r);
    }, 1200);
    pushLeaderboard(room);
  });

  socket.on('player:timeout', () => {
    const pin = socket.data.pin;
    const room = rooms[pin];
    if (!room || room.state !== 'playing') return;
    const player = room.players[socket.id];
    if (!player || player.answered || player.done) return;
    player.answered = true;
    player.currentIndex += 1;
    sendQuestionToPlayer(room, socket.id);
    pushLeaderboard(room);
  });

  socket.on('host:final', () => {
    const pin = socket.data.pin;
    const room = rooms[pin];
    if (!room || room.hostId !== socket.id) return;
    io.to(room.hostId).emit('host:final', { leaderboard: leaderboard(room) });
  });

  socket.on('disconnect', () => {
    const pin = socket.data.pin;
    const room = rooms[pin];
    if (!room) return;
    if (socket.data.role === 'host') {
      io.to(pin).emit('game:closed');
      delete rooms[pin];
    } else if (room.players[socket.id]) {
      delete room.players[socket.id];
      io.to(room.hostId).emit('host:players', {
        count: Object.keys(room.players).length,
        names: Object.values(room.players).map((p) => p.name),
      });
      pushLeaderboard(room);
    }
  });
});

function localIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

server.listen(PORT, () => {
  console.log('  퀴즈 게임 서버 실행 중 (개인전) : http://' + localIP() + ':' + PORT + '/host.html');
});
