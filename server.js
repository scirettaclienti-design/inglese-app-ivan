import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { DeepgramService } from './services/deepgram.js';
import { GeminiService } from './services/gemini.js';
import { TtsService } from './services/tts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Simple API status check
app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    voiceProvider: 'google-cloud-tts',
    geminiKeyConfigured: !!config.geminiApiKey,
    deepgramKeyConfigured: !!config.deepgramApiKey,
    googleTtsKeyConfigured: !!config.googleCloudTtsApiKey,
    emailConfigured: !!config.resendApiKey || (!!config.smtpHost && !!config.smtpUser),
    activeConnections: wss.clients.size
  });
});

// STANDBY & AUTO-SLEEP LOGIC
// When no users are connected, wait 10 minutes, then shutdown process (standby)
let standbyTimer = null;
const STANDBY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function startStandbyTimer() {
  if (standbyTimer) return;
  console.log(`No active clients. Standby timer started: server will shut down in 10 minutes to save resources.`);
  standbyTimer = setTimeout(() => {
    console.log('Standby timer expired. Shutting down server to standby/sleep state...');
    process.exit(0);
  }, STANDBY_TIMEOUT_MS);
}

function stopStandbyTimer() {
  if (standbyTimer) {
    console.log('Client connected. Standby timer cancelled.');
    clearTimeout(standbyTimer);
    standbyTimer = null;
  }
}

// Start standby timer initially on server boot
startStandbyTimer();

// WebSocket orchestration
wss.on('connection', async (ws) => {
  stopStandbyTimer();
  console.log('Client connected to WebSocket.');

  const gemini = new GeminiService();
  const tts = new TtsService();
  let deepgram = null;
  let isSessionActive = false;

  // Initialize Gemini Chat session
  try {
    await gemini.initializeChat();
    ws.send(JSON.stringify({ type: 'status', message: 'Ready' }));
  } catch (err) {
    console.error('Failed to initialize Gemini:', err);
    ws.send(JSON.stringify({ type: 'error', message: 'Failed to initialize Tutor Engine' }));
    ws.close();
    return;
  }

  // Set up Deepgram STT
  deepgram = new DeepgramService(
    async (event) => {
      // Transcription received from Deepgram
      if (event.isFinal && event.text.trim().length > 0) {
        // Send user transcript to browser
        ws.send(JSON.stringify({ type: 'transcript', speaker: 'user', text: event.text }));

        try {
          // Tell client that tutor is typing/thinking
          ws.send(JSON.stringify({ type: 'status', message: 'Tutor is thinking...' }));

          let sentenceBuffer = '';
          
          // Send user text to Gemini and handle streaming response
          await gemini.sendMessageStream(event.text, async (textChunk) => {
            sentenceBuffer += textChunk;

            // Extract complete clauses or sentences for TTS natural phrasing
            let match;
            while ((match = /[.?!;\n]/.exec(sentenceBuffer)) !== null) {
              const sentenceIndex = match.index + 1;
              const sentence = sentenceBuffer.substring(0, sentenceIndex).trim();
              sentenceBuffer = sentenceBuffer.substring(sentenceIndex);

              if (sentence.length > 0) {
                // Send text transcript of this sentence to the browser
                ws.send(JSON.stringify({ type: 'transcript', speaker: 'tutor', text: sentence }));

                // Send sentence to Google Cloud TTS and pipe the audio stream directly back to browser
                await tts.synthesizeStream(
                  sentence,
                  (audioChunk) => {
                    // Send binary audio chunks directly to client
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(audioChunk);
                    }
                  },
                  (ttsErr) => {
                    console.error('GCloud TTS synthesis error:', ttsErr);
                  }
                );
              }
            }
          });

          // Process remaining text in sentence buffer
          if (sentenceBuffer.trim().length > 0) {
            const sentence = sentenceBuffer.trim();
            ws.send(JSON.stringify({ type: 'transcript', speaker: 'tutor', text: sentence }));
            
            await tts.synthesizeStream(
              sentence,
              (audioChunk) => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(audioChunk);
                }
              },
              (ttsErr) => {
                console.error('GCloud TTS final chunk error:', ttsErr);
              }
            );
          }

          ws.send(JSON.stringify({ type: 'status', message: 'Listening...' }));
        } catch (geminiErr) {
          console.error('Error during Gemini transaction:', geminiErr);
          ws.send(JSON.stringify({ type: 'error', message: 'Tutor engine encountered an error' }));
        }
      }
    },
    (dgErr) => {
      console.error('Deepgram service encountered error:', dgErr);
      ws.send(JSON.stringify({ type: 'error', message: 'Speech recognition failure' }));
    }
  );

  // Initialize Deepgram connection
  deepgram.connect();

  // Handle incoming WebSocket messages from the client
  ws.on('message', (message, isBinary) => {
    if (isBinary) {
      // Direct raw audio chunks from client's microphone are forwarded to Deepgram
      if (deepgram && isSessionActive) {
        deepgram.sendAudio(message);
      }
    } else {
      // Text commands from client
      try {
        const data = JSON.parse(message.toString());
        console.log('Received command:', data);
        
        if (data.type === 'start') {
          isSessionActive = true;
          ws.send(JSON.stringify({ type: 'status', message: 'Listening...' }));
        } else if (data.type === 'stop') {
          isSessionActive = false;
          ws.send(JSON.stringify({ type: 'status', message: 'Paused' }));
        }
      } catch (err) {
        console.error('Error parsing client text message:', err);
      }
    }
  });

  // Handle client disconnect or session close
  ws.on('close', async () => {
    console.log('Client disconnected. Stopping services and compiling session summary...');
    isSessionActive = false;

    if (deepgram) {
      deepgram.close();
    }

    // Call Gemini offline compiler to extract grammar errors and vocabulary upgrades, sending the email
    try {
      await gemini.compileSessionSummary();
    } catch (compileErr) {
      console.error('Error during end-of-session reporting:', compileErr);
    }

    // Check if we need to enter standby/sleep mode
    if (wss.clients.size === 0) {
      startStandbyTimer();
    }
  });
});

// Start server
const PORT = config.port;
server.listen(PORT, () => {
  console.log(`=============================================================`);
  console.log(`   Voice Tutor Agent Server running on http://localhost:${PORT}`);
  console.log(`   Auto-Sleep Inactivity standby enabled (10 minutes)`);
  console.log(`=============================================================`);
});
