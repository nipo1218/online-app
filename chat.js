// chat.js - Deno Deploy 最適化版

// ★URLを空文字にする（同じサーバーに通信するため、リクエストが半減します）
const SERVER_URL = "";

// --- 設定 ---
const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const SPEED = 2.0;
// ★ハートビートを8分に変更（サーバーは10分まで待ってくれるのでこれで十分）
const HEARTBEAT_INTERVAL = 8 * 60 * 1000;

// ジャンプ設定
const JUMP_FORCE = -6;
const GRAVITY = 0.3;

// Y座標制限
const MIN_Y = 80;
const MAX_Y = 188;

// 初期位置
const SPAWN_X = 357;
const SPAWN_Y = 178;

// 部屋移動ポイント
const PORTAL_X = 30;
const PORTAL_Y = 80;
const PORTAL_TOLERANCE = 15;

// --- 状態管理 ---
let eventSource = null;
let currentRoom = "A";
let sessionStatus = "none";
let obsMode = false;
let debugMode = false;
let myData = { 
    x: SPAWN_X, y: SPAWN_Y, z: 0, vz: 0,
    name: "", charId: "1", msg: ""
};
let keys = {};
let players = {};

// クリック移動用
let targetX = null;
let targetY = null;

// WebRTC管理
let peers = {};
let dataChannels = {};
let pendingCandidates = {};

// タイマー
let heartbeatTimer = null;
let lastActivity = Date.now();
let hasActivity = false;

// エフェクト
let particles = [];

// UUID永続化
let myUuid = localStorage.getItem("game_uuid");
if (!myUuid) {
    myUuid = crypto.randomUUID();
    localStorage.setItem("game_uuid", myUuid);
}
let storedName = localStorage.getItem("game_name");
let storedCharId = localStorage.getItem("game_charId") || "1";

// --- DOM ---
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const loginScreen = document.getElementById('login-screen');
const bottomUI = document.getElementById('bottom-ui');
const roomBadge = document.getElementById('room-badge');
const roomName = document.getElementById('room-name');
const obsExitBtn = document.getElementById('obs-exit-btn');
const debugInfo = document.getElementById('debug-info');

// --- 画像読み込み ---
const images = {};
['1','2','3','4'].forEach(id => {
    const img = new Image();
    img.src = `${id}.png`;
    images[id] = img;
});

// ==========================================
// 0. 初期化
// ==========================================
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('dblclick', e => e.preventDefault());

// キャラ選択
document.querySelectorAll('.char-opt').forEach(opt => {
    opt.addEventListener('click', () => {
        document.querySelectorAll('.char-opt').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
    });
});

if (storedCharId) {
    document.querySelectorAll('.char-opt').forEach(o => o.classList.remove('selected'));
    const savedOpt = document.querySelector(`.char-opt[data-id="${storedCharId}"]`);
    if (savedOpt) savedOpt.classList.add('selected');
}

// 名前入力欄
const usernameInput = document.getElementById('username');
if (storedName) {
    usernameInput.value = storedName;
    usernameInput.disabled = true;
    usernameInput.title = "名前は変更できません";
}

// ==========================================
// 1. ゲーム開始フロー
// ==========================================
document.getElementById('start-btn').addEventListener('click', () => {
    const name = usernameInput.value.trim() || storedName;
    
    if (!name) {
        showError("おなまえをいれてね");
        return;
    }
    
    if (storedName) {
        startGame();
    } else {
        document.getElementById('confirm-name-display').textContent = `「${name}」`;
        document.getElementById('name-confirm-modal').style.display = 'flex';
    }
});

function closeNameConfirm() {
    document.getElementById('name-confirm-modal').style.display = 'none';
}

async function confirmNameAndJoin() {
    closeNameConfirm();
    await startGame();
}

