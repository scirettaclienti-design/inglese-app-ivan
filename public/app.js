// Fluency Tutor - Core Application Logic

let socket = null;
let audioContext = null;
let micStream = null;
let micNode = null;
let scriptProcessor = null;
let isSessionRunning = false;

// Audio analysers for visualization
let micAnalyser = null;
let speakerAnalyser = null;

// Audio Playback Queue variables (for gapless playback)
let nextStartTime = 0;
let isTutorSpeaking = false;
let activeSources = [];

// Session markdown for copy-paste summaries
let sessionMarkdown = '';
let serverDoneSpeaking = false;

// Canvas visualizer setup
const canvas = document.getElementById('waveform-canvas');
const ctx = canvas.getContext('2d');
let animationId = null;
let wavePhase = 0;

// UI Elements
const actionBtn = document.getElementById('action-btn');
const micIcon = document.getElementById('mic-icon');
const stopIcon = document.getElementById('stop-icon');
const statusBadge = document.getElementById('status-indicator');
const helperText = document.getElementById('helper-text');
const logContainer = document.getElementById('log-container');
const clearLogBtn = document.getElementById('clear-log-btn');
const wakeUpOverlay = document.getElementById('wake-up-overlay');

// Modal Elements
const summaryModal = document.getElementById('summary-modal');
const closeModalBtn = document.getElementById('close-modal-btn');
const summaryScore = document.getElementById('summary-score');
const summaryCorrections = document.getElementById('summary-corrections');
const summaryVocab = document.getElementById('summary-vocab');
const copySummaryBtn = document.getElementById('copy-summary-btn');

// Configure Canvas dimensions
function resizeCanvas() {
  canvas.width = canvas.parentElement.clientWidth * window.devicePixelRatio;
  canvas.height = canvas.parentElement.clientHeight * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Dynamic state-driven colors and layout manager
function updateUIState(state, label) {
  document.body.className = '';
  statusBadge.className = 'status-badge';
  
  if (state === 'paused') {
    document.body.classList.add('state-paused');
    statusBadge.classList.add('disconnected');
    statusBadge.innerText = label || 'Disconnected';
    actionBtn.className = 'action-btn-inactive';
    micIcon.classList.remove('hidden');
    stopIcon.classList.add('hidden');
    helperText.innerText = 'Tap to start walking session';
    
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
  } else if (state === 'listening') {
    document.body.classList.add('state-listening');
    statusBadge.classList.add('active-state');
    statusBadge.innerText = label || 'Listening...';
    actionBtn.className = 'action-btn-active';
    micIcon.classList.add('hidden');
    stopIcon.classList.remove('hidden');
    helperText.innerText = 'Tutor is listening...';
    
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }
  } else if (state === 'speaking') {
    document.body.classList.add('state-speaking');
    statusBadge.classList.add('active-state');
    statusBadge.innerText = label || 'Tutor is speaking...';
    actionBtn.className = 'action-btn-active';
    micIcon.classList.add('hidden');
    stopIcon.classList.remove('hidden');
    helperText.innerText = 'Tap to pause/save';
  } else if (state === 'loading') {
    statusBadge.classList.add('loading');
    statusBadge.innerText = label || 'Connecting...';
    actionBtn.className = 'action-btn-inactive';
    micIcon.classList.add('hidden');
    stopIcon.classList.remove('hidden');
    helperText.innerText = 'Setting up voice streams...';
  }
}

