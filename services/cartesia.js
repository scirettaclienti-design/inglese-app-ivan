import fetch from 'node-fetch';
import { config } from '../config.js';

export class TtsService {
  /**
   * Synthesize text to speech and pipe the binary audio chunks to the provided callback
   * @param {string} text - The text to synthesize
   * @param {function(Buffer)} onAudioChunk - Callback when a chunk of audio is received
   * @param {function(Error)} onError - Callback on error
   */
  async synthesizeStream(text, onAudioChunk, onError) {
    try {
      if (config.voiceProvider === 'cartesia') {
        await this.synthesizeCartesia(text, onAudioChunk);
      } else {
        await this.synthesizeElevenLabs(text, onAudioChunk);
      }
    } catch (err) {
      console.error('TTS Synthesis error:', err);
      onError(err);
    }
  }

  async synthesizeCartesia(text, onAudioChunk) {
    if (!config.cartesiaApiKey) {
      throw new Error('Cartesia API Key is missing');
    }

    const response = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: {
        'X-API-Key': config.cartesiaApiKey,
        'Cartesia-Version': '2024-06-10',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_id: 'sonic-english',
        voice: {
          mode: 'id',
          id: config.cartesiaVoiceId,
        },
        output_format: {
          container: 'raw',
          encoding: 'pcm_s16le',
          sample_rate: 16000,
        },
        transcript: text,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Cartesia API error (${response.status}): ${errorText}`);
    }

    // Stream the response body chunks
    for await (const chunk of response.body) {
      onAudioChunk(chunk);
    }
  }

  async synthesizeElevenLabs(text, onAudioChunk) {
    if (!config.elevenlabsApiKey) {
      throw new Error('ElevenLabs API Key is missing');
    }

    // We can stream MP3 44.1kHz from ElevenLabs. 
    // (ElevenLabs doesn't easily support raw PCM streams on basic tiers, or it's less standard. 
    // MP3 is widely supported, so we will stream MP3 chunks if using ElevenLabs)
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${config.elevenlabsVoiceId}/stream?output_format=mp3_44100_128`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': config.elevenlabsApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_turbo_v2', // Low latency turbo model
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        }
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ElevenLabs API error (${response.status}): ${errorText}`);
    }

    for await (const chunk of response.body) {
      onAudioChunk(chunk);
    }
  }
}