async function startGame() {
    const name = usernameInput.value.trim() || storedName;
    
    myData.name = name;
    
    const selected = document.querySelector('.char-opt.selected');
    if (selected) {
        myData.charId = selected.dataset.id;
        localStorage.setItem("game_charId", myData.charId);
    }

    myData.x = SPAWN_X;
    myData.y = SPAWN_Y;

    try {
        const res = await fetch(`${SERVER_URL}/roomAction`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                uuid: myUuid,
                name: myData.name,
                charId: myData.charId,
                action: "join",
                targetRoom: currentRoom
            })
        });

        const data = await res.json();
        
        if (data.error) {
            showError(data.error);
            return;
        }

        localStorage.setItem("game_name", myData.name);

        if (data.status === "restored") {
            sessionStatus = "restored";
            currentRoom = data.user.room;
            addLog("System", "セッションを復帰しました");
        } else {
            sessionStatus = "joined";
            addLog("System", "入室しました");
        }

        loginScreen.style.display = 'none';
        bottomUI.style.display = 'flex';
        updateRoomUI();

        connectSSE();
        await fetchUsersAndConnect();
        startHeartbeat();
        startActivityMonitor();
        gameLoop();

    } catch (e) {
        console.error("Join failed:", e);
        showError("接続に失敗しました。しばらく待ってからお試しください。");
    }
}

// ==========================================
// 2. モーダル関連
// ==========================================
function showError(message) {
    document.getElementById('error-message').textContent = message;
    document.getElementById('error-modal').style.display = 'flex';
}

function closeErrorModal() {
    document.getElementById('error-modal').style.display = 'none';
}

function openExitModal() {
    document.getElementById('confirm-modal').style.display = 'flex';
}

function closeExitModal() {
    document.getElementById('confirm-modal').style.display = 'none';
}

// ==========================================
// 3. SSE接続
// ==========================================
function connectSSE() {
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }

    eventSource = new EventSource(`${SERVER_URL}/events?uuid=${myUuid}`);

    eventSource.onopen = () => console.log("SSE Connected");

    eventSource.onmessage = async (e) => {
        const msg = JSON.parse(e.data);

        // ★チャット受信 (サーバー経由)
        if (msg.type === "chat") {
            const senderName = msg.name || "???";
            addLog(senderName, msg.msg);
            
            // 吹き出し表示
            if (players[msg.uuid]) {
                players[msg.uuid].msg = msg.msg;
                setTimeout(() => { if(players[msg.uuid]) players[msg.uuid].msg = ""; }, 5000);
            } else if (msg.uuid === myUuid) {
                // 自分
                myData.msg = msg.msg;
                setTimeout(() => myData.msg = "", 5000);
            }
        }

        if (msg.type === "userJoined") {
            const user = msg.user;
            if (user.uuid === myUuid) return;
            if (user.room === currentRoom) {
                addLog("System", `${user.name}さんが入室`);
                createPeerConnection(user.uuid, true);
            }
        }

        if (msg.type === "userMoved") {
            const user = msg.user;
            if (user.uuid === myUuid) return;
            
            if (user.room === currentRoom) {
                addLog("System", `${user.name}さんが来ました`);
                createPeerConnection(user.uuid, true);
            } else {
                closePeerConnection(user.uuid);
            }
        }

        if (msg.type === "userLeft") {
            if (msg.uuid === myUuid) return;
            closePeerConnection(msg.uuid);
            addLog("System", `${msg.name}さんが退室`);
        }

        if (msg.type === "userTimeout") {
            if (msg.uuid === myUuid) {
                handleSessionExpired("長時間放置のため退室しました");
                return;
            }
            closePeerConnection(msg.uuid);
            addLog("System", `${msg.name}さんがタイムアウト`);
        }

        if (msg.type === "signal") {
            await handleSignalMessage(msg.from, msg.data);
        }
    };

    eventSource.onerror = () => {
        console.log("SSE Error");
    };
}

