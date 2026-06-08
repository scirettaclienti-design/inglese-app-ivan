import WebSocket from 'ws';
import { config } from '../config.js';

const KEEPALIVE_INTERVAL_MS = 5000;
const RECONNECT_DELAY_MS = 800;

export class DeepgramService {
  constructor(onTranscript, onError) {
    this.onTranscript = onTranscript;
    this.onError = onError;
    this.ws = null;
    this.isAlive = false;
    this.shouldReconnect = false;
    this.keepAliveTimer = null;
  }

  connect() {
    if (!config.deepgramApiKey) {
      console.error('Deepgram API Key is missing!');
      this.onError(new Error('Deepgram API Key is missing'));
      return;
    }

    this.shouldReconnect = true;

    // Primary decoder locked to English to eliminate the Spanish false-positives
    // we saw with language=multi ("Non ci sta" -> "No nos cabida").
    // alternative_languages=it is included as an Italian secondary hint: if
    // Deepgram supports it (undocumented at time of writing) we get bilingual
    // support; if it's ignored, we degrade to strict English-only which is
    // still the safe baseline. Either way Spanish is excluded.
    const url = 'wss://api.deepgram.com/v1/listen?model=nova-2&language=en&alternative_languages=it&encoding=linear16&sample_rate=16000&channels=1&interim_results=false&punctuate=true&endpointing=300';

    console.log('Connecting to Deepgram WebSocket...');
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Token ${config.deepgramApiKey}`,
      },
    });

    this.ws.on('open', () => {
      console.log('Connected to Deepgram STT engine.');
      this.isAlive = true;
      this.startKeepAlive();
    });

    this.ws.on('message', (data) => {
      try {
        const response = JSON.parse(data.toString());
        if (response.channel && response.channel.alternatives && response.channel.alternatives[0]) {
          const transcript = response.channel.alternatives[0].transcript;
          const isFinal = response.is_final;

          if (transcript.trim() !== '') {
            this.onTranscript({
              text: transcript,
              isFinal: isFinal,
              speaker: 'user'
            });
          }
        }
      } catch (err) {
        console.error('Error parsing Deepgram message:', err);
      }
    });

    this.ws.on('error', (error) => {
      console.error('Deepgram WebSocket error:', error);
      this.onError(error);
    });

    this.ws.on('close', (code, reason) => {
      console.log(`Deepgram connection closed: ${code} - ${reason.toString() || 'No reason'}`);
      this.isAlive = false;
      this.stopKeepAlive();
      this.ws = null;

      // Auto-reconnect on unexpected drop (Deepgram idle timeout, network blip).
      // Skipped when close() was called explicitly (session end).
      if (this.shouldReconnect) {
        console.log(`Auto-reconnecting Deepgram in ${RECONNECT_DELAY_MS}ms...`);
        setTimeout(() => {
          if (this.shouldReconnect) this.connect();
        }, RECONNECT_DELAY_MS);
      }
    });
  }

  startKeepAlive() {
    this.stopKeepAlive();
    // Deepgram closes idle live streams after ~10s of no audio. The mic stays
    // muted for the whole duration of the tutor reply (5-15s), so without
    // explicit KeepAlive frames the STT socket dies between turns.
    this.keepAliveTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
        } catch (e) {
          console.error('Deepgram KeepAlive error:', e);
        }
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  sendAudio(chunk) {
    if (this.ws && this.isAlive && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    }
  }

  close() {
    this.shouldReconnect = false;
    this.stopKeepAlive();
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        } catch (e) {}
        this.ws.close();
      }
      this.ws = null;
      this.isAlive = false;
    }
  }
}
