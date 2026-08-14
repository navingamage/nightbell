/**
 * The media server process.
 *
 * An HTTP server for health checks and the Twilio webhook, plus a WebSocket
 * endpoint that carries the audio for each live call. One Session object per
 * call, torn down when the socket closes.
 */

import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { Session, type TenantConfig } from "./call/session.js";
import { connectTwiml, mediaPayload, parseInbound } from "./call/twilio.js";
import { loadConfig } from "./config.js";
import { ControlPlane } from "./control.js";
import { CartesiaSynthesiser } from "./providers/cartesia.js";
import { ClaudeModel } from "./providers/claude.js";
import { DeepgramRecogniser } from "./providers/deepgram.js";

const config = loadConfig();
const control = new ControlPlane(config);

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, calls: sessions.size }));
    return;
  }

  // Twilio's inbound-call webhook. The reply is TwiML that opens the media
  // stream back to this same host.
  if (req.method === "POST" && req.url?.startsWith("/voice")) {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const called = params.get("To") ?? "";
      const from = params.get("From") ?? "";
      res.writeHead(200, { "content-type": "text/xml" });
      res.end(
        connectTwiml(`wss://${config.publicHost}/stream`, { called, from }),
      );
    });
    return;
  }

  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, path: "/stream" });
const sessions = new Map<string, Session>();

wss.on("connection", (socket) => {
  let session: Session | null = null;
  let callSid = "";

  socket.on("message", (raw: Buffer) => {
    const msg = parseInbound(raw.toString());
    if (!msg) return;

    switch (msg.event) {
      case "start": {
        callSid = msg.start.callSid;
        const called = msg.start.customParameters?.["called"] ?? "";
        void startSession(socket, msg.streamSid, callSid, called)
          .then((created) => {
            session = created;
            if (created) sessions.set(callSid, created);
          })
          .catch((err: unknown) => {
            console.error(`[${callSid}] failed to start session:`, err);
            socket.close();
          });
        break;
      }

      case "media": {
        session?.onAudio(mediaPayload(msg));
        break;
      }

      case "mark": {
        session?.onMark(msg.mark.name);
        break;
      }

      case "stop": {
        void session?.close();
        sessions.delete(callSid);
        break;
      }
    }
  });

  socket.on("close", () => {
    void session?.close();
    if (callSid) sessions.delete(callSid);
  });
});

async function startSession(
  socket: import("ws").WebSocket,
  streamSid: string,
  callSid: string,
  calledNumber: string,
): Promise<Session | null> {
  const tenant = await control.tenantForNumber(calledNumber);
  if (!tenant) {
    console.warn(`[${callSid}] no tenant configured for ${calledNumber}`);
    socket.close();
    return null;
  }

  const session = new Session({
    socket,
    streamSid,
    callSid,
    tenant,
    recogniser: new DeepgramRecogniser({ apiKey: config.deepgramApiKey }),
    synthesiser: new CartesiaSynthesiser({
      apiKey: config.cartesiaApiKey,
      voiceId: config.cartesiaVoiceId,
    }),
    model: new ClaudeModel({ apiKey: config.anthropicApiKey }),
    persist: (record) => control.persistCall(record),
    transfer: (sid, to, reason) => control.transfer(sid, to, reason),
  });

  await session.start();
  return session;
}

server.listen(config.port, () => {
  console.info(`nightbell media server listening on :${config.port}`);
});

/**
 * Graceful shutdown.
 *
 * Fly sends SIGTERM on deploy. Live calls get a moment to finish and persist
 * rather than being cut off mid-sentence — a deploy should never be the reason
 * a contractor loses a job.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.info(`${signal} received, draining ${sessions.size} call(s)`);
    server.close();
    void Promise.allSettled([...sessions.values()].map((s) => s.close())).then(() => {
      process.exit(0);
    });
  });
}

export type { TenantConfig };