// Render loop for the sine-wave canvas visualizer
function drawWave() {
  animationId = requestAnimationFrame(drawWave);
  
  const width = canvas.width / window.devicePixelRatio;
  const height = canvas.height / window.devicePixelRatio;
  
  ctx.clearRect(0, 0, width, height);
  
  // Decide which signal strength to use
  let signalStrength = 0;
  let dataArray = null;
  let activeAnalyser = null;

  if (isTutorSpeaking && speakerAnalyser) {
    activeAnalyser = speakerAnalyser;
  } else if (isSessionRunning && micAnalyser) {
    activeAnalyser = micAnalyser;
  }

  if (activeAnalyser) {
    dataArray = new Uint8Array(activeAnalyser.frequencyBinCount);
    activeAnalyser.getByteTimeDomainData(dataArray);
    
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const val = dataArray[i] - 128;
      sum += val * val;
    }
    signalStrength = Math.sqrt(sum / dataArray.length) / 10;
  } else {
    // Gentle default idle wave
    signalStrength = isSessionRunning ? 0.15 : 0.04;
  }

  signalStrength = Math.min(Math.max(signalStrength, 0.04), 1.8);
  wavePhase += isTutorSpeaking ? 0.06 : 0.035;
  
  // State-driven wave colors matching the themes
  let waveColor1, waveColor2, waveColor3;
  if (isTutorSpeaking) {
    // Emerald Green theme
    waveColor1 = 'rgba(16, 185, 129, 0.35)';
    waveColor2 = 'rgba(52, 211, 153, 0.25)';
    waveColor3 = 'rgba(6, 95, 70, 0.12)';
  } else if (isSessionRunning) {
    // Electric Cyan theme
    waveColor1 = 'rgba(0, 255, 255, 0.35)';
    waveColor2 = 'rgba(56, 189, 248, 0.25)';
    waveColor3 = 'rgba(3, 105, 161, 0.12)';
  } else {
    // Ruby red standby theme
    waveColor1 = 'rgba(239, 68, 68, 0.2)';
    waveColor2 = 'rgba(248, 113, 113, 0.12)';
    waveColor3 = 'rgba(153, 27, 27, 0.05)';
  }

  const waves = [
    { freq: 0.007, amp: 26 * signalStrength, phase: wavePhase, color: waveColor1, width: 3.5 },
    { freq: 0.013, amp: 18 * signalStrength, phase: wavePhase * 1.4, color: waveColor2, width: 1.5 },
    { freq: 0.005, amp: 32 * signalStrength, phase: wavePhase * 0.7, color: waveColor3, width: 1.0 }
  ];

  waves.forEach(wave => {
    ctx.beginPath();
    ctx.strokeStyle = wave.color;
    ctx.lineWidth = wave.width;
    
    for (let x = 0; x < width; x++) {
      const edgeScale = Math.sin((x / width) * Math.PI);
      const y = (height / 2) + Math.sin(x * wave.freq + wave.phase) * wave.amp * edgeScale;
      
      if (x === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  });
}

// Log utility to print texts on screen
function addLog(text, speaker = 'system') {
  const entry = document.createElement('div');
  entry.classList.add('log-entry', speaker);
  entry.innerText = text;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
}

// Clear log panel
clearLogBtn.addEventListener('click', () => {
  logContainer.innerHTML = '';
});

// Connection State Manager to handle cold start wake-up, loading state, and WebSocket lifecycle
class ConnectionStateManager {
  constructor() {
    this.state = 'DISCONNECTED'; // DISCONNECTED, PINGING, WAKING_UP, CONNECTING, READY
    this.isReconnecting = false;
  }

  updateState(newState, detail = '') {
    this.state = newState;
    console.log(`[Connection State] Transitioned to ${newState} ${detail ? `(${detail})` : ''}`);
    
    // Update UI elements based on state
    switch (newState) {
      case 'PINGING':
      case 'WAKING_UP':
        wakeUpOverlay.classList.remove('hidden');
        actionBtn.setAttribute('disabled', 'true');
        statusBadge.className = 'status-badge loading';
        statusBadge.innerText = 'Waking up...';
        helperText.innerText = 'Waiting for tutor engine...';
        
        // Update overlay text to show it is indeed waking up
        const overlayTitle = wakeUpOverlay.querySelector('h2');
        const overlayDesc = wakeUpOverlay.querySelector('p');
        if (overlayTitle) overlayTitle.innerText = 'Tutor is waking up...';
        if (overlayDesc) overlayDesc.innerText = 'Initializing backend cloud engine. This may take 20-30 seconds if the server was asleep.';
        break;

      case 'CONNECTING':
        wakeUpOverlay.classList.remove('hidden');
        actionBtn.setAttribute('disabled', 'true');
        statusBadge.className = 'status-badge loading';
        statusBadge.innerText = 'Connecting...';
        break;

      case 'READY':
        wakeUpOverlay.classList.add('hidden');
        actionBtn.removeAttribute('disabled');
        updateUIState('paused', 'Ready');
        break;

      case 'DISCONNECTED':
        wakeUpOverlay.classList.remove('hidden');
        actionBtn.setAttribute('disabled', 'true');
        updateUIState('paused', 'Disconnected');
        break;
    }
  }

  async startConnection() {
    if (this.state === 'READY' || this.state === 'CONNECTING' || this.state === 'PINGING' || this.state === 'WAKING_UP') {
      return;
    }
    
    this.updateState('PINGING');
    
    let wsUrl = '';
    const storedUrl = localStorage.getItem('voice_tutor_backend_url');
    if (storedUrl && storedUrl.trim().length > 0) {
      wsUrl = storedUrl.trim();
    } else {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${protocol}//${window.location.host}`;
    }

    let httpUrl = wsUrl.replace(/^ws/, 'http');
    if (!httpUrl.endsWith('/')) {
      httpUrl += '/';
    }
    httpUrl += 'status';

    console.log(`[Connection State] Pinging backend URL: ${httpUrl}`);

    let isOnline = false;
    let attempts = 0;
    
    while (!isOnline && (this.state === 'PINGING' || this.state === 'WAKING_UP')) {
      attempts++;
      try {
        const response = await fetch(httpUrl, { mode: 'cors' });
        if (response.ok) {
          const data = await response.json();
          if (data.status === 'online') {
            console.log('[Connection State] Backend is online! Establishing WebSocket.');
            isOnline = true;
          }
        }
      } catch (err) {
        console.log(`[Connection State] Ping attempt ${attempts} failed. Server is likely sleeping or booting...`);
        this.updateState('WAKING_UP', `Attempt ${attempts}`);
      }

      if (!isOnline) {
        // Wait 3 seconds before next ping
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    if (isOnline) {
      this.connectWS(wsUrl);
    }
  }

  connectWS(wsUrl) {
    this.updateState('CONNECTING');
    
    socket = new WebSocket(wsUrl);
    socket.binaryType = 'arraybuffer';

    socket.onopen = () => {
      console.log('[Connection State] WebSocket connected. Waiting for Ready status packet...');
    };

    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);
        if (message.type === 'status' && message.message === 'Ready') {
          this.updateState('READY');
        }
        handleJsonMessage(message);
      } else {
        playBinaryAudioChunk(event.data);
      }
    };

    socket.onerror = (err) => {
      console.error('[Connection State] WebSocket error:', err);
      this.handleDisconnect();
    };

    socket.onclose = () => {
      console.log('[Connection State] WebSocket closed.');
      this.handleDisconnect();
    };
  }

  handleDisconnect() {
    stopSession(false); // Make sure we clean up audio streams but don't try to send WS message if closed
    this.updateState('DISCONNECTED');
    
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket = null;
    }

    if (!this.isReconnecting) {
      this.isReconnecting = true;
      console.log('[Connection State] Attempting reconnection in 3s...');
      setTimeout(() => {
        this.isReconnecting = false;
        this.startConnection();
      }, 3000);
    }
  }
}

