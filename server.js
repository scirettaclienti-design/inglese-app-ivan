import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { DeepgramService } from './services/deepgram.js';
import { OpenaiService } from './services/openai.js';

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
    voiceProvider: 'openai',
    openaiKeyConfigured: !!config.openaiApiKey,
    deepgramKeyConfigured: !!config.deepgramApiKey,
    emailConfigured: !!config.resendApiKey || (!!config.smtpHost && !!config.smtpUser),
    activeConnections: wss.clients.size
  });
});

// STANDBY & AUTO-SLEEP LOGIC
let standbyTimer = null;
const STANDBY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function startStandbyTimer() {
  if (standbyTimer) return;
  console.log(`No active clients. Standby timer started: server will shut down in 10 minutes.`);
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

  const openai = new OpenaiService();
  let deepgram = null;
  let isSessionActive = false;
  let isSummaryCompiled = false; // Prevents duplicate summaries/emails

  // Initialize Gemini Chat session
  try {
    await openai.initializeChat();
    ws.send(JSON.stringify({ type: 'status', message: 'Ready' }));
  } catch (err) {
    console.error('Failed to initialize Gemini:', err);
    ws.send(JSON.stringify({ type: 'error', message: 'Failed to initialize Tutor Engine' }));
    ws.close();
    return;
  }

  // Core function to process text
  async function processUserText(text) {
    try {
      ws.send(JSON.stringify({ type: 'status', message: 'Tutor is thinking...' }));
      
      let completeResponse = '';
      
      // Get the full response from OpenAI Chat Completion
      await openai.sendMessageStream(text, (textChunk) => {
        completeResponse += textChunk;
      });

      // Send the clean, complete transcript block
      ws.send(JSON.stringify({ type: 'transcript', speaker: 'tutor', text: completeResponse }));

      // Now synthesize the complete response in a single audio stream
      ws.send(JSON.stringify({ type: 'status', message: 'Tutor is speaking...' }));
      
      const audioBuffer = await openai.synthesize(completeResponse);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(audioBuffer);
      }

      // Tell client that the server is done sending audio chunks
      ws.send(JSON.stringify({ type: 'status', message: 'Done' }));
    } catch (err) {
      console.error('Error processing user text:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Tutor engine encountered an error' }));
    }
  }

  // Set up Deepgram STT
  deepgram = new DeepgramService(
    async (event) => {
      if (event.isFinal && event.text.trim().length > 0) {
        ws.send(JSON.stringify({ type: 'transcript', speaker: 'user', text: event.text }));
        await processUserText(event.text);
      }
    },
    (dgErr) => {
      console.error('Deepgram service encountered error:', dgErr);
      ws.send(JSON.stringify({ type: 'error', message: 'Speech recognition failure' }));
    }
  );

  deepgram.connect();

  // Handle incoming WebSocket messages from the client
  ws.on('message', async (message, isBinary) => {
    if (isBinary) {
      // Audio stream from mic
      if (deepgram && isSessionActive) {
        deepgram.sendAudio(message);
      }
    } else {
      // Text commands
      try {
        const data = JSON.parse(message.toString());
        console.log('Received command:', data);
        
        if (data.type === 'start') {
          isSessionActive = true;
          ws.send(JSON.stringify({ type: 'status', message: 'Listening...' }));
        } else if (data.type === 'stop') {
          isSessionActive = false;
          ws.send(JSON.stringify({ type: 'status', message: 'Tutor is compiling summary...' }));
          
          if (!isSummaryCompiled) {
            isSummaryCompiled = true;
            try {
              const summary = await openai.compileSessionSummary();
              if (summary) {
                ws.send(JSON.stringify({
                  type: 'summary',
                  score: summary.score,
                  errors: summary.grammar_errors,
                  vocab: summary.vocabulary_upgrades,
                  markdown: summary.markdown
                }));
              }
            } catch (sumErr) {
              console.error('Error compiling session summary on stop:', sumErr);
            }
          }
          ws.send(JSON.stringify({ type: 'status', message: 'Ready' }));
        } else if (data.type === 'test_chat') {
          ws.send(JSON.stringify({ type: 'transcript', speaker: 'user', text: data.text }));
          await processUserText(data.text);
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

    // Auto-compile summary on connection drops if not compiled yet
    if (!isSummaryCompiled) {
      isSummaryCompiled = true;
      try {
        await openai.compileSessionSummary();
      } catch (compileErr) {
        console.error('Error during end-of-session database merge:', compileErr);
      }
    }

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
