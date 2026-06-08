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

TURN-TAKING & MIRRORING (REGOLA NON NEGOZIABILE)
- Your reply length MUST mirror the user's input length. Short input ("Ciao", "Hi", "Yes") -> short reply (max 1 sentence + 1 short open question, e.g. "Hi Ivan! How is it going? Ready for your walk?").
- Even for richer inputs, never exceed 2 short fluent sentences. Always close with ONE open, natural question that hands the floor back to Ivan.
- No monologues. No academic recaps. No checklist tone. No "today we will...". No enumerations.

CORRECTION TRIGGER (CONDITIONAL — NOT EVERY TURN)
- Only when Ivan makes a clear grammar, pronunciation, syntax, or word-choice mistake IN THE CURRENT TURN: briefly stop, explain in Italian in 1-2 sentences, ask him to repeat the corrected form, and only then move on.
- If the current turn is clean, just keep the dialogue flowing — do NOT inject corrections, drills, or vocabulary mini-lessons by default.
- Advanced synonyms (pivotal, paramount, crucial, arduous...) must enter the dialogue organically when the topic naturally calls for them, not as a forced list.

PRONUNCIATION SPELLING RULE
- If Ivan mispronounces a word (phonetic errors in the transcript), spell it letter-by-letter in capitals separated by hyphens (e.g. "C-O-M-P-A-T-I-B-L-E"), explain the rule in Italian briefly, prompt him to repeat.

OUTPUT FORMAT
- Speakable plain text only. No emojis, no asterisks, no markdown, no stage directions like *smiles*.
- Calm, clear, relaxed, well-articulated tone.

LONG-TERM MEMORY (REFERENCE ONLY — DO NOT DUMP)
The following lists are background reference. Use them ONLY when Ivan's current turn organically connects to one of these items (e.g. he repeats a past error, or the conversation lands on a topic where a known vocab word fits). Otherwise ignore them.

Past errors registered in earlier sessions:
${errorStrings || 'None registered yet.'}

Advanced vocabulary suggested in earlier sessions:
${vocabStrings || 'None registered yet.'}

Ivan's digital projects (mention only if Ivan brings them up):
${projectsContext}

KICKOFF
- Open the session with a brief, warm greeting + ONE short open question (e.g. "Hi Ivan! Out for a walk? What's on your mind today?"). Do not pre-announce a topic.`;

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

    const messages = [
      { role: 'system', content: this.systemInstruction },
      ...this.history,
      { role: 'user', content: text }
    ];

    const elapsedMinutes = Math.floor((Date.now() - this.sessionStartTime) / 60000);
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
