const express = require('express');
const app = express();
const http = require('http').createServer(app);
const { Server } = require('socket.io');
const io = new Server(http);
const path = require('path');

const HOST_PASSWORD = process.env.HOST_PASSWORD || '123456';

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};            // roomName -> { hostId, videoUrl, subtitleUrl, videoState, users:{socketId:username}, watchPassword }
const passwordToRoom = {};   // watchPassword -> roomName
const hostToRoom = {};       // hostSocketId -> roomName

function broadcastUserList(room) {
  const list = rooms[room] ? Object.values(rooms[room].users) : [];
  io.in(room).emit('userList', list);
}

// 当房间被销毁
function destroyRoom(roomName) {
  if (!rooms[roomName]) return;
  const { watchPassword, hostId } = rooms[roomName];
  io.in(roomName).emit('roomClosed');
  delete passwordToRoom[watchPassword];
  delete hostToRoom[hostId];
  // 强制所有人离开房间
  const sockSet = io.sockets.adapter.rooms.get(roomName);
  if (sockSet) {
    for (let sid of sockSet) {
      const s = io.sockets.sockets.get(sid);
      if (s) s.leave(roomName);
    }
  }
  delete rooms[roomName];
  console.log(`️ 房间 ${roomName} 已销毁`);
}

io.on('connection', socket => {
  console.log('→', socket.id, 'connected');
    // 新增：观众请求当前视频状态（可用于初次进入/重新加载时主动拉取）
  socket.on('getCurrentVideoState', (__, cb) => {
    const room = socket.data?.room;
    if (!room || !rooms[room]) return cb(null); // 无效房间
    const { videoState } = rooms[room];
    cb(videoState);
  });
  socket.on('getLatestViewerState', (_, cb) => {
    const room = socket.data?.room;
    if (!room || !rooms[room]) return cb(null);
    cb(rooms[room].latestViewerState || null);
  });
    // 主动退出
  socket.on('logout', () => {
    const room = socket.data?.room;
    if (room && rooms[room]) {
      delete rooms[room].users[socket.id];
      broadcastUserList(room);
      console.log(`${socket.id} 主动退出房间 ${room}`);
    }

    // 如果是主持人
    if (hostToRoom[socket.id]) {
      const roomName = hostToRoom[socket.id];
      delete hostToRoom[socket.id];
      if (rooms[roomName]) {
        rooms[roomName].hostId = null;
        io.in(roomName).emit('chatMessage', { from: '系统', msg: '主持人已退出' });
        broadcastUserList(roomName);
      }
    }
  socket.leaveAll();
  });
  // 主持人登录
  socket.on('hostLogin', ({ username, hostPassword }, cb) => {
    if (!username || !hostPassword) return cb({ success: false, message: '参数不完整' });
    if (hostPassword !== HOST_PASSWORD) return cb({ success: false, message: '主持人密码错误' });
    socket.data = { role: 'host', username, room: null };
    cb({ success: true });
  });

  // 获取房间列表
  socket.on('getRooms', (_, cb) => {
    if (!socket.data || socket.data.role !== 'host') return cb({ success: false, message: '请先登录主持人' });
    const list = Object.values(rooms).map(r => ({
      roomName: r.roomName,
      hostName: io.sockets.sockets.get(r.hostId)?.data.username,
      hasHost: !!r.hostId,
      watchPassword: r.watchPassword
    }));
    cb({ success: true, rooms: list });
  });

  // 创建房间
  socket.on('createRoom', ({ roomName, watchPassword }, cb) => {
    if (!socket.data || socket.data.role !== 'host') return cb({ success: false, message: '请先登录主持人' });
    if (!roomName) return cb({ success: false, message: '房间名不能为空' });
    if (!watchPassword) return cb({ success: false, message: '观众密码不能为空' });
    if (rooms[roomName]) return cb({ success: false, message: '房间已存在' });
    if (passwordToRoom[watchPassword]) return cb({ success: false, message: '密码已被使用' });

    rooms[roomName] = {
      roomName,
      hostId: socket.id,
      hostName: socket.data.username,
      watchPassword,
      videoUrl: '',
      subtitleUrl: '',
      videoState: { playing: false, currentTime: 0 },
      users: {},
      chatHistory: [],
      latestViewerState: null
    };
    passwordToRoom[watchPassword] = roomName;
    hostToRoom[socket.id] = roomName;

    // 加入房间
    socket.data.room = roomName;
    socket.join(roomName);
    rooms[roomName].users[socket.id] = socket.data.username;
    broadcastUserList(roomName);

    cb({ success: true, message: `房间 ${roomName} 创建成功` });
  });

  // 主持人加入已有房间
  socket.on('joinRoomByHost', ({ roomName }, cb) => {
    if (!socket.data || socket.data.role !== 'host') return cb({ success: false, message: '请先登录主持人' });
    if (!rooms[roomName]) return cb({ success: false, message: '房间不存在' });

    rooms[roomName].hostId = socket.id;
    hostToRoom[socket.id] = roomName;
    socket.data.room = roomName;
    socket.join(roomName);
    rooms[roomName].users[socket.id] = socket.data.username;
    broadcastUserList(roomName);

    // 正确使用 latestViewerState
    const latest = rooms[roomName].latestViewerState;
    let videoState;

    if (latest) {
      videoState = {
        ...latest,
        syncedFrom: 'viewer',
        syncedAt: Date.now()
      };
    } else {
      videoState = rooms[roomName].videoState;
    }

    cb({
      success: true,
      videoUrl: rooms[roomName].videoUrl,
      subtitleUrl: rooms[roomName].subtitleUrl,
      videoState,
      chatHistory: rooms[roomName].chatHistory
    });
  });

  // 观众加入
  socket.on('joinRoom', ({ username, watchPassword }, cb) => {
    if (!username || !watchPassword) return cb({ success: false, message: '参数不完整' });
    const roomName = passwordToRoom[watchPassword];
    if (!roomName || !rooms[roomName]) return cb({ success: false, message: '房间不存在或密码错误' });
    // 昵称冲突
    if (Object.values(rooms[roomName].users).includes(username)) {
      return cb({ success: false, message: '昵称已被使用' });
    }
    socket.data = { role: 'viewer', username, room: roomName };
    socket.join(roomName);
    rooms[roomName].users[socket.id] = username;
    broadcastUserList(roomName);
    // 发送当前视频/字幕/状态
    cb({success: true,room: roomName,videoUrl: rooms[roomName].videoUrl,subtitleUrl: rooms[roomName].subtitleUrl,videoState: rooms[roomName].videoState,chatHistory: rooms[roomName].chatHistory});
  });

  // 聊天
  socket.on('chatMessage', msg => {
    const room = socket.data?.room;
    if (!room || !rooms[room]) return;

    const data = {
      from: socket.data.username,
      fromId: socket.id,
      role: socket.data.role,
      msg: msg,
      timestamp: Date.now()
    };
    if (rooms[room].chatHistory.length >= 500) {
    rooms[room].chatHistory.shift(); // 最多保存 500 条
    }
    rooms[room].chatHistory.push(data);

    io.in(room).emit('chatMessage', data);
  });

  // 主持人 下发视频
  socket.on('hostAddVideo', (url) => {
    const room = hostToRoom[socket.id];
    if (!room) return;
    rooms[room].videoUrl = url;
    rooms[room].videoState = { playing: false, currentTime: 0 };
    io.in(room).emit('videoUpdate', { videoUrl: url });
  });
  // 下发字幕
  socket.on('hostAddSubtitle', (url) => {
    const room = hostToRoom[socket.id];
    if (!room) return;
    rooms[room].subtitleUrl = url;
    io.in(room).emit('videoUpdate', { subtitleUrl: url });
  });
  // 播放/暂停/seek
  socket.on('hostControl', (state) => {
    const room = hostToRoom[socket.id];
    if (!room) return;
    rooms[room].videoState = state;
    io.in(room).emit('videoState', state);
  });

  // 请求用户列表
  socket.on('requestUserList', () => {
    const room = socket.data?.room;
    if (!room) return;
    broadcastUserList(room);
  });
  socket.on('viewerReportVideoState', (state) => {
  	console.log('[✅ 后端收到观众状态]', state);
    const room = socket.data?.room;
    if (!room || !rooms[room]) return;
    console.log('[✅ 后端收到观众状态]', state);
    // ✅ 记录最新观众状态
    rooms[room].latestViewerState = {
      ...state,
      lastUpdatedAt: Date.now()
    };

    // ✅ 不再广播 videoState，也不再 reset host
  });

  // 主持人重连（刷新）
  socket.on('reconnectHost', ({ username, roomName }, cb) => {
    const room = rooms[roomName];

    if (!room) {
      // ✅ 房间不存在，仍设置主持人身份（role），允许前端继续使用 getRooms 等功能
      socket.data = { role: 'host', username };
      return cb({ success: false, message: '房间不存在' });
    }
    if (room.hostName && room.hostName !== username) {
      socket.data = { role: 'host', username, room: null };
      return cb({ success: false, message: '主持人身份不匹配' });
    }
    // ✅ 房间存在，恢复正常绑定
    room.hostId = socket.id;
    hostToRoom[socket.id] = roomName;

    socket.data = { role: 'host', username, room: roomName };
    socket.join(roomName);
    room.users[socket.id] = username;

    broadcastUserList(roomName);
    io.in(roomName).emit('requestViewerVideoState');
    const safeVideoState = room.latestViewerState
      ? {
          ...room.latestViewerState,
          syncedFrom: 'viewer',
          syncedAt: Date.now()
        }
      : room.videoState;    
    cb({
      success: true,
      videoUrl: room.videoUrl,
      subtitleUrl: room.subtitleUrl,
      videoState: safeVideoState,
      chatHistory: room.chatHistory
    });
  });

  // 观众重连（刷新）
  socket.on('reconnectViewer', ({ username, roomName }, cb) => {
    const room = rooms[roomName];
    if (!room) return cb({ success: false, message: '房间不存在' });

    // 避免昵称冲突
    if (Object.values(room.users).includes(username)) {
      return cb({ success: false, message: '昵称已被使用' });
    }

    socket.data = { role: 'viewer', username, room: roomName };
    socket.join(roomName);
    room.users[socket.id] = username;

    broadcastUserList(roomName);

    cb({
      success: true,
      videoUrl: room.videoUrl,
      subtitleUrl: room.subtitleUrl,
      videoState: room.videoState,
      chatHistory: rooms[roomName].chatHistory
    });
  });

  // 销毁房间
socket.on('destroyRoomByHost', (roomName, cb) => {
  if (hostToRoom[socket.id] !== roomName) return cb({ success: false, message: '无权限' });

  destroyRoom(roomName);

  // 清除房间绑定，但不强制主持人下线
  socket.leaveAll();
  delete socket.data.room;

  cb({ success: true });
});

  socket.on('disconnect', () => {
    const room = socket.data?.room;
    if (room && rooms[room]) {
      delete rooms[room].users[socket.id];
      // 如果是 host 掉线
      if (hostToRoom[socket.id] === room) {
        delete hostToRoom[socket.id];
        rooms[room].hostId = null;
        io.in(room).emit('chatMessage', { from: '系统', msg: '主持人离线' });
      }
      broadcastUserList(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`服务器已启动: http://localhost:${PORT}`));
