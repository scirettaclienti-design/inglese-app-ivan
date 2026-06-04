import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../memory/db.json');
const projectsPath = path.join(__dirname, '../memory/projects.md');

export class OpenaiService {
  constructor() {
    if (!config.openaiApiKey) {
      console.error('OpenAI API Key is missing!');
    }
    this.history = [];
    this.sessionStartTime = null;
    this.systemInstruction = '';
    this.ttsCarryover = null;
  }

  /**
   * Load history database and project context, and initialize system prompt
   */
  async initializeChat() {
    // 1. Read Project Context
    let projectsContext = '';
    try {
      if (fs.existsSync(projectsPath)) {
        projectsContext = fs.readFileSync(projectsPath, 'utf8');
      } else {
        projectsContext = 'No project context defined yet.';
      }
    } catch (err) {
      console.error('Error reading projects.md:', err);
      projectsContext = 'Error loading project context.';
    }

    // 2. Read Errors & Vocab Memory
    let memoryDb = { grammar_errors: [], vocabulary_upgrades: [] };
    try {
      if (fs.existsSync(dbPath)) {
        memoryDb = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      }
    } catch (err) {
      console.error('Error reading db.json:', err);
    }

    // 3. Format Errors & Vocabulary for prompt injection
    const errorStrings = memoryDb.grammar_errors.map(err => 
      `- Incorrect: "${err.incorrect}" -> Correct: "${err.correct}" (Explanation: ${err.explanation})`
    ).join('\n');

    const vocabStrings = memoryDb.vocabulary_upgrades.map(v => 
      `- Word: "${v.word}" (Meaning: ${v.meaning}, Context: ${v.context})`
    ).join('\n');

    // 4. Construct Adaptive Didactic System Instructions
    this.systemInstruction = `You are a real-life native English tutor and coach for advanced English (Fluency & Vocabulary), level B2/Intermediate.
The student's name is Ivan. You will lead an audio-only, hands-free conversation with them while they are walking.

DIDACTIC STRATEGY: ADAPTIVE LEARNING PATH
You must guide the conversation through two active phases depending on the flow:
- PHASE A (Technical & Business): Focus on Ivan's current digital projects (Dove Vai, Seanfinity, Mykonos Made in Italy, Parlami, Borgo Pigneto). Conduct mock pitches, roleplay investor meetings, or brainstorm technical roadblocks.
- PHASE B (Generalist Transitions): Since Ivan is comfortable in technical jargon, you MUST force him out of his comfort zone. Approximately every 10 minutes (or if you notice the technical topics are exhausted), initiate a smooth, natural transition to general topics (such as philosophy, technology trends, global travel stories, culinary arts, or current events). This forces the activation of non-technical passive vocabulary.
- VOCABULARY CHALLENGE: Challenge Ivan to upgrade his vocabulary. Actively suggest and use high-level synonyms. Encourage him to replace basic words: do not let him use "important" always; prompt him to use "pivotal", "crucial", or "paramount". Instead of "show", use "illustrate" or "demonstrate". Instead of "difficult", use "arduous" or "challenging".

CRITICAL RULES:
1. ITALIAN ASSISTANCE & BLOCKS:
   - If Ivan hesitates, gets stuck, makes a significant grammatical mistake, or asks a question in Italian, IMMEDIATELY explain the term, correction, or rule in Italian (clear, concise, helpful).
   - In the very next sentence, immediately switch back to English and ask a guiding question to resume the conversation in English.
2. PRONUNCIATION & SPELLING RULE:
   - If Ivan mispronounces a word (or if the transcribed text implies a phonetic spelling error), or if he asks how to pronounce a word, you MUST stop the conversation, spell the word out slowly letter-by-letter in capital letters separated by hyphens (e.g. "S-E-A-N-F-I-N-I-T-Y" or "P-R-O-N-U-N-C-I-A-T-I-O-N"), explain the correct pronunciation rule, and then resume the chat in English.
3. NO SERVICE WORDS OR MARKUP: You are in an audio-only session. NEVER output text describing actions, emoji, or formatting like asterisks (e.g. do NOT output things like "*smiles*", "*laughs*", or emojis like 😊, or formatting like bolding "**"). Output ONLY clear, speakable text.
4. DRILLING HISTORICAL MEMORY:
   - You must review and drill Ivan on grammar/pronunciation errors he committed in previous sessions. Design questions that prompt him to use the correct forms.
   - Force him to actively use the advanced vocabulary words he learned in previous sessions.

Here is the history of errors Ivan committed in past sessions (Test him on these!):
${errorStrings || 'No past errors registered yet.'}

Here is the list of vocabulary upgrades suggested in past sessions (Encourage him to use these!):
${vocabStrings || 'No vocabulary upgrades registered yet.'}

Here is the context of Ivan's 5 active digital projects:
${projectsContext}

Let's begin! Greet Ivan naturally and ask how his projects are going, or reference one of his past errors/vocabulary words to kick off the session.
CI DEVE ESSERE PIÙ DIALOGO: Non fare monologhi lunghi. Fai risposte corte (massimo 1-2 frasi) e incentiva Ivan a parlare. Fai domande brevi. Parla in modo calmo, rilassato e scandito. Keep your response short and concise (1-2 sentences max) to encourage more dialogue and back-and-forth interaction. Speak in a calm, clear, and relaxed tone.`;

    this.history = [];
    this.sessionStartTime = Date.now();
    console.log('OpenAI GPT-4o Chat session initialized with Adaptive Learning Path.');
  }

