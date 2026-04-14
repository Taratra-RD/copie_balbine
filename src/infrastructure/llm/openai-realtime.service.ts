import dotenv from 'dotenv';
import WebSocket from 'ws';

dotenv.config();

// Ce service est le "client" OpenAI Realtime.
// Il ouvre un WebSocket vers OpenAI, configure une session (voix, formats audio, règles),
// puis relaie (bridge) :
// - audio entrant (depuis ton client / 3CX) -> OpenAI
// - audio sortant (depuis OpenAI) -> ton serveur -> client
// - transcripts (texte) pour logs / debug
export class OpenAIRealtimeService {
  // WebSocket vers OpenAI (différent du WebSocket entre ton navigateur et ton serveur).
  private ws: WebSocket | null = null;

  // OPENAI_API_KEY : clé d'authentification pour le WS Realtime.
  private readonly apiKey = process.env.OPENAI_API_KEY;

  // Modèle Realtime utilisé (tu peux le surcharger avec OPENAI_MODEL dans .env).
  private readonly model = process.env.OPENAI_MODEL || 'gpt-4o-mini-realtime-preview';

  // URL du WebSocket Realtime. Le modèle est passé dans la query string.
  private readonly url = `wss://api.openai.com/v1/realtime?model=${this.model}`;

  // Flag local: permet de savoir si OpenAI est en train de générer une réponse.
  // Sert pour la gestion du "barge-in" (si l'utilisateur parle pendant que l'IA parle,
  // on annule la réponse en cours).
  private isGenerating = false;

  // Certaines erreurs arrivent si on appelle `response.create` alors qu'une réponse
  // est déjà en cours. On track donc l'état localement.
  private activeResponseId: string | null = null;
  private processedToolCallIds = new Set<string>();
  private lastResponseCreateAt = 0;

  // Callbacks fournis par ton serveur (voir src/server.ts)
  // - onAudioReceived: appelé quand OpenAI renvoie un chunk audio (base64)
  // - onTextReceived: appelé quand OpenAI renvoie un bout de transcript (debug)
  // - onToolCall: appelé quand OpenAI demande d'exécuter une fonction (ex: transfert humain)
  constructor(
    private onAudioReceived: (base64Audio: string) => void,
    private onTextReceived: (text: string) => void,
    private onToolCall: (toolCall: any) => Promise<any>
  ) {}

  // connect() ouvre la connexion Realtime vers OpenAI.
  // Dès que le socket est ouvert, on envoie un "session.update" pour configurer :
  // - la voix
  // - formats audio
  // - règles de comportement
  // - outils (functions) autorisés
  async connect() {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is missing');
    }

