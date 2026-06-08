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
  let currentTurn = null;        // { ac: AbortController, cancelled: boolean } for barge-in

  // Heartbeat: keep the TCP connection alive across mobile NATs and prevent
  // Render's free-tier from marking the socket as idle. Client browsers
  // auto-respond to ping frames with pong (no app-level code required).
  // If two consecutive pings go unanswered, force-terminate so the client
  // reconnects via its own onclose -> startConnection() recovery loop.
  let isClientAlive = true;
  const heartbeatInterval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!isClientAlive) {
      console.log('Client heartbeat missed — terminating stale WebSocket.');
      try { ws.terminate(); } catch (e) {}
      return;
    }
    isClientAlive = false;
    try { ws.ping(); } catch (e) {}
  }, 15000);
  ws.on('pong', () => { isClientAlive = true; });

  // Initialize OpenAI Chat session
  try {
    await openai.initializeChat();
    ws.send(JSON.stringify({ type: 'status', message: 'Ready' }));
  } catch (err) {
    console.error('Failed to initialize OpenAI:', err);
    ws.send(JSON.stringify({ type: 'error', message: 'Failed to initialize Tutor Engine' }));
    ws.close();
    return;
  }

  // Core function: stream GPT-4o output, slice on [.?!], fire TTS per sub-sentence
  // in parallel, send audio chunks to the client in original order.
  async function processUserText(text) {
    // Abort any previous in-flight turn (defensive — should already be cleared).
    if (currentTurn) {
      currentTurn.cancelled = true;
      try { currentTurn.ac.abort(); } catch (e) {}
    }
    const turn = { ac: new AbortController(), cancelled: false };
    currentTurn = turn;

    try {
      ws.send(JSON.stringify({ type: 'status', message: 'Tutor is thinking...' }));

      let completeResponse = '';
      let textBuffer = '';
      let serverSpeakingNotified = false;
      let audioChain = Promise.resolve();

      const enqueueSentence = (rawSentence) => {
        const sentence = rawSentence.trim();
        if (!sentence || turn.cancelled) return;

        // Mute the mic on the client BEFORE the first audio frame lands
        if (!serverSpeakingNotified) {
          serverSpeakingNotified = true;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'server_speaking' }));
          }
        }

        // Start TTS immediately (in parallel); serialize WS sends to keep order.
        // Pass the abort signal so an interrupt cancels the in-flight HTTP call.
        const ttsPromise = openai.synthesize(sentence, turn.ac.signal).catch((err) => {
          if (err.name !== 'AbortError') {
            console.error('TTS error for sentence chunk:', sentence, err);
          }
          return null;
        });

        audioChain = audioChain.then(async () => {
          const buffer = await ttsPromise;
          if (!turn.cancelled && buffer && ws.readyState === WebSocket.OPEN) {
            ws.send(buffer);
          }
        });
      };

      await openai.sendMessageStream(text, (textChunk) => {
        if (turn.cancelled) return;
        completeResponse += textChunk;
        textBuffer += textChunk;

        // Extract every complete sub-sentence ending in . ? !
        const sentenceRegex = /^([^.?!]*[.?!]+)/;
        let match;
        while ((match = sentenceRegex.exec(textBuffer))) {
          const sentence = match[1];
          textBuffer = textBuffer.slice(sentence.length);
          enqueueSentence(sentence);
        }
      }, turn.ac.signal);

      // Flush any trailing fragment without terminating punctuation
      if (!turn.cancelled && textBuffer.trim().length > 0) {
        enqueueSentence(textBuffer);
        textBuffer = '';
      }

      // Send the full transcript once for the on-screen log (skip on abort)
      if (!turn.cancelled && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'transcript', speaker: 'tutor', text: completeResponse }));
      }

      // Wait until every queued audio chunk has hit the wire in order
      await audioChain;
    } catch (err) {
      if (turn.cancelled || err.name === 'AbortError') {
        console.log('Turn aborted by user barge-in.');
      } else {
        console.error('Error processing user text:', err);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: 'Tutor engine encountered an error' }));
        }
      }
    } finally {
      // Always emit server_done so the client re-arms the mic, even on abort/error.
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'server_done' }));
      }
      if (currentTurn === turn) currentTurn = null;
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
        } else if (data.type === 'user_interrupted') {
          // Barge-in: client detected user voice while tutor was speaking.
          // Cancel the in-flight GPT-4o stream + queued TTS sends.
          if (currentTurn) {
            console.log('User barge-in detected — aborting current turn.');
            currentTurn.cancelled = true;
            try { currentTurn.ac.abort(); } catch (e) {}
          }
        } else if (data.type === 'user_listening') {
          // Informational: client has re-armed its mic. No server action needed.
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
    clearInterval(heartbeatInterval);
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