  /**
   * Send user transcript to OpenAI and stream the text response
   * @param {string} text - User's transcription text
   * @param {function(string)} onTextChunk - Callback for each generated text chunk
   * @returns {Promise<string>} - Complete generated text
   */
  async sendMessageStream(text, onTextChunk) {
    if (!this.sessionStartTime) {
      await this.initializeChat();
    }

    const elapsedMinutes = Math.floor((Date.now() - this.sessionStartTime) / 60000);
    const timeInstruction = `\n\n[SYSTEM REMINDER: Elapsed session time is ${elapsedMinutes} minutes. ` +
      `${elapsedMinutes >= 10 ? 
        'We are now in PHASE B (Generalist). You MUST guide the conversation to transition smoothly towards non-technical topics (travel, daily life, philosophy, culture, etc.) to challenge Ivan outside his technical projects comfort zone.' : 
        'We are in PHASE A (Technical). Focus on Ivan\'s projects (Dove Vai, Seanfinity, Mykonos Made in Italy, Parlami, Borgo Pigneto).'} ` +
      `Active Vocab Challenge: Prompt Ivan with sophisticated synonyms (e.g. replace 'important' with 'pivotal', 'crucial', 'paramount'). ` +
      `Ensure you drill him on historical errors/words if appropriate.]`;

    const messages = [
      { role: 'system', content: this.systemInstruction },
      ...this.history,
      { role: 'user', content: text + timeInstruction }
    ];

    console.log(`Sending user transcript to OpenAI: "${text}" (Session duration: ${elapsedMinutes} min)`);
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.openaiApiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: messages,
        stream: true
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API stream error: ${response.status} - ${errorText}`);
    }

    let completeResponse = '';
    const reader = response.body;

    await new Promise((resolve, reject) => {
      let buffer = '';
      
      reader.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep trailing incomplete line in buffer

        for (const line of lines) {
          const cleanLine = line.trim();
          if (cleanLine === '') continue;
          if (cleanLine === 'data: [DONE]') continue;
          if (cleanLine.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(cleanLine.substring(6));
              const delta = parsed.choices[0]?.delta?.content || '';
              if (delta) {
                completeResponse += delta;
                onTextChunk(delta);
              }
            } catch (err) {
              // Ignore partial JSON parsing errors
            }
          }
        }
      });

      reader.on('end', () => {
        resolve();
      });

      reader.on('error', (err) => {
        reject(err);
      });
    });

    // Record clean conversation history (without the hidden time reminders)
    this.history.push({ role: 'user', content: text });
    this.history.push({ role: 'assistant', content: completeResponse });

    return completeResponse;
  }

  /**
   * Synthesize text speech via OpenAI Audio API, streaming back raw 16kHz PCM chunks (resampled statefully from 24kHz)
   * @param {string} text - Text to synthesize
   * @param {function(Buffer)} onAudioChunk - Callback for each audio data buffer
   * @returns {Promise<void>}
   */
  async synthesizeStream(text, onAudioChunk) {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.openaiApiKey}`
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice: 'alloy', // alloy or echo
        response_format: 'pcm', // Outputs 24kHz 16-bit mono little-endian raw PCM
        speed: 0.88 // Speaks in a slightly slower, calm, and well-articulated tone
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI TTS API error: ${response.status} - ${errorText}`);
    }

    const reader = response.body;

    await new Promise((resolve, reject) => {
      reader.on('data', (chunk) => {
        // Concatenate with existing carryover from previous chunks
        let totalBuffer = chunk;
        if (this.ttsCarryover) {
          totalBuffer = Buffer.concat([this.ttsCarryover, chunk]);
          this.ttsCarryover = null;
        }

        // 3 samples of 24kHz = 6 bytes. We downsample blocks of 3 samples into 2 samples of 16kHz.
        const numBlocks = Math.floor(totalBuffer.length / 6);
        const processLength = numBlocks * 6;

        if (processLength > 0) {
          const bufferToProcess = totalBuffer.subarray(0, processLength);

          // Store remaining odd bytes as carryover for the next chunk
          if (totalBuffer.length > processLength) {
            this.ttsCarryover = totalBuffer.subarray(processLength);
          }

          const length16 = numBlocks * 2;
          const samples16 = new Int16Array(length16);

          for (let b = 0; b < numBlocks; b++) {
            const offset24 = b * 6;
            const s0 = bufferToProcess.readInt16LE(offset24);
            const s1 = bufferToProcess.readInt16LE(offset24 + 2);
            const s2 = bufferToProcess.readInt16LE(offset24 + 4);

            // Linear interpolation downsampling (pos0=0 -> s0, pos1=1.5 -> s1*0.5 + s2*0.5)
            samples16[b * 2] = s0;
            samples16[b * 2 + 1] = Math.round(s1 * 0.5 + s2 * 0.5);
          }

          const outputChunk = Buffer.from(samples16.buffer, samples16.byteOffset, samples16.byteLength);
          onAudioChunk(outputChunk);
        } else {
          // If chunk is less than 6 bytes, store all of it
          this.ttsCarryover = totalBuffer;
        }
      });

      reader.on('end', () => {
        // Process any leftover bytes at the end of the stream
        if (this.ttsCarryover && this.ttsCarryover.length >= 2) {
          const length24 = Math.floor(this.ttsCarryover.length / 2);
          const length16 = Math.floor(length24 * 2 / 3);

          if (length16 > 0) {
            const samples16 = new Int16Array(length16);
            for (let i = 0; i < length16; i++) {
              const pos24 = i * 1.5;
              const idx = Math.floor(pos24);
              const fraction = pos24 - idx;

              const val1 = this.ttsCarryover.readInt16LE(idx * 2);
              if (idx + 1 < length24) {
                const val2 = this.ttsCarryover.readInt16LE((idx + 1) * 2);
                samples16[i] = Math.round(val1 * (1 - fraction) + val2 * fraction);
              } else {
                samples16[i] = val1;
              }
            }
            onAudioChunk(Buffer.from(samples16.buffer, samples16.byteOffset, samples16.byteLength));
          }
        }
        this.ttsCarryover = null;
        resolve();
      });

      reader.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Run compilation of mistakes, vocabulary upgrades, and email reports at the end of the session
   * @returns {Promise<object|null>} - Returns the summary object containing scores, errors, vocab, and markdown
   */
  async compileSessionSummary() {
    if (this.history.length < 2) {
      console.log('Not enough conversation history to compile session summary.');
      return null;
    }

    console.log('Compiling unified session summary using OpenAI gpt-4o...');
    
    const transcript = this.history.map(msg => 
      `${msg.role === 'user' ? 'User' : 'Tutor'}: ${msg.content}`
    ).join('\n');

    const analysisPrompt = `Analyze the following transcript of an English tutoring session.
Compile the evaluation results into a single JSON object matching this exact schema:
{
  "score": 8, // An integer fluency score between 1 and 10 assessing speaking flow, pauses, and grammar.
  "grammar_errors": [
    { 
      "incorrect": "phrase user said", 
      "correct": "corrected natural version", 
      "explanation": "brief rule explanation in Italian" 
    }
  ],
  "vocabulary_upgrades": [
    { 
      "word": "advanced expression/word suggested", 
      "meaning": "translation/meaning in Italian", 
      "context": "short example sentence relevant to user's projects" 
    }
  ], // Provide exactly 3 advanced vocabulary upgrades
  "markdown": "# Resoconto Sessione Didattica\\n\\n### 📊 Punteggio Fluidità: 8/10\\n\\n### ❌ Registro delle Correzioni\\n- *Errato*: \\\"...\\\" -> *Corretto*: \\\"...\\\" (Spiegazione: ...)\\n\\n### 🚀 Incremento Vocabolario\\n1. **Word**: meaning (Es: \\\"...\\\")\\n\\n### 📝 Valutazione Finale\\nUn breve paragrafo di 3-4 frasi in italiano con un feedback incoraggiante sui progressi, fluidità e uso dei sinonimi."
}

Return ONLY this valid JSON object. Do not wrap it in markdown blocks or write any text other than the JSON string.

Here is the transcript:
${transcript}`;

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.openaiApiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'You output JSON data only.' },
            { role: 'user', content: analysisPrompt }
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI Summary API error: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      const jsonText = result.choices[0]?.message?.content;
      console.log('OpenAI Analysis JSON output:', jsonText);

      const summary = JSON.parse(jsonText);
      
      // Save results to local JSON db
      await this.saveSummaryToDb(summary);

      // Email dispatch report (runs in background)
      try {
        const { sendEmailReport } = await import('./email.js');
        const today = new Date().toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
        const subject = `Daily Progress Report - ${today}`;
        
        // Convert Markdown to basic HTML for email compatibility
        const htmlBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; color: #333; line-height: 1.6;">
            ${summary.markdown
              .replace(/# (.*)/g, '<h2>$1</h2>')
              .replace(/### (.*)/g, '<h3>$1</h3>')
              .replace(/\n/g, '<br>')
              .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
              .replace(/\*(.*?)\*/g, '<em>$1</em>')}
          </div>
        `;
        await sendEmailReport(subject, htmlBody);
      } catch (emailErr) {
        console.error('Email report dispatch failed:', emailErr);
      }

