const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

const rooms = {};

io.on('connection', (socket) => {
  console.log('用户连接:', socket.id);

  // 普通用户加入房间
  socket.on('joinRoom', ({ room, username, watchPassword }, callback) => {
    if (!room || !username) {
      return callback({ success: false, message: '房间名和用户名不能为空' });
    }

    const roomData = rooms[room];

    if (!roomData) {
      return callback({ success: false, message: '房间不存在，请等待主持人创建' });
    }

    if (roomData.watchPassword === null) {
      return callback({ success: false, message: '房间观看密码尚未设置，请稍后再试' });
    }

    if (roomData.watchPassword !== watchPassword) {
      return callback({ success: false, message: '观看密码错误' });
    }

    socket.join(room);
    roomData.users[socket.id] = username;
    socket.data.room = room;
    socket.data.username = username;

    socket.emit('videoUpdate', {
      videoUrl: roomData.videoUrl,
      subtitleUrl: roomData.subtitleUrl,
    });
    socket.emit('videoState', roomData.videoState);

    socket.to(room).emit('chatMessage', {
      id: '系统',
      msg: `${username} 加入了房间`,
    });

    callback({ success: true });
  });

  // 主持人登录或首次创建房间（携带主持人密码和观看密码）
  socket.on('hostLogin', ({ room, hostPassword, watchPassword, username }, callback) => {
    if (!room || !hostPassword || !watchPassword || !username) {
      return callback({ success: false, message: '参数不完整' });
    }

    let roomData = rooms[room];

    if (!roomData) {
      // 首次创建房间，主持人设定密码
      rooms[room] = {
        hostPassword,
        watchPassword,
        hostId: socket.id,
        videoUrl: '',
        subtitleUrl: '',
        videoState: {
          playing: false,
          currentTime: 0,
          lastUpdate: Date.now(),
        },
        users: {},
      };
      roomData = rooms[room];
      console.log(`房间 ${room} 被首次创建，主持人设定密码`);
    } else {
      // 房间已存在，验证主持人密码
      if (roomData.hostPassword !== hostPassword) {
        return callback({ success: false, message: '主持人密码错误' });
      }
      if (roomData.hostId) {
        return callback({ success: false, message: '房间已有主持人' });
      }
      roomData.hostId = socket.id;
    }

    socket.join(room);
    roomData.users[socket.id] = username;
    socket.data.room = room;
    socket.data.username = username;

    socket.emit('hostAssigned');
    socket.emit('videoUpdate', {
      videoUrl: roomData.videoUrl,
      subtitleUrl: roomData.subtitleUrl,
    });
    socket.emit('videoState', roomData.videoState);

    socket.to(room).emit('chatMessage', {
      id: '系统',
      msg: `${username} 成为主持人`,
    });

    callback({ success: true });
  });

  // 主持人修改密码
  socket.on('hostChangePasswords', ({ newHostPassword, newWatchPassword }, callback) => {
    const room = socket.data.room;
    if (!room || !rooms[room]) return callback({ success: false, message: '房间不存在' });
    if (rooms[room].hostId !== socket.id) return callback({ success: false, message: '无权限' });

    if (newHostPassword) rooms[room].hostPassword = newHostPassword;
    if (newWatchPassword) rooms[room].watchPassword = newWatchPassword;

    callback({ success: true, message: '密码已更新' });
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
