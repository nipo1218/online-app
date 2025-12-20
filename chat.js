// chat.js - スプライトアニメーション対応版

const SERVER_URL = "";

// --- 設定 ---
const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const SPEED = 1.0; // 移動速度（半分に）
const HEARTBEAT_INTERVAL = 8 * 60 * 1000;

// ジャンプ設定（もっとゆっくり）
const JUMP_FORCE = -3;
const GRAVITY = 0.08;
const JUMP_COOLDOWN = 2000; // ジャンプ後2秒間は再ジャンプ不可

// 初期位置
const SPAWN_X = 362;
const SPAWN_Y = 217;

// ライブ会場スポーン位置
const LIVE_SPAWN_X = 368;
const LIVE_SPAWN_Y = 202;

// 部屋移動ポイント（ドア）
const DOOR_X = 45;
const DOOR_Y = 115;
const DOOR_TOLERANCE = 30;

// スプライト設定
const SPRITE_COLS = 4;
const SPRITE_ROWS = 3;
const ANIM_SPEED = 150; // ms per frame
const WALK_PATTERN = [0, 1, 2, 1]; // 歩行アニメパターン: 1,2,3,2,1,2,3,2...

// 画面サイズ（埋め込み用）
const GAME_WIDTH = 402;
const GAME_HEIGHT = 373;

// Y座標制限
const MIN_Y = 150; // 両部屋共通
const MAX_Y = 258; // チャット欄で隠れないように

// HP/MPシステム
let playerHP = 100;
let playerMP = 30;
const MAX_HP = 100;
const MAX_MP = 30;

// デジョン使用回数
let dejonUseCount = 0;
const MAX_DEJON_USE = 2;
const DEJON_MP_COST = 14;

// 椅子クールダウン
let chairCooldown = false;
let chairCooldownTimer = null;
const CHAIR_COOLDOWN_MS = 1000;

// 暴言リスト
const BAD_WORDS = ['死ね', 'しね', '殺す', 'ころす', 'バカ', 'ばか', '馬鹿', 'アホ', 'あほ', 'クソ', 'くそ', '糞', 'きもい', 'キモい', 'うざい', 'ウザい', '消えろ', 'きえろ'];

// 楽屋の家具配置（椅子1個 + テーブル）
const ROOM_A_FURNITURE = [
    { type: 'chair', x: 160, y: 230, dir: 'right' },
    { type: 'table', x: 250, y: 230 },
];

// 当たり判定
const TABLE_COLLISION_DIST = 40;
const CHAIR_SIT_DIST = 28;

// 環境エフェクト（ライブ会場のライト）
let ambientEffects = [];

// デジョンエフェクト
let isDejonActive = false;
let dejonStartTime = 0;
const DEJON_DURATION = 3000;

// ルームトランジション
let roomTransition = {
    active: false,
    type: '', // 'toLive' or 'toGakuya'
    startTime: 0,
    duration: 800
};

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

// --- 静的画像読み込み（1枚絵） ---
const staticImages = {};
['1','2','3','4'].forEach(id => {
    const img = new Image();
    img.src = `${id}.png`;
    staticImages[id] = img;
});

// 椅子スプライト
const chairSprite = new Image();
chairSprite.src = 'chair-sp.png';

// アニメーション用の変数
let breathingOffset = 0; // 呼吸アニメーション用

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
        
        // HP/MP表示を初期化
        document.getElementById('hp-mp-display').style.display = 'flex';
        playerHP = MAX_HP;
        playerMP = MAX_MP;
        updateHPMPDisplay();

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

// デジョンエラーポップアップ
function showDejonErrorPopup() {
    document.getElementById('dejon-error-modal').style.display = 'flex';
}

function closeDejonErrorModal() {
    document.getElementById('dejon-error-modal').style.display = 'none';
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
    if (pendingLiveMove) return;
    pendingLiveMove = true;
    document.getElementById('live-confirm-modal').style.display = 'flex';
}

function closeLiveConfirmModal() {
    document.getElementById('live-confirm-modal').style.display = 'none';
    pendingLiveMove = false;
    // いいえを押したらドアから離れる
    if (currentRoom === 'A') {
        myData.x = DOOR_X + DOOR_TOLERANCE + 30;
        targetX = myData.x;
        targetY = myData.y;
    }
}