      return summary;

    } catch (err) {
      console.error('Failed to compile session summary:', err);
      return null;
    }
  }

  /**
   * Merge new session results into memory/db.json
   * @param {object} summary 
   */
  async saveSummaryToDb(summary) {
    try {
      let currentDb = { grammar_errors: [], vocabulary_upgrades: [] };
      if (fs.existsSync(dbPath)) {
        currentDb = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      }

      // Merge Grammar Errors
      if (summary.grammar_errors && Array.isArray(summary.grammar_errors)) {
        summary.grammar_errors.forEach(newErr => {
          const exists = currentDb.grammar_errors.some(
            err => err.incorrect.toLowerCase() === newErr.incorrect.toLowerCase()
          );
          if (!exists && newErr.incorrect.trim() !== '') {
            currentDb.grammar_errors.push(newErr);
          }
        });
      }

      // Merge Vocabulary Upgrades
      if (summary.vocabulary_upgrades && Array.isArray(summary.vocabulary_upgrades)) {
        summary.vocabulary_upgrades.forEach(newVoc => {
          const exists = currentDb.vocabulary_upgrades.some(
            v => v.word.toLowerCase() === newVoc.word.toLowerCase()
          );
          if (!exists && newVoc.word.trim() !== '') {
            currentDb.vocabulary_upgrades.push(newVoc);
          }
        });
      }

      // Write back to db.json
      fs.writeFileSync(dbPath, JSON.stringify(currentDb, null, 2), 'utf8');
    } catch (err) {
      console.error('Error writing to memory db.json:', err);
    }
  }
}
