// ============================================================
//  실시간 퀴즈 게임 서버 (교실용)
//  - QR 접속 / 객관식·주관식 / 정답+속도 보너스 / 실시간 순위
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
  do {
    pin = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms[pin]);
  return pin;
}

// 점수 계산: 정답이면 기본 100점 + 남은 시간 비율에 따른 속도 보너스(최대 100)
function calcScore(isCorrect, elapsedMs, limitMs) {
  if (!isCorrect) return 0;
  const base = 100;
  const remain = Math.max(0, limitMs - elapsedMs);
  const speedBonus = Math.round((remain / limitMs) * 100);
  return base + speedBonus;
}

function leaderboard(room) {
  return Object.values(room.players)
    .map((p) => ({ name: p.name, score: p.score, lastGain: p.lastGain || 0 }))
    .sort((a, b) => b.score - a.score);
}

function normalize(str) {
  return String(str).trim().toLowerCase().replace(/\s+/g, '');
}

io.on('connection', (socket) => {
  socket.on('host:create', (quiz, cb) => {
    const pin = makePin();
    rooms[pin] = {
      pin,
      hostId: socket.id,
      players: {},
      quiz: quiz && quiz.questions ? quiz : { title: '퀴즈', questions: [] },
      state: 'lobby',
      currentIndex: -1,
      questionStartAt: 0,
    };
    socket.join(pin);
    socket.data.pin = pin;
    socket.data.role = 'host';
    cb && cb({ ok: true, pin });
  });

  socket.on('player:join', ({ pin, name }, cb) => {
    const room = rooms[pin];
    if (!room) return cb && cb({ ok: false, error: '존재하지 않는 방 번호입니다.' });
    if (room.state !== 'lobby')
      return cb && cb({ ok: false, error: '이미 시작된 게임입니다.' });

    const clean = String(name || '').trim().slice(0, 12) || '학생';
    room.players[socket.id] = {
      name: clean,
      score: 0,
      answered: false,
      lastGain: 0,
    };
    socket.join(pin);
    socket.data.pin = pin;
    socket.data.role = 'player';

    cb && cb({ ok: true, name: clean });
    io.to(room.hostId).emit('host:players', {
      count: Object.keys(room.players).length,
      names: Object.values(room.players).map((p) => p.name),
    });
  });

  socket.on('host:next', () => {
    const pin = socket.data.pin;
    const room = rooms[pin];
    if (!room || room.hostId !== socket.id) return;

    room.currentIndex += 1;
    if (room.currentIndex >= room.quiz.questions.length) {
      room.state = 'ended';
      io.to(pin).emit('game:ended', { leaderboard: leaderboard(room) });
      return;
    }

    const q = room.quiz.questions[room.currentIndex];
    room.state = 'question';
    room.questionStartAt = Date.now();
    Object.values(room.players).forEach((p) => (p.answered = false));

    const limit = q.time || 20;
    io.to(room.hostId).emit('host:question', {
      index: room.currentIndex,
      total: room.quiz.questions.length,
      question: q.q,
      type: q.type,
      options: q.options || [],
      time: limit,
    });
    Object.keys(room.players).forEach((sid) => {
      io.to(sid).emit('player:question', {
        index: room.currentIndex,
        total: room.quiz.questions.length,
        question: q.q,
        type: q.type,
        options: (q.options || []).map((o, i) => ({ i, text: o })),
        time: limit,
      });
    });
  });

  socket.on('player:answer', ({ answer }, cb) => {
    const pin = socket.data.pin;
    const room = rooms[pin];
    if (!room || room.state !== 'question') return;
    const player = room.players[socket.id];
    if (!player || player.answered) return;

    const q = room.quiz.questions[room.currentIndex];
    const limit = (q.time || 20) * 1000;
    const elapsed = Date.now() - room.questionStartAt;

    let isCorrect = false;
    if (q.type === 'mc') {
      isCorrect = Number(answer) === Number(q.answer);
    } else {
      const accepts = Array.isArray(q.answer) ? q.answer : [q.answer];
      isCorrect = accepts.some((a) => normalize(a) === normalize(answer));
    }

    const gain = calcScore(isCorrect, elapsed, limit);
    player.score += gain;
    player.lastGain = gain;
    player.answered = true;

    cb && cb({ ok: true, correct: isCorrect, gain });

    const answered = Object.values(room.players).filter((p) => p.answered).length;
    io.to(room.hostId).emit('host:progress', {
      answered,
      total: Object.keys(room.players).length,
    });
  });

  socket.on('host:reveal', () => {
    const pin = socket.data.pin;
    const room = rooms[pin];
    if (!room || room.hostId !== socket.id) return;
    room.state = 'reveal';
    const q = room.quiz.questions[room.currentIndex];
    const board = leaderboard(room);

    io.to(room.hostId).emit('host:reveal', {
      correctAnswer: q.type === 'mc' ? q.answer : (Array.isArray(q.answer) ? q.answer[0] : q.answer),
      leaderboard: board,
    });
    Object.entries(room.players).forEach(([sid, p]) => {
      const rank = board.findIndex((b) => b.name === p.name && b.score === p.score) + 1;
      io.to(sid).emit('player:reveal', {
        score: p.score,
        lastGain: p.lastGain,
        rank,
        total: board.length,
      });
    });
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
  console.log('====================================');
  console.log('  퀴즈 게임 서버 실행 중');
  console.log(`  교사 화면 : http://${localIP()}:${PORT}/host.html`);
  console.log(`  학생 접속 : http://${localIP()}:${PORT}/`);
  console.log('====================================');
});
