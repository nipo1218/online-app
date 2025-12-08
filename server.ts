// ==========================================
// Deno Deploy Server - 名前重複許可版
// ==========================================

import { serveDir } from "https://deno.land/std@0.224.0/http/file_server.ts";

const kv = await Deno.openKv();
const BC_CHANNEL = "nipo_signaling";

// 設定定数
const TIMEOUT_MS = 10 * 60 * 1000; // 10分 (放置判定)
const PENALTY_MS = 10 * 60 * 1000; // 10分 (再入室禁止)

interface UserState {
  uuid: string;
  name: string;
  charId: string;
  room: "A" | "B";
  lastActive: number;
  joinedAt: number;
  lastChatTime?: number;
}

// CORSヘッダー
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ==========================================
// 定期クリーンアップ (5分ごと)
// ==========================================
setInterval(async () => {
  try {
    const now = Date.now();
    const iter = kv.list<UserState>({ prefix: ["users"] });
    const channel = new BroadcastChannel(BC_CHANNEL);
    
    for await (const entry of iter) {
      const user = entry.value;
      if (now - user.lastActive > TIMEOUT_MS) {
        await kv.delete(["users", user.uuid]);
        
        channel.postMessage({ 
          type: "userTimeout", 
          uuid: user.uuid, 
          name: user.name 
        });
      }
    }
    channel.close();
  } catch (e) {
    console.error("Cleanup error:", e);
  }
}, 5 * 60 * 1000);


// ==========================================
// メインサーバー処理
// ==========================================
Deno.serve(async (req) => {
  const url = new URL(req.url);

  // 1. APIリクエスト
  if (url.pathname.startsWith("/roomAction") || 
      url.pathname.startsWith("/events") || 
      url.pathname.startsWith("/signal") || 
      url.pathname.startsWith("/users") ||
      url.pathname.startsWith("/status")) {
      return await handleApi(req, url);
  }

  // 2. 静的ファイル
  return serveDir(req, {
    fsRoot: ".",
    urlRoot: "",
    showDirListing: true,
    enableCors: true,
    headers: ["Cache-Control: public, max-age=86400"]
  });
});

// ==========================================
// APIハンドラー
// ==========================================
async function handleApi(req: Request, url: URL) {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // --- SSE (Keep-Alive付き) ---
  if (url.pathname === "/events") {
    const uuid = url.searchParams.get("uuid");
    if (!uuid) return new Response("Missing uuid", { status: 400 });

    const channel = new BroadcastChannel(BC_CHANNEL);
    const encoder = new TextEncoder();
    let keepAliveId: number;

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`: connected\n\n`));

        keepAliveId = setInterval(() => {
            try {
                controller.enqueue(encoder.encode(`: keepalive\n\n`));
            } catch (e) {
                clearInterval(keepAliveId);
            }
        }, 30 * 1000);

        channel.onmessage = (e) => {
          const msg = e.data;
          if (msg.type === "signal" && msg.to !== uuid) return;
          if (msg.user?.uuid === uuid && (msg.type === "userJoined" || msg.type === "userMoved")) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`));
        };
      },
      cancel() {
        channel.close();
        clearInterval(keepAliveId);
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

  if (req.method === "POST" && url.pathname === "/roomAction") {
    try {
      const body = await req.json();
      const { uuid, name, charId, action, targetRoom, message, isRefresh } = body;
      const now = Date.now();

      if (action === "chat") {
          if (!message || message.length > 100) {
              return new Response(JSON.stringify({ error: "文字数が多すぎます" }), { status: 400, headers: corsHeaders });
          }
          const existing = await kv.get<UserState>(["users", uuid]);
          if (!existing.value) return new Response(JSON.stringify({ error: "ログインしていません" }), { status: 403, headers: corsHeaders });

          const lastChatTime = existing.value.lastChatTime || 0;
          if (now - lastChatTime < 5000) {
              const wait = Math.ceil((5000 - (now - lastChatTime)) / 1000);
              return new Response(JSON.stringify({ error: `あと${wait}秒待ってください` }), { status: 429, headers: corsHeaders });
          }
          existing.value.lastChatTime = now;
          existing.value.lastActive = now;
          await kv.set(["users", uuid], existing.value);

          const ch = new BroadcastChannel(BC_CHANNEL);
          ch.postMessage({ type: "chat", uuid, name: existing.value.name, msg: message });
          ch.close();
          return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
      }

      if (action === "heartbeat") {
        const existing = await kv.get<UserState>(["users", uuid]);
        if (existing.value) {
          existing.value.lastActive = now;
          await kv.set(["users", uuid], existing.value);
          return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
        }
        return new Response(JSON.stringify({ expired: true }), { status: 410, headers: corsHeaders });
      }

      if (action === "leave") {
        const existing = await kv.get<UserState>(["users", uuid]);
        if (existing.value) {
          await kv.delete(["users", uuid]);
          
          // リフレッシュ(F5)の場合もペナルティを与える
          if (isRefresh) {
            await kv.set(["penalty", uuid], now + PENALTY_MS);
          } else {
            await kv.set(["penalty", uuid], now + PENALTY_MS);
          }
          
          const channel = new BroadcastChannel(BC_CHANNEL);
          channel.postMessage({ type: "userLeft", uuid, name: existing.value.name });
          channel.close();
        }
        return new Response(JSON.stringify({ status: "left" }), { headers: corsHeaders });
      }

      if (action === "join") {
        // ペナルティチェック
        const penalty = await kv.get<number>(["penalty", uuid]);
        if (penalty.value && penalty.value > now) {
          const remainMin = Math.ceil((penalty.value - now) / 60000);
          return new Response(JSON.stringify({ 
            error: `あと${remainMin}分待ってから入室してください` 
          }), { status: 403, headers: corsHeaders });
        }

        // 既存セッションの復帰（同じUUID）
        const existing = await kv.get<UserState>(["users", uuid]);
        if (existing.value) {
          existing.value.lastActive = now;
          if (charId) existing.value.charId = charId;
          await kv.set(["users", uuid], existing.value);
          return new Response(JSON.stringify({ status: "restored", user: existing.value }), { headers: corsHeaders });
        }

        // ★名前の重複チェックを削除 - 同じ名前でも入室可能に
        const userState: UserState = {
          uuid, name, charId: charId || "1", room: targetRoom || "A", lastActive: now, joinedAt: now
        };
        await kv.set(["users", uuid], userState);
        
        const channel = new BroadcastChannel(BC_CHANNEL);
        channel.postMessage({ type: "userJoined", user: userState });
        channel.close();
        return new Response(JSON.stringify({ status: "joined", user: userState }), { headers: corsHeaders });
      }

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

  if (req.method === "POST" && url.pathname === "/signal") {
    const body = await req.json();
    const channel = new BroadcastChannel(BC_CHANNEL);
    channel.postMessage({ type: "signal", from: body.uuid, to: body.targetUuid, data: body.signalData });
    channel.close();
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
  }

  if (req.method === "GET" && url.pathname === "/users") {
    const room = url.searchParams.get("room");
    const users: UserState[] = [];
    const iter = kv.list<UserState>({ prefix: ["users"] });
    for await (const entry of iter) {
      if (!room || entry.value.room === room) users.push(entry.value);
    }
    return new Response(JSON.stringify(users), { headers: corsHeaders });
  }

  return new Response("Not Found", { status: 404 });
}