// ==========================================
// 4. ハートビート（8分ごと）
// ==========================================
function startHeartbeat() {
    heartbeatTimer = setInterval(async () => {
        // アクティビティがあった場合のみ送信
        if (hasActivity) {
            await sendHeartbeat();
            hasActivity = false;
        }
    }, HEARTBEAT_INTERVAL);
}

function startActivityMonitor() {
    const activityEvents = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'touchmove'];
    activityEvents.forEach(event => {
        window.addEventListener(event, () => {
            lastActivity = Date.now();
            hasActivity = true;
        }, { passive: true });
    });
}

async function sendHeartbeat() {
    try {
        const res = await fetch(`${SERVER_URL}/roomAction`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ uuid: myUuid, action: "heartbeat" })
        });

        const data = await res.json();
        if (data.expired) {
            handleSessionExpired("セッションが切れました");
        }
    } catch (e) {
        console.error("Heartbeat failed:", e);
    }
}

function handleSessionExpired(message) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (eventSource) eventSource.close();
    Object.keys(peers).forEach(closePeerConnection);
    showError(message);
    setTimeout(() => location.reload(), 2000);
}

// ==========================================
// 5. サーバー通信
// ==========================================
async function fetchUsersAndConnect() {
    try {
        const res = await fetch(`${SERVER_URL}/users?room=${currentRoom}`);
        const users = await res.json();
        
        for (const user of users) {
            if (user.uuid === myUuid) continue;
            createPeerConnection(user.uuid, true);
        }
    } catch (e) {
        console.error("Failed to fetch users:", e);
    }
}

async function sendSignal(targetUuid, signalData) {
    try {
        await fetch(`${SERVER_URL}/signal`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                uuid: myUuid,
                targetUuid: targetUuid,
                signalData: signalData
            })
        });
    } catch (e) {
        console.error("Signal send failed:", e);
    }
}

// ==========================================
// 6. WebRTC (移動同期のみ)
// ==========================================
async function createPeerConnection(targetUuid, isInitiator) {
    if (peers[targetUuid]) return;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    peers[targetUuid] = pc;
    pendingCandidates[targetUuid] = [];

    // WebRTC Candidate バッチ送信 (リクエスト削減)
    let iceSendTimer = null;
    let iceBatch = [];
    
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            iceBatch.push(event.candidate);
            
            if (iceSendTimer) clearTimeout(iceSendTimer);
            iceSendTimer = setTimeout(() => {
                if (iceBatch.length > 0) {
                    sendSignal(targetUuid, { 
                        type: "candidates", 
                        candidates: iceBatch 
                    });
                    iceBatch = [];
                }
            }, 200);
        }
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            closePeerConnection(targetUuid);
        }
    };

    if (isInitiator) {
        const channel = pc.createDataChannel("game");
        setupDataChannel(channel, targetUuid);
        
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal(targetUuid, { type: "offer", sdp: pc.localDescription });
    } else {
        pc.ondatachannel = (e) => setupDataChannel(e.channel, targetUuid);
    }
}

async function handleSignalMessage(fromUuid, signalData) {
    if (!peers[fromUuid]) {
        await createPeerConnection(fromUuid, false);
    }
    const pc = peers[fromUuid];
    if (!pc) return;

    try {
        if (signalData.type === "offer") {
            await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendSignal(fromUuid, { type: "answer", sdp: pc.localDescription });
        } else if (signalData.type === "answer") {
            await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
        } else if (signalData.type === "candidate") {
            // 古い単発処理も念のため残す
            await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
        } else if (signalData.type === "candidates") {
            // ★バッチ受信対応
            for (const candidate of signalData.candidates) {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            }
        }
    } catch (e) {
        console.error("Signal handling error:", e);
    }
}

function setupDataChannel(channel, uuid) {
    dataChannels[uuid] = channel;
    
    channel.onopen = () => {
        channel.send(JSON.stringify({ type: "sync", data: myData }));
    };

    channel.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        
        if (msg.type === "sync" || msg.type === "update") {
            players[uuid] = { ...players[uuid], ...msg.data };
        } else if (msg.type === "effect") {
            spawnParticles(msg.effectType);
        }
        // ★チャットはServer経由になったのでP2P処理は削除
    };

    channel.onclose = () => {
        delete dataChannels[uuid];
        delete players[uuid];
    };
}

