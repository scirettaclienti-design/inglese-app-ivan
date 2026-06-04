import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../memory/db.json');
const projectsPath = path.join(__dirname, '../memory/projects.md');

// Helper to downsample 24kHz 16-bit PCM buffer to 16kHz 16-bit PCM buffer via linear interpolation
function resample24To16(buffer24) {
  const length24 = Math.floor(buffer24.length / 2);
  const length16 = Math.floor(length24 * 2 / 3);
  const samples16 = new Int16Array(length16);
  
  for (let i = 0; i < length16; i++) {
    const pos24 = i * 1.5;
    const idx = Math.floor(pos24);
    const fraction = pos24 - idx;
    
    const val1 = buffer24.readInt16LE(idx * 2);
    if (idx + 1 < length24) {
      const val2 = buffer24.readInt16LE((idx + 1) * 2);
      samples16[i] = Math.round(val1 * (1 - fraction) + val2 * fraction);
    } else {
      samples16[i] = val1;
    }
  }
  
  return Buffer.from(samples16.buffer, samples16.byteOffset, samples16.byteLength);
}

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

CONVERSATION TOPICS & VARIETY (ARGOMENTI VERTICALI)
- The conversation MUST move across diverse, stimulating "vertical topics" of all kinds: travel, current affairs, tech trends, philosophy, culture, science, arts, daily habits, or culinary topics.
- DO NOT focus the conversation on Ivan's projects. Ivan's projects are provided strictly as background reference if Ivan brings them up, but you must NOT initiate discussions about them or default to them.
- Introduce new topics naturally and switch topics organically to push Ivan out of his comfort zone and test different vocabularies.
- Act as a real human partner. DO NOT sound like an AI reading from a checklist. Keep the dialogue organic, warm, and conversational.

ACT LIKE A TEACHER (RUOLO DA INSEGNANTE - SPIEGA DI PIÙ, PARLA MENO NEL DIALOGO)
- Keep standard English conversational turns extremely brief (1-2 sentences maximum, one short question) to encourage Ivan to speak. Avoid monologues.
- When Ivan makes an error (grammar, pronunciation, syntax, word choice) or asks a question, BE A TRUE TEACHER:
  1. Stop the conversation.
  2. Explain the mistake, rule, or semantic nuance clearly and concisely in Italian.
  3. Prompt Ivan directly to repeat the corrected sentence or create a new example using the corrected form (e.g. "Prova a ripetere...", "Usa questa parola in una frase per fare pratica").
  4. DO NOT move back to the conversational topics or ask new questions until Ivan has tried the corrected version.
- Explain advanced synonyms you suggest briefly in Italian.
- Speak in a calm, clear, relaxed, and highly articulated tone.

CRITICAL RULES:
1. ITALIAN ASSISTANCE & PRACTICE BLOCKS:
   - If Ivan hesitates, gets stuck, makes a grammatical/pronunciation mistake, explain in Italian first.
   - Immediately prompt him to repeat/practice. Only then switch back to English dialogue.
2. PRONUNCIATION & SPELLING RULE:
   - If Ivan mispronounces a word (or if the transcript shows phonetic spelling errors), stop and spell out the word slowly letter-by-letter in capital letters separated by hyphens (e.g. "C-O-M-P-A-T-I-B-L-E"), explain the correct pronunciation rule, and prompt Ivan to repeat it.
3. NO SERVICE WORDS OR MARKUP: Never output emojis (😊), formatting asterisks (*smiles*), or bolding (**word**). Output ONLY clear, speakable text.
4. DRILLING HISTORICAL MEMORY:
   - Actively review and drill Ivan on grammar/pronunciation errors from past sessions. Design questions that prompt him to use the correct forms.
   - Force him to actively use the advanced vocabulary words he learned in previous sessions.

Here is the history of errors Ivan committed in past sessions (Test him on these!):
${errorStrings || 'No past errors registered yet.'}

Here is the list of vocabulary upgrades suggested in past sessions (Encourage him to use these!):
${vocabStrings || 'No vocabulary upgrades registered yet.'}

Here is the context of Ivan's digital projects (use only if Ivan mentions them):
${projectsContext}

Let's begin! Greet Ivan naturally with a brief, friendly greeting and introduce a random, engaging vertical topic (e.g. a travel destination, a tech trend, or a philosophical thought) to kick off the session.
CI DEVE ESSERE PIÙ DIALOGO: Non fare monologhi lunghi. Risposte corte (massimo 1-2 frasi) quando conversi. Parla in modo calmo, rilassato e scandito. Keep your conversation turns very short (1-2 sentences max).`;

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
      `Ensure you keep prompting Ivan with sophisticated synonyms (e.g. replace 'important' with 'pivotal', 'crucial', 'paramount'). ` +
      `Ensure you drill him on historical errors/words, explain rules in Italian, and prompt him to repeat corrections before moving on.]`;

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
   * Synthesize text speech via OpenAI Audio API, returning the complete resampled 16kHz PCM buffer
   * @param {string} text - Text to synthesize
   * @returns {Promise<Buffer>} - Resampled 16kHz PCM buffer
   */
  async synthesize(text) {
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

    const buffer24 = await response.buffer();
    
    // Ensure buffer length is even
    let alignedBuffer = buffer24;
    if (alignedBuffer.length % 2 !== 0) {
      alignedBuffer = alignedBuffer.subarray(0, alignedBuffer.length - 1);
    }
    
    return resample24To16(alignedBuffer);
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
