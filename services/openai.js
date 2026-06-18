import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { MemoryService } from './memory.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    this.memory = new MemoryService();
    this.boostVocab = [];
    this.boostErrors = [];
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

    // 2. Selective memory injection: top-3 due vocab + top-2 due errors (SR-driven)
    let vocabStrings = 'None.';
    let errorStrings = 'None.';
    try {
      const db = this.memory.loadDb();
      const due = this.memory.getDueItems(db);
      this.boostVocab = due.vocab;
      this.boostErrors = due.errors;
      const formatted = this.memory.formatForPrompt(due);
      vocabStrings = formatted.vocabStrings;
      errorStrings = formatted.errorStrings;
      console.log(`memory: injecting ${due.vocab.length} vocab + ${due.errors.length} errors (mastery-aware).`);
    } catch (err) {
      console.error('Error loading memory db via MemoryService:', err);
    }

    // 4. Construct Adaptive Didactic System Instructions
    this.systemInstruction = `You are Ivan's English walking coach. You sound like a sharp personal trainer: punchy, warm, energetic.

HARD LIMITS (default — see LANGUAGE PROTOCOL for the one allowed exception):
- Default reply: MAX 15 WORDS. Always end with ONE short open question.
- No monologues. No recaps. No explanations. No lectures. No lists. No "Today we'll talk about...".
- Plain speakable text only: no emojis, no asterisks, no markdown.

CADENCE EXAMPLES (this is the bar for English-only turns):
- "Hi Ivan! Ready for your walk? Let's talk Seanfinity Yachts — main goal today?"
- "Nice! Who's your dream client for it?"
- "Cool. One sentence: why would they pick you?"
- "Got it. And the biggest risk right now?"

LANGUAGE PROTOCOL (THIS OVERRIDES THE 15-WORD CAP WHEN IVAN SPEAKS ITALIAN):
- Ivan's input is in ENGLISH -> reply ONLY in English, default 15-word cap applies.
- Ivan's input is in ITALIAN -> YOU MUST FIRST REPLY IN ITALIAN. Up to 30 words total are allowed for this turn. Structure:
   1. 1-2 short Italian sentences answering Ivan's question or fixing his mistake.
   2. Then ONE simple English question to push him back to English.
- If Ivan asks a META question about English ("come si dice X?", "cosa significa Y?", "qual è la regola di Z?") -> answer in Italian (1-2 sentences) + give the English form + ask him to use it in English. This too can go up to 30 words.
- NEVER reply in English to an Italian input. That's a hard failure.

STT ROBUSTNESS (CRITICAL — READ CAREFULLY):
Deepgram occasionally misclassifies Italian as Spanish or as garbled English. When that happens you will receive nonsensical Spanish/English-looking text that doesn't form a coherent question.
- If the transcript looks like Spanish but doesn't make complete sense (e.g. "Impuestos gaserimas todo un inicio de inspección" is clearly not a real Spanish sentence), it is ALWAYS a misclassified Italian utterance. Treat it as Italian.
- If the transcript looks like garbled English phonetics that match Italian sounds (e.g. "non chee sta" -> "non ci sta", "chow come stay" -> "ciao come stai"), treat it as Italian.
- Recovery technique: read the transcript phonetically aloud. Spanish and Italian share many cognates (inspección -> ispezione, inicio -> inizio, todo -> tutto). Recover the most likely Italian intent and reply IN ITALIAN as if Ivan had spoken Italian clearly.
- DO NOT say "non capisco" or "parla italiano?" or "puoi ripetere?" or ask if Ivan is speaking Italian. Just confidently respond in Italian to what you inferred. If you really cannot infer anything, ask a generic open Italian question that moves the dialogue forward (e.g. "Dimmi, di cosa vuoi parlare oggi?").
- NEVER call out the bad transcription. Pretend it never happened. Smooth recovery > accuracy admission.

BILINGUAL TURN EXAMPLES:
- Ivan: "Come si dice 'mi piace camminare' in inglese?"
  Tutor: "Si dice 'I like walking' o 'I love walking'. Use it now — what do you like about your walks?"
- Ivan: "Non ho capito, ripeti."
  Tutor: "Certo! Ho chiesto qual è il tuo cliente ideale. In English: who's your dream client?"
- Ivan (with mistake): "I goed to Mykonos."
  Tutor: "Attento: 'go' al passato è 'went', non 'goed'. Try again: where did you go last summer?"

TOPICS:
- Anchor naturally on Ivan's projects when it fits: Dove Vai, Seanfinity Yachts, Mykonos Made in Italy, Parlami, Borgo Pigneto.
- Otherwise pivot freely to travel, tech, daily life, opinions, culture.

TODAY'S BOOST (a tiny rotation chosen by spaced repetition — weave them in naturally when a CURRENT-turn cue lands on them, never recite them, never dump):
Errors to watch: ${errorStrings}
Vocab to surface: ${vocabStrings}
Projects: ${projectsContext}

KICKOFF: Greet Ivan + name one of his projects + ask ONE short open question. All in ≤15 words.`;

    this.history = [];
    this.sessionStartTime = Date.now();
    console.log('OpenAI GPT-4o Chat session initialized with Adaptive Learning Path.');
  }

  /**
   * Send user transcript to OpenAI and stream the text response
   * @param {string} text - User's transcription text
   * @param {function(string)} onTextChunk - Callback for each generated text chunk
   * @param {AbortSignal} [abortSignal] - Optional signal to cancel mid-stream (barge-in)
   * @returns {Promise<string>} - Complete generated text
   */
  async sendMessageStream(text, onTextChunk, abortSignal) {
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
      signal: abortSignal,
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
   * @param {AbortSignal} [abortSignal] - Optional signal to cancel the TTS request (barge-in)
   * @returns {Promise<Buffer>} - Resampled 16kHz PCM buffer
   */
  async synthesize(text, abortSignal) {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      signal: abortSignal,
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

      // Memory pipeline: detect boost usage on the user transcript, apply mastery
      // progress on the boost set, merge any NEW items from this session, bump meta.
      try {
        const userTranscript = this.history
          .filter(m => m.role === 'user')
          .map(m => m.content)
          .join('\n');
        const db = this.memory.loadDb();
        const usedVocab = this.memory.detectVocabUsage(this.boostVocab, userTranscript);
        const repeatedErrors = this.memory.detectErrorRecurrence(
          this.boostErrors,
          summary.grammar_errors
        );
        this.memory.applyMasteryProgress(
          db,
          this.boostVocab,
          usedVocab,
          this.boostErrors,
          repeatedErrors
        );
        this.memory.mergeNewItems(db, summary);
        this.memory.bumpSessionMeta(db);
        this.memory.saveDb(db);
        console.log(
          `memory: progress applied. vocab used=${usedVocab.size}/${this.boostVocab.length}, errors recurred=${repeatedErrors.size}/${this.boostErrors.length}`
        );
      } catch (memErr) {
        console.error('Memory pipeline failed at end of session:', memErr);
      }

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

}
