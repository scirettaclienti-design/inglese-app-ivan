import WebSocket from 'ws';

const BACKEND_URL = 'ws://localhost:3000';
let ws = null;
let currentTestPromise = null;
let testOutput = [];

console.log('========================================================');
console.log('      HEADLESS VOICE TUTOR AGENT - TEST SUITE           ');
console.log('========================================================');

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  try {
    console.log(`Connecting to Voice Tutor Server on ${BACKEND_URL}...`);
    ws = new WebSocket(BACKEND_URL);
    ws.binaryType = 'arraybuffer';

    ws.on('error', (err) => {
      console.error('Connection failed! Make sure your server is running ("npm start").');
      process.exit(1);
    });

    await new Promise((resolve) => ws.on('open', resolve));
    console.log('Connected! Starting test sequence...\n');

    // Send initial start trigger
    ws.send(JSON.stringify({ type: 'start' }));
    await delay(1000);

    // ==========================================
    // TEST 1: Latency & Handshake Round-trip
    // ==========================================
    console.log('[TEST 1] Testing WebSocket Response Latency...');
    const startTime = Date.now();
    let firstByteReceived = false;
    let latency = 0;

    const latencyPromise = new Promise((resolve) => {
      const handleMessage = (data) => {
        if (!firstByteReceived) {
          firstByteReceived = true;
          latency = Date.now() - startTime;
          ws.off('message', handleMessage);
          resolve();
        }
      };
      ws.on('message', handleMessage);
    });

    ws.send(JSON.stringify({ type: 'test_chat', text: 'Hello, coach! Let\'s do a quick connection check.' }));
    await latencyPromise;

    console.log(`-> First response packet received in: ${latency}ms`);
    if (latency < 500) {
      testOutput.push({ test: 'WebSocket Latency (< 500ms)', status: 'PASS', details: `${latency}ms` });
    } else {
      testOutput.push({ test: 'WebSocket Latency (< 500ms)', status: 'FAIL', details: `${latency}ms (target is < 500ms)` });
    }

    // Wait for response to finish
    await delay(5000);

    // ==========================================
    // TEST 2: Italian Fallback Check
    // ==========================================
    console.log('\n[TEST 2] Testing Italian Fallback...');
    let italianResponse = '';
    
    const italianPromise = new Promise((resolve) => {
      const handleMessage = (data) => {
        if (typeof data === 'string') {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'transcript' && msg.speaker === 'tutor') {
            italianResponse += ' ' + msg.text;
          }
        }
      };
      ws.on('message', handleMessage);
      
      // Resolve after 6 seconds of collecting stream responses
      setTimeout(() => {
        ws.off('message', handleMessage);
        resolve();
      }, 7000);
    });

    // Send a message containing Italian speech
    ws.send(JSON.stringify({ type: 'test_chat', text: 'Scusa coach, sono bloccato. Come si dice "ecocompatibile" in inglese?' }));
    await italianPromise;

    console.log(`-> Tutor Response text: "${italianResponse.trim()}"`);
    
    // Check if response contains typical Italian dictionary/explanation words (tutor explains rules in Italian)
    const hasItalian = /[a-zA-Z]/.test(italianResponse) && 
                       (italianResponse.toLowerCase().includes('dice') || 
                        italianResponse.toLowerCase().includes('significa') || 
                        italianResponse.toLowerCase().includes('ecocompatibile') || 
                        italianResponse.toLowerCase().includes('regola') ||
                        italianResponse.toLowerCase().includes('puoi') ||
                        italianResponse.toLowerCase().includes('è') ||
                        italianResponse.toLowerCase().includes('in inglese'));

    if (hasItalian) {
      testOutput.push({ test: 'Italian Fallback Explanation', status: 'PASS', details: 'Correctly replied in Italian to explain the term.' });
    } else {
      testOutput.push({ test: 'Italian Fallback Explanation', status: 'FAIL', details: 'No Italian explanation detected in tutor reply.' });
    }

    // ==========================================
    // TEST 3: Stress Pronunciation Spelling
    // ==========================================
    console.log('\n[TEST 3] Testing Pronunciation Spelling Correction...');
    let spellingResponse = '';

    const spellingPromise = new Promise((resolve) => {
      const handleMessage = (data) => {
        if (typeof data === 'string') {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'transcript' && msg.speaker === 'tutor') {
            spellingResponse += ' ' + msg.text;
          }
        }
      };
      ws.on('message', handleMessage);
      
      setTimeout(() => {
        ws.off('message', handleMessage);
        resolve();
      }, 7000);
    });

    // Send query mispronouncing Seanfinity
    ws.send(JSON.stringify({ type: 'test_chat', text: 'I am struggling to pronounce the name of my yacht charter project, "Sonfiniti", how should I spell it?' }));
    await spellingPromise;

    console.log(`-> Tutor Response text: "${spellingResponse.trim()}"`);

    // Check if the response contains capital letters separated by hyphens (e.g. S-E-A-N-F-I-N-I-T-Y or similar words spelled out)
    const hasSpellingPattern = /([A-Z]-){2,}[A-Z]/.test(spellingResponse);

    if (hasSpellingPattern) {
      const match = spellingResponse.match(/([A-Z]-){2,}[A-Z]/);
      testOutput.push({ test: 'Pronunciation Spell-Out Tip', status: 'PASS', details: `Spelled out word successfully: "${match[0]}"` });
    } else {
      testOutput.push({ test: 'Pronunciation Spell-Out Tip', status: 'FAIL', details: 'No hyphenated letter-by-letter capital spelling detected.' });
    }

    // Connect close sequence
    console.log('\nClosing connection and saving database summaries...');
    ws.send(JSON.stringify({ type: 'stop' }));
    ws.close();
    
    printReport();

  } catch (err) {
    console.error('Test execution failed:', err);
    process.exit(1);
  }
}

function printReport() {
  console.log('\n========================================================');
  console.log('               DIAGNOSTIC TEST REPORT                   ');
  console.log('========================================================');
  
  let allPass = true;
  testOutput.forEach(res => {
    const icon = res.status === 'PASS' ? '✅' : '❌';
    if (res.status === 'FAIL') allPass = false;
    console.log(`${icon} [${res.status}] ${res.test}`);
    console.log(`   Details: ${res.details}\n`);
  });

  console.log('========================================================');
  if (allPass) {
    console.log('  🎉 ALL TESTS PASSED! Ready for Vercel & Cloud deploy.');
  } else {
    console.log('  ⚠️ SOME TESTS FAILED. Please review the responses above.');
  }
  console.log('========================================================');
}

runTests();
