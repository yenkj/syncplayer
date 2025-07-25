// server.js
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

const rooms = {}; // 保存每个房间的信息

io.on('connection', (socket) => {
  console.log('用户连接:', socket.id);

  socket.on('joinRoom', ({ room, password, username }, callback) => {
    if (!room || !password || !username) {
      return callback({ success: false, message: '参数不完整' });
    }

    if (!rooms[room]) {
      rooms[room] = {
        password,
        hostId: null,
        videoUrl: '',
        subtitleUrl: '',
        videoState: {
          playing: false,
          currentTime: 0,
          lastUpdate: Date.now(),
        },
        users: {},
      };
    } else if (rooms[room].password !== password) {
      return callback({ success: false, message: '密码错误' });
    }

    socket.join(room);
    rooms[room].users[socket.id] = username;
    socket.data.room = room;
    socket.data.username = username;

    // 初始状态发送
    socket.emit('videoUpdate', {
      videoUrl: rooms[room].videoUrl,
      subtitleUrl: rooms[room].subtitleUrl,
    });
    socket.emit('videoState', rooms[room].videoState);

    // 广播新用户加入
    socket.to(room).emit('chatMessage', {
      id: '系统',
      msg: `${username} 加入了房间`
    });

    return callback({ success: true });
  });

  socket.on('loginAsHost', ({ password }, callback) => {
    const room = socket.data.room;
    if (!room || !rooms[room]) return;
    if (rooms[room].hostId) return callback(false);
    if (password === 'admin123') {
      rooms[room].hostId = socket.id;
      socket.emit('hostAssigned');
      callback(true);
    } else {
      callback(false);
    }
  });

  socket.on('chatMessage', (msg) => {
    const room = socket.data.room;
    if (!room || !rooms[room]) return;
    io.to(room).emit('chatMessage', {
      id: socket.data.username || socket.id,
      msg,
    });
  });

  socket.on('hostAddVideo', (url) => {
    const room = socket.data.room;
    if (!room || !rooms[room]) return;
    if (rooms[room].hostId !== socket.id) return;
    rooms[room].videoUrl = url;
    io.to(room).emit('videoUpdate', {
      videoUrl: url,
      subtitleUrl: rooms[room].subtitleUrl,
    });
  });

  socket.on('hostAddSubtitle', (url) => {
    const room = socket.data.room;
    if (!room || !rooms[room]) return;
    if (rooms[room].hostId !== socket.id) return;
    rooms[room].subtitleUrl = url;
    io.to(room).emit('videoUpdate', {
      videoUrl: rooms[room].videoUrl,
      subtitleUrl: url,
    });
  });

  socket.on('hostControl', (state) => {
    const room = socket.data.room;
    if (!room || !rooms[room]) return;
    if (rooms[room].hostId !== socket.id) return;
    rooms[room].videoState = { ...state, lastUpdate: Date.now() };
    socket.to(room).emit('videoState', rooms[room].videoState);
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (!room || !rooms[room]) return;

    const username = socket.data.username;
    delete rooms[room].users[socket.id];

    if (rooms[room].hostId === socket.id) {
      rooms[room].hostId = null;
      io.to(room).emit('chatMessage', { id: '系统', msg: `主持人 ${username} 离开了房间` });
    } else {
      io.to(room).emit('chatMessage', { id: '系统', msg: `${username} 离开了房间` });
    }

    // 如果房间空了，就删除
    if (Object.keys(rooms[room].users).length === 0) {
      delete rooms[room];
      console.log('房间被销毁:', room);
    }
  });
});

const PORT = 3000;
http.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
