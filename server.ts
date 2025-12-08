// ==========================================
// Deno Deploy Server - Web & API 統合・完全版
// ==========================================

import { serveDir } from "https://deno.land/std@0.224.0/http/file_server.ts";

const kv = await Deno.openKv();
const BC_CHANNEL = "nipo_signaling";

// 設定定数
const TIMEOUT_MS = 10 * 60 * 1000; // 10分 (放置判定)
const PENALTY_MS = 10 * 60 * 1000; // 10分 (退室後の再入室禁止)

// 型定義
interface UserState {
  uuid: string;
  name: string;
  charId: string;
  room: "A" | "B";
  lastActive: number;
  joinedAt: number;
  lastChatTime?: number; // チャット連投制限用
}

// CORSヘッダー (API用)
// 同一オリジン(同じ場所)から呼ぶので基本不要ですが、念のため残します
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ==========================================
// 定期クリーンアップ (1分ごと)
// ==========================================
setInterval(async () => {
  try {
    const now = Date.now();
    const iter = kv.list<UserState>({ prefix: ["users"] });
    // channelはループの外で作る（接続回数節約）
    const channel = new BroadcastChannel(BC_CHANNEL);
    
    for await (const entry of iter) {
      const user = entry.value;
      if (now - user.lastActive > TIMEOUT_MS) {
        // 強制退室処理
        await kv.delete(["users", user.uuid]);
        await kv.delete(["names", user.name]);
        
        // 全員に通知
        channel.postMessage({ 
          type: "userTimeout", 
          uuid: user.uuid, 
          name: user.name 
        });
        
        console.log(`Timeout: ${user.name}`);
      }
    }
    
    channel.close();
  } catch (e) {
    console.error("Cleanup error:", e);
  }
}, 60 * 1000);


// ==========================================
// メインサーバー処理
// ==========================================
Deno.serve(async (req) => {
  const url = new URL(req.url);

  // 1. APIリクエストの処理
  if (url.pathname.startsWith("/roomAction") || 
      url.pathname.startsWith("/events") || 
      url.pathname.startsWith("/signal") || 
      url.pathname.startsWith("/users") ||
      url.pathname.startsWith("/status")) {
      return await handleApi(req, url);
  }

  // 2. 静的ファイル配信 (HTML, CSS, JS, 画像)
  // ★重要: キャッシュ設定を追加してリクエストを削減
  return serveDir(req, {
    fsRoot: ".",
    urlRoot: "",
    showDirListing: true,
    enableCors: true,
    headers: [
      // "public": 誰でもキャッシュOK
      // "max-age=86400": 86400秒(1日)はサーバーに確認しに来ないで！
      "Cache-Control: public, max-age=86400"
    ]
  });
});

