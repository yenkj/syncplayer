const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

const rooms = {};

io.on('connection', socket => {
  let currentRoom = null;
  let isHost = false;

  socket.on('joinRoom', ({roomId, host}) => {
    currentRoom = roomId;
    isHost = host;
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        hostId: isHost ? socket.id : null,
        users: new Set(),
        playState: { paused: true, time: 0 }
      };
    }
    rooms[roomId].users.add(socket.id);

    // 如果是主持人，设定hostId
    if (isHost) rooms[roomId].hostId = socket.id;

    // 给新加入的客户端同步当前播放状态
    socket.emit('syncState', rooms[roomId].playState);

    // 广播当前在线人数
    io.to(roomId).emit('userCount', rooms[roomId].users.size);

    // 通知聊天室
    io.to(roomId).emit('chatMessage', {user: '系统', message: `用户${socket.id.substring(0,4)}加入房间`});
  });

  socket.on('playbackAction', ({roomId, action, currentTime}) => {
    if (!rooms[roomId]) return;
    // 只有主持人能控制
    if (socket.id !== rooms[roomId].hostId) {
      socket.emit('errorMessage', '只有主持人可控制播放');
      return;
    }
    // 更新播放状态
    if (action === 'play') rooms[roomId].playState.paused = false;
    else if (action === 'pause') rooms[roomId].playState.paused = true;
    else if (action === 'seek') rooms[roomId].playState.time = currentTime;

    rooms[roomId].playState.time = currentTime;

    // 同步给其他观众
    socket.to(roomId).emit('syncAction', {action, currentTime});
  });

  socket.on('sendMessage', ({roomId, user, message}) => {
    io.to(roomId).emit('chatMessage', {user, message});
  });

  socket.on('disconnecting', () => {
    if (!currentRoom) return;
    if (rooms[currentRoom]) {
      rooms[currentRoom].users.delete(socket.id);
      if (rooms[currentRoom].hostId === socket.id) {
        rooms[currentRoom].hostId = null;
        io.to(currentRoom).emit('chatMessage', {user:'系统', message:'主持人已离开，播放控制失效'});
      }
      io.to(currentRoom).emit('userCount', rooms[currentRoom].users.size);
    }
  });
});

http.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
