import WebSocket from 'ws';
import { config } from '../config.js';

export class DeepgramService {
  constructor(onTranscript, onError) {
    this.onTranscript = onTranscript;
    this.onError = onError;
    this.ws = null;
    this.isAlive = false;
  }

  connect() {
    if (!config.deepgramApiKey) {
      console.error('Deepgram API Key is missing!');
      this.onError(new Error('Deepgram API Key is missing'));
      return;
    }

    // Set up Deepgram Live Streaming parameters
    // We request linear16 PCM at 16kHz, mono
    const url = 'wss://api.deepgram.com/v1/listen?model=nova-2&encoding=linear16&sample_rate=16000&channels=1&interim_results=false&punctuate=true&endpointing=300';
    
    console.log('Connecting to Deepgram WebSocket...');
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Token ${config.deepgramApiKey}`,
      },
    });

    this.ws.on('open', () => {
      console.log('Connected to Deepgram STT engine.');
      this.isAlive = true;
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
    });
  }

  sendAudio(chunk) {
    if (this.ws && this.isAlive && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    }
  }

  close() {
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        // Send an empty JSON buffer to signal end of stream
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        this.ws.close();
      }
      this.ws = null;
      this.isAlive = false;
    }
  }
}
