// ==========================================
// Node.js ローカルサーバー
// 起動: node server-local.js
// ==========================================

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8000;

// メモリストレージ
const users = new Map();
const penalties = new Map();
const sseClients = new Map();

// 設定（テスト用：短いペナルティ）
const TIMEOUT_MS = 10 * 60 * 1000;
const PENALTY_MS = 10 * 1000; // テスト用: 10秒（本番は10分）

// MIMEタイプ
const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
};

// ブロードキャスト
function broadcast(msg, excludeUuid) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const [uuid, res] of sseClients) {
    if (uuid === excludeUuid) continue;
    try {
      res.write(data);
    } catch (e) {
      sseClients.delete(uuid);
    }
  }
}

// 特定クライアントに送信
function sendTo(uuid, msg) {
  const res = sseClients.get(uuid);
  if (res) {
    try {
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    } catch (e) {
      sseClients.delete(uuid);
    }
  }
}

// クリーンアップ（1分ごと）
setInterval(() => {
  const now = Date.now();
  for (const [uuid, user] of users) {
    if (now - user.lastActive > TIMEOUT_MS) {
      users.delete(uuid);
      broadcast({ type: "userTimeout", uuid, name: user.name });
      console.log(`⏰ Timeout: ${user.name}`);
    }
  }
}, 60 * 1000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // SSE
  if (url.pathname === '/events') {
    const uuid = url.searchParams.get('uuid');
    if (!uuid) {
      res.writeHead(400);
      res.end('Missing uuid');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    res.write(': connected\n\n');
    sseClients.set(uuid, res);
    console.log(`🔗 SSE接続: ${uuid.slice(0,8)}...`);

    const keepAlive = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch (e) {
        clearInterval(keepAlive);
      }
    }, 30000);

    req.on('close', () => {
      sseClients.delete(uuid);
      clearInterval(keepAlive);
      console.log(`❌ SSE切断: ${uuid.slice(0,8)}...`);
    });
    return;
  }

  // API: roomAction
  if (url.pathname === '/roomAction' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { uuid, name, charId, action, targetRoom, message, isRefresh } = data;
        const now = Date.now();

        // チャット
        if (action === 'chat') {
          if (!message || message.length > 30) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '30文字以内で入力してください' }));
            return;
          }
          const user = users.get(uuid);
          if (!user) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ログインしていません' }));
            return;
          }
          const lastChatTime = user.lastChatTime || 0;
          if (now - lastChatTime < 5000) {
            const wait = Math.ceil((5000 - (now - lastChatTime)) / 1000);
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `あと${wait}秒待ってください` }));
            return;
          }
          user.lastChatTime = now;
          user.lastActive = now;
          broadcast({ type: 'chat', uuid, name: user.name, msg: message });
          console.log(`💬 ${user.name}: ${message}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // ハートビート
        if (action === 'heartbeat') {
          const user = users.get(uuid);
          if (user) {
            user.lastActive = now;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(410, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ expired: true }));
          }
          return;
        }

        // 退室
        if (action === 'leave') {
          const user = users.get(uuid);
          if (user) {
            users.delete(uuid);
            penalties.set(uuid, now + PENALTY_MS);
            broadcast({ type: 'userLeft', uuid, name: user.name });
            console.log(`🚪 退室: ${user.name}`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'left' }));
          return;
        }

        // 入室
        if (action === 'join') {
          // ペナルティチェック
          const penaltyEnd = penalties.get(uuid);
          if (penaltyEnd && penaltyEnd > now) {
            const remainMin = Math.ceil((penaltyEnd - now) / 60000);
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `あと${remainMin}分待ってから入室してください` }));
            return;
          }

          // 既存セッション復帰
          const existing = users.get(uuid);
          if (existing) {
            existing.lastActive = now;
            if (charId) existing.charId = charId;
            console.log(`🔄 復帰: ${existing.name}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'restored', user: existing }));
            return;
          }

          // 新規参加
          const userState = {
            uuid, name, charId: charId || '1', room: targetRoom || 'A', lastActive: now, joinedAt: now
          };
          users.set(uuid, userState);
          broadcast({ type: 'userJoined', user: userState }, uuid);
          console.log(`✨ 入室: ${name} (キャラ${charId})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'joined', user: userState }));
          return;
        }

        // 部屋移動
        if (action === 'move') {
          const user = users.get(uuid);
          if (user) {
            user.room = targetRoom;
            user.lastActive = now;
            broadcast({ type: 'userMoved', user }, uuid);
            console.log(`🚶 移動: ${user.name} → Room ${targetRoom}`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'moved' }));
          return;
        }

        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unknown action' }));

      } catch (e) {
        console.error('Error:', e);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return;
  }

  // API: signal
  if (url.pathname === '/signal' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        sendTo(data.targetUuid, { type: 'signal', from: data.uuid, to: data.targetUuid, data: data.signalData });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return;
  }

  // API: users
  if (url.pathname === '/users' && req.method === 'GET') {
    const room = url.searchParams.get('room');
    const result = [];
    for (const user of users.values()) {
      if (!room || user.room === room) result.push(user);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // 静的ファイル
  let filePath = url.pathname === '/' ? '/chat.html' : url.pathname;
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not Found');
      } else {
        res.writeHead(500);
        res.end('Server Error');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('🎮 じっけんしつ ローカルサーバー');
  console.log('================================');
  console.log(`📍 URL: http://localhost:${PORT}/chat.html`);
  console.log('');
  console.log('⚠️  テスト用のペナルティを無効化するには:');
  console.log('    PENALTY_MS を 0 に変更してください');
  console.log('');
  console.log('Ctrl+C で終了');
  console.log('================================');
});