function closePeerConnection(uuid) {
    if (dataChannels[uuid]) {
        dataChannels[uuid].close();
        delete dataChannels[uuid];
    }
    if (peers[uuid]) {
        peers[uuid].close();
        delete peers[uuid];
    }
    delete players[uuid];
}

function broadcastToAll(type, payload) {
    const json = JSON.stringify({ type, ...payload });
    Object.values(dataChannels).forEach(ch => {
        if (ch.readyState === "open") ch.send(json);
    });
}

// ==========================================
// 7. パーティクルエフェクト (変更なし)
// ==========================================
function spawnParticles(effectType) {
    const colors = effectType === 'nice' 
        ? ['#FFD700', '#FFA500', '#FF6347', '#FF69B4', '#00CED1']
        : ['#FF69B4', '#FFD700', '#7B68EE', '#00FA9A', '#FF6347'];
    
    for (let i = 0; i < 50; i++) {
        particles.push({
            x: Math.random() * canvas.width,
            y: -20,
            vx: (Math.random() - 0.5) * 8,
            vy: Math.random() * 3 + 2,
            size: Math.random() * 12 + 6,
            color: colors[Math.floor(Math.random() * colors.length)],
            rotation: Math.random() * 360,
            rotationSpeed: (Math.random() - 0.5) * 10,
            life: 1,
            type: effectType === 'nice' ? 'star' : 'confetti'
        });
    }
}

function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.1; 
        p.rotation += p.rotationSpeed;
        p.life -= 0.008;
        
        if (p.life <= 0 || p.y > canvas.height + 50) {
            particles.splice(i, 1);
        }
    }
}

function drawParticles() {
    particles.forEach(p => {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation * Math.PI / 180);
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.color;
        
        if (p.type === 'star') {
            drawStar(0, 0, 5, p.size, p.size / 2);
        } else {
            ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        }
        ctx.restore();
    });
}

function drawStar(cx, cy, spikes, outerRadius, innerRadius) {
    let rot = Math.PI / 2 * 3;
    let step = Math.PI / spikes;
    
    ctx.beginPath();
    ctx.moveTo(cx, cy - outerRadius);
    
    for (let i = 0; i < spikes; i++) {
        ctx.lineTo(cx + Math.cos(rot) * outerRadius, cy + Math.sin(rot) * outerRadius);
        rot += step;
        ctx.lineTo(cx + Math.cos(rot) * innerRadius, cy + Math.sin(rot) * innerRadius);
        rot += step;
    }
    
    ctx.lineTo(cx, cy - outerRadius);
    ctx.closePath();
    ctx.fill();
}

// ==========================================
// 8. ゲームループ (変更なし)
// ==========================================
let lastBroadcast = 0;

function update() {
    if (document.activeElement.id !== 'chat-input') {
        if (keys['ArrowUp'] || keys['w'] || keys['W']) myData.y -= SPEED;
        if (keys['ArrowDown'] || keys['s'] || keys['S']) myData.y += SPEED;
        if (keys['ArrowLeft'] || keys['a'] || keys['A']) myData.x -= SPEED;
        if (keys['ArrowRight'] || keys['d'] || keys['D']) myData.x += SPEED;
        
        if ((keys[' '] || keys['Space']) && myData.z === 0) {
            myData.vz = JUMP_FORCE;
        }
    }

    if (targetX !== null && targetY !== null) {
        const dx = targetX - myData.x;
        const dy = targetY - myData.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist > SPEED) {
            myData.x += (dx / dist) * SPEED;
            myData.y += (dy / dist) * SPEED;
        } else {
            myData.x = targetX;
            myData.y = targetY;
            targetX = null;
            targetY = null;
        }
    }

    if (myData.z < 0 || myData.vz !== 0) {
        myData.vz += GRAVITY;
        myData.z += myData.vz;
        
        if (myData.z >= 0) {
            myData.z = 0;
            myData.vz = 0;
        }
    }

    myData.y = Math.max(MIN_Y, Math.min(MAX_Y, myData.y));
    const w = window.innerWidth;
    myData.x = Math.max(30, Math.min(w - 30, myData.x));

    if (currentRoom === 'A') {
        if (myData.x <= PORTAL_X + PORTAL_TOLERANCE && 
            Math.abs(myData.y - PORTAL_Y) <= PORTAL_TOLERANCE) {
            performRoomSwitch('B');
            myData.x = w - 60;
            myData.y = PORTAL_Y;
        }
    } else {
        if (myData.x >= w - PORTAL_X - PORTAL_TOLERANCE && 
            Math.abs(myData.y - PORTAL_Y) <= PORTAL_TOLERANCE) {
            performRoomSwitch('A');
            myData.x = 60;
            myData.y = PORTAL_Y;
        }
    }

    updateParticles();

    if (debugMode) {
        const connectedCount = Object.keys(dataChannels).length + 1;
        debugInfo.innerHTML = `X: ${Math.round(myData.x)}, Y: ${Math.round(myData.y)}<br>接続数: ${connectedCount}`;
    }

    const now = Date.now();
    if (now - lastBroadcast > 100) {
        broadcastToAll("update", { data: myData });
        lastBroadcast = now;
    }
}

async function performRoomSwitch(newRoom) {
    if (currentRoom === newRoom) return;

    Object.keys(peers).forEach(closePeerConnection);
    players = {};

    currentRoom = newRoom;
    updateRoomUI();

    try {
        await fetch(`${SERVER_URL}/roomAction`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                uuid: myUuid,
                name: myData.name,
                charId: myData.charId,
                action: "move",
                targetRoom: newRoom
            })
        });
    } catch (e) {
        console.error("Room switch failed:", e);
    }

    addLog("System", `${newRoom === 'B' ? 'ライブ会場' : '楽屋'}へ移動`);
    await fetchUsersAndConnect();
}

function updateRoomUI() {
    if (obsMode) {
        document.body.style.background = "#00FF00";
        return;
    }
    
    if (currentRoom === 'A') {
        document.body.style.background = "#a8d5ba";
        roomName.textContent = "楽屋（配信外）";
        roomBadge.classList.remove('room-b');
    } else {
        document.body.style.background = "#2a2a3a";
        roomName.textContent = "ライブ会場（配信内）";
        roomBadge.classList.add('room-b');
    }
}

function draw() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!obsMode) {
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.font = "11px 'Yusei Magic', sans-serif";
        
        if (currentRoom === 'A') {
            ctx.textAlign = "left";
            ctx.fillText("← ライブ会場", 15, PORTAL_Y);
            ctx.fillStyle = "rgba(255,100,100,0.3)";
            ctx.fillRect(0, PORTAL_Y - 20, 40, 40);
        } else {
            ctx.textAlign = "right";
            ctx.fillText("楽屋 →", canvas.width - 15, PORTAL_Y);
            ctx.fillStyle = "rgba(100,255,100,0.3)";
            ctx.fillRect(canvas.width - 40, PORTAL_Y - 20, 40, 40);
        }
    }

    drawChar(myData, true);
    Object.values(players).forEach(p => drawChar(p, false));
    drawParticles();
}

