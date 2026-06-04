import fetch from 'node-fetch';
import { config } from '../config.js';

export class TtsService {
  /**
   * Synthesize text to speech using Google Cloud TTS REST API and pipe the binary audio chunks to the callback
   * @param {string} text - The text to synthesize
   * @param {function(Buffer)} onAudioChunk - Callback when a chunk of audio is ready
   * @param {function(Error)} onError - Callback on error
   */
  async synthesizeStream(text, onAudioChunk, onError) {
    try {
      if (!config.googleCloudTtsApiKey) {
        throw new Error('Google Cloud TTS API Key is missing (GOOGLE_CLOUD_TTS_API_KEY)');
      }

      const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${config.googleCloudTtsApiKey}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: { text: text },
          voice: {
            languageCode: 'en-US',
            name: 'en-US-Neural2-F', // Natural premium Neural2 female voice
            ssmlGender: 'FEMALE'
          },
          audioConfig: {
            audioEncoding: 'LINEAR16', // Signed 16-bit PCM
            sampleRateHertz: 16000,
            speakingRate: 1.0,
            pitch: 0.0
          }
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Google Cloud TTS API error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      if (!data.audioContent) {
        throw new Error('Google Cloud TTS response is missing audioContent');
      }

      // Convert base64 audio content from GCP to a Node.js Buffer
      const audioBuffer = Buffer.from(data.audioContent, 'base64');

      // Send the buffer to the callback in chunks of 4096 bytes to allow progressive browser streaming
      const CHUNK_SIZE = 4096;
      for (let offset = 0; offset < audioBuffer.length; offset += CHUNK_SIZE) {
        const chunk = audioBuffer.subarray(offset, offset + CHUNK_SIZE);
        onAudioChunk(chunk);
      }

    } catch (err) {
      console.error('GCloud TTS Synthesis error:', err);
      onError(err);
    }
  }
}
