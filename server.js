// ============================================================
//  실시간 퀴즈 게임 서버 (교실용)
//  - QR 접속 / 객관식·주관식 / 정답+속도 보너스 / 실시간 순위
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

// ---- 방(세션) 저장소 : 메모리 기반 ----
// rooms[pin] = { hostId, players:{socketId:{name,score,answered,...}}, quiz, state, currentIndex, questionStartAt }
const rooms = {};

function makePin() {
  let pin;
  do {
    pin = String(Math.floor(1000 + Math.random() * 9000)); // 4자리
  } while (rooms[pin]);
  return pin;
}

// 점수 계산: 정답이면 기본 1000점 + 남은 시간 비율에 따른 속도 보너스(최대 1000)
function calcScore(isCorrect, elapsedMs, limitMs) {
  if (!isCorrect) return 0;
  const base = 1000;
  const remain = Math.max(0, limitMs - elapsedMs);
  const speedBonus = Math.round((remain / limitMs) * 1000);
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
  // ---------- 교사: 방 생성 ----------
  socket.on('host:create', (quiz, cb) => {
    const pin = makePin();
    rooms[pin] = {
      pin,
      hostId: socket.id,
      players: {},
      quiz: quiz && quiz.questions ? quiz : { title: '퀴즈', questions: [] },
      state: 'lobby', // lobby | question | reveal | ended
      currentIndex: -1,
      questionStartAt: 0,
    };
    socket.join(pin);
    socket.data.pin = pin;
    socket.data.role = 'host';
    cb && cb({ ok: true, pin });
  });

  // ---------- 학생: 방 참가 ----------
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
    // 교사 화면에 참가자 명단 갱신
    io.to(room.hostId).emit('host:players', {
      count: Object.keys(room.players).length,
      names: Object.values(room.players).map((p) => p.name),
    });
  });

  // ---------- 교사: 다음 문제 진행 ----------
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

    const limit = q.time || 20; // 초
    // 교사: 문제/보기 전체 전송
    io.to(room.hostId).emit('host:question', {
      index: room.currentIndex,
      total: room.quiz.questions.length,
      question: q.q,
      type: q.type,
      options: q.options || [],
      time: limit,
    });
    // 학생: 문제와 보기(주관식이면 입력창)
    room.playerSockets = Object.keys(room.players);
    room.playerSockets.forEach((sid) => {
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

  // ---------- 학생: 답안 제출 ----------
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
      // 주관식: 허용 정답 목록 중 하나와 일치(공백/대소문자 무시)
      const accepts = Array.isArray(q.answer) ? q.answer : [q.answer];
      isCorrect = accepts.some((a) => normalize(a) === normalize(answer));
    }

    const gain = calcScore(isCorrect, elapsed, limit);
    player.score += gain;
    player.lastGain = gain;
    player.answered = true;

    cb && cb({ ok: true, correct: isCorrect, gain });

    // 교사에게 응답 수 갱신
    const answered = Object.values(room.players).filter((p) => p.answered).length;
    io.to(room.hostId).emit('host:progress', {
      answered,
      total: Object.keys(room.players).length,
    });
  });

  // ---------- 교사: 문제 마감 후 순위 공개 ----------
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
    // 학생 개인에게 현재 순위/점수 알려주기
    board.forEach((entry, rank) => {
      // 이름으로 매칭
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

  // ---------- 연결 종료 처리 ----------
  socket.on('disconnect', () => {
    const pin = socket.data.pin;
    const room = rooms[pin];
    if (!room) return;
    if (socket.data.role === 'host') {
      // 교사가 나가면 방 종료
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

// 접속 주소 안내용 로컬 IP
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
