import { AudioSocketClient } from './infrastructure/telephony/audiosocket-client.service';

/**
 * Mini serveur d'écoute pour les appels entrants via Asterisk AudioSocket.
 * Pour le POC, on lance un client AudioSocket par appel.
 * En prod, on gérerait plusieurs appels simultanés.
 */
async function main() {
  console.log('[AudioSocketServer] Démarrage du serveur AudioSocket (écoute sur 127.0.0.1:5000)');

  // Pour le POC, on simule un seul appel
  const callId = 'audiosocket-demo-' + Date.now();
  const client = new AudioSocketClient(callId);

  try {
    await client.start();
    console.log('[AudioSocketServer] Client AudioSocket démarré pour callId', callId);
  } catch (err) {
    console.error('[AudioSocketServer] Erreur démarrage client:', err);
  }

  // Nettoyage sur CTRL+C
  process.on('SIGINT', async () => {
    console.log('[AudioSocketServer] Arrêt...');
    await client.stop();
    process.exit(0);
  });
}

main().catch(console.error);