// ==========================================
// APIハンドラー
// ==========================================
async function handleApi(req: Request, url: URL) {
  // Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // --- SSE (イベント通知) ---
  if (url.pathname === "/events") {
    const uuid = url.searchParams.get("uuid");
    if (!uuid) return new Response("Missing uuid", { status: 400 });

    const channel = new BroadcastChannel(BC_CHANNEL);
    const encoder = new TextEncoder();

    const body = new ReadableStream({
      start(controller) {
        // 接続維持用のコメント(課金対象外)
        controller.enqueue(encoder.encode(`: connected\n\n`));

        channel.onmessage = (e) => {
          const msg = e.data;
          
          // シグナリングフィルタリング
          if (msg.type === "signal" && msg.to !== uuid) return;
          // 自分の入室移動は無視
          if (msg.user?.uuid === uuid && (msg.type === "userJoined" || msg.type === "userMoved")) return;
          
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`));
        };
      },
      cancel() {
        channel.close();
      }
    });

    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      }
    });
  }

  // --- ルームアクション (入室・移動・退室・チャット) ---
  if (req.method === "POST" && url.pathname === "/roomAction") {
    try {
      const body = await req.json();
      const { uuid, name, charId, action, targetRoom, message } = body;
      const now = Date.now();

      // ★ チャット処理 (ここが変わりました！)
      if (action === "chat") {
          // 1. 文字数制限 (100文字)
          if (!message || message.length > 100) {
              return new Response(JSON.stringify({ error: "文字数が多すぎます(100文字まで)" }), { status: 400, headers: corsHeaders });
          }

          const existing = await kv.get<UserState>(["users", uuid]);
          if (!existing.value) {
              return new Response(JSON.stringify({ error: "ログインしていません" }), { status: 403, headers: corsHeaders });
          }

          // 2. 連投制限 (5秒ルール)
          const lastChatTime = existing.value.lastChatTime || 0;
          if (now - lastChatTime < 5000) {
              const wait = Math.ceil((5000 - (now - lastChatTime)) / 1000);
              return new Response(JSON.stringify({ error: `あと${wait}秒待ってください` }), { status: 429, headers: corsHeaders });
          }

          // 3. 更新 (DBにはチャット本文は保存せず、時間だけ更新)
          existing.value.lastChatTime = now;
          existing.value.lastActive = now;
          await kv.set(["users", uuid], existing.value);

          // 4. 全員に配信 (KV保存なし = 負荷最小)
          const ch = new BroadcastChannel(BC_CHANNEL);
          ch.postMessage({ 
              type: "chat", 
              uuid: uuid,
              name: existing.value.name,
              msg: message 
          });
          ch.close();

          return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
      }

      // ハートビート
      if (action === "heartbeat") {
        const existing = await kv.get<UserState>(["users", uuid]);
        if (existing.value) {
          existing.value.lastActive = now;
          await kv.set(["users", uuid], existing.value);
          return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
        }
        return new Response(JSON.stringify({ expired: true }), { status: 410, headers: corsHeaders });
      }

      // 退室
      if (action === "leave") {
        const existing = await kv.get<UserState>(["users", uuid]);
        if (existing.value) {
          await kv.delete(["users", uuid]);
          await kv.delete(["names", existing.value.name]);
          await kv.set(["penalty", uuid], now + PENALTY_MS);

          const channel = new BroadcastChannel(BC_CHANNEL);
          channel.postMessage({ type: "userLeft", uuid, name: existing.value.name });
          channel.close();
        }
        return new Response(JSON.stringify({ status: "left" }), { headers: corsHeaders });
      }

      // 入室
      if (action === "join") {
        const existing = await kv.get<UserState>(["users", uuid]);
        
        // 復帰処理
        if (existing.value) {
          existing.value.lastActive = now;
          if (name && name !== existing.value.name) {
             // 名前が変わった場合
             await kv.delete(["names", existing.value.name]);
             existing.value.name = name;
             await kv.set(["names", name], uuid);
          }
          if (charId) existing.value.charId = charId;
          await kv.set(["users", uuid], existing.value);
          return new Response(JSON.stringify({ status: "restored", user: existing.value }), { headers: corsHeaders });
        }

        // 名前重複チェック
        const nameOwner = await kv.get(["names", name]);
        if (nameOwner.value && nameOwner.value !== uuid) {
          return new Response(JSON.stringify({ error: "その名前のキャラクターはまだ部屋にいます。" }), { status: 409, headers: corsHeaders });
        }

        // 新規作成
        const userState: UserState = {
          uuid, name, charId: charId || "1", room: targetRoom || "A", lastActive: now, joinedAt: now
        };
        await kv.atomic()
          .set(["users", uuid], userState)
          .set(["names", name], uuid)
          .commit();

        const channel = new BroadcastChannel(BC_CHANNEL);
        channel.postMessage({ type: "userJoined", user: userState });
        channel.close();

        return new Response(JSON.stringify({ status: "joined", user: userState }), { headers: corsHeaders });
      }

      // 移動
      if (action === "move") {
        const user = (await kv.get<UserState>(["users", uuid])).value;
        if (user) {
          user.room = targetRoom;
          user.lastActive = now;
          await kv.set(["users", uuid], user);
          const channel = new BroadcastChannel(BC_CHANNEL);
          channel.postMessage({ type: "userMoved", user });
          channel.close();
        }
        return new Response(JSON.stringify({ status: "moved" }), { headers: corsHeaders });
      }

    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid Request" }), { status: 400, headers: corsHeaders });
    }
  }

  // --- シグナリング (P2P接続用) ---
  if (req.method === "POST" && url.pathname === "/signal") {
    const body = await req.json();
    const channel = new BroadcastChannel(BC_CHANNEL);
    channel.postMessage({ type: "signal", from: body.uuid, to: body.targetUuid, data: body.signalData });
    channel.close();
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
  }

  // --- ユーザーリスト ---
  if (req.method === "GET" && url.pathname === "/users") {
    const room = url.searchParams.get("room");
    const users: UserState[] = [];
    const iter = kv.list<UserState>({ prefix: ["users"] });
    for await (const entry of iter) {
      if (!room || entry.value.room === room) {
        users.push(entry.value);
      }
    }
    return new Response(JSON.stringify(users), { headers: corsHeaders });
  }

  return new Response("Not Found", { status: 404 });
}