const connectionManager = new ConnectionStateManager();

// Audio capture starting
async function startSession() {
  isSessionRunning = true;
  nextStartTime = 0;
  isTutorSpeaking = false;
  serverDoneSpeaking = true;
  
  updateUIState('loading', 'Starting...');
  addLog('Inizializzazione microfono in corso...', 'system');

  try {
    // 1. Initialize Audio Context (16kHz downsampling)
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass({ sampleRate: 16000 });
    
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(e => console.error('Error resuming audio context initially:', e));
    }

    // 2. Setup analysers
    micAnalyser = audioContext.createAnalyser();
    micAnalyser.fftSize = 256;
    speakerAnalyser = audioContext.createAnalyser();
    speakerAnalyser.fftSize = 256;

    // 3. Keep AudioContext active in background
    const silentBuffer = audioContext.createBuffer(1, 4096, 16000);
    const silentSource = audioContext.createBufferSource();
    silentSource.buffer = silentBuffer;
    silentSource.loop = true;
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0.0;
    silentSource.connect(silentGain);
    silentGain.connect(audioContext.destination);
    silentSource.start();

    // 4. Request microphone access with an 8-second timeout to prevent hanging
    const getUserMediaPromise = navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      }
    });

    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Microphone permission request timed out')), 8000)
    );

    micStream = await Promise.race([getUserMediaPromise, timeoutPromise]);

    // 5. Connect node streams
    micNode = audioContext.createMediaStreamSource(micStream);
    micNode.connect(micAnalyser);
    
    scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    micNode.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);

    // 6. Send trigger command to server
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'start' }));
      updateUIState('listening', 'Listening...');
      setupMediaSession();
    } else {
      throw new Error('WebSocket connection is not open');
    }

    // 7. Microphonic stream downsampling callback
    scriptProcessor.onaudioprocess = (event) => {
      if (!isSessionRunning || isTutorSpeaking || !serverDoneSpeaking) return;

      const inputBuffer = event.inputBuffer.getChannelData(0);
      const length = inputBuffer.length;
      
      const pcm16 = new Int16Array(length);
      for (let i = 0; i < length; i++) {
        const s = Math.max(-1, Math.min(1, inputBuffer[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(pcm16.buffer);
      }
    };

    if (!animationId) {
      drawWave();
    }

  } catch (err) {
    console.error('Error starting session:', err);
    addLog(`Impossibile avviare il microfono: ${err.message}`, 'system');
    stopSession();
  }
}

// Stop current session
function stopSession(requestStop = true) {
  isSessionRunning = false;
  isTutorSpeaking = false;
  updateUIState('paused', 'Disconnected');

  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
  }

  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor = null;
  }

  if (micNode) {
    micNode.disconnect();
    micNode = null;
  }

  if (socket && socket.readyState === WebSocket.OPEN && requestStop) {
    socket.send(JSON.stringify({ type: 'stop' }));
  }

  activeSources.forEach(s => {
    try {
      s.stop();
    } catch (e) {}
  });
  activeSources = [];

  if (audioContext) {
    audioContext.close().catch(e => console.error('Error closing audio context:', e));
    audioContext = null;
  }
}

// Setup background Media Session triggers to prevent system sleep
function setupMediaSession() {
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Voice Tutor Session',
      artist: 'English Fluency Coach',
      album: 'Walk & Speak Advanced Study',
      artwork: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' }
      ]
    });

    navigator.mediaSession.setActionHandler('play', () => {
      if (!isSessionRunning) startSession();
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      if (isSessionRunning) stopSession();
    });
  }
}

// Process textual JSON instructions from the server
function handleJsonMessage(message) {
  switch (message.type) {
    case 'status':
      if (message.message === 'Ready') {
        // HIDE WAKE-UP OVERLAY
        wakeUpOverlay.classList.add('hidden');
        actionBtn.removeAttribute('disabled');
        updateUIState('paused', 'Ready');
      } else if (message.message === 'Tutor is thinking...') {
        updateUIState('loading', 'Tutor is thinking...');
      }
      break;
    case 'server_speaking':
      // Tutor is about to (or did just) start emitting audio frames.
      // Mute the mic immediately to prevent echo / spurious capture.
      serverDoneSpeaking = false;
      break;
    case 'server_done':
      // Last audio frame already on the wire. If nothing is queued for
      // playback we can re-arm the mic right away, otherwise source.onended
      // will pick up the transition.
      serverDoneSpeaking = true;
      if (activeSources.length === 0) {
        isTutorSpeaking = false;
        checkListeningTransition();
      }
      break;
    case 'transcript':
      addLog(message.text, message.speaker);
      break;
    case 'summary':
      // Render the Session Summary Card Modal
      renderSummaryCard(message);
      break;
    case 'error':
      addLog(`Tutor Error: ${message.message}`, 'system');
      serverDoneSpeaking = true;
      isTutorSpeaking = false;
      checkListeningTransition();
      break;
    default:
      console.log('Unhandled JSON message:', message);
  }
}

// Open and populate the Session Summary Card
function renderSummaryCard(data) {
  // 1. Populate values
  summaryScore.innerText = `${data.score}/10`;
  
  // Color the score badge dynamically based on the score
  if (data.score >= 8) {
    summaryScore.style.color = '#10b981'; // Emerald
  } else if (data.score >= 6) {
    summaryScore.style.color = '#fbbf24'; // Yellow
  } else {
    summaryScore.style.color = '#ef4444'; // Red
  }

  // 2. Render correction log
  if (data.errors && data.errors.length > 0) {
    summaryCorrections.innerHTML = data.errors.map(err => 
      `<div class="log-item" style="margin-bottom: 10px;">
        <span style="color: #ef4444; text-decoration: line-through;">"${err.incorrect}"</span> 
        <span style="color: #10b981;"> &rarr; "${err.correct}"</span>
        <p style="color: #8b5cf6; font-size: 0.75rem; margin-top: 2px;"><em>${err.explanation}</em></p>
      </div>`
    ).join('');
  } else {
    summaryCorrections.innerText = 'Ottimo lavoro! Nessun errore rilevante registrato in questa sessione.';
  }

  // 3. Render vocabulary upgrades
  if (data.vocab && data.vocab.length > 0) {
    summaryVocab.innerHTML = data.vocab.map(v => 
      `<div class="vocab-item" style="margin-bottom: 10px;">
        <strong style="color: #a78bfa; font-size: 0.85rem;">${v.word}</strong>: <em>${v.meaning}</em>
        <p style="color: #6b7280; font-size: 0.75rem; margin-top: 2px;">"${v.context}"</p>
      </div>`
    ).join('');
  } else {
    summaryVocab.innerText = 'Nessun vocabolo registrato.';
  }

  // 4. Save markdown for copying (with robust fallback)
  if (data.markdown) {
    sessionMarkdown = data.markdown;
  } else {
    let md = `# Resoconto Sessione Didattica\n\n`;
    md += `### 📊 Punteggio Fluidità: ${data.score}/10\n\n`;
    md += `### ❌ Registro delle Correzioni\n`;
    if (data.errors && data.errors.length > 0) {
      data.errors.forEach(err => {
        md += `- *Errato*: "${err.incorrect}" -> *Corretto*: "${err.correct}" (Spiegazione: ${err.explanation})\n`;
      });
    } else {
      md += `Ottimo lavoro! Nessun errore rilevante registrato in questa sessione.\n`;
    }
    md += `\n### 🚀 Incremento Vocabolario\n`;
    if (data.vocab && data.vocab.length > 0) {
      data.vocab.forEach((v, idx) => {
        md += `${idx + 1}. **${v.word}**: ${v.meaning} (Es: "${v.context}")\n`;
      });
    } else {
      md += `Nessun vocabolo avanzato registrato.\n`;
    }
    sessionMarkdown = md;
  }

  // 5. Open Modal
  summaryModal.classList.remove('hidden');
}

// Modal interactive listeners
closeModalBtn.addEventListener('click', () => {
  summaryModal.classList.add('hidden');
});

copySummaryBtn.addEventListener('click', () => {
  if (sessionMarkdown) {
    navigator.clipboard.writeText(sessionMarkdown)
      .then(() => {
        const originalText = copySummaryBtn.innerText;
        copySummaryBtn.innerText = 'Copied to Clipboard! ✓';
        copySummaryBtn.style.background = '#10b981';
        setTimeout(() => {
          copySummaryBtn.innerText = originalText;
          copySummaryBtn.style.background = '';
        }, 1500);
      })
      .catch(err => {
        console.error('Failed to copy text:', err);
      });
  }
});

// Play tutor voice audio chunks seamlessly
async function playBinaryAudioChunk(arrayBuffer) {
  if (!audioContext) return;

  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume();
    } catch (e) {
      console.error('Failed to resume AudioContext during playback:', e);
    }
  }

  const pcm16 = new Int16Array(arrayBuffer);
  const length = pcm16.length;
  const float32 = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    float32[i] = pcm16[i] / 32768.0;
  }

  const audioBuffer = audioContext.createBuffer(1, length, 16000);
  audioBuffer.copyToChannel(float32, 0);

  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  
  if (speakerAnalyser) {
    source.connect(speakerAnalyser);
    speakerAnalyser.connect(audioContext.destination);
  } else {
    source.connect(audioContext.destination);
  }

  const currentTime = audioContext.currentTime;
  if (nextStartTime < currentTime) {
    nextStartTime = currentTime + 0.04;
  }

  source.start(nextStartTime);
  
  isTutorSpeaking = true;
  updateUIState('speaking', 'Tutor is speaking...');
  
  nextStartTime += audioBuffer.duration;

  activeSources.push(source);
  source.onended = () => {
    activeSources = activeSources.filter(s => s !== source);
    if (activeSources.length === 0) {
      isTutorSpeaking = false;
      checkListeningTransition();
    }
  };
}

function checkListeningTransition() {
  if (serverDoneSpeaking && !isTutorSpeaking && isSessionRunning) {
    updateUIState('listening', 'Listening...');
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'user_listening' }));
    }
  }
}

// Handle control button interaction
actionBtn.addEventListener('click', () => {
  if (isSessionRunning) {
    stopSession();
  } else {
    startSession();
  }
});

// Load saved backend URL on page load and connect WebSocket
const backendUrlInput = document.getElementById('backend-url');
const saveUrlBtn = document.getElementById('save-url-btn');

const savedUrl = localStorage.getItem('voice_tutor_backend_url');
if (savedUrl) {
  backendUrlInput.value = savedUrl;
}

saveUrlBtn.addEventListener('click', () => {
  const url = backendUrlInput.value.trim();
  if (url.length > 0) {
    localStorage.setItem('voice_tutor_backend_url', url);
    addLog(`Server URL impostato a: ${url}`, 'system');
  } else {
    localStorage.removeItem('voice_tutor_backend_url');
    addLog('Server URL resettato all\'host corrente.', 'system');
  }
  // Reset socket connection on server URL change
  if (socket) {
    socket.close();
  } else {
    connectionManager.startConnection();
  }
});

// Boot Connection State Manager immediately on page load to initiate wake-up
connectionManager.startConnection();
drawWave();
