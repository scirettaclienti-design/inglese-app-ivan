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
let audioQueueDuration = 0; // tracking length of scheduled chunks

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

// Configure Canvas dimensions
function resizeCanvas() {
  canvas.width = canvas.parentElement.clientWidth * window.devicePixelRatio;
  canvas.height = canvas.parentElement.clientHeight * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

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
    
    // Calculate simple signal amplitude (deviation from 128 midpoint)
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const val = dataArray[i] - 128;
      sum += val * val;
    }
    signalStrength = Math.sqrt(sum / dataArray.length) / 10;
  } else {
    // Gentle default idle wave
    signalStrength = isSessionRunning ? 0.15 : 0.05;
  }

  // Cap the signal strength to keep visualization elegant
  signalStrength = Math.min(Math.max(signalStrength, 0.05), 1.8);
  
  wavePhase += 0.04;
  
  // Draw 3 layered sine waves with different offsets and opacity
  const waves = [
    { freq: 0.008, amp: 28 * signalStrength, phase: wavePhase, color: 'rgba(0, 255, 255, 0.25)' }, // Cyan
    { freq: 0.015, amp: 20 * signalStrength, phase: wavePhase * 1.5, color: 'rgba(138, 43, 226, 0.3)' }, // Violet
    { freq: 0.005, amp: 35 * signalStrength, phase: wavePhase * 0.7, color: 'rgba(16, 185, 129, 0.15)' }  // Emerald
  ];

  waves.forEach(wave => {
    ctx.beginPath();
    ctx.strokeStyle = wave.color;
    ctx.lineWidth = wave === waves[0] ? 3 : 1.5;
    
    for (let x = 0; x < width; x++) {
      // Bezier-like fade at the left and right edges so waves start/end at 0
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
  
  // Scroll to bottom
  logContainer.scrollTop = logContainer.scrollHeight;
}

// Clear log panel
clearLogBtn.addEventListener('click', () => {
  logContainer.innerHTML = '';
});

// Setup audio and WebSockets
async function startSession() {
  isSessionRunning = true;
  nextStartTime = 0;
  audioQueueDuration = 0;
  
  updateUI(true);
  addLog('Connessione al server in corso...', 'system');
  updateStatus('loading', 'Connecting...');

  try {
    // 1. Initialize Audio Context (we enforce 16kHz for low latency and automatic downsampling)
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass({ sampleRate: 16000 });
    
    // Enable AudioContext on mobile
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    // 2. Setup visualizer Analyser Nodes
    micAnalyser = audioContext.createAnalyser();
    micAnalyser.fftSize = 256;
    speakerAnalyser = audioContext.createAnalyser();
    speakerAnalyser.fftSize = 256;

    // 3. Keep AudioContext alive in background on iOS
    // Create silent loop source to run continuously
    const silentBuffer = audioContext.createBuffer(1, 4096, 16000);
    const silentSource = audioContext.createBufferSource();
    silentSource.buffer = silentBuffer;
    silentSource.loop = true;
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0.0;
    silentSource.connect(silentGain);
    silentGain.connect(audioContext.destination);
    silentSource.start();

    // 4. Request microphone access
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      }
    });

    // 5. Connect Microphone to Analyser and ScriptProcessor for streaming
    micNode = audioContext.createMediaStreamSource(micStream);
    micNode.connect(micAnalyser);
    
    // Using 4096 buffer size (approx. 250ms chunks)
    scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    micNode.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);

    // 6. Establish WebSocket connection dynamically
    let wsUrl = '';
    const storedUrl = localStorage.getItem('voice_tutor_backend_url');
    if (storedUrl && storedUrl.trim().length > 0) {
      wsUrl = storedUrl.trim();
    } else {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${protocol}//${window.location.host}`;
    }
    console.log('Connecting to WebSocket backend:', wsUrl);
    socket = new WebSocket(wsUrl);
    socket.binaryType = 'arraybuffer';

    socket.onopen = () => {
      console.log('WebSocket connection opened.');
      // Send initial start trigger
      socket.send(JSON.stringify({ type: 'start' }));
      updateStatus('active', 'Listening...');
    };

    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        // Handle metadata JSON messages
        const message = JSON.parse(event.data);
        handleJsonMessage(message);
      } else {
        // Handle raw binary audio chunks (PCM s16le, 16000Hz)
        playBinaryAudioChunk(event.data);
      }
    };

    socket.onerror = (err) => {
      console.error('WebSocket error:', err);
      addLog('Errore di connessione websocket.', 'system');
      stopSession();
    };

    socket.onclose = () => {
      console.log('WebSocket closed.');
      addLog('Sessione vocale terminata e salvata sul server.', 'system');
      stopSession();
    };

    // 7. Microphonic stream processing callback
    scriptProcessor.onaudioprocess = (event) => {
      if (!isSessionRunning || isTutorSpeaking) return;

      const inputBuffer = event.inputBuffer.getChannelData(0);
      const length = inputBuffer.length;
      
      // Convert float32 [-1, 1] audio data to signed 16-bit PCM integer chunks
      const pcm16 = new Int16Array(length);
      for (let i = 0; i < length; i++) {
        const s = Math.max(-1, Math.min(1, inputBuffer[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      // Stream the PCM data buffer directly over WebSocket
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(pcm16.buffer);
      }
    };

    // Start wave drawing loop
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
function stopSession() {
  isSessionRunning = false;
  isTutorSpeaking = false;
  updateUI(false);
  updateStatus('disconnected', 'Disconnected');

  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // Close microphone streams
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

  if (socket) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'stop' }));
      socket.close();
    }
    socket = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
}