    this.ws = new WebSocket(this.url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    return new Promise((resolve, reject) => {
      let settled = false;

      this.ws?.on('open', () => {
        // Important : la session DOIT être initialisée dès l'ouverture.
        // C'est ici qu'on fixe la voix, la VAD (détection de tour de parole), etc.
        this.initializeSession();
        if (!settled) {
          settled = true;
          resolve(true);
        }
      });

      this.ws?.on('message', async (data) => {
        try {
          // OpenAI envoie des events JSON (type: response.audio.delta, response.done, etc.).
          const event = JSON.parse(data.toString());
          await this.handleEvent(event);
        } catch (e) {
          // ignore parse errors
        }
      });

      this.ws?.on('error', (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      this.ws?.on('close', () => {
        // Si la connexion se ferme avant le 'open', on rejette la promesse
        // (ex: client amont se déconnecte très vite et on ferme le socket).
        if (!settled) {
          settled = true;
          reject(new Error('OpenAI Realtime WS closed before open'));
        }
      });
    });
  }

  // initializeSession() configure le comportement de l'IA.
  // C'est l'équivalent d'un "prompt système" + paramètres audio.
  // Ici on limite volontairement à une réponse courte (1 phrase) pour réduire la latence
  // et garder l'expérience vocale naturelle.
  private initializeSession() {
    const baseInstructions = `Tu es une assistante vocale professionnelle d'une société de pièces auto (B2B). Tu réponds en français uniquement.

OBJECTIF (Module 1) : qualifier et router l'appel. Tu dois soit transférer à un humain, soit prendre un message pour rappel.

RÈGLES DE STYLE :
- 1 phrase maximum par réponse.
- Une seule question à la fois.
- Pas de blabla (pas de “bien sûr”, pas de phrases longues).

RÈGLES D'ACTION (TOOLS) :

1) TRANSFERT HUMAIN
- Si l'utilisateur demande un humain/commercial/atelier (“je veux parler à quelqu'un”, “un humain”, “transférez-moi”), appelle IMMÉDIATEMENT la fonction transfer_human.
- Arguments : {"reason": "...", "target": "sales"|"atelier"|"compta" (optionnel)}.
- Après le tool call, dis 1 phrase courte du type : “Je vous transfère.”

2) PRISE DE MESSAGE
- Si l'utilisateur demande de laisser un message / être rappelé / personne n'est dispo, alors tu dois appeler take_message.
- Si le téléphone manque, demande : “Quel est votre numéro ?” puis quand tu l'as, appelle take_message.
- Arguments : {"name": "..." (optionnel), "phone": "..." (optionnel), "message": "résumé court"}.
- Après le tool call, dis : “C'est noté, on vous rappelle.”

3) QUALIFICATION MINIMALE
- Si le motif n'est pas clair, demande : “Quel est le motif de votre appel ?”
- Si l'utilisateur parle d'une pièce, demande 1 info manquante à la fois (véhicule, année, motorisation) puis propose un transfert à un vendeur.

SÉCURITÉ
- Ne dis jamais que tu as appelé une API; contente-toi de l'action (transfert/message).`;

    this.send({
      type: 'session.update',
      session: {
        // modalities: on veut du texte (pour logs) ET de l'audio (pour répondre).
        modalities: ['text', 'audio'],
        instructions: baseInstructions,
        voice: process.env.OPENAI_VOICE || 'shimmer',

        // Formats audio : ici on s'aligne sur balbine-dev : PCM16.
        // Important : ton client doit envoyer de l'audio compatible.
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',

        // Transcription côté OpenAI : whisper-1.
        input_audio_transcription: { model: 'whisper-1' },

        // turn_detection = VAD côté serveur OpenAI.
        // Permet à OpenAI de détecter quand l'utilisateur commence / arrête de parler,
        // pour déclencher les réponses automatiquement.
        turn_detection: {
          type: 'server_vad',
          threshold: 0.6,
          prefix_padding_ms: 200,
          silence_duration_ms: 700,
        },

        // Tools: fonctions que l'IA a le droit d'appeler.
        // Pour Module 1, on se limite à : transfert humain + prise de message.
        tools: [
          {
            type: 'function',
            name: 'transfer_human',
            description: "Demander le transfert de l'appel vers un humain (extension/queue)",
            parameters: {
              type: 'object',
              properties: {
                reason: { type: 'string' },
                target: { type: 'string', description: 'Extension ou queue' },
              },
              required: ['reason'],
            },
          },
          {
            type: 'function',
            name: 'take_message',
            description: 'Prendre un message (nom/téléphone/raison) pour rappel',
            parameters: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                phone: { type: 'string' },
                message: { type: 'string' },
              },
              required: ['message'],
            },
          },
        ],
        tool_choice: 'auto',
      },
    });
  }

  // handleEvent() reçoit tous les events Realtime et applique la logique.
  // IMPORTANT : ce code ne "fabrique" pas la réponse.
  // Il se contente de relayer l'audio + gérer l'état (barge-in, tool calls, logs).
  private async handleEvent(event: any) {
    switch (event.type) {
      case 'response.created':
        // OpenAI commence à générer une réponse.
        this.isGenerating = true;
        this.activeResponseId = event.response?.id || event.response_id || this.activeResponseId;
        break;

      case 'response.audio.delta':
        // Un chunk audio (base64) arrive : on le renvoie au client via callback.
        if (event.delta) this.onAudioReceived(event.delta);
        break;

      case 'response.audio_transcript.delta':
        // Transcript incrémental (utile pour debug / monitoring).
        if (event.delta) this.onTextReceived(event.delta);
        break;

      case 'conversation.item.input_audio_transcription.completed':
        // Transcript user final (utile pour logs)
        if (event.transcript) {
          console.log(`[User] ${event.transcript}`);
          // On remonte le transcript final au serveur pour persistance/KPI.
          this.onTextReceived(JSON.stringify({ role: 'user', text: event.transcript }));
        }
        break;

      case 'response.audio_transcript.done':
        if (event.transcript) {
          console.log(`[IA] ${event.transcript}`);
          // On remonte le transcript final au serveur pour persistance/KPI.
          this.onTextReceived(JSON.stringify({ role: 'assistant', text: event.transcript }));
        }
        break;

      case 'response.done':
        // La réponse est terminée :
        // - on baisse le flag isGenerating
        // - on inspecte si OpenAI a demandé un tool call
        this.isGenerating = false;
        this.activeResponseId = null;
        await this.handleToolCalls(event);
        break;

      case 'input_audio_buffer.speech_started':
        // BARGE-IN : l'utilisateur recommence à parler pendant que l'IA parle.
        // On annule immédiatement la réponse en cours pour éviter les chevauchements.
        if (this.isGenerating) {
          this.send({ type: 'response.cancel' });
          this.isGenerating = false;
          this.activeResponseId = null;
        }
        break;

      case 'error':
        // ignore some non-blocking errors
        if (event.error?.code === 'response_cancel_not_active') break;
        console.error('Realtime error:', event.error?.message || event.error);
        break;
    }
  }