function drawChar(p, isMe) {
    const charId = p.charId || "1";
    if (!images[charId] || !images[charId].complete) return;
    
    const img = images[charId];
    const x = p.x || 0;
    const y = p.y || 0;
    const z = p.z || 0;

    const maxSize = 64;
    let drawW, drawH;
    
    if (img.naturalWidth > img.naturalHeight) {
        drawW = maxSize;
        drawH = (img.naturalHeight / img.naturalWidth) * maxSize;
    } else {
        drawH = maxSize;
        drawW = (img.naturalWidth / img.naturalHeight) * maxSize;
    }

    const drawY = y + z - drawH / 2;
    
    ctx.drawImage(img, x - drawW / 2, drawY, drawW, drawH);

    ctx.fillStyle = "#000";
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 3;
    ctx.font = "13px 'Yusei Magic', sans-serif";
    ctx.textAlign = "center";
    const nameY = y + z + drawH / 2 + 16;
    ctx.strokeText(p.name || "", x, nameY);
    ctx.fillText(p.name || "", x, nameY);

    if (p.msg) {
        const displayMsg = p.msg.substring(0, 20);
        ctx.font = "12px 'Yusei Magic', sans-serif";
        const metrics = ctx.measureText(displayMsg);
        const bubbleW = Math.min(metrics.width + 24, 180);
        const bubbleH = 30;
        const bubbleX = x - bubbleW / 2;
        const bubbleY = y + z - drawH / 2 - bubbleH - 12;

        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.beginPath();
        ctx.roundRect(bubbleX, bubbleY, bubbleW, bubbleH, 12);
        ctx.fill();
        
        ctx.beginPath();
        ctx.moveTo(x - 6, bubbleY + bubbleH);
        ctx.lineTo(x + 6, bubbleY + bubbleH);
        ctx.lineTo(x, bubbleY + bubbleH + 8);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = "#333";
        ctx.fillText(displayMsg, x, bubbleY + 20);
    }
}

function gameLoop() {
    update();
    draw();
    requestAnimationFrame(gameLoop);
}

// ==========================================
// 9. 入力処理
// ==========================================
window.addEventListener('keydown', e => {
    keys[e.key] = true;
    if (e.key === ' ' && document.activeElement.id !== 'chat-input') {
        e.preventDefault();
    }
});
window.addEventListener('keyup', e => keys[e.key] = false);

canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    targetX = e.clientX - rect.left;
    targetY = e.clientY - rect.top;
    targetY = Math.max(MIN_Y, Math.min(MAX_Y, targetY));
});

let touchStartX = 0, touchStartY = 0;
canvas.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    targetX = touch.clientX;
    targetY = Math.max(MIN_Y, Math.min(MAX_Y, touch.clientY));
});
canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;
    myData.x += dx * 0.5;
    myData.y += dy * 0.5;
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    targetX = null;
    targetY = null;
});

// ==========================================
// 10. チャット機能 (サーバー経由送信に変更)
// ==========================================
document.getElementById('send-btn').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) sendChat();
});

async function sendChat() {
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    const text = input.value.trim();
    if (!text) return;

    if (text.toLowerCase() === '/obs') {
        toggleObsMode();
        input.value = "";
        return;
    }
    if (text === '/1218') {
        debugMode = !debugMode;
        debugInfo.style.display = debugMode ? 'block' : 'none';
        addLog("System", debugMode ? "デバッグ情報 ON" : "デバッグ情報 OFF");
        input.value = "";
        return;
    }

    // 文字数制限チェック
    if (text.length > 100) {
        addLog("System", "文字数が多すぎます(100文字まで)");
        return;
    }

    // 連投防止 (ボタンが無効なら送らない)
    if (sendBtn.disabled) return;

    try {
        // ボタンを一時的に無効化
        sendBtn.disabled = true;
        sendBtn.style.opacity = "0.5";

        // ★サーバーへ送信 (P2Pではありません！)
        const res = await fetch(`${SERVER_URL}/roomAction`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                uuid: myUuid,
                action: "chat",
                message: text
            })
        });

        const data = await res.json();

        if (data.error) {
            addLog("System", data.error);
            sendBtn.disabled = false;
            sendBtn.style.opacity = "1.0";
        } else {
            // 成功したら5秒待機
            input.value = "";
            setTimeout(() => {
                sendBtn.disabled = false;
                sendBtn.style.opacity = "1.0";
            }, 5000);
        }

    } catch (e) {
        console.error("Chat error:", e);
        sendBtn.disabled = false;
        sendBtn.style.opacity = "1.0";
    }
}

function toggleObsMode() {
    obsMode = !obsMode;
    if (obsMode) {
        document.body.style.background = "#00FF00";
        bottomUI.style.display = 'none';
        obsExitBtn.style.display = 'block';
        addLog("System", "OBSモード ON");
    } else {
        obsExitBtn.style.display = 'none';
        bottomUI.style.display = 'flex';
        updateRoomUI();
        addLog("System", "OBSモード OFF");
    }
}

function sendQuickChat(text) {
    // クイックチャットもサーバー経由にする場合はここを変えますが
    // 演出優先でP2Pのままでも良いですし、制限をかけたいなら sendChat と同じ仕組みにします。
    // 今回は整合性を取るため、sendChatと同じくサーバー経由にします。
    
    // (inputに値を入れてsendChatを呼ぶのが楽です)
    const input = document.getElementById('chat-input');
    const oldVal = input.value;
    input.value = text;
    sendChat(); // サーバー経由で送信
    input.value = oldVal;
    
    // エフェクトは自分の画面だけ即出し
    if (text.includes('ナイス')) {
        spawnParticles('nice');
        broadcastToAll("effect", { effectType: 'nice' });
        if (myData.z === 0) myData.vz = JUMP_FORCE;
    } else if (text.includes('おめでとう')) {
        spawnParticles('congrats');
        broadcastToAll("effect", { effectType: 'congrats' });
        if (myData.z === 0) myData.vz = JUMP_FORCE;
    }
    
    toggleQuickChat();
}

// ==========================================
// 11. UI補助
// ==========================================
function addLog(name, text) {
    const list = document.getElementById('log-list');
    if (!list) return;

    const item = document.createElement('div');
    item.className = "log-item";
    item.innerHTML = `<span class="log-name">${name}:</span> ${text}`;
    list.prepend(item);

    while (list.children.length > 50) {
        list.removeChild(list.lastChild);
    }
}

function toggleLog() {
    const overlay = document.getElementById('log-overlay');
    overlay.style.display = overlay.style.display === 'flex' ? 'none' : 'flex';
}

function toggleQuickChat() {
    const popup = document.getElementById('quick-chat-popup');
    popup.style.display = popup.style.display === 'flex' ? 'none' : 'flex';
}

async function performExit() {
    closeExitModal();
    
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    Object.keys(peers).forEach(closePeerConnection);
    if (eventSource) eventSource.close();

    // ★ビーコン送信に変更（タブ閉じ対策）
    navigator.sendBeacon(`${SERVER_URL}/roomAction`, JSON.stringify({ uuid: myUuid, action: "leave" }));

    showError("退室しました。10分間再入室できません。");
    setTimeout(() => location.reload(), 2000);
}

// ==========================================
// 12. ページ離脱時
// ==========================================
window.addEventListener('beforeunload', () => {
    // 退出処理はビーコンで
    navigator.sendBeacon(`${SERVER_URL}/roomAction`, JSON.stringify({ uuid: myUuid, action: "leave" }));
    
    if (eventSource) eventSource.close();
    Object.keys(peers).forEach(uuid => {
        if (dataChannels[uuid]) dataChannels[uuid].close();
        if (peers[uuid]) peers[uuid].close();
    });
});

// グローバル公開
window.toggleLog = toggleLog;
window.toggleQuickChat = toggleQuickChat;
window.sendQuickChat = sendQuickChat;
window.openExitModal = openExitModal;
window.closeExitModal = closeExitModal;
window.performExit = performExit;
window.toggleObsMode = toggleObsMode;
window.closeNameConfirm = closeNameConfirm;
window.confirmNameAndJoin = confirmNameAndJoin;
window.closeErrorModal = closeErrorModal;
window.showError = showError;