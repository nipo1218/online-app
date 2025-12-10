// chat.js - スプライトアニメーション対応版

const SERVER_URL = "";

// --- 設定 ---
const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const SPEED = 1.0; // 移動速度（半分に）
const HEARTBEAT_INTERVAL = 8 * 60 * 1000;

// ジャンプ設定（ゆっくり）
const JUMP_FORCE = -4;
const GRAVITY = 0.15;
const JUMP_COOLDOWN = 2000; // ジャンプ後2秒間は再ジャンプ不可

// 初期位置
const SPAWN_X = 362;
const SPAWN_Y = 217;

// ライブ会場スポーン位置
const LIVE_SPAWN_X = 368;
const LIVE_SPAWN_Y = 202;

// 部屋移動ポイント
const PORTAL_X = 20;
const PORTAL_Y = 216;
const PORTAL_TOLERANCE = 20;

// スプライト設定
const SPRITE_COLS = 4;
const SPRITE_ROWS = 3;
const ANIM_SPEED = 150; // ms per frame
const WALK_PATTERN = [0, 1, 2, 1]; // 歩行アニメパターン: 1,2,3,2,1,2,3,2...

// 画面サイズ（埋め込み用）
const GAME_WIDTH = 398;
const GAME_HEIGHT = 385;

// Y座標制限
const MIN_Y_ROOM_A = 186; // 楽屋
const MIN_Y_ROOM_B = 177; // ライブ会場
const MAX_Y = 320;

// 楽屋の家具配置（絵文字で描画）
const ROOM_A_FURNITURE = [
    { type: 'chair', x: 140, y: 230, emoji: '🪑' },
    { type: 'table', x: 199, y: 230, emoji: '🪵' },
    { type: 'chair', x: 258, y: 230, emoji: '🪑' },
];

// テーブル当たり判定
const TABLE_COLLISION_DIST = 25;
const CHAIR_SIT_DIST = 18;

// 環境エフェクト（ライブ会場のライト）
let ambientEffects = [];

// デジョンエフェクト
let isDejonActive = false;
let dejonStartTime = 0;
const DEJON_DURATION = 3000;