// Process textual JSON instructions from the server
function handleJsonMessage(message) {
  switch (message.type) {
    case 'status':
      updateStatus(message.message === 'Listening...' ? 'active' : 'loading', message.message);
      break;
    case 'transcript':
      addLog(message.text, message.speaker);
      break;
    case 'error':
      addLog(`Tutor Error: ${message.message}`, 'system');
      break;
    default:
      console.log('Unhandled JSON message:', message);
  }
}

// Play tutor voice audio chunks seamlessly using the AudioContext scheduler
function playBinaryAudioChunk(arrayBuffer) {
  if (!audioContext || audioContext.state === 'suspended') return;

  // Convert binary Int16 buffer data to standard Float32
  const pcm16 = new Int16Array(arrayBuffer);
  const length = pcm16.length;
  const float32 = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    float32[i] = pcm16[i] / 32768.0;
  }

  // Create standard 16kHz AudioBuffer
  const audioBuffer = audioContext.createBuffer(1, length, 16000);
  audioBuffer.copyToChannel(float32, 0);

  // Setup buffer source
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  
  // Pipe through speaker analyzer to show the speech wave
  source.connect(speakerAnalyser);
  speakerAnalyser.connect(audioContext.destination);

  // Schedule playback
  const currentTime = audioContext.currentTime;
  if (nextStartTime < currentTime) {
    // If we lagged or queue is empty, set start in the immediate future (50ms buffer)
    nextStartTime = currentTime + 0.05;
  }

  // Play chunk
  source.start(nextStartTime);
  
  // Set flag that Tutor is speaking
  isTutorSpeaking = true;
  
  // Keep track of end of queued audio
  nextStartTime += audioBuffer.duration;

  // Set timeout to clear tutor speaking state when speech queue ends
  const durationMs = (nextStartTime - currentTime) * 1000;
  
  if (this.tutorSpeechTimeout) {
    clearTimeout(this.tutorSpeechTimeout);
  }
  this.tutorSpeechTimeout = setTimeout(() => {
    isTutorSpeaking = false;
  }, durationMs);
}

// Helper to update the top status badge
function updateStatus(state, label) {
  statusBadge.className = `status-badge ${state}`;
  statusBadge.innerText = label;
}

// Helper to toggle active state UI classes and icons
function updateUI(active) {
  if (active) {
    actionBtn.className = 'action-btn-active';
    micIcon.classList.add('hidden');
    stopIcon.classList.remove('hidden');
    helperText.innerText = 'Tap to pause/save';
  } else {
    actionBtn.className = 'action-btn-inactive';
    micIcon.classList.remove('hidden');
    stopIcon.classList.add('hidden');
    helperText.innerText = 'Tap to start walking session';
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

// Register Service Worker for PWA support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('Service Worker registered successfully:', reg.scope))
      .catch(err => console.error('Service Worker registration failed:', err));
  });
}

// Load saved backend URL on page load
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
});
