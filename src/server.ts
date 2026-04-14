import crypto from "crypto";
import dotenv from "dotenv";
import express from "express";
import http from "http";
import { createClient } from "redis";
import { WebSocketServer } from "ws";
import { OpenAIRealtimeService } from "./infrastructure/llm/openai-realtime.service";
dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.static("public")); // sert index.html, app.js, etc.
const server = http.createServer(app);
// IMPORTANT: deux WebSocketServer sur le même `server` doivent être routés via `upgrade`
// (sinon plusieurs listeners d'upgrade peuvent provoquer des handshakes/cadres invalides).
const wss = new WebSocketServer({ noServer: true });
const wssTwilio = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = req.url || "/";

  if (url.startsWith("/twilio/media")) {
    wssTwilio.handleUpgrade(req, socket, head, (ws) => {
      wssTwilio.emit("connection", ws, req);
    });
    return;
  }

  // default WS: client web local
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const redis = createClient({ url: redisUrl });

let redisConnected = false;

redis.on("error", (err) => {
  // Silencieux si non connecté (évite le spam)
  if (redisConnected) {
    console.error("Redis error:", err);
  }
});

void redis.connect().then(() => {
  redisConnected = true;
  console.log("Redis connecté:", redisUrl);
}).catch((e) => {
  console.log("Redis non disponible (optionnel pour les tests SIP)");
});

type TakeMessageArgs = {
  name?: string;
  phone?: string;
  message: string;
};

type TransferHumanArgs = {
  reason: string;
  target?: string;
};

type Session = {
  callId: string;
  createdAt: number;
  closedAt?: number;
  durationMs?: number;
  lastTool?: string;
  outcome?: "message_taken" | "transfer_requested" | "abandoned";
  state: "idle" | "collect_phone" | "collect_message" | "done";
  stateSinceAt: number;
  collectedPhone?: string;
  nudgesTotal: number;
  stateNudgesTotal: number;
  lastUserText?: string;
  lastIaText?: string;
  userTranscripts: Array<{ at: number; text: string }>;
  iaTranscripts: Array<{ at: number; text: string }>;
  events: Array<{ at: number; type: string; data?: any }>;
  messages: Array<{ at: number; name?: string; phone?: string; message: string }>;
  transfers: Array<{ at: number; reason: string; target?: string }>;
};

const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 60 * 60 * 24); // 24h
const SESSION_KEY_PREFIX = "balbine:session:";
const SESSION_INDEX_KEY = "balbine:sessions:recent";

function sessionKey(callId: string) {
  return `${SESSION_KEY_PREFIX}${callId}`;
}

async function persistSession(session: Session) {
  if (!redisConnected) return;
  const key = sessionKey(session.callId);
  await redis.set(key, JSON.stringify(session), { EX: SESSION_TTL_SECONDS });
  await redis.lPush(SESSION_INDEX_KEY, session.callId);
  await redis.lTrim(SESSION_INDEX_KEY, 0, 199);
}

async function readSession(callId: string): Promise<Session | null> {
  if (!redisConnected) return null;
  const raw = await redis.get(sessionKey(callId));
  if (!raw) return null;
  return JSON.parse(raw) as Session;
}

async function readRecentSessions(limit = 50): Promise<Session[]> {
  if (!redisConnected) return [];
  const callIds = await redis.lRange(SESSION_INDEX_KEY, 0, Math.max(0, limit - 1));
  if (callIds.length === 0) return [];
  const keys = callIds.map(sessionKey);
  const raws = await redis.mGet(keys);
  const sessions: Session[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    try {
      sessions.push(JSON.parse(raw) as Session);
    } catch {
      // ignore
    }
  }
  return sessions;
}

app.get("/debug", (_req, res) => {
  res.json({ status: "Server is Running", realtime: "active" });
});

app.get("/debug/sessions", async (req, res) => {
  const limit = Number(req.query.limit || 50);
  const sessions = await readRecentSessions(limit);
  res.json({ count: sessions.length, sessions });
});

app.get("/debug/sessions/:callId", async (req, res) => {
  const { callId } = req.params;
  const session = await readSession(callId);
  if (!session) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(session);
});

app.post("/twilio/voice", (req, res) => {
  const callSid = req.body.CallSid || 'unknown';
  const from = req.body.From || 'unknown';
  const to = req.body.To || 'unknown';
  
  console.log(`\n🚨🚨🚨 TWILIO WEBHOOK REÇU 🚨🚨🚨`);
  console.log(`   Call SID: ${callSid}`);
  console.log(`   From: ${from}`);
  console.log(`   To: ${to}`);
  console.log(`   Time: ${new Date().toISOString()}`);
  console.log(`🚨🚨🚨 TWILIO WEBHOOK REÇU 🚨🚨🚨\n`);
  
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
  const proto = String(req.headers["x-forwarded-proto"] || "https");
  const base = process.env.PUBLIC_BASE_URL || (host ? `${proto}://${host}` : "");
  const wsUrl = process.env.PUBLIC_WSS_URL || (base ? base.replace(/^http/, "ws") + "/twilio/media" : "");

  console.log(`   → Stream URL: ${wsUrl}`);
  console.log(`   → Réponse TwiML envoyée\n`);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  res.setHeader("Content-Type", "text/xml");
  res.send(twiml);
});

function mulawDecode(uVal: number) {
  let u = (~uVal) & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function mulawEncode(pcm16: number) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let pcm = pcm16;
  let sign = 0;
  if (pcm < 0) {
    sign = 0x80;
    pcm = -pcm;
  }
  if (pcm > CLIP) pcm = CLIP;
  pcm += BIAS;

  let exponent = 7;
  for (let exp = 0; exp < 8; exp++) {
    if (pcm <= (0x1f << (exp + 3))) {
      exponent = exp;
      break;
    }
  }
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  const uval = ~(sign | (exponent << 4) | mantissa);
  return uval & 0xff;
}

function ulawToPcm16_8k(buf: Buffer) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = mulawDecode(buf[i]);
  return out;
}

function pcm16_24kToUlaw_8k(pcm24k: Int16Array) {
  const outLen = Math.floor(pcm24k.length / 3);
  const out = Buffer.alloc(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = pcm24k[i * 3];
    out[i] = mulawEncode(s);
  }
  return out;
}

function upsample8kTo24k(pcm8k: Int16Array) {
  const out = new Int16Array(pcm8k.length * 3);
  for (let i = 0; i < pcm8k.length; i++) {
    const s0 = pcm8k[i];
    const s1 = i + 1 < pcm8k.length ? pcm8k[i + 1] : s0;
    out[i * 3] = s0;
    out[i * 3 + 1] = (2 * s0 + s1) / 3;
    out[i * 3 + 2] = (s0 + 2 * s1) / 3;
  }
  return out;
}

function bufferToInt16Array(buf: Buffer) {
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
}

wss.on("connection", (ws) => {
  console.log("Client connecté pour un appel Realtime");

  let clientClosed = false;

  const session: Session = {
    callId: crypto.randomUUID(),
    createdAt: Date.now(),
    state: "idle",
    stateSinceAt: Date.now(),
    nudgesTotal: 0,
    stateNudgesTotal: 0,
    userTranscripts: [],
    iaTranscripts: [],
    events: [],
    messages: [],
    transfers: [],
  };

  void persistSession(session).catch(() => {
    // ignore
  });

  const silenceMs = Number(process.env.SILENCE_TIMEOUT_MS || 15000);
  const maxNudges = Number(process.env.SILENCE_MAX_NUDGES || 2);
  const activityThreshold = Number(process.env.SILENCE_ACTIVITY_THRESHOLD || 200);
  const silenceDebug = process.env.SILENCE_DEBUG === "1";
  let lastAudioAt = Date.now();
  let nudgeCount = 0;
  let stateNudgeCount = 0;
  let silenceTimer: NodeJS.Timeout | null = null;

  const isActiveAudio = (pcm16Buffer: Buffer) => {
    // Le client web envoie souvent en continu même quand on ne parle pas (silence numérique).
    // On détecte une "activité" minimale pour ne pas réinitialiser le timer sur du silence.
    // PCM16 little-endian mono.
    const sampleCount = Math.floor(pcm16Buffer.length / 2);
    if (sampleCount <= 0) return false;

    // On échantillonne pour réduire le coût CPU.
    const step = Math.max(1, Math.floor(sampleCount / 200));
    let sumAbs = 0;
    let maxAbs = 0;
    let n = 0;
    for (let i = 0; i < sampleCount; i += step) {
      const v = pcm16Buffer.readInt16LE(i * 2);
      const av = Math.abs(v);
      sumAbs += av;
      if (av > maxAbs) maxAbs = av;
      n += 1;
    }
    const avgAbs = sumAbs / Math.max(1, n);

    if (silenceDebug) {
      console.log("🔈 Audio energy avgAbs=", Math.round(avgAbs), "maxAbs=", maxAbs);
    }

    // On considère une activité si :
    // - moyenne au-dessus du seuil (parole probable)
    // - OU pic très élevé (consonnes/pics) même si moyenne plus basse.
    const peakThreshold = activityThreshold * 8;
    return avgAbs >= activityThreshold || maxAbs >= peakThreshold;
  };

  const onAudioReceived = (base64Audio: string) => {
    if (ws.readyState === ws.OPEN) ws.send(Buffer.from(base64Audio, "base64"));
  };

  const onTextReceived = (_text: string) => {
    // Le service Realtime peut nous envoyer :
    // - soit des deltas texte (pour debug)
    // - soit un JSON {role:'user'|'assistant', text:'...'} pour les transcripts finaux
    const at = Date.now();
    const text = String(_text || "");

    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && typeof parsed.text === "string") {
        const t = String(parsed.text);
        const lowered = t.toLowerCase();

        if (parsed.role === "user") {
          session.userTranscripts.push({ at, text: t });
          session.events.push({ at, type: "transcript.user", data: { text: t } });
          session.lastUserText = t;

          // Si on attend un numéro, et que l'utilisateur en donne un, on sort de l'état.
          if (session.state === "collect_phone") {
            const digits = t.replace(/\D/g, "");
            if (digits.length >= 8) {
              session.collectedPhone = digits;
              session.state = "idle";
              session.stateSinceAt = at;
              stateNudgeCount = 0;
              session.events.push({ at, type: "state.change", data: { state: session.state } });
            }
          }

          // Si on attend un message, et que l'utilisateur répond, on sort de l'état.
          if (session.state === "collect_message") {
            if (t.trim().length >= 3) {
              session.state = "idle";
              session.stateSinceAt = at;
              stateNudgeCount = 0;
              session.events.push({ at, type: "state.change", data: { state: session.state } });
            }
          }
        } else if (parsed.role === "assistant") {
          session.iaTranscripts.push({ at, text: t });
          session.events.push({ at, type: "transcript.assistant", data: { text: t } });
          session.lastIaText = t;

          // Détection d'intention : si l'IA demande explicitement un numéro, on passe en collect_phone.
          if (
            lowered.includes("quel est votre numéro") ||
            lowered.includes("votre numéro") ||
            lowered.includes("numéro de téléphone") ||
            lowered.includes("votre telephone") ||
            lowered.includes("votre téléphone")
          ) {
            if (session.state !== "collect_phone") {
              session.state = "collect_phone";
              session.stateSinceAt = at;
              stateNudgeCount = 0;
              session.events.push({ at, type: "state.change", data: { state: session.state } });
            }
          }

          // Détection d'intention : si l'IA demande le contenu du message, on passe en collect_message.
          if (
            lowered.includes("quel message") ||
            lowered.includes("votre message") ||
            lowered.includes("laissez un message") ||
            lowered.includes("laisser un message")
          ) {
            if (session.state !== "collect_message") {
              session.state = "collect_message";
              session.stateSinceAt = at;
              stateNudgeCount = 0;
              session.events.push({ at, type: "state.change", data: { state: session.state } });
            }
          }
        }
        void persistSession(session).catch(() => {
          // ignore
        });
        return;
      }
    } catch {
      // pas un JSON, on considère ça comme un delta debug
    }

    // Delta debug (optionnel)
    session.events.push({ at, type: "transcript.delta", data: { text } });
  };

  const onToolCall = async (toolCall: any) => {
    const name = String(toolCall?.name || "");
    const args = toolCall?.arguments || {};

    session.lastTool = name;
    session.events.push({ at: Date.now(), type: "tool.call", data: { name, args } });
    console.log("Exécution outil:", name, args, "callId=", session.callId);

    switch (name) {
      case "take_message": {
        const { name, phone, message } = args as TakeMessageArgs;

        if (!message || typeof message !== "string") {
          return { ok: false, error: "message is required" };
        }

        session.messages.push({
          at: Date.now(),
          name,
          phone,
          message,
        });

        session.events.push({ at: Date.now(), type: "tool.result", data: { name: "take_message", ok: true } });

        session.outcome = "message_taken";

        session.state = "done";
        session.stateSinceAt = Date.now();
        session.events.push({ at: Date.now(), type: "state.change", data: { state: session.state } });

        await persistSession(session);

        return {
          ok: true,
          callId: session.callId,
          saved: true,
        };
      }

      case "transfer_human": {
        const { reason, target } = args as TransferHumanArgs;

        if (!reason || typeof reason !== "string") {
          return { ok: false, error: "reason is required" };
        }

        session.transfers.push({ at: Date.now(), reason, target });

        session.events.push({ at: Date.now(), type: "tool.result", data: { name: "transfer_human", ok: true } });

        session.outcome = "transfer_requested";

        session.state = "done";
        session.stateSinceAt = Date.now();
        session.events.push({ at: Date.now(), type: "state.change", data: { state: session.state } });

        await persistSession(session);

        // Module 1: on simule le transfert. Plus tard, ici tu appelleras 3CX/SIP.
        return {
          ok: true,
          callId: session.callId,
          transfer: "queued",
          target: target || null,
        };
      }

      default:
        return { ok: false, error: "Unknown function", name };
    }
  };

  const realtime = new OpenAIRealtimeService(onAudioReceived, onTextReceived, onToolCall);

  realtime.connect().then(() => {
    if (clientClosed) return;
    console.log("Bridge Realtime OpenAI établi.");
  }).catch(e => {
    // Si le client amont s'est déjà déconnecté, ce rejet est attendu (connexion OpenAI
    // interrompue) et ne doit pas polluer les logs.
    if (clientClosed) return;
    console.error("Erreur bridge Realtime:", e);
    try {
      ws.close();
    } catch {
      // ignore
    }
  });

  const startSilenceTimer = () => {
    if (silenceTimer) return;
    silenceTimer = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;

      const now = Date.now();
      const silentFor = now - lastAudioAt;
      if (silentFor < silenceMs) return;
      if (nudgeCount >= maxNudges) return;
      if (session.state === "done") return;

      nudgeCount += 1;
      session.nudgesTotal += 1;
      if (session.state === "collect_phone" || session.state === "collect_message") {
        stateNudgeCount += 1;
        session.stateNudgesTotal += 1;
      }

      console.log("⏱️ Silence timeout:", silentFor, "ms => nudge", nudgeCount, "callId=", session.callId);
      session.events.push({
        at: now,
        type: "silence.nudge",
        data: { silentForMs: silentFor, nudgeCount, state: session.state, stateNudgeCount },
      });
      void persistSession(session).catch(() => {
        // ignore
      });

      // Nudge 1: check presence. Nudge 2: propose leaving a message.
      if (session.state === "collect_phone") {
        // Si on insiste trop sans réponse, on fallback sur un message sans numéro.
        if (stateNudgeCount >= maxNudges) {
          session.state = "collect_message";
          session.stateSinceAt = now;
          stateNudgeCount = 0;
          session.events.push({ at: now, type: "state.change", data: { state: session.state, reason: "phone_timeout" } });
          void persistSession(session).catch(() => {
            // ignore
          });
          realtime.sendUserText("Je peux prendre votre message même sans numéro, quel message souhaitez-vous laisser ?");
        } else {
          realtime.sendUserText("Quel est votre numéro de téléphone ?");
        }
      } else if (session.state === "collect_message") {
        // Si on n'obtient pas de message après plusieurs relances, on clôture avec un rappel automatique.
        if (stateNudgeCount >= maxNudges) {
          const phone = session.collectedPhone;
          session.messages.push({
            at: now,
            phone,
            message: "Rappel demandé mais aucun message n'a été dicté (silence).",
          });
          session.events.push({
            at: now,
            type: "fallback.take_message",
            data: { phone: phone || null },
          });
          session.outcome = "message_taken";
          session.state = "done";
          session.stateSinceAt = now;
          session.events.push({ at: now, type: "state.change", data: { state: session.state, reason: "message_timeout" } });
          void persistSession(session).catch(() => {
            // ignore
          });
          realtime.sendUserText("D'accord, je note une demande de rappel.");
        } else {
          realtime.sendUserText("Quel message souhaitez-vous laisser ?");
        }
      } else {
        if (nudgeCount === 1) {
          realtime.sendUserText("Êtes-vous toujours là ?");
        } else {
          realtime.sendUserText("Souhaitez-vous laisser un message pour être rappelé ?");
        }
      }

      // On évite d'envoyer des nudges en boucle si aucun audio ne revient.
      lastAudioAt = now;
    }, 1000);
  };

  startSilenceTimer();

  ws.on("message", (data: any, isBinary: boolean) => {
    // Côté navigateur, on envoie un ArrayBuffer (PCM16). Avec `ws`, ça arrive parfois
    // en Buffer, parfois en ArrayBuffer/Uint8Array. On se base donc sur isBinary.
    if (isBinary) {
      const buffer = Buffer.isBuffer(data)
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.from(data as any);

      console.log("🎧 Audio chunk reçu:", buffer.length, "bytes");

      if (isActiveAudio(buffer)) {
        lastAudioAt = Date.now();
        nudgeCount = 0;
        stateNudgeCount = 0;
      }

      realtime.sendAudio(buffer.toString("base64"));
      return;
    }

    // Messages non binaires (JSON) -> commandes (interrupt)
    try {
      const message = JSON.parse(data.toString());
      if (message.type === "interrupt") {
        console.log("Interruption client reçue");
        realtime.interrupt();
      }
    } catch (_e) {
      console.log("Message client (texte):", data.toString());
    }
  });

  ws.on("close", () => {
    console.log("Client déconnecté, fermeture du bridge OpenAI");
    clientClosed = true;
    realtime.close();

    if (silenceTimer) {
      clearInterval(silenceTimer);
      silenceTimer = null;
    }

    session.closedAt = Date.now();
    session.durationMs = session.closedAt - session.createdAt;
    if (!session.outcome) {
      // Si aucun tool n'a été appelé et aucun message/transfert n'a été enregistré.
      session.outcome = "abandoned";
    }
    session.events.push({ at: Date.now(), type: "ws.close" });
    void persistSession(session).catch(() => {
      // ignore
    });
  });
});

wssTwilio.on("connection", (ws) => {
  console.log(`\n✅✅✅ WEBSOCKET TWILIO CONNECTÉ ✅✅✅`);
  console.log(`   Time: ${new Date().toISOString()}`);
  console.log(`✅✅✅ WEBSOCKET TWILIO CONNECTÉ ✅✅✅\n`);

  const session: Session = {
    callId: crypto.randomUUID(),
    createdAt: Date.now(),
    state: "idle",
    stateSinceAt: Date.now(),
    nudgesTotal: 0,
    stateNudgesTotal: 0,
    userTranscripts: [],
    iaTranscripts: [],
    events: [],
    messages: [],
    transfers: [],
  };

  let streamSid: string | null = null;

  void persistSession(session).catch(() => {
    // ignore
  });

  const onAudioReceived = (base64Audio: string) => {
    if (!streamSid) return;
    if (ws.readyState !== ws.OPEN) return;

    const pcmBuf = Buffer.from(base64Audio, "base64");
    const pcm24 = bufferToInt16Array(pcmBuf);
    const ulaw8 = pcm16_24kToUlaw_8k(pcm24);

    ws.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: ulaw8.toString("base64") },
      })
    );
  };

  const onTextReceived = (_text: string) => {
    const at = Date.now();
    const text = String(_text || "");

    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && typeof parsed.text === "string") {
        const t = String(parsed.text);
        if (parsed.role === "user") {
          session.userTranscripts.push({ at, text: t });
          session.lastUserText = t;
          session.events.push({ at, type: "transcript.user", data: { text: t } });
        } else if (parsed.role === "assistant") {
          session.iaTranscripts.push({ at, text: t });
          session.lastIaText = t;
          session.events.push({ at, type: "transcript.assistant", data: { text: t } });
        }

        void persistSession(session).catch(() => {
          // ignore
        });
      }
    } catch {
      // ignore
    }
  };

  const onToolCall = async (toolCall: any) => {
    const name = String(toolCall?.name || "");
    const args = toolCall?.arguments || {};

    session.lastTool = name;
    session.events.push({ at: Date.now(), type: "tool.call", data: { name, args } });
    console.log("Exécution outil (Twilio):", name, args, "callId=", session.callId);

    switch (name) {
      case "take_message": {
        const { name, phone, message } = args as TakeMessageArgs;
        if (!message || typeof message !== "string") {
          return { ok: false, error: "message is required" };
        }

        session.messages.push({ at: Date.now(), name, phone, message });
        session.events.push({ at: Date.now(), type: "tool.result", data: { name: "take_message", ok: true } });
        session.outcome = "message_taken";
        session.state = "done";
        session.stateSinceAt = Date.now();
        session.events.push({ at: Date.now(), type: "state.change", data: { state: session.state } });

        await persistSession(session);
        return { ok: true, callId: session.callId, saved: true };
      }

      case "transfer_human": {
        const { reason, target } = args as TransferHumanArgs;
        if (!reason || typeof reason !== "string") {
          return { ok: false, error: "reason is required" };
        }

        session.transfers.push({ at: Date.now(), reason, target });
        session.events.push({ at: Date.now(), type: "tool.result", data: { name: "transfer_human", ok: true } });
        session.outcome = "transfer_requested";
        session.state = "done";
        session.stateSinceAt = Date.now();
        session.events.push({ at: Date.now(), type: "state.change", data: { state: session.state } });

        await persistSession(session);
        return { ok: true, callId: session.callId, transfer: "queued", target: target || null };
      }

      default:
        return { ok: false, error: "Unknown function", name };
    }
  };

  const realtime = new OpenAIRealtimeService(onAudioReceived, onTextReceived, onToolCall);

  realtime.connect().then(() => {
    console.log("[TWILIO] Bridge Realtime OpenAI établi.");
  }).catch(e => {
    console.error("[TWILIO] Erreur bridge Realtime:", e);
    ws.close();
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "start") {
        streamSid = msg.start?.streamSid || msg.streamSid || null;
        console.log(`\n🎙️🎙️🎙️ STREAM AUDIO DÉMARRÉ 🎙️🎙️🎙️`);
        console.log(`   Stream SID: ${streamSid}`);
        console.log(`   Call SID: ${msg.start?.callSid || 'unknown'}`);
        console.log(`🎙️🎙️🎙️ STREAM AUDIO DÉMARRÉ 🎙️🎙️🎙️\n`);
        session.events.push({ at: Date.now(), type: "twilio.start", data: { streamSid } });
        void persistSession(session).catch(() => {
          // ignore
        });
        return;
      }

      if (msg.event === "stop") {
        session.events.push({ at: Date.now(), type: "twilio.stop" });
        ws.close();
        return;
      }

      if (msg.event === "media") {
        const payload = msg.media?.payload;
        if (!payload) return;
        const ulawBuf = Buffer.from(payload, "base64");
        const pcm8 = ulawToPcm16_8k(ulawBuf);
        const pcm24 = upsample8kTo24k(pcm8);
        realtime.sendAudio(Buffer.from(pcm24.buffer).toString("base64"));
        return;
      }
    } catch {
      // ignore
    }
  });

  ws.on("close", () => {
    console.log("Client Twilio déconnecté");
    realtime.close();

    session.closedAt = Date.now();
    session.durationMs = session.closedAt - session.createdAt;
    if (!session.outcome) session.outcome = "abandoned";
    session.events.push({ at: Date.now(), type: "ws.close" });
    void persistSession(session).catch(() => {
      // ignore
    });
  });
});

// =========================
// 3CX Call Flow Designer (CFD) Webhook
// =========================
// Endpoint pour recevoir les requêtes de 3CX CFD
// Format attendu par 3CX: JSON avec action à exécuter
app.post("/webhook/3cx-cfd", express.json(), async (req, res) => {
  const { caller, callee, callId, action } = req.body;
  
  console.log(`[3CX-CFD] Appel de ${caller} vers ${callee}, CallID: ${callId}, Action: ${action}`);
  
  // Réponse par défaut: continuer le flux 3CX normalement
  res.json({
    success: true,
    action: "continue",
    message: "Appel reçu par l'IA"
  });
});

// Endpoint GET pour tester la connectivité depuis 3CX
app.get("/webhook/3cx-cfd", (req, res) => {
  res.json({ status: "ok", service: "Balbine AI Webhook" });
});

const PORT = Number(process.env.PORT || 3001);
server.listen(PORT, "0.0.0.0", () => {
  console.log(` Serveur Realtime Balbine démarré !
------------------------------------------
Local: http://localhost:${PORT}
------------------------------------------
Webhooks 3CX:
  POST /webhook/3cx-cfd
  GET  /webhook/3cx-cfd (test)
------------------------------------------
`);

// Note: SIP Bot désactivé temporairement - on utilise 3CX CFD/Webhook à la place
// const sipBot = new SipBotService();
// sipBot.start().catch(err => console.error('SIP Bot failed:', err));

console.log('[CFD] Webhook prêt. Utilisez 3CX Call Flow Designer pour appeler /webhook/3cx-cfd');
});