  // handleToolCalls() lit les outputs de la réponse.
  // Si OpenAI décide d'appeler une fonction, on :
  // 1) appelle onToolCall(...) côté serveur
  // 2) renvoie le résultat à OpenAI (function_call_output)
  // 3) demande à OpenAI de continuer la réponse (response.create)
  private async handleToolCalls(event: any) {
    const outputs = event.response?.output || [];
    for (const output of outputs) {
      if (output?.type !== 'function_call') continue;

      const { name, arguments: args, call_id } = output;

      // Déduplication: certains modèles peuvent répéter le même tool call.
      if (call_id && this.processedToolCallIds.has(call_id)) {
        continue;
      }
      if (call_id) this.processedToolCallIds.add(call_id);

      let result: any = { error: 'Unknown function' };
      try {
        result = await this.onToolCall({ name, arguments: JSON.parse(args || '{}') });
      } catch (e: any) {
        result = { error: e?.message || String(e) };
      }

      this.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id, output: JSON.stringify(result) },
      });

      // Important: éviter `response.create` concurrent.
      this.requestResponseCreate();
    }
  }

  private requestResponseCreate() {
    const now = Date.now();
    // Anti-spam: ne pas appeler `response.create` trop souvent.
    if (now - this.lastResponseCreateAt < 250) return;
    this.lastResponseCreateAt = now;

    // Si une réponse est déjà active (ex: VAD a relancé une réponse), on annule avant.
    if (this.activeResponseId || this.isGenerating) {
      this.send({ type: 'response.cancel' });
      this.activeResponseId = null;
      this.isGenerating = false;
    }

    this.send({ type: 'response.create' });
  }

  // sendUserText() : permet au serveur d'injecter un texte "user" pour relancer
  // une réponse (ex: timeout silence => "Êtes-vous toujours là ?").
  // Important : on passe par requestResponseCreate() pour éviter les réponses concurrentes.
  sendUserText(text: string) {
    const safeText = String(text || '').trim();
    if (!safeText) return;

    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: safeText }],
      },
    });

    this.requestResponseCreate();
  }

  // sendAudio() : ton serveur appelle cette méthode quand il reçoit un chunk audio
  // du client (binaire -> base64). Cela remplit le buffer audio côté OpenAI.
  sendAudio(base64Audio: string) {
    this.send({ type: 'input_audio_buffer.append', audio: base64Audio });
  }

  // interrupt() : interruption manuelle (ex: message JSON {type:'interrupt'} depuis le client).
  // Utile quand tu veux forcer un stop (bouton "Stop" côté UI) ou logique serveur.
  interrupt() {
    if (this.isGenerating) {
      this.send({ type: 'response.cancel' });
      this.isGenerating = false;
    }
  }

  // send() : méthode bas niveau pour envoyer des events à OpenAI Realtime.
  private send(event: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  // close() : fermeture propre du WebSocket OpenAI.
  close() {
    if (!this.ws) return;

    try {
      // `ws.close()` peut throw si appelé alors que la connexion est encore en cours
      // d'établissement (readyState = CONNECTING). On encapsule pour éviter un log bruité.
      this.ws.close();
    } catch {
      try {
        this.ws.terminate();
      } catch {
        // ignore
      }
    }
  }
}