// --- 状態管理 ---
let eventSource = null;
let currentRoom = "A";
let sessionStatus = "none";
let obsMode = false;
let debugMode = false;
let myData = { 
    x: SPAWN_X, y: SPAWN_Y, z: 0, vz: 0,
    name: "", charId: "1", msg: "",
    direction: 'down', // up, down, left, right
    isMoving: false,
    isSitting: false,
    sittingChair: null
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

// アニメーション
let animFrame = 0;
let walkPatternIndex = 0;
let lastAnimTime = 0;
let lastJumpTime = 0; // ジャンプクールダウン用

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

// --- スプライトシート読み込み ---
const spriteSheets = {};
const staticImages = {};
['1','2','3','4'].forEach(id => {
    // スプライトシート
    const sp = new Image();
    sp.src = `${id}-sp.png`;
    spriteSheets[id] = sp;
    
    // 静的画像（フォールバック用）
    const img = new Image();
    img.src = `${id}.png`;
    staticImages[id] = img;
});

// 椅子スプライト
const chairSprite = new Image();
chairSprite.src = 'chair-sp.png';

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
        showError("接続に失敗しました");
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

// ライブ会場確認モーダル
let pendingLiveMove = false;

function openLiveConfirmModal() {
    if (pendingLiveMove) return; // 既に開いている場合は無視
    pendingLiveMove = true;
    document.getElementById('live-confirm-modal').style.display = 'flex';
}

function closeLiveConfirmModal() {
    document.getElementById('live-confirm-modal').style.display = 'none';
    pendingLiveMove = false;
}

function confirmGoToLive() {
    closeLiveConfirmModal();
    const w = GAME_WIDTH;
    performRoomSwitch('B');
    myData.x = w - 60;
    myData.y = PORTAL_Y;
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

        if (msg.type === "chat") {
            const senderName = msg.name || "???";
            addLog(senderName, msg.msg);
            
            if (players[msg.uuid]) {
                players[msg.uuid].msg = msg.msg;
                setTimeout(() => { if(players[msg.uuid]) players[msg.uuid].msg = ""; }, 5000);
            } else if (msg.uuid === myUuid) {
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
// 6. WebRTC (移動同期)
// ==========================================
async function createPeerConnection(targetUuid, isInitiator) {
    if (peers[targetUuid]) return;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    peers[targetUuid] = pc;
    pendingCandidates[targetUuid] = [];

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
            await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
        } else if (signalData.type === "candidates") {
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
// 7. パーティクルエフェクト（ド派手版・3秒間）
// ==========================================
function spawnParticles(effectType) {
    const PARTICLE_LIFE_DECAY = 0.0045; // 3秒間 (1 / (60fps * 3.7秒))
    
    if (effectType === 'nice') {
        // ナイス: 金色の星と拍手マーク、放射状に広がる
        const colors = ['#FFD700', '#FFC107', '#FFEB3B', '#FF9800', '#FF5722'];
        
        // 大きな星を中央から放射
        for (let i = 0; i < 30; i++) {
            const angle = (Math.PI * 2 / 30) * i;
            const speed = Math.random() * 4 + 3;
            particles.push({
                x: GAME_WIDTH / 2,
                y: GAME_HEIGHT / 2,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                size: Math.random() * 20 + 15,
                color: colors[Math.floor(Math.random() * colors.length)],
                rotation: Math.random() * 360,
                rotationSpeed: (Math.random() - 0.5) * 15,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'star',
                glow: true
            });
        }
        
        // 上からキラキラ
        for (let i = 0; i < 40; i++) {
            particles.push({
                x: Math.random() * GAME_WIDTH,
                y: -30,
                vx: (Math.random() - 0.5) * 3,
                vy: Math.random() * 2 + 1,
                size: Math.random() * 15 + 8,
                color: colors[Math.floor(Math.random() * colors.length)],
                rotation: Math.random() * 360,
                rotationSpeed: (Math.random() - 0.5) * 20,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'sparkle'
            });
        }
        
        // 👏 絵文字エフェクト
        for (let i = 0; i < 8; i++) {
            particles.push({
                x: Math.random() * GAME_WIDTH,
                y: GAME_HEIGHT + 20,
                vx: (Math.random() - 0.5) * 2,
                vy: -(Math.random() * 3 + 2),
                size: 30,
                color: '#FFD700',
                rotation: 0,
                rotationSpeed: 0,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'emoji',
                emoji: '👏'
            });
        }
        
    } else if (effectType === 'congrats') {
        // おめでとう: レインボー紙吹雪＋キラキラ＋🎉
        const colors = ['#FF1493', '#00BFFF', '#FFD700', '#32CD32', '#FF6347', '#9370DB', '#00FA9A'];
        
        // レインボー紙吹雪（大量に）
        for (let i = 0; i < 80; i++) {
            particles.push({
                x: Math.random() * GAME_WIDTH,
                y: -50 - Math.random() * 100,
                vx: (Math.random() - 0.5) * 6,
                vy: Math.random() * 2 + 1,
                size: Math.random() * 15 + 8,
                color: colors[Math.floor(Math.random() * colors.length)],
                rotation: Math.random() * 360,
                rotationSpeed: (Math.random() - 0.5) * 20,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'confetti'
            });
        }
        
        // 画面端からの爆発
        for (let side = 0; side < 2; side++) {
            const startX = side === 0 ? 0 : GAME_WIDTH;
            for (let i = 0; i < 20; i++) {
                const angle = side === 0 ? 
                    (Math.random() * Math.PI / 2 - Math.PI / 4) : 
                    (Math.random() * Math.PI / 2 + Math.PI * 3/4);
                const speed = Math.random() * 6 + 4;
                particles.push({
                    x: startX,
                    y: GAME_HEIGHT / 2,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed - 2,
                    size: Math.random() * 18 + 10,
                    color: colors[Math.floor(Math.random() * colors.length)],
                    rotation: Math.random() * 360,
                    rotationSpeed: (Math.random() - 0.5) * 25,
                    life: 1,
                    decay: PARTICLE_LIFE_DECAY,
                    type: 'ribbon'
                });
            }
        }
        
        // 🎉 絵文字エフェクト
        for (let i = 0; i < 10; i++) {
            particles.push({
                x: Math.random() * GAME_WIDTH,
                y: GAME_HEIGHT + 30,
                vx: (Math.random() - 0.5) * 3,
                vy: -(Math.random() * 4 + 3),
                size: 35,
                color: '#FF1493',
                rotation: (Math.random() - 0.5) * 30,
                rotationSpeed: (Math.random() - 0.5) * 5,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'emoji',
                emoji: '🎉'
            });
        }
        
    } else if (effectType === 'kawaii') {
        // かわいい: ピンクのハート大量
        const colors = ['#FF69B4', '#FF1493', '#FFB6C1', '#FFC0CB', '#FF85A2', '#E75480'];
        
        // ハートを中央から放射
        for (let i = 0; i < 25; i++) {
            const angle = (Math.PI * 2 / 25) * i;
            const speed = Math.random() * 3 + 2;
            particles.push({
                x: GAME_WIDTH / 2,
                y: GAME_HEIGHT / 2,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                size: Math.random() * 25 + 20,
                color: colors[Math.floor(Math.random() * colors.length)],
                rotation: Math.random() * 30 - 15,
                rotationSpeed: (Math.random() - 0.5) * 8,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'emoji',
                emoji: '💕'
            });
        }
        
        // 上からハートが降ってくる
        for (let i = 0; i < 50; i++) {
            particles.push({
                x: Math.random() * GAME_WIDTH,
                y: -30 - Math.random() * 80,
                vx: (Math.random() - 0.5) * 2,
                vy: Math.random() * 1.5 + 0.8,
                size: Math.random() * 20 + 15,
                color: colors[Math.floor(Math.random() * colors.length)],
                rotation: Math.random() * 360,
                rotationSpeed: (Math.random() - 0.5) * 10,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'heart'
            });
        }
        
        // 💖 絵文字エフェクト（下から上へ）
        for (let i = 0; i < 12; i++) {
            particles.push({
                x: Math.random() * GAME_WIDTH,
                y: GAME_HEIGHT + 20,
                vx: (Math.random() - 0.5) * 2,
                vy: -(Math.random() * 2.5 + 1.5),
                size: 28,
                color: '#FF69B4',
                rotation: 0,
                rotationSpeed: (Math.random() - 0.5) * 3,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'emoji',
                emoji: '💖'
            });
        }
        
        // キラキラ
        for (let i = 0; i < 30; i++) {
            particles.push({
                x: Math.random() * GAME_WIDTH,
                y: Math.random() * GAME_HEIGHT,
                vx: (Math.random() - 0.5) * 1,
                vy: (Math.random() - 0.5) * 1,
                size: Math.random() * 12 + 6,
                color: colors[Math.floor(Math.random() * colors.length)],
                rotation: Math.random() * 360,
                rotationSpeed: (Math.random() - 0.5) * 15,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'sparkle'
            });
        }
    }
}

function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        
        // 重力（種類によって異なる）
        if (p.type === 'confetti' || p.type === 'ribbon') {
            p.vy += 0.05;
            p.vx *= 0.99;
        } else if (p.type === 'emoji') {
            p.vy += 0.06;
        } else if (p.type === 'heart') {
            p.vy += 0.02; // ハートはゆっくり落ちる
            p.vx += Math.sin(p.y * 0.05) * 0.1; // ゆらゆら
        } else {
            p.vy += 0.03;
        }
        
        p.rotation += p.rotationSpeed;
        p.life -= p.decay || 0.0045;
        
        if (p.life <= 0 || p.y > GAME_HEIGHT + 100) {
            particles.splice(i, 1);
        }
    }
}

function drawParticles() {
    particles.forEach(p => {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation * Math.PI / 180);
        ctx.globalAlpha = Math.min(p.life * 1.5, 1);
        
        if (p.type === 'emoji') {
            ctx.font = `${p.size}px serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(p.emoji, 0, 0);
        } else if (p.type === 'star') {
            if (p.glow) {
                ctx.shadowColor = p.color;
                ctx.shadowBlur = 15;
            }
            ctx.fillStyle = p.color;
            drawStar(0, 0, 5, p.size, p.size / 2);
        } else if (p.type === 'sparkle') {
            ctx.fillStyle = p.color;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 10;
            const s = p.size / 2;
            ctx.fillRect(-s/4, -s, s/2, s*2);
            ctx.fillRect(-s, -s/4, s*2, s/2);
        } else if (p.type === 'confetti') {
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.size/2, -p.size/4, p.size, p.size/2);
        } else if (p.type === 'ribbon') {
            ctx.strokeStyle = p.color;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(-p.size/2, 0);
            ctx.quadraticCurveTo(0, -p.size/3, p.size/2, 0);
            ctx.stroke();
        } else if (p.type === 'heart') {
            ctx.fillStyle = p.color;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 8;
            drawHeart(0, 0, p.size);
        }
        ctx.restore();
    });
}

function drawHeart(x, y, size) {
    const s = size / 2;
    ctx.beginPath();
    ctx.moveTo(x, y + s * 0.3);
    ctx.bezierCurveTo(x, y - s * 0.3, x - s, y - s * 0.3, x - s, y + s * 0.1);
    ctx.bezierCurveTo(x - s, y + s * 0.6, x, y + s, x, y + s);
    ctx.bezierCurveTo(x, y + s, x + s, y + s * 0.6, x + s, y + s * 0.1);
    ctx.bezierCurveTo(x + s, y - s * 0.3, x, y - s * 0.3, x, y + s * 0.3);
    ctx.fill();
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
// 環境エフェクト（ライブ会場のほわほわライト）
// ==========================================
function initAmbientEffects() {
    ambientEffects = [];
    const colors = ['#FF69B4', '#00BFFF', '#FFD700', '#9370DB', '#00FA9A', '#FF6347'];
    
    for (let i = 0; i < 15; i++) {
        ambientEffects.push({
            x: Math.random() * GAME_WIDTH,
            y: Math.random() * GAME_HEIGHT,
            size: Math.random() * 40 + 20,
            color: colors[Math.floor(Math.random() * colors.length)],
            alpha: Math.random() * 0.3 + 0.1,
            speed: Math.random() * 0.5 + 0.2,
            angle: Math.random() * Math.PI * 2,
            pulse: Math.random() * Math.PI * 2
        });
    }
}

function updateAmbientEffects() {
    if (currentRoom !== 'B') return;
    
    for (const e of ambientEffects) {
        e.angle += 0.01;
        e.pulse += 0.05;
        e.x += Math.cos(e.angle) * e.speed;
        e.y += Math.sin(e.angle) * e.speed * 0.5;
        
        // 画面内にラップ
        if (e.x < -50) e.x = GAME_WIDTH + 50;
        if (e.x > GAME_WIDTH + 50) e.x = -50;
        if (e.y < -50) e.y = GAME_HEIGHT + 50;
        if (e.y > GAME_HEIGHT + 50) e.y = -50;
    }
}

function drawAmbientEffects() {
    if (currentRoom !== 'B') return;
    
    for (const e of ambientEffects) {
        const pulseSize = e.size + Math.sin(e.pulse) * 10;
        const pulseAlpha = e.alpha + Math.sin(e.pulse * 0.7) * 0.1;
        
        const gradient = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, pulseSize);
        gradient.addColorStop(0, e.color + Math.floor(pulseAlpha * 255).toString(16).padStart(2, '0'));
        gradient.addColorStop(1, e.color + '00');
        
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(e.x, e.y, pulseSize, 0, Math.PI * 2);
        ctx.fill();
    }
}

// ==========================================
// デジョンエフェクト（3秒かけて楽屋に戻る）
// ==========================================
function startDejonEffect() {
    isDejonActive = true;
    dejonStartTime = Date.now();
    addLog("System", "デジョン詠唱開始...");
    
    // 詠唱中は移動不可
    myData.isMoving = false;
    targetX = null;
    targetY = null;
}

function updateDejonEffect() {
    if (!isDejonActive) return;
    
    const elapsed = Date.now() - dejonStartTime;
    
    if (elapsed >= DEJON_DURATION) {
        // デジョン完了
        isDejonActive = false;
        myData.isSitting = false;
        myData.sittingChair = null;
        performRoomSwitch('A');
        myData.x = SPAWN_X;
        myData.y = SPAWN_Y;
        addLog("System", "楽屋に戻りました");
    }
}

function drawDejonEffect() {
    if (!isDejonActive) return;
    
    const elapsed = Date.now() - dejonStartTime;
    const progress = elapsed / DEJON_DURATION;
    
    // ほわんほわんエフェクト（波紋のような円）
    const time = Date.now() * 0.005;
    const x = myData.x;
    const y = myData.y;
    
    // 複数の波紋
    for (let i = 0; i < 3; i++) {
        const phase = (time + i * 0.7) % 1;
        const radius = 20 + phase * 60;
        const alpha = (1 - phase) * 0.5 * (1 - progress * 0.5);
        
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = '#88DDFF';
        ctx.lineWidth = 3;
        ctx.shadowColor = '#88DDFF';
        ctx.shadowBlur = 15;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }
    
    // キラキラ
    for (let i = 0; i < 8; i++) {
        const angle = (time * 2 + i * Math.PI / 4) % (Math.PI * 2);
        const dist = 30 + Math.sin(time * 3 + i) * 10;
        const px = x + Math.cos(angle) * dist;
        const py = y + Math.sin(angle) * dist;
        const size = 4 + Math.sin(time * 5 + i * 2) * 2;
        
        ctx.save();
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = '#AAEEFF';
        ctx.shadowColor = '#AAEEFF';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(px, py, size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
    
    // 画面全体のフェード
    if (progress > 0.7) {
        const fadeAlpha = (progress - 0.7) / 0.3;
        ctx.save();
        ctx.globalAlpha = fadeAlpha * 0.8;
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
        ctx.restore();
    }
}

// ==========================================
// 8. ゲームループ
// ==========================================
let lastBroadcast = 0;
let prevX = SPAWN_X;
let prevY = SPAWN_Y;

function update() {
    // WASDキーの入力チェック
    const hasMovementKey = keys['ArrowUp'] || keys['w'] || keys['W'] ||
                           keys['ArrowDown'] || keys['s'] || keys['S'] ||
                           keys['ArrowLeft'] || keys['a'] || keys['A'] ||
                           keys['ArrowRight'] || keys['d'] || keys['D'];
    
    // WASDが押されたらクリック移動をキャンセル
    if (hasMovementKey) {
        targetX = null;
        targetY = null;
    }
    
    // 座っている場合
    if (myData.isSitting) {
        myData.isMoving = false;
        
        // スペースキー、WASDキー、クリック移動で立ち上がる
        if (keys[' '] || keys['Space'] || hasMovementKey || targetX !== null) {
            myData.isSitting = false;
            // 椅子から少し離れた位置に移動
            if (myData.sittingChair) {
                const chair = myData.sittingChair;
                if (chair.dir === 'left') {
                    myData.x = chair.x - 25;
                } else if (chair.dir === 'right') {
                    myData.x = chair.x + 25;
                } else {
                    myData.y = chair.y + 25; // 後ろ向き椅子の場合
                }
            }
            myData.sittingChair = null;
            keys[' '] = false;
            keys['Space'] = false;
        }
        
        updateParticles();
        updateAmbientEffects();
        const now = Date.now();
        if (now - lastBroadcast > 100) {
            broadcastToAll("update", { data: myData });
            lastBroadcast = now;
        }
        return;
    }
    
    prevX = myData.x;
    prevY = myData.y;
    
    if (document.activeElement.id !== 'chat-input') {
        if (keys['ArrowUp'] || keys['w'] || keys['W']) {
            myData.y -= SPEED;
            myData.direction = 'up';
        }
        if (keys['ArrowDown'] || keys['s'] || keys['S']) {
            myData.y += SPEED;
            myData.direction = 'down';
        }
        if (keys['ArrowLeft'] || keys['a'] || keys['A']) {
            myData.x -= SPEED;
            myData.direction = 'left';
        }
        if (keys['ArrowRight'] || keys['d'] || keys['D']) {
            myData.x += SPEED;
            myData.direction = 'right';
        }
        
        if ((keys[' '] || keys['Space']) && myData.z === 0) {
            const now = Date.now();
            if (now - lastJumpTime >= JUMP_COOLDOWN) {
                myData.vz = JUMP_FORCE;
                lastJumpTime = now;
            }
        }
    }

    if (targetX !== null && targetY !== null) {
        const dx = targetX - myData.x;
        const dy = targetY - myData.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist > SPEED) {
            myData.x += (dx / dist) * SPEED;
            myData.y += (dy / dist) * SPEED;
            
            // 方向を決定
            if (Math.abs(dx) > Math.abs(dy)) {
                myData.direction = dx > 0 ? 'right' : 'left';
            } else {
                myData.direction = dy > 0 ? 'down' : 'up';
            }
        } else {
            myData.x = targetX;
            myData.y = targetY;
            targetX = null;
            targetY = null;
        }
    }

    // 移動判定
    myData.isMoving = (myData.x !== prevX || myData.y !== prevY);

    if (myData.z < 0 || myData.vz !== 0) {
        myData.vz += GRAVITY;
        myData.z += myData.vz;
        
        if (myData.z >= 0) {
            myData.z = 0;
            myData.vz = 0;
        }
    }

    myData.y = Math.max(currentRoom === 'A' ? MIN_Y_ROOM_A : MIN_Y_ROOM_B, Math.min(MAX_Y, myData.y));
    const w = GAME_WIDTH;
    myData.x = Math.max(30, Math.min(w - 30, myData.x));

    // 楽屋の家具判定
    if (currentRoom === 'A') {
        for (const furniture of ROOM_A_FURNITURE) {
            const dist = Math.sqrt(Math.pow(myData.x - furniture.x, 2) + Math.pow(myData.y - furniture.y, 2));
            
            if (furniture.type === 'table') {
                // テーブルは障害物（押し戻す）
                if (dist < TABLE_COLLISION_DIST) {
                    const angle = Math.atan2(myData.y - furniture.y, myData.x - furniture.x);
                    myData.x = furniture.x + Math.cos(angle) * TABLE_COLLISION_DIST;
                    myData.y = furniture.y + Math.sin(angle) * TABLE_COLLISION_DIST;
                    targetX = null;
                    targetY = null;
                }
            } else if (furniture.type === 'chair') {
                // 椅子は座れる
                if (dist < CHAIR_SIT_DIST && !myData.isSitting) {
                    myData.isSitting = true;
                    myData.sittingChair = furniture;
                    myData.x = furniture.x;
                    myData.y = furniture.y;
                    myData.direction = 'down'; // 椅子に座ったら正面向き
                }
            }
        }
    }
    
    // ライブ会場は立ち席なので椅子判定なし

    // 部屋移動（楽屋→ライブ会場のみ、確認モーダル表示）
    if (currentRoom === 'A') {
        if (myData.x <= PORTAL_X + PORTAL_TOLERANCE && 
            Math.abs(myData.y - PORTAL_Y) <= PORTAL_TOLERANCE) {
            // ポータルに入ったら確認モーダルを表示
            myData.x = PORTAL_X + PORTAL_TOLERANCE + 10; // 少し戻す
            openLiveConfirmModal();
        }
    }
    // ライブ会場から楽屋へは戻れない（ポータル無効化）

    updateParticles();
    updateAmbientEffects();
    updateDejonEffect();

    if (debugMode) {
        const connectedCount = Object.keys(dataChannels).length + 1;
        debugInfo.innerHTML = `X: ${Math.round(myData.x)}, Y: ${Math.round(myData.y)}<br>Dir: ${myData.direction}<br>接続: ${connectedCount}`;
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
    
    // ライブ会場に入ったらエフェクト初期化とスポーン位置設定
    if (newRoom === 'B') {
        initAmbientEffects();
        myData.x = LIVE_SPAWN_X;
        myData.y = LIVE_SPAWN_Y;
    }

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
    
    // 背景はCanvas内で描画するので、bodyは透明か黒
    document.body.style.background = "#0d0812";
    
    if (currentRoom === 'A') {
        roomName.textContent = "楽屋";
        roomBadge.classList.remove('room-b');
    } else {
        roomName.textContent = "ライブ会場";
        roomBadge.classList.add('room-b');
    }
}

function draw() {
    // 固定サイズ
    canvas.width = GAME_WIDTH;
    canvas.height = GAME_HEIGHT;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // アニメーションフレーム更新
    const now = Date.now();
    if (now - lastAnimTime > ANIM_SPEED) {
        walkPatternIndex = (walkPatternIndex + 1) % WALK_PATTERN.length;
        animFrame = WALK_PATTERN[walkPatternIndex];
        lastAnimTime = now;
    }

    // 背景描画
    drawBackground();
    
    // ライブ会場のほわほわエフェクト（キャラの後ろ）
    if (currentRoom === 'B') {
        drawAmbientEffects();
    }

    if (!obsMode) {
        if (currentRoom === 'A') {
            // ポータル
            ctx.fillStyle = "rgba(255,255,255,0.7)";
            ctx.font = "10px 'Yusei Magic', sans-serif";
            ctx.textAlign = "left";
            ctx.fillText("← LIVE", 5, PORTAL_Y - 15);
            
            // ポータルエリア
            const portalGrad = ctx.createRadialGradient(0, PORTAL_Y, 0, 0, PORTAL_Y, 40);
            portalGrad.addColorStop(0, 'rgba(255,100,200,0.5)');
            portalGrad.addColorStop(1, 'rgba(255,100,200,0)');
            ctx.fillStyle = portalGrad;
            ctx.beginPath();
            ctx.arc(0, PORTAL_Y, 40, 0, Math.PI * 2);
            ctx.fill();
            
            // 楽屋の家具を描画
            drawRoomAFurniture();
        }
        // ライブ会場は立ち席なので椅子なし
    }

    // プレイヤーをY座標でソート
    const allPlayers = [
        { ...myData, isMe: true },
        ...Object.values(players).map(p => ({ ...p, isMe: false }))
    ].sort((a, b) => (a.y || 0) - (b.y || 0));
    
    allPlayers.forEach(p => {
        drawChar(p, p.isMe);
    });
    
    drawParticles();
    drawDejonEffect();
}

// 背景描画
function drawBackground() {
    if (currentRoom === 'A') {
        // 楽屋：おしゃれなお部屋風
        // 壁（パステルピンクベージュ）
        const wallGrad = ctx.createLinearGradient(0, 0, 0, 186);
        wallGrad.addColorStop(0, '#FFF5F5');
        wallGrad.addColorStop(1, '#FFE4E1');
        ctx.fillStyle = wallGrad;
        ctx.fillRect(0, 0, GAME_WIDTH, 186);
        
        // 床（明るいウッドフローリング）
        const floorGrad = ctx.createLinearGradient(0, 186, 0, GAME_HEIGHT);
        floorGrad.addColorStop(0, '#DEB887');
        floorGrad.addColorStop(1, '#D2A679');
        ctx.fillStyle = floorGrad;
        ctx.fillRect(0, 186, GAME_WIDTH, GAME_HEIGHT - 186);
        
        // フローリングパターン
        ctx.strokeStyle = 'rgba(139, 90, 43, 0.12)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 15; i++) {
            const y = 186 + i * 14;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(GAME_WIDTH, y);
            ctx.stroke();
        }
        
        // 壁の下部装飾ライン
        ctx.fillStyle = '#DCCCC0';
        ctx.fillRect(0, 175, GAME_WIDTH, 11);
        
        // 絵文字で装飾
        ctx.font = '28px serif';
        ctx.textAlign = 'center';
        
        // 窓
        ctx.fillText('🪟', 320, 80);
        ctx.fillText('🪟', 80, 80);
        
        // カーテン
        ctx.font = '22px serif';
        ctx.fillText('🎀', 320, 50);
        ctx.fillText('🎀', 80, 50);
        
        // 時計
        ctx.font = '20px serif';
        ctx.fillText('🕐', 200, 55);
        
        // 植物
        ctx.font = '24px serif';
        ctx.fillText('🪴', 370, 165);
        ctx.fillText('🌸', 30, 165);
        
        // 額縁
        ctx.font = '18px serif';
        ctx.fillText('🖼️', 150, 80);
        ctx.fillText('🖼️', 250, 80);
        
    } else {
        // ライブ会場：ステージ風
        // 暗い背景
        const bgGrad = ctx.createRadialGradient(GAME_WIDTH/2, 50, 0, GAME_WIDTH/2, 50, GAME_HEIGHT);
        bgGrad.addColorStop(0, '#3d2b5a');
        bgGrad.addColorStop(0.5, '#1a1025');
        bgGrad.addColorStop(1, '#0d0812');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
        
        // ステージ（上部）
        const stageGrad = ctx.createLinearGradient(0, 0, 0, 100);
        stageGrad.addColorStop(0, '#4a3a6a');
        stageGrad.addColorStop(1, '#2a1a3a');
        ctx.fillStyle = stageGrad;
        ctx.fillRect(0, 0, GAME_WIDTH, 100);
        
        // ステージエリア
        ctx.fillStyle = 'rgba(60, 40, 80, 0.5)';
        ctx.fillRect(0, 100, GAME_WIDTH, 77);
        
        // ステージライト（動的）
        const time = Date.now() * 0.001;
        for (let i = 0; i < 5; i++) {
            const lx = 40 + i * 80;
            const hue = (i * 60 + time * 30) % 360;
            const gradient = ctx.createRadialGradient(lx, 10, 0, lx, 80, 100);
            gradient.addColorStop(0, `hsla(${hue}, 80%, 60%, 0.4)`);
            gradient.addColorStop(1, 'transparent');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.moveTo(lx, 10);
            ctx.lineTo(lx - 35, 140);
            ctx.lineTo(lx + 35, 140);
            ctx.closePath();
            ctx.fill();
        }
        
        // 絵文字で装飾
        ctx.font = '28px serif';
        ctx.textAlign = 'center';
        
        // スポットライト
        ctx.font = '22px serif';
        ctx.fillText('💡', 40, 25);
        ctx.fillText('💡', 120, 25);
        ctx.fillText('💡', 200, 25);
        ctx.fillText('💡', 280, 25);
        ctx.fillText('💡', 360, 25);
        
        // マイク（ステージ中央）
        ctx.font = '30px serif';
        ctx.fillText('🎤', 200, 90);
        
        // スピーカー
        ctx.font = '24px serif';
        ctx.fillText('🔊', 30, 130);
        ctx.fillText('🔊', 370, 130);
        
        // 床のライン
        ctx.strokeStyle = 'rgba(100, 80, 150, 0.2)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 8; i++) {
            const y = 177 + i * 25;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(GAME_WIDTH, y);
            ctx.stroke();
        }
    }
}

// 楽屋の家具描画（絵文字）
function drawRoomAFurniture() {
    ctx.font = '32px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    for (const furniture of ROOM_A_FURNITURE) {
        ctx.fillText(furniture.emoji, furniture.x, furniture.y);
    }
}

function drawChar(p, isMe) {
    const charId = p.charId || "1";
    const sprite = spriteSheets[charId];
    const fallback = staticImages[charId];
    
    const x = p.x || 0;
    const y = p.y || 0;
    const z = p.z || 0;
    const direction = p.direction || 'down';
    const isMoving = p.isMoving || false;
    const isSitting = p.isSitting || false;

    // キャラクターの影を描画
    const shadowWidth = 30;
    const shadowHeight = 10;
    const shadowY = y + 20; // 足元
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(x, shadowY, shadowWidth / 2, shadowHeight / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // スプライトシートを使用
    if (sprite && sprite.complete && sprite.naturalWidth > 0) {
        const frameW = sprite.naturalWidth / SPRITE_COLS;
        const frameH = sprite.naturalHeight / SPRITE_ROWS;
        
        // アスペクト比を保持した描画サイズ
        const maxSize = 56;
        let drawW, drawH;
        if (frameW > frameH) {
            drawW = maxSize;
            drawH = (frameH / frameW) * maxSize;
        } else {
            drawH = maxSize;
            drawW = (frameW / frameH) * maxSize;
        }
        
        const drawY = y + z - drawH / 2;
        
        // 行を決定: 0=front(down), 1=back(up), 2=side(left/right)
        let row = 0;
        if (direction === 'up') row = 1;
        else if (direction === 'left' || direction === 'right') row = 2;
        else row = 0; // down
        
        // フレームを決定
        let frame = 0;
        if (isSitting) {
            frame = 3; // 4枚目（index 3）= 座りポーズ
        } else if (isMoving) {
            frame = animFrame; // 歩行パターン: 0,1,2,1,0,1,2,1...
        } else {
            frame = 0; // 静止
        }
        
        const sx = frame * frameW;
        const sy = row * frameH;
        
        ctx.save();
        
        // 左右反転（左向きの場合に反転）
        if (direction === 'left') {
            ctx.translate(x, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(
                sprite,
                sx, sy, frameW, frameH,
                -drawW / 2, drawY, drawW, drawH
            );
        } else {
            ctx.drawImage(
                sprite,
                sx, sy, frameW, frameH,
                x - drawW / 2, drawY, drawW, drawH
            );
        }
        
        ctx.restore();
        
        // 名前表示
        ctx.fillStyle = "#000";
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 3;
        ctx.font = "11px 'Yusei Magic', sans-serif";
        ctx.textAlign = "center";
        const nameY = y + z + drawH / 2 + 12;
        ctx.strokeText(p.name || "", x, nameY);
        ctx.fillText(p.name || "", x, nameY);

        // 吹き出し（改行対応: 10文字ごと、最大3行）
        if (p.msg) {
            drawBubble(x, y + z - drawH / 2, p.msg);
        }
    } else if (fallback && fallback.complete) {
        // フォールバック: 静的画像を使用
        const drawSize = 56;
        const drawY = y + z - drawSize / 2;
        ctx.drawImage(fallback, x - drawSize / 2, drawY, drawSize, drawSize);
        
        ctx.fillStyle = "#000";
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 3;
        ctx.font = "11px 'Yusei Magic', sans-serif";
        ctx.textAlign = "center";
        const nameY = y + z + drawSize / 2 + 12;
        ctx.strokeText(p.name || "", x, nameY);
        ctx.fillText(p.name || "", x, nameY);
        
        if (p.msg) {
            drawBubble(x, y + z - drawSize / 2, p.msg);
        }
    }
}

// 吹き出し描画（改行対応）
function drawBubble(x, charTop, msg) {
    // 全角30文字以内、10文字で改行、最大3行
    const maxChars = 30;
    const charsPerLine = 10;
    const maxLines = 3;
    
    let text = msg.substring(0, maxChars);
    const lines = [];
    
    for (let i = 0; i < text.length && lines.length < maxLines; i += charsPerLine) {
        lines.push(text.substring(i, i + charsPerLine));
    }
    
    const fontSize = 10;
    const lineHeight = fontSize + 4;
    const padding = 8;
    
    ctx.font = `${fontSize}px 'Yusei Magic', sans-serif`;
    
    // 最も長い行の幅を計算
    let maxWidth = 0;
    for (const line of lines) {
        const w = ctx.measureText(line).width;
        if (w > maxWidth) maxWidth = w;
    }
    
    const bubbleW = Math.min(maxWidth + padding * 2, 120);
    const bubbleH = lines.length * lineHeight + padding * 2 - 4;
    const bubbleX = x - bubbleW / 2;
    const bubbleY = charTop - bubbleH - 10;

    // 吹き出し背景
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath();
    ctx.roundRect(bubbleX, bubbleY, bubbleW, bubbleH, 10);
    ctx.fill();
    
    // 吹き出しの尻尾
    ctx.beginPath();
    ctx.moveTo(x - 5, bubbleY + bubbleH);
    ctx.lineTo(x + 5, bubbleY + bubbleH);
    ctx.lineTo(x, bubbleY + bubbleH + 6);
    ctx.closePath();
    ctx.fill();

    // テキスト描画
    ctx.fillStyle = "#333";
    ctx.textAlign = "center";
    for (let i = 0; i < lines.length; i++) {
        const textY = bubbleY + padding + (i + 1) * lineHeight - 4;
        ctx.fillText(lines[i], x, textY);
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
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    
    // 通常移動（椅子に向かってクリックすれば当たり判定で座る）
    if (!myData.isSitting) {
        targetX = clickX;
        targetY = Math.max(MIN_Y, Math.min(MAX_Y, clickY));
    }
});

let touchStartX = 0, touchStartY = 0;
canvas.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    const rect = canvas.getBoundingClientRect();
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    
    if (!myData.isSitting) {
        targetX = touch.clientX - rect.left;
        targetY = Math.max(MIN_Y, Math.min(MAX_Y, touch.clientY - rect.top));
    }
});
canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (myData.isSitting) return;
    
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;
    myData.x += dx * 0.5;
    myData.y += dy * 0.5;
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    targetX = null;
    targetY = null;
    
    // 方向更新
    if (Math.abs(dx) > Math.abs(dy)) {
        myData.direction = dx > 0 ? 'right' : 'left';
    } else if (dy !== 0) {
        myData.direction = dy > 0 ? 'down' : 'up';
    }
    myData.isMoving = true;
});
canvas.addEventListener('touchend', () => {
    myData.isMoving = false;
});

// ==========================================
// 10. チャット機能
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
        addLog("System", debugMode ? "デバッグ ON" : "デバッグ OFF");
        input.value = "";
        return;
    }
    if (text === '/stand' && myData.isSitting) {
        myData.isSitting = false;
        myData.sittingChair = null;
        input.value = "";
        return;
    }
    
    // デジョン: ライブ会場から楽屋に戻る（3秒エフェクト付き）
    if (text === '/デジョン' && currentRoom === 'B') {
        if (isDejonActive) {
            addLog("System", "デジョン詠唱中...");
            input.value = "";
            return;
        }
        startDejonEffect();
        input.value = "";
        return;
    }
    
    // かわいいエフェクト
    if (text === 'かわいい' || text === 'カワイイ' || text === 'kawaii') {
        spawnParticles('kawaii');
        broadcastToAll("effect", { effectType: "kawaii" });
    }

    if (text.length > 30) {
        addLog("System", "30文字まで");
        return;
    }

    if (sendBtn.disabled) return;

    try {
        sendBtn.disabled = true;
        sendBtn.style.opacity = "0.5";

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
    const input = document.getElementById('chat-input');
    const oldVal = input.value;
    input.value = text;
    sendChat();
    input.value = oldVal;
    
    if (text.includes('ナイス')) {
        spawnParticles('nice');
        broadcastToAll("effect", { effectType: 'nice' });
        if (myData.z === 0 && !myData.isSitting) myData.vz = JUMP_FORCE;
    } else if (text.includes('おめでとう')) {
        spawnParticles('congrats');
        broadcastToAll("effect", { effectType: 'congrats' });
        if (myData.z === 0 && !myData.isSitting) myData.vz = JUMP_FORCE;
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

    while (list.children.length > 30) {
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

    navigator.sendBeacon(`${SERVER_URL}/roomAction`, JSON.stringify({ 
        uuid: myUuid, 
        action: "leave",
        isRefresh: false
    }));

    showError("退室しました。10分間再入室できません。");
    setTimeout(() => location.reload(), 2000);
}

// ==========================================
// 12. ページ離脱時（F5含む）
// ==========================================
window.addEventListener('beforeunload', () => {
    // F5やタブ閉じでもペナルティ
    navigator.sendBeacon(`${SERVER_URL}/roomAction`, JSON.stringify({ 
        uuid: myUuid, 
        action: "leave",
        isRefresh: true 
    }));
    
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
window.openLiveConfirmModal = openLiveConfirmModal;
window.closeLiveConfirmModal = closeLiveConfirmModal;
window.confirmGoToLive = confirmGoToLive;
