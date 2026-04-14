import { createConnection } from 'net';
import { OpenAIRealtimeService } from '../llm/openai-realtime.service';

/**
 * AudioSocket client (TCP) :
 * Asterisk -> AudioSocket -> Node (PCM16 8k) -> OpenAI Realtime (PCM16 24k)
 * OpenAI -> Node -> AudioSocket -> Asterisk (PCM16 8k)
 *
 * AudioSocket envoie du PCM16 8kHz mono (PCMU sans header).
 * OpenAI attend du PCM16 24kHz.
 */
export class AudioSocketClient {
  private socket: ReturnType<typeof createConnection> | null = null;
  private openai: OpenAIRealtimeService;
  private callId: string;
  private isActive = false;

  constructor(callId: string) {
    this.callId = callId;
    this.openai = new OpenAIRealtimeService(
      this.onAudioReceived.bind(this),
      this.onTextReceived.bind(this),
      this.onToolCall.bind(this)
    );
  }

  async start(): Promise<void> {
    console.log(`[AudioSocket] Connexion vers Asterisk (127.0.0.1:5000) pour callId=${this.callId}`);
    this.socket = createConnection(5000, '127.0.0.1', () => {
      console.log('[AudioSocket] Connecté à Asterisk');
      this.isActive = true;
    });

    this.socket.on('data', (data) => {
      // AudioSocket envoie du PCM16 8kHz mono brut (sans header)
      if (!this.isActive) return;
      this.handleAudioFromAsterisk(data);
    });

    this.socket.on('close', () => {
      console.log('[AudioSocket] Fermé');
      this.isActive = false;
      this.openai.close();
    });

    this.socket.on('error', (err) => {
      console.error('[AudioSocket] Erreur:', err);
      this.isActive = false;
      this.openai.close();
    });

    // Connecter à OpenAI Realtime
    await this.openai.connect();
  }

  private handleAudioFromAsterisk(buf: Buffer) {
    // Asterisk envoie PCM16 8kHz ; OpenAI veut PCM16 24kHz
    const pcm8k = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
    const pcm24k = this.upsample8kTo24k(pcm8k);
    const base64 = Buffer.from(pcm24k.buffer).toString('base64');
    this.openai.sendAudio(base64);
  }

  private onAudioReceived(base64Audio: string) {
    // OpenAI envoie PCM16 24kHz ; Asterisk veut PCM16 8kHz
    const pcm24k = Buffer.from(base64Audio, 'base64');
    const pcm24kArray = new Int16Array(pcm24k.buffer, pcm24k.byteOffset, pcm24k.length / 2);
    const pcm8k = this.downsample24kTo8k(pcm24kArray);
    if (this.socket && this.isActive) {
      this.socket.write(Buffer.from(pcm8k.buffer));
    }
  }

  private onTextReceived(text: string) {
    console.log('[OpenAI]', text);
  }

  private async onToolCall(toolCall: any) {
    const name = toolCall?.name || '';
    const args = toolCall?.arguments || {};
    console.log('[Tool]', name, args);
    // TODO: intégrer avec la logique de session Redis comme dans server.ts
    return { ok: true, callId: this.callId };
  }

  // Simple upsample 8k -> 24k (x3)
  private upsample8kTo24k(pcm8k: Int16Array): Int16Array {
    const out = new Int16Array(pcm8k.length * 3);
    for (let i = 0; i < pcm8k.length; i++) {
      const s0 = pcm8k[i];
      const s1 = i + 1 < pcm8k.length ? pcm8k[i + 1] : s0;
      out[i * 3] = s0;
      out[i * 3 + 1] = Math.round((2 * s0 + s1) / 3);
      out[i * 3 + 2] = Math.round((s0 + 2 * s1) / 3);
    }
    return out;
  }

  // Simple downsample 24k -> 8k (moyenne par 3)
  private downsample24kTo8k(pcm24k: Int16Array): Int16Array {
    const out = new Int16Array(Math.floor(pcm24k.length / 3));
    for (let i = 0; i < out.length; i++) {
      const s0 = pcm24k[i * 3];
      const s1 = pcm24k[i * 3 + 1];
      const s2 = pcm24k[i * 3 + 2];
      out[i] = Math.round((s0 + s1 + s2) / 3);
    }
    return out;
  }

  async stop(): Promise<void> {
    this.isActive = false;
    if (this.socket) {
      this.socket.destroy();
    }
    this.openai.close();
  }
}
