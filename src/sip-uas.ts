/// <reference path="./types/sip.d.ts" />
import 'dotenv/config';

import { randomUUID } from 'crypto';
import sip from 'sip';

const HOST = process.env.SIP_BIND_HOST || '0.0.0.0';
const PORT = Number(process.env.SIP_BIND_PORT || 5060);

// IP publique (côté 3CX Cloud). Utilisée dans le SDP qu'on renvoie.
// Tu peux la forcer via .env : SIP_PUBLIC_IP=197.158.81.75
const PUBLIC_IP = process.env.SIP_PUBLIC_IP || '197.158.81.75';

// Port RTP "fictif" (on ne traite pas l'audio dans ce POC signalisation)
const RTP_PORT = Number(process.env.SIP_RTP_PORT || 40000);

function buildSdp(ip: string, port: number) {
  return [
    'v=0',
    `o=- 0 0 IN IP4 ${ip}`,
    's=balbine-sip-uas',
    `c=IN IP4 ${ip}`,
    't=0 0',
    `m=audio ${port} RTP/AVP 0 8`,
    'a=rtpmap:0 PCMU/8000',
    'a=rtpmap:8 PCMA/8000',
    'a=sendrecv',
    '',
  ].join('\r\n');
}

function logMsg(prefix: string, req: any) {
  const method = req?.method || req?.status;
  const callId = req?.headers?.['call-id'];
  const from = req?.headers?.from?.uri;
  const to = req?.headers?.to?.uri;
  console.log(`[SIP] ${prefix} ${method} call-id=${callId || '-'} from=${from || '-'} to=${to || '-'}`);
}

const sipStack = sip.start(
  {
    protocol: 'udp',
    address: HOST,
    port: PORT,
    // NOTE: on laisse le stack gérer les sockets.
  },
  (req: any) => {
    try {
      logMsg('RX', req);

      // Répondre aux keepalive OPTIONS
      if (req.method === 'OPTIONS') {
        const res = sip.makeResponse(req, 200, 'OK');
        sipStack.send(res);
        return;
      }

      // POC REGISTER: on répond OK (pas d'auth pour l'instant)
      if (req.method === 'REGISTER') {
        const res = sip.makeResponse(req, 200, 'OK');
        sipStack.send(res);
        return;
      }

      if (req.method === 'INVITE') {
        // 180 Ringing rapide
        sipStack.send(sip.makeResponse(req, 180, 'Ringing'));

        // 200 OK avec SDP minimal
        const sdp = buildSdp(PUBLIC_IP, RTP_PORT);
        const ok = sip.makeResponse(req, 200, 'OK', {
          headers: {
            'content-type': 'application/sdp',
            'contact': [{ uri: `sip:balbine@${PUBLIC_IP}:${PORT}` }],
          },
          content: sdp,
        });
        sipStack.send(ok);
        return;
      }

      if (req.method === 'ACK') {
        // Rien à faire en POC
        return;
      }

      if (req.method === 'BYE') {
        sipStack.send(sip.makeResponse(req, 200, 'OK'));
        return;
      }

      // Default
      sipStack.send(sip.makeResponse(req, 501, 'Not Implemented'));
    } catch (err) {
      console.error('[SIP] Handler error:', err);
      try {
        sipStack.send(sip.makeResponse(req, 500, 'Server Error'));
      } catch {
        // ignore
      }
    }
  }
);

console.log(`[SIP] UAS démarré sur udp://${HOST}:${PORT} (PUBLIC_IP=${PUBLIC_IP}) instance=${randomUUID()}`);
