import Srf from 'drachtio-srf';

import { OpenAIRealtimeService } from '../llm/openai-realtime.service';

// Configuration via .env
const SIP_SERVER = process.env.SIP_SERVER || '1142.3cx.cloud';
const SIP_PORT = parseInt(process.env.SIP_PORT || '5060');
const SIP_USERNAME = process.env.SIP_USERNAME || '48013';
const SIP_PASSWORD = process.env.SIP_PASSWORD || '';
const SIP_FROM_DOMAIN = process.env.SIP_FROM_DOMAIN || '1142.3cx.cloud';
const RTP_ENGINE_HOST = process.env.RTP_ENGINE_HOST || '127.0.0.1';
const RTP_ENGINE_PORT = parseInt(process.env.RTP_ENGINE_PORT || '22222');

export class SipBotService {
  private srf: Srf;

  private activeCalls = new Map<string, {
    openai: OpenAIRealtimeService;
    rtpOffer: any;
    rtpAnswer: any;
  }>();

  constructor() {
    this.srf = new Srf();
    // Client pour rtpengine (si tu en as un, sinon on gérera le RTP directement)
    // this.rtpEngine = new RtpEngine({ host: RTP_ENGINE_HOST, port: RTP_ENGINE_PORT });
  }

  async start(): Promise<void> {
    // Déterminer le protocole (sips pour TLS/5061, sip pour UDP/TCP/5060)
    const isTls = SIP_PORT === 5061;
    const protocol = isTls ? 'sips' : 'sip';
    
    // Se connecter au serveur SIP (3CX)
    this.srf.connect({
      host: SIP_SERVER,
      port: SIP_PORT,
      secret: SIP_PASSWORD
    });

    this.srf.on('connect', (err: any) => {
      if (err) {
        console.error('[SIP] Erreur connexion:', err);
        return;
      }
      console.log(`[${protocol}] Connecté à ${SIP_SERVER}:${SIP_PORT} en tant que ${SIP_USERNAME}`);
      
      // S'enregistrer (REGISTER)
      this.register();
    });

    // Gérer les appels entrants (INVITE)
    this.srf.invite(async (req: any, res: any) => {
      const callId = req.get('Call-ID');
      const from = req.callingNumber || 'unknown';
      console.log(`[${protocol}] Appel entrant de ${from}, Call-ID: ${callId}`);

      try {
        // 1. Décrocher (200 OK)
        // 2. Négocier le RTP (SDP offer/answer)
        // 3. Connecter à OpenAI Realtime
        
        await this.handleIncomingCall(req, res, callId);
      } catch (error) {
        console.error(`[${protocol}] Erreur traitement appel:`, error);
        res.send(500);
      }
    });
  }

  private async register(): Promise<void> {
    // Envoyer REGISTER pour s'enregistrer sur 3CX
    try {
      const isTls = SIP_PORT === 5061;
      const protocol = isTls ? 'sips' : 'sip';
    
      await (this.srf.request as any)(
        `${protocol}:${SIP_SERVER}`,
        {
          headers: {
            'From': `<sip:${SIP_USERNAME}@${SIP_FROM_DOMAIN}>`,
            'To': `<sip:${SIP_USERNAME}@${SIP_FROM_DOMAIN}>`,
            'Contact': `<${protocol}:${SIP_USERNAME}@${SIP_SERVER}:${SIP_PORT}>`
          }
        },
        'REGISTER',
        ''
      );
      console.log('[SIP] REGISTER envoyé avec succès');
    } catch (err) {
      console.error('[SIP] Erreur REGISTER:', err);
    }
  }

  private async handleIncomingCall(req: any, res: any, callId: string): Promise<void> {
    const remoteSdp = req.body;
    
    // Créer une instance OpenAI Realtime pour cet appel
    const openai = new OpenAIRealtimeService(
      // onAudioReceived: quand OpenAI envoie de l'audio, on l'envoie en RTP
      (base64Audio: string) => {
        this.sendAudioToRtp(base64Audio, callId);
      },
      // onTextReceived: logs/debug
      (text: string) => {
        console.log('[OpenAI]', text);
      },
      // onToolCall: gérer transfer_human / take_message
      async (toolCall: any) => {
        return this.handleToolCall(toolCall, callId, req, res);
      }
    );

    // Connecter à OpenAI
    await openai.connect();

    // Stocker la session
    this.activeCalls.set(callId, {
      openai,
      rtpOffer: null,
      rtpAnswer: null
    });

    // Répondre 200 OK avec SDP (acceptation de l'appel)
    // Pour l'instant, on accepte G.711 PCMU/PCMA (8000Hz)
    const localSdp = this.generateLocalSdp();
    
   res.send(200, { body: localSdp, headers: { 'Content-Type': 'application/sdp' } });

    console.log(`[SIP] Appel ${callId} décroché, pont vers OpenAI établi`);

    // Démarrer le flux audio
    // Note: ici il faut recevoir le RTP et le convertir en PCM16 pour OpenAI
    this.startRtpToOpenaiPipeline(callId, req);
  }

  private generateLocalSdp(): string {
    // SDP minimal pour G.711 (PCMU/PCMA)
    return `v=0
    o=- 0 0 IN IP4 127.0.0.1
    s=SIP Bot
    c=IN IP4 127.0.0.1
    t=0 0
    m=audio 10000 RTP/AVP 0 8
    a=rtpmap:0 PCMU/8000
    a=rtpmap:8 PCMA/8000`;
    }

  private async sendAudioToRtp(base64Audio: string, callId: string): Promise<void> {
    // TODO: Convertir base64 PCM16 en RTP (G.711) et envoyer
    // Cette partie nécessite un proxy RTP ou rtpengine
    console.log('[RTP] Envoi audio vers 3CX (à implémenter)');
  }

  private startRtpToOpenaiPipeline(callId: string, req: any): void {
    // TODO: Recevoir RTP de 3CX, convertir en PCM16, envoyer à OpenAI
    console.log('[RTP] Réception audio depuis 3CX (à implémenter)');
    
    const session = this.activeCalls.get(callId);
    if (!session) return;

    // Simuler pour l'instant: envoyer un message de test
    setTimeout(() => {
      session.openai.sendUserText("Bonjour, je suis votre assistant IA. Comment puis-je vous aider?");
    }, 1000);
  }

  private async handleToolCall(toolCall: any, callId: string, req: any, res: any): Promise<any> {
    const { name, arguments: args } = toolCall;
    
    console.log(`[Tool] ${name}`, args);

    if (name === 'transfer_human') {
      // Transférer l'appel vers 48010 (humain)
      await this.transferCall(req, res, '48010', args.reason || 'Transfert vers humain');
      return { status: 'transferred', target: '48010' };
    }

    if (name === 'take_message') {
      // Note: prendre un message implique de l'enregistrer quelque part
      console.log('[Tool] Message reçu:', args);
      return { status: 'message_recorded', ...args };
    }

    return { error: 'Unknown tool' };
  }

  private async transferCall(req: any, res: any, target: string, reason: string): Promise<void> {
    // Envoyer REFER pour transférer l'appel (si supporté par 3CX)
    // Ou alternative: envoyer 302 Moved Temporarily
    console.log(`[SIP] Transfert vers ${target}: ${reason}`);
    
    // Pour l'instant, on termine proprement
    const callId = req.get('Call-ID');
    const session = this.activeCalls.get(callId);
    if (session) {
      session.openai.close();
      this.activeCalls.delete(callId);
    }
  }

  async stop(): Promise<void> {
    this.srf.disconnect();
    console.log('[SIP] Déconnecté');
  }
}