function confirmGoToLive() {
    document.getElementById('live-confirm-modal').style.display = 'none';
    pendingLiveMove = false;
    // トランジション開始
    startRoomTransition('toLive');
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
        // 自分のデータを送信
        channel.send(JSON.stringify({ type: "sync", data: myData }));

        // 既存の全プレイヤーの情報も送信
        Object.keys(players).forEach(playerId => {
            if (playerId !== uuid) {
                channel.send(JSON.stringify({
                    type: "playerInfo",
                    uuid: playerId,
                    data: players[playerId]
                }));
            }
        });
    };

    channel.onmessage = (e) => {
        const msg = JSON.parse(e.data);

        if (msg.type === "sync" || msg.type === "update") {
            players[uuid] = { ...players[uuid], ...msg.data };
        } else if (msg.type === "playerInfo") {
            // 既存プレイヤー情報を受信
            if (msg.uuid && msg.data) {
                players[msg.uuid] = { ...players[msg.uuid], ...msg.data };
            }
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
    const PARTICLE_LIFE_DECAY = 0.008; // 約2秒間（控えめに）
    
    // 魔法少女パステルカラーパレット
    const pastelPink = ['#FFB6C1', '#FFC0CB', '#FFD1DC', '#FFDAE0', '#FFE4E9'];
    const pastelBlue = ['#B0E0E6', '#ADD8E6', '#87CEEB', '#AFEEEE', '#E0FFFF'];
    const pastelPurple = ['#E6E6FA', '#DDA0DD', '#D8BFD8', '#E0B0FF', '#F0E6FF'];
    const pastelYellow = ['#FFFACD', '#FAFAD2', '#FFFFE0', '#FFF8DC', '#FFFDD0'];
    const pastelMint = ['#98FB98', '#90EE90', '#BDFCC9', '#C1FFC1', '#E0FFE0'];
    
    if (effectType === 'nice') {
        // ナイス👏: 控えめなキラキラ
        const colors = [...pastelPink, ...pastelYellow, ...pastelBlue];

        // 中央から広がる星
        for (let i = 0; i < 12; i++) {
            const angle = (Math.PI * 2 / 12) * i;
            const speed = Math.random() * 2 + 1;
            particles.push({
                x: GAME_WIDTH / 2,
                y: GAME_HEIGHT / 2,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                size: Math.random() * 12 + 8,
                color: colors[Math.floor(Math.random() * colors.length)],
                rotation: Math.random() * 360,
                rotationSpeed: (Math.random() - 0.5) * 8,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'magicStar',
                glow: true
            });
        }

        // ふわふわ降ってくるキラキラ
        for (let i = 0; i < 15; i++) {
            particles.push({
                x: Math.random() * GAME_WIDTH,
                y: -30 - Math.random() * 60,
                vx: (Math.random() - 0.5) * 1,
                vy: Math.random() * 1.2 + 0.5,
                size: Math.random() * 10 + 5,
                color: colors[Math.floor(Math.random() * colors.length)],
                rotation: Math.random() * 360,
                rotationSpeed: (Math.random() - 0.5) * 10,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'twinkle',
                twinklePhase: Math.random() * Math.PI * 2
            });
        }

        // 👏 絵文字（ふわっと浮かぶ）
        for (let i = 0; i < 4; i++) {
            particles.push({
                x: Math.random() * GAME_WIDTH,
                y: GAME_HEIGHT + 20,
                vx: (Math.random() - 0.5) * 1,
                vy: -(Math.random() * 1.5 + 1),
                size: 24,
                color: pastelPink[0],
                rotation: 0,
                rotationSpeed: (Math.random() - 0.5) * 3,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'emoji',
                emoji: '👏',
                wobble: Math.random() * Math.PI * 2
            });
        }
        
    } else if (effectType === 'congrats') {
        // おめでとう🎉: 控えめな紙吹雪とキラキラ
        const colors = [...pastelPink, ...pastelBlue, ...pastelPurple, ...pastelYellow, ...pastelMint];

        // パステル紙吹雪
        for (let i = 0; i < 25; i++) {
            particles.push({
                x: Math.random() * GAME_WIDTH,
                y: -50 - Math.random() * 100,
                vx: (Math.random() - 0.5) * 3,
                vy: Math.random() * 2 + 1,
                size: Math.random() * 10 + 5,
                color: colors[Math.floor(Math.random() * colors.length)],
                rotation: Math.random() * 360,
                rotationSpeed: (Math.random() - 0.5) * 15,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'confetti'
            });
        }

        // 🎉 絵文字
        for (let i = 0; i < 5; i++) {
            particles.push({
                x: Math.random() * GAME_WIDTH,
                y: GAME_HEIGHT + 30,
                vx: (Math.random() - 0.5) * 2,
                vy: -(Math.random() * 3 + 2),
                size: 28,
                color: pastelPink[0],
                rotation: (Math.random() - 0.5) * 30,
                rotationSpeed: (Math.random() - 0.5) * 5,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'emoji',
                emoji: '🎉'
            });
        }

        // キラキラスター
        for (let i = 0; i < 15; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * 80;
            particles.push({
                x: GAME_WIDTH / 2 + Math.cos(angle) * dist,
                y: GAME_HEIGHT / 2 + Math.sin(angle) * dist,
                vx: Math.cos(angle) * 1.2,
                vy: Math.sin(angle) * 1.2,
                size: Math.random() * 12 + 6,
                color: pastelYellow[Math.floor(Math.random() * pastelYellow.length)],
                rotation: Math.random() * 360,
                rotationSpeed: (Math.random() - 0.5) * 10,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'magicStar'
            });
        }
        
    } else if (effectType === 'kawaii') {
        // かわいい💕: 控えめなハート
        const colors = [...pastelPink, ...pastelPurple];

        // 中央からハートバースト
        for (let i = 0; i < 12; i++) {
            const angle = (Math.PI * 2 / 12) * i;
            const speed = Math.random() * 2 + 1.5;
            particles.push({
                x: GAME_WIDTH / 2,
                y: GAME_HEIGHT / 2,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                size: Math.random() * 18 + 12,
                color: colors[Math.floor(Math.random() * colors.length)],
                rotation: Math.random() * 20 - 10,
                rotationSpeed: (Math.random() - 0.5) * 5,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'heart',
                glow: true
            });
        }

        // 上からハートが降ってくる
        for (let i = 0; i < 15; i++) {
            particles.push({
                x: Math.random() * GAME_WIDTH,
                y: -30 - Math.random() * 80,
                vx: (Math.random() - 0.5) * 1.5,
                vy: Math.random() * 1.2 + 0.8,
                size: Math.random() * 14 + 10,
                color: colors[Math.floor(Math.random() * colors.length)],
                rotation: Math.random() * 30 - 15,
                rotationSpeed: (Math.random() - 0.5) * 8,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'heart'
            });
        }

        // 💖💕 絵文字
        const heartEmojis = ['💖', '💕', '💗'];
        for (let i = 0; i < 6; i++) {
            particles.push({
                x: Math.random() * GAME_WIDTH,
                y: -30 - Math.random() * 50,
                vx: (Math.random() - 0.5) * 1.5,
                vy: Math.random() * 1.5 + 1,
                size: 24,
                color: pastelPink[0],
                rotation: 0,
                rotationSpeed: (Math.random() - 0.5) * 3,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'emoji',
                emoji: heartEmojis[Math.floor(Math.random() * heartEmojis.length)],
                wobble: Math.random() * Math.PI * 2
            });
        }
        
    } else if (effectType === 'fight') {
        // ファイト🔥: 控えめな炎と星
        const flameColors = [...pastelPink, '#FFDAB9', '#FFE4B5', ...pastelYellow];

        // ピンク炎（下から上へ）
        for (let i = 0; i < 20; i++) {
            particles.push({
                x: GAME_WIDTH / 2 + (Math.random() - 0.5) * 80,
                y: GAME_HEIGHT,
                vx: (Math.random() - 0.5) * 1,
                vy: -(Math.random() * 2 + 1),
                size: Math.random() * 15 + 10,
                color: flameColors[Math.floor(Math.random() * flameColors.length)],
                rotation: Math.random() * 360,
                rotationSpeed: (Math.random() - 0.5) * 10,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'magicFlame'
            });
        }

        // 勇気の星（放射）
        for (let i = 0; i < 10; i++) {
            const angle = (Math.PI * 2 / 10) * i;
            particles.push({
                x: GAME_WIDTH / 2,
                y: GAME_HEIGHT / 2,
                vx: Math.cos(angle) * 2,
                vy: Math.sin(angle) * 2,
                size: Math.random() * 14 + 10,
                color: pastelYellow[Math.floor(Math.random() * pastelYellow.length)],
                rotation: Math.random() * 360,
                rotationSpeed: (Math.random() - 0.5) * 12,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'magicStar',
                glow: true
            });
        }

        // 🔥💪✨ 絵文字
        const fightEmojis = ['🔥', '💪', '✨'];
        for (let i = 0; i < 6; i++) {
            const angle = (Math.PI * 2 / 6) * i;
            particles.push({
                x: GAME_WIDTH / 2,
                y: GAME_HEIGHT / 2,
                vx: Math.cos(angle) * 2,
                vy: Math.sin(angle) * 2 - 1,
                size: 26,
                color: pastelPink[0],
                rotation: 0,
                rotationSpeed: 0,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'emoji',
                emoji: fightEmojis[i % fightEmojis.length]
            });
        }
        
    } else if (effectType === 'www') {
        // www: 控えめな笑いエフェクト

        // ふわふわ「w」文字（ミント色）
        for (let i = 0; i < 15; i++) {
            particles.push({
                x: Math.random() * GAME_WIDTH,
                y: GAME_HEIGHT + 10,
                vx: (Math.random() - 0.5) * 0.8,
                vy: -(Math.random() * 1.2 + 0.6),
                size: Math.random() * 12 + 8,
                color: pastelMint[Math.floor(Math.random() * pastelMint.length)],
                rotation: (Math.random() - 0.5) * 20,
                rotationSpeed: (Math.random() - 0.5) * 5,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'text',
                text: 'w'
            });
        }

        // 😂🤣😆 絵文字（ゆらゆら）
        const laughEmojis = ['😂', '🤣', '😆'];
        for (let i = 0; i < 5; i++) {
            particles.push({
                x: Math.random() * GAME_WIDTH,
                y: GAME_HEIGHT / 2 + (Math.random() - 0.5) * 80,
                vx: (Math.random() - 0.5) * 1.5,
                vy: (Math.random() - 0.5) * 1.5,
                size: 28,
                color: pastelPink[0],
                rotation: 0,
                rotationSpeed: (Math.random() - 0.5) * 6,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'emoji',
                emoji: laughEmojis[Math.floor(Math.random() * laughEmojis.length)],
                wobble: Math.random() * Math.PI * 2
            });
        }

        // 星キラキラ
        for (let i = 0; i < 12; i++) {
            particles.push({
                x: Math.random() * GAME_WIDTH,
                y: Math.random() * GAME_HEIGHT,
                vx: 0,
                vy: 0,
                size: Math.random() * 10 + 5,
                color: pastelYellow[Math.floor(Math.random() * pastelYellow.length)],
                rotation: Math.random() * 360,
                rotationSpeed: (Math.random() - 0.5) * 10,
                life: 1,
                decay: PARTICLE_LIFE_DECAY * 1.3,
                type: 'twinkle',
                twinklePhase: Math.random() * Math.PI * 2
            });
        }
        
        // 花びら
        for (let i = 0; i < 20; i++) {
            particles.push({
                x: Math.random() * GAME_WIDTH,
                y: -20,
                vx: (Math.random() - 0.5) * 2,
                vy: Math.random() * 1.5 + 0.8,
                size: Math.random() * 12 + 8,
                color: pastelPink[Math.floor(Math.random() * pastelPink.length)],
                rotation: Math.random() * 360,
                rotationSpeed: (Math.random() - 0.5) * 15,
                life: 1,
                decay: PARTICLE_LIFE_DECAY,
                type: 'petal',
                wobble: Math.random() * Math.PI * 2
            });
        }
    }
}

function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        
        // パーティクルタイプ別の挙動
        if (p.type === 'magicStar') {
            p.vx *= 0.98;
            p.vy *= 0.98;
        } else if (p.type === 'twinkle') {
            p.twinklePhase += 0.15;
        } else if (p.type === 'ribbon') {
            p.vy += 0.03;
            p.vx += Math.sin(p.y * 0.05) * 0.1;
        } else if (p.type === 'magicCircle') {
            p.size += p.expandSpeed || 2;
        } else if (p.type === 'confetti') {
            p.vy += 0.04;
            p.vx *= 0.99;
        } else if (p.type === 'bubble') {
            p.x += Math.sin(p.wobble + p.y * 0.02) * 0.5;
            p.wobble += 0.08;
        } else if (p.type === 'heart') {
            p.vy += 0.02;
            p.vx += Math.sin(p.y * 0.03) * 0.08;
        } else if (p.type === 'petal') {
            p.vy += 0.015;
            p.vx += Math.sin(p.wobble) * 0.3;
            p.wobble += 0.05;
        } else if (p.type === 'magicFlame') {
            p.vx += (Math.random() - 0.5) * 0.2;
            p.size *= 0.985;
        } else if (p.type === 'text') {
            p.vy += 0.01;
        } else if (p.type === 'emoji') {
            p.vy += 0.03;
            if (p.wobble !== undefined) {
                p.wobble += 0.1;
                p.x += Math.sin(p.wobble) * 0.6;
            }
        } else {
            p.vy += 0.02;
        }
        
        p.rotation += p.rotationSpeed;
        p.life -= p.decay || 0.004;
        
        if (p.life <= 0 || p.y > GAME_HEIGHT + 100 || p.x > GAME_WIDTH + 100 || p.x < -100) {
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
            
        } else if (p.type === 'magicStar') {
            // 魔法の星（やわらかグロー）
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 12;
            ctx.fillStyle = p.color;
            drawStar(0, 0, 5, p.size, p.size / 2.5);
            // 中心に白いハイライト
            ctx.fillStyle = '#FFFFFF';
            ctx.globalAlpha *= 0.6;
            ctx.beginPath();
            ctx.arc(0, 0, p.size * 0.2, 0, Math.PI * 2);
            ctx.fill();
            
        } else if (p.type === 'twinkle') {
            // キラキラ（点滅）
            const twinkle = Math.abs(Math.sin(p.twinklePhase));
            ctx.globalAlpha *= twinkle;
            ctx.fillStyle = p.color;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 10;
            const s = p.size * twinkle;
            // 4方向のキラキラ
            ctx.fillRect(-1.5, -s, 3, s * 2);
            ctx.fillRect(-s, -1.5, s * 2, 3);
            // 斜め方向
            ctx.rotate(45 * Math.PI / 180);
            ctx.fillRect(-1, -s * 0.7, 2, s * 1.4);
            ctx.fillRect(-s * 0.7, -1, s * 1.4, 2);
            
        } else if (p.type === 'ribbon') {
            // リボン
            ctx.strokeStyle = p.color;
            ctx.lineWidth = 3;
            ctx.lineCap = 'round';
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 5;
            ctx.beginPath();
            ctx.moveTo(-p.size / 2, 0);
            ctx.quadraticCurveTo(0, -p.size / 2.5, p.size / 2, 0);
            ctx.stroke();
            
        } else if (p.type === 'magicCircle') {
            // 魔法陣
            ctx.strokeStyle = p.color;
            ctx.lineWidth = 2;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 15;
            ctx.globalAlpha *= 0.7;
            // 外円
            ctx.beginPath();
            ctx.arc(0, 0, p.size, 0, Math.PI * 2);
            ctx.stroke();
            // 内円
            ctx.beginPath();
            ctx.arc(0, 0, p.size * 0.7, 0, Math.PI * 2);
            ctx.stroke();
            // 星形
            ctx.beginPath();
            for (let i = 0; i < 6; i++) {
                const angle = (i / 6) * Math.PI * 2 - Math.PI / 2;
                const x = Math.cos(angle) * p.size * 0.85;
                const y = Math.sin(angle) * p.size * 0.85;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.stroke();
            
        } else if (p.type === 'confetti') {
            // 紙吹雪
            ctx.fillStyle = p.color;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 3;
            ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
            
        } else if (p.type === 'bubble') {
            // シャボン玉
            const gradient = ctx.createRadialGradient(-p.size * 0.3, -p.size * 0.3, 0, 0, 0, p.size);
            gradient.addColorStop(0, '#FFFFFF99');
            gradient.addColorStop(0.4, p.color + '55');
            gradient.addColorStop(0.8, p.color + '33');
            gradient.addColorStop(1, p.color + '11');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(0, 0, p.size, 0, Math.PI * 2);
            ctx.fill();
            // ハイライト
            ctx.fillStyle = '#FFFFFF88';
            ctx.beginPath();
            ctx.arc(-p.size * 0.3, -p.size * 0.3, p.size * 0.15, 0, Math.PI * 2);
            ctx.fill();
            
        } else if (p.type === 'heart') {
            // ハート
            ctx.fillStyle = p.color;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = p.glow ? 12 : 6;
            drawHeart(0, 0, p.size);
            
        } else if (p.type === 'petal') {
            // 花びら
            ctx.fillStyle = p.color;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 5;
            ctx.beginPath();
            ctx.ellipse(0, 0, p.size / 2, p.size / 4, 0, 0, Math.PI * 2);
            ctx.fill();
            // グラデーション風の縁
            ctx.fillStyle = '#FFFFFF44';
            ctx.beginPath();
            ctx.ellipse(-p.size * 0.15, -p.size * 0.05, p.size / 4, p.size / 8, 0, 0, Math.PI * 2);
            ctx.fill();
            
        } else if (p.type === 'magicFlame') {
            // 魔法の炎（パステルピンク）
            const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, p.size);
            gradient.addColorStop(0, '#FFFFFF');
            gradient.addColorStop(0.3, p.color);
            gradient.addColorStop(1, 'transparent');
            ctx.fillStyle = gradient;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 15;
            ctx.beginPath();
            ctx.arc(0, 0, p.size, 0, Math.PI * 2);
            ctx.fill();
            
        } else if (p.type === 'text') {
            // テキスト（w）
            ctx.font = `bold ${p.size}px 'Yusei Magic', sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = p.color;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 8;
            ctx.fillText(p.text || 'w', 0, 0);
            
        } else if (p.type === 'star') {
            ctx.fillStyle = p.color;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 10;
            drawStar(0, 0, 5, p.size, p.size / 2);
        } else if (p.type === 'sparkle') {
            ctx.fillStyle = p.color;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 8;
            const s = p.size / 2;
            ctx.fillRect(-s / 4, -s, s / 2, s * 2);
            ctx.fillRect(-s, -s / 4, s * 2, s / 2);
        } else if (p.type === 'flame') {
            const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, p.size);
            gradient.addColorStop(0, p.color);
            gradient.addColorStop(0.5, p.color + 'aa');
            gradient.addColorStop(1, 'transparent');
            ctx.fillStyle = gradient;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 12;
            ctx.beginPath();
            ctx.arc(0, 0, p.size, 0, Math.PI * 2);
            ctx.fill();
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
            speed: Math.random() * 0.05 + 0.02, // さらに遅く
            angle: Math.random() * Math.PI * 2,
            pulse: Math.random() * Math.PI * 2
        });
    }
}

function updateAmbientEffects() {
    if (currentRoom !== 'B') return;
    
    for (const e of ambientEffects) {
        e.angle += 0.001; // さらに遅く
        e.pulse += 0.008; // さらに遅く
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

// ルームトランジション
function startRoomTransition(type) {
    roomTransition.active = true;
    roomTransition.type = type;
    roomTransition.startTime = Date.now();
}

function updateRoomTransition() {
    if (!roomTransition.active) return;
    
    const elapsed = Date.now() - roomTransition.startTime;
    const progress = elapsed / roomTransition.duration;
    
    if (progress >= 0.5 && roomTransition.type === 'toLive' && currentRoom === 'A') {
        // 中間点で実際に部屋移動
        performRoomSwitch('B');
        myData.x = LIVE_SPAWN_X;
        myData.y = LIVE_SPAWN_Y;
    }
    
    if (progress >= 1) {
        roomTransition.active = false;
    }
}

function drawRoomTransition() {
    if (!roomTransition.active) return;
    
    const elapsed = Date.now() - roomTransition.startTime;
    const progress = Math.min(1, elapsed / roomTransition.duration);
    
    // フェードイン/アウト効果
    let alpha;
    if (progress < 0.5) {
        // フェードアウト（暗くなる）
        alpha = progress * 2;
    } else {
        // フェードイン（明るくなる）
        alpha = (1 - progress) * 2;
    }
    
    // 黒いオーバーレイ
    ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    
    // キラキラエフェクト
    if (alpha > 0.3) {
        const sparkleCount = 20;
        for (let i = 0; i < sparkleCount; i++) {
            const angle = (i / sparkleCount) * Math.PI * 2 + elapsed * 0.005;
            const dist = 50 + Math.sin(elapsed * 0.01 + i) * 30;
            const sx = GAME_WIDTH / 2 + Math.cos(angle) * dist;
            const sy = GAME_HEIGHT / 2 + Math.sin(angle) * dist;
            const size = 2 + Math.sin(elapsed * 0.02 + i) * 1;
            
            ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.8})`;
            ctx.beginPath();
            ctx.arc(sx, sy, size, 0, Math.PI * 2);
            ctx.fill();
        }
        
        // 中央のテキスト
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.font = "bold 14px 'Yusei Magic', sans-serif";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (roomTransition.type === 'toLive') {
            ctx.fillText('🎤 LIVE会場へ移動中...', GAME_WIDTH / 2, GAME_HEIGHT / 2);
        }
    }
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
            // 椅子クールダウン開始（1秒間は再度座らない）
            chairCooldown = true;
            setTimeout(() => { chairCooldown = false; }, 1000);
            
            // 椅子から少し離れた位置に移動
            if (myData.sittingChair) {
                const chair = myData.sittingChair;
                if (chair.dir === 'left') {
                    myData.x = chair.x - 30;
                } else if (chair.dir === 'right') {
                    myData.x = chair.x + 30;
                } else {
                    myData.y = chair.y + 30; // 後ろ向き椅子の場合
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

    myData.y = Math.max(MIN_Y, Math.min(MAX_Y, myData.y));
    const w = GAME_WIDTH;
    myData.x = Math.max(30, Math.min(w - 30, myData.x));

    // 楽屋の家具判定
    if (currentRoom === 'A') {
        // テーブル判定（四方からブロック）
        for (const furniture of ROOM_A_FURNITURE) {
            if (furniture.type === 'table') {
                const dx = myData.x - furniture.x;
                const dy = myData.y - furniture.y;
                const absDx = Math.abs(dx);
                const absDy = Math.abs(dy);
                
                // 矩形当たり判定（テーブルに乗れないように）
                const tableW = 35;
                const tableH = 25;
                
                if (absDx < tableW && absDy < tableH) {
                    // どの方向から侵入したか判定して押し出す
                    const overlapX = tableW - absDx;
                    const overlapY = tableH - absDy;
                    
                    if (overlapX < overlapY) {
                        // 左右から押し出す
                        myData.x = furniture.x + (dx > 0 ? tableW : -tableW);
                    } else {
                        // 上下から押し出す
                        myData.y = furniture.y + (dy > 0 ? tableH : -tableH);
                    }
                    targetX = null;
                    targetY = null;
                }
            }
        }
        
        // 椅子判定（範囲内なら滑らかに座る、クールダウン中は無効）
        if (!myData.isSitting && !chairCooldown) {
            for (const furniture of ROOM_A_FURNITURE) {
                if (furniture.type === 'chair') {
                    const dx = myData.x - furniture.x;
                    const dy = myData.y - furniture.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    
                    if (dist < CHAIR_SIT_DIST) {
                        myData.isSitting = true;
                        myData.sittingChair = furniture;
                        myData.direction = 'down';
                        targetX = null;
                        targetY = null;
                        // 椅子の位置にセット
                        myData.x = furniture.x;
                        myData.y = furniture.y;
                        break;
                    }
                }
            }
        }
    }
    
    // ライブ会場は立ち席なので椅子判定なし

    // 部屋移動（ドアから楽屋→ライブ会場）
    if (currentRoom === 'A' && !roomTransition.active) {
        // ドアはY=115に表示されているが、判定はプレイヤーが到達できるY=150付近
        const doorHitY = MIN_Y; // プレイヤーが到達できる最上部
        const doorDist = Math.sqrt(Math.pow(myData.x - DOOR_X, 2) + Math.pow(myData.y - doorHitY, 2));
        if (doorDist <= DOOR_TOLERANCE && myData.y <= MIN_Y + 10) {
            // ドアに近づいたら確認モーダルを表示
            openLiveConfirmModal();
        }
    }
    // ライブ会場から楽屋へは /dejon コマンドで戻る

    updateParticles();
    updateAmbientEffects();
    updateDejonEffect();
    updateRoomTransition();

    // 呼吸アニメーション更新
    breathingOffset += 0.05;

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

    // OBSモード: クロマキー背景のみ
    if (obsMode) {
        ctx.fillStyle = "#00FF00";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else {
        // 通常モード: 背景描画
        drawBackground();
        
        // ライブ会場のほわほわエフェクト（キャラの後ろ）
        if (currentRoom === 'B') {
            drawAmbientEffects();
        }
        
        if (currentRoom === 'A') {
            // ドア（壁に配置）
            // ドア枠
            ctx.fillStyle = '#8B4513';
            ctx.fillRect(DOOR_X - 18, DOOR_Y - 35, 36, 70);
            
            // ドア本体
            const doorGrad = ctx.createLinearGradient(DOOR_X - 15, 0, DOOR_X + 15, 0);
            doorGrad.addColorStop(0, '#D2691E');
            doorGrad.addColorStop(0.5, '#CD853F');
            doorGrad.addColorStop(1, '#A0522D');
            ctx.fillStyle = doorGrad;
            ctx.fillRect(DOOR_X - 15, DOOR_Y - 32, 30, 64);
            
            // ドアノブ
            ctx.fillStyle = '#FFD700';
            ctx.beginPath();
            ctx.arc(DOOR_X + 10, DOOR_Y, 3, 0, Math.PI * 2);
            ctx.fill();
            
            // 「LIVE」看板
            ctx.fillStyle = '#FF1493';
            ctx.fillRect(DOOR_X - 14, DOOR_Y - 28, 28, 12);
            ctx.fillStyle = '#FFF';
            ctx.font = "bold 8px 'Arial', sans-serif";
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('LIVE', DOOR_X, DOOR_Y - 22);
            
            // 楽屋の家具を描画
            drawRoomAFurniture();
        }
    }

    // プレイヤーをY座標でソート（OBSモードでも描画）
    const allPlayers = [
        { ...myData, isMe: true },
        ...Object.values(players).map(p => ({ ...p, isMe: false }))
    ].sort((a, b) => (a.y || 0) - (b.y || 0));
    
    allPlayers.forEach(p => {
        drawChar(p, p.isMe);
    });
    
    // エフェクト（OBSモードでも描画）
    drawParticles();
    drawDejonEffect();
    drawRoomTransition();
}

// 背景描画
function drawBackground() {
    if (currentRoom === 'A') {
        // 楽屋：おしゃれなお部屋風
        // 壁（パステルピンクベージュ）
        const wallGrad = ctx.createLinearGradient(0, 0, 0, 145);
        wallGrad.addColorStop(0, '#FFF5F5');
        wallGrad.addColorStop(1, '#FFE4E1');
        ctx.fillStyle = wallGrad;
        ctx.fillRect(0, 0, GAME_WIDTH, 145);
        
        // 床（明るいウッドフローリング）
        const floorGrad = ctx.createLinearGradient(0, 145, 0, GAME_HEIGHT);
        floorGrad.addColorStop(0, '#DEB887');
        floorGrad.addColorStop(1, '#D2A679');
        ctx.fillStyle = floorGrad;
        ctx.fillRect(0, 145, GAME_WIDTH, GAME_HEIGHT - 145);
        
        // フローリングパターン
        ctx.strokeStyle = 'rgba(139, 90, 43, 0.12)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 18; i++) {
            const y = 145 + i * 14;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(GAME_WIDTH, y);
            ctx.stroke();
        }
        
        // 壁の下部装飾ライン（幅木）
        ctx.fillStyle = '#DCCCC0';
        ctx.fillRect(0, 135, GAME_WIDTH, 10);
        
        // 窓（CSSグラデーションで描画）
        drawWindow(80, 25, 55, 75);
        drawWindow(320, 25, 55, 75);
        
    } else {
        // ライブ会場：豪華なステージ
        // 深い暗闘の背景
        const bgGrad = ctx.createRadialGradient(GAME_WIDTH/2, 30, 0, GAME_WIDTH/2, 30, GAME_HEIGHT);
        bgGrad.addColorStop(0, '#2a1a4a');
        bgGrad.addColorStop(0.3, '#1a0a2a');
        bgGrad.addColorStop(1, '#050208');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
        
        // ステージ（上部）- 豪華な紫のグラデーション
        const stageGrad = ctx.createLinearGradient(0, 0, 0, 95);
        stageGrad.addColorStop(0, '#5a3a8a');
        stageGrad.addColorStop(0.5, '#3a2a5a');
        stageGrad.addColorStop(1, '#1a0a2a');
        ctx.fillStyle = stageGrad;
        ctx.fillRect(0, 0, GAME_WIDTH, 95);
        
        // ステージの縁取り
        ctx.fillStyle = '#FFD700';
        ctx.fillRect(0, 93, GAME_WIDTH, 3);
        
        // ステージフロア（Y145まで）
        const floorGrad = ctx.createLinearGradient(0, 96, 0, 145);
        floorGrad.addColorStop(0, '#3a2a5a');
        floorGrad.addColorStop(1, '#2a1a3a');
        ctx.fillStyle = floorGrad;
        ctx.fillRect(0, 96, GAME_WIDTH, 49);
        
        // ステージライト（動的レインボー）
        const time = Date.now() * 0.001;
        for (let i = 0; i < 7; i++) {
            const lx = 30 + i * 58;
            const hue = (i * 50 + time * 20) % 360; // 遅くした
            
            // ライトの光線
            const gradient = ctx.createRadialGradient(lx, 0, 0, lx, 90, 110);
            gradient.addColorStop(0, `hsla(${hue}, 100%, 70%, 0.5)`);
            gradient.addColorStop(0.5, `hsla(${hue}, 100%, 60%, 0.15)`);
            gradient.addColorStop(1, 'transparent');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.moveTo(lx, 0);
            ctx.lineTo(lx - 35, 130);
            ctx.lineTo(lx + 35, 130);
            ctx.closePath();
            ctx.fill();
            
            // ライト本体（丸い光源）
            const lightGrad = ctx.createRadialGradient(lx, 8, 0, lx, 8, 10);
            lightGrad.addColorStop(0, '#FFFFFF');
            lightGrad.addColorStop(0.5, `hsla(${hue}, 100%, 80%, 1)`);
            lightGrad.addColorStop(1, `hsla(${hue}, 100%, 60%, 0)`);
            ctx.fillStyle = lightGrad;
            ctx.beginPath();
            ctx.arc(lx, 8, 10, 0, Math.PI * 2);
            ctx.fill();
        }
        
        // スポットライトエフェクト（ステージ中央）
        const spotGrad = ctx.createRadialGradient(GAME_WIDTH/2, 70, 0, GAME_WIDTH/2, 70, 70);
        spotGrad.addColorStop(0, 'rgba(255, 255, 200, 0.25)');
        spotGrad.addColorStop(0.5, 'rgba(255, 220, 150, 0.08)');
        spotGrad.addColorStop(1, 'transparent');
        ctx.fillStyle = spotGrad;
        ctx.beginPath();
        ctx.ellipse(GAME_WIDTH/2, 85, 55, 25, 0, 0, Math.PI * 2);
        ctx.fill();
        
        // 観客エリアの床
        const audienceGrad = ctx.createLinearGradient(0, 177, 0, GAME_HEIGHT);
        audienceGrad.addColorStop(0, '#1a1025');
        audienceGrad.addColorStop(1, '#0a0510');
        ctx.fillStyle = audienceGrad;
        ctx.fillRect(0, 177, GAME_WIDTH, GAME_HEIGHT - 177);
        
        // 床のキラキラ反射
        for (let i = 0; i < 20; i++) {
            const sx = (i * 47 + time * 10) % GAME_WIDTH;
            const sy = 180 + Math.sin(time * 2 + i) * 5 + (i % 4) * 40;
            const sparkleAlpha = 0.3 + Math.sin(time * 3 + i * 0.5) * 0.2;
            ctx.fillStyle = `rgba(255, 255, 255, ${sparkleAlpha})`;
            ctx.beginPath();
            ctx.arc(sx, sy, 2, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

// 窓の描画
function drawWindow(x, y, w, h) {
    // 窓枠
    ctx.fillStyle = '#8B7355';
    ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
    
    // 窓ガラス
    const glassGrad = ctx.createLinearGradient(x, y, x + w, y + h);
    glassGrad.addColorStop(0, '#E0F7FF');
    glassGrad.addColorStop(0.5, '#B0E0FF');
    glassGrad.addColorStop(1, '#C0ECFF');
    ctx.fillStyle = glassGrad;
    ctx.fillRect(x, y, w, h);
    
    // 窓の仕切り
    ctx.strokeStyle = '#8B7355';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x + w/2, y);
    ctx.lineTo(x + w/2, y + h);
    ctx.moveTo(x, y + h/2);
    ctx.lineTo(x + w, y + h/2);
    ctx.stroke();
    
    // 光の反射
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.fillRect(x + 3, y + 3, 15, 25);
}

// 楽屋の家具描画（画像）
function drawRoomAFurniture() {
    if (!chairSprite.complete) return;
    
    const spriteW = chairSprite.naturalWidth / 2;
    const spriteH = chairSprite.naturalHeight / 2;
    
    for (const furniture of ROOM_A_FURNITURE) {
        let sx, sy;
        const drawSize = furniture.type === 'table' ? 52 : 42;
        
        if (furniture.type === 'table') {
            // 右下: テーブル
            sx = spriteW;
            sy = spriteH;
        } else if (furniture.dir === 'left') {
            // 左上: 左向き椅子
            sx = 0;
            sy = 0;
        } else {
            // 右上: 右向き椅子
            sx = spriteW;
            sy = 0;
        }
        
        ctx.drawImage(
            chairSprite,
            sx, sy, spriteW, spriteH,
            furniture.x - drawSize / 2, furniture.y - drawSize / 2, drawSize, drawSize
        );
    }
}

function drawChar(p) {
    const charId = p.charId || "1";
    const img = staticImages[charId];

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

    if (img && img.complete) {
        const drawHeight = 56;
        const drawWidth = drawHeight * (img.naturalWidth / img.naturalHeight);

        // 呼吸アニメーション（静止時）
        let yOffset = 0;
        let xOffset = 0;

        if (isSitting) {
            // 座っている時の呼吸
            yOffset = Math.sin(breathingOffset) * 1;
        } else if (isMoving) {
            // 歩いている時の揺れ（上下に揺らす）
            yOffset = Math.sin(breathingOffset * 3) * 2.5;
            xOffset = Math.sin(breathingOffset * 3 + Math.PI / 2) * 0.8;
        } else {
            // 静止時の呼吸
            yOffset = Math.sin(breathingOffset) * 1.2;
        }

        const drawY = y + z - drawHeight / 2 + yOffset;
        const drawX = x - drawWidth / 2 + xOffset;

        ctx.save();

        // 左右反転（右向きの場合に反転）
        if (direction === 'right') {
            ctx.translate(x, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(img, -drawWidth / 2 - xOffset, drawY, drawWidth, drawHeight);
        } else {
            ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
        }

        ctx.restore();

        // 名前表示（5px上に）
        ctx.fillStyle = "#000";
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 3;
        ctx.font = "11px 'Yusei Magic', sans-serif";
        ctx.textAlign = "center";
        const nameY = y + z + drawHeight / 2 + 7 + yOffset;
        ctx.strokeText(p.name || "", x, nameY);
        ctx.fillText(p.name || "", x, nameY);

        // 吹き出し（改行対応: 10文字ごと、最大3行）
        if (p.msg) {
            drawBubble(x, y + z - drawHeight / 2 + yOffset, p.msg);
        }
    }
}

// 吹き出し描画（改行対応）
function drawBubble(x, charTop, msg) {
    // 全角30文字以内、10文字で改行、最大3行
    const maxChars = 30;
    const charsPerLine = 10;
    const maxLines = 3;
    
    let text = msg.substring(0, maxChars).trim(); // 前後の空白を削除
    if (!text) return; // 空なら描画しない
    
    const lines = [];
    
    for (let i = 0; i < text.length && lines.length < maxLines; i += charsPerLine) {
        const line = text.substring(i, i + charsPerLine);
        if (line) lines.push(line);
    }
    
    if (lines.length === 0) return;
    
    const fontSize = 10;
    const lineHeight = fontSize + 3;
    const padding = 6;
    
    ctx.font = `${fontSize}px 'Yusei Magic', sans-serif`;
    
    // 最も長い行の幅を計算
    let maxWidth = 0;
    for (const line of lines) {
        const w = ctx.measureText(line).width;
        if (w > maxWidth) maxWidth = w;
    }
    
    const bubbleW = Math.min(maxWidth + padding * 2, 120);
    const bubbleH = lines.length * lineHeight + padding * 2;
    const bubbleX = x - bubbleW / 2;
    const bubbleY = charTop - bubbleH - 8;

    // 吹き出し背景
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath();
    ctx.roundRect(bubbleX, bubbleY, bubbleW, bubbleH, 8);
    ctx.fill();
    
    // 吹き出しの尻尾
    ctx.beginPath();
    ctx.moveTo(x - 4, bubbleY + bubbleH);
    ctx.lineTo(x + 4, bubbleY + bubbleH);
    ctx.lineTo(x, bubbleY + bubbleH + 5);
    ctx.closePath();
    ctx.fill();

    // テキスト描画
    ctx.fillStyle = "#333";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let i = 0; i < lines.length; i++) {
        const textY = bubbleY + padding + i * lineHeight;
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
    
    // 座っている場合はクリックで立ち上がる
    if (myData.isSitting) {
        myData.isSitting = false;
        chairCooldown = true;
        setTimeout(() => { chairCooldown = false; }, CHAIR_COOLDOWN_MS);
        if (myData.sittingChair) {
            myData.y = myData.sittingChair.y + 25;
        }
        myData.sittingChair = null;
    }
    
    // 移動先を設定
    targetX = clickX;
    targetY = Math.max(MIN_Y, Math.min(MAX_Y, clickY));
});

let touchStartX = 0, touchStartY = 0;
canvas.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    const rect = canvas.getBoundingClientRect();
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    
    // 座っている場合はタッチで立ち上がる
    if (myData.isSitting) {
        myData.isSitting = false;
        chairCooldown = true;
        setTimeout(() => { chairCooldown = false; }, CHAIR_COOLDOWN_MS);
        if (myData.sittingChair) {
            myData.y = myData.sittingChair.y + 25;
        }
        myData.sittingChair = null;
    }
    
    targetX = touch.clientX - rect.left;
    targetY = Math.max(MIN_Y, Math.min(MAX_Y, touch.clientY - rect.top));
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
        chairCooldown = true;
        setTimeout(() => { chairCooldown = false; }, CHAIR_COOLDOWN_MS);
        myData.sittingChair = null;
        input.value = "";
        return;
    }
    
    // デジョン: ライブ会場から楽屋に戻る（3秒エフェクト付き、MP14消費、最大2回）
    if (text === '/dejon' || text === '/デジョン') {
        if (currentRoom !== 'B') {
            addLog("System", "楽屋ではデジョンできません");
            input.value = "";
            return;
        }
        if (isDejonActive) {
            addLog("System", "デジョン詠唱中...");
            input.value = "";
            return;
        }
        if (dejonUseCount >= MAX_DEJON_USE) {
            showDejonErrorPopup();
            input.value = "";
            return;
        }
        if (playerMP < DEJON_MP_COST) {
            showDejonErrorPopup();
            input.value = "";
            return;
        }
        playerMP -= DEJON_MP_COST;
        dejonUseCount++;
        updateHPMPDisplay();
        startDejonEffect();
        input.value = "";
        return;
    }
    
    // かわいいエフェクト
    if (text === 'かわいい' || text === 'カワイイ' || text === 'kawaii') {
        spawnParticles('kawaii');
        broadcastToAll("effect", { effectType: "kawaii" });
        playerHP = Math.min(MAX_HP, playerHP + 5);
        playerMP = Math.min(MAX_MP, playerMP + 2);
        updateHPMPDisplay();
    }
    
    // 暴言チェック
    const lowerText = text.toLowerCase();
    let isBadWord = false;
    for (const word of BAD_WORDS) {
        if (lowerText.includes(word.toLowerCase())) {
            isBadWord = true;
            break;
        }
    }
    
    if (isBadWord) {
        playerHP -= 20;
        updateHPMPDisplay();
        addLog("System", "暴言はダメ！ HP-20");
        
        if (playerHP <= 0) {
            addLog("System", "HPが0になりました。退室します...");
            input.value = "";
            setTimeout(() => {
                performExit();
            }, 1500);
            return;
        }
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
    const hpMpDisplay = document.getElementById('hp-mp-display');
    if (obsMode) {
        document.body.style.background = "#00FF00";
        bottomUI.style.display = 'none';
        if (hpMpDisplay) hpMpDisplay.style.display = 'none';
        obsExitBtn.style.display = 'block';
        addLog("System", "OBSモード ON");
    } else {
        document.body.style.background = "";
        obsExitBtn.style.display = 'none';
        bottomUI.style.display = 'flex';
        if (hpMpDisplay) hpMpDisplay.style.display = 'flex';
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
    
    // エフェクトに応じてHP/MP回復とジャンプ
    let effectType = null;
    if (text.includes('ナイス')) {
        effectType = 'nice';
    } else if (text.includes('おめでとう')) {
        effectType = 'congrats';
    } else if (text.includes('ファイト')) {
        effectType = 'fight';
    } else if (text.includes('www')) {
        effectType = 'www';
    }
    
    if (effectType) {
        spawnParticles(effectType);
        broadcastToAll("effect", { effectType });
        if (myData.z === 0 && !myData.isSitting) myData.vz = JUMP_FORCE;
        
        // HP/MP回復
        playerHP = Math.min(MAX_HP, playerHP + 5);
        playerMP = Math.min(MAX_MP, playerMP + 2);
        updateHPMPDisplay();
    }
    
    toggleQuickChat();
}

// ==========================================
// 11. UI補助
// ==========================================
function updateHPMPDisplay() {
    const hpFill = document.getElementById('hp-fill');
    const hpValue = document.getElementById('hp-value');
    const mpFill = document.getElementById('mp-fill');
    const mpValue = document.getElementById('mp-value');
    
    if (hpFill && hpValue) {
        const hpPercent = (playerHP / MAX_HP) * 100;
        hpFill.style.width = hpPercent + '%';
        hpValue.textContent = playerHP;
    }
    
    if (mpFill && mpValue) {
        const mpPercent = (playerMP / MAX_MP) * 100;
        mpFill.style.width = mpPercent + '%';
        mpValue.textContent = playerMP;
    }
}

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
window.closeDejonErrorModal = closeDejonErrorModal;
