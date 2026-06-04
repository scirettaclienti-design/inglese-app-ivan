import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../memory/db.json');
const projectsPath = path.join(__dirname, '../memory/projects.md');

export class GeminiService {
  constructor() {
    if (!config.geminiApiKey) {
      console.error('Gemini API Key is missing!');
    }
    this.genAI = new GoogleGenerativeAI(config.geminiApiKey);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
    this.chat = null;
    this.history = [];
  }

  /**
   * Load history database and project context, and initialize the Chat Session
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

    // 4. Construct System Instructions
    const systemInstruction = `You are a real-life native English tutor and coach for advanced English (Fluency & Vocabulary), level B2/Intermediate.
The student's name is Ivan. You will lead an audio-only, hands-free conversation with them while they are walking.

CRITICAL RULES:
1. MAIN LANGUAGE: Speak in fluent, natural, spoken English suitable for a B2 learner. Keep sentences relatively clear but natural.
2. CONVERSATIONAL TOPIC: Ask updates and conduct realistic simulations, pitches, or brainstorms about Ivan's current digital projects (Dove Vai, Seanfinity, Mykonos Made in Italy, Parlami, Borgo Pigneto). You must keep the conversation engaging and relevant to these projects.
3. ITALIAN ASSISTANCE & BLOCKS:
   - If Ivan hesitates, gets stuck, makes a significant grammatical mistake, or asks a question in Italian, IMMEDIATELY explain the term, correction, or rule in Italian (clear, concise, helpful).
   - In the very next sentence, immediately switch back to English and ask a guiding question to resume the conversation in English.
4. PRONUNCIATION & SPELLING RULE:
   - If Ivan mispronounces a word (or if the transcribed text implies a phonetic spelling error), or if he asks how to pronounce a word, you MUST stop the conversation, spell the word out slowly letter-by-letter in capital letters separated by hyphens (e.g. "S-E-A-N-F-I-N-I-T-Y" or "P-R-O-N-U-N-C-I-A-T-I-O-N"), explain the correct pronunciation rule, and then resume the chat in English.
5. NO SERVICE WORDS OR MARKUP: You are in an audio-only session. NEVER output text describing actions, emoji, or formatting like asterisks (e.g. do NOT output things like "*smiles*", "*laughs*", or emojis like 😊, or formatting like bolding "**"). Output ONLY clear, speakable text.
6. INTEGRATION OF MEMORY:
   - You must test Ivan on grammar/pronunciation errors he made in previous sessions. Try to lead questions that prompt him to use the correct forms.
   - Encourage him to use the advanced vocabulary words he learned in previous sessions.

Here is the history of errors Ivan committed in past sessions (Test him on these!):
${errorStrings || 'No past errors registered yet.'}

Here is the list of vocabulary upgrades suggested in past sessions (Encourage him to use these!):
${vocabStrings || 'No vocabulary upgrades registered yet.'}

Here is the context of Ivan's 5 active digital projects (Use this for conversation topics):
${projectsContext}

Let's begin! Greet Ivan naturally and ask how his projects are going, or reference one of his past errors/vocabulary words to kick off the session. Keep your response relatively short (2-3 sentences max) to maintain a fast voice back-and-forth.`;

    // 5. Initialize Gemini Chat with System Instructions
    this.chat = this.model.startChat({
      generationConfig: {
        maxOutputTokens: 250, // Keep responses short and conversational
        temperature: 0.7,
      },
      systemInstruction: systemInstruction,
    });

    this.history = [];
    console.log('Gemini Chat session initialized with spelling and project rules.');
  }

  /**
   * Send user transcript to Gemini and stream the response
   * @param {string} text - User's transcription text
   * @param {function(string)} onTextChunk - Callback for each generated text chunk
   * @returns {Promise<string>} - Complete generated text
   */
  async sendMessageStream(text, onTextChunk) {
    if (!this.chat) {
      await this.initializeChat();
    }

    // Save user message to history
    this.history.push({ role: 'user', parts: [{ text }] });

    console.log(`Sending user transcript to Gemini: "${text}"`);
    const result = await this.chat.sendMessageStream(text);
    
    let completeResponse = '';
    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      completeResponse += chunkText;
      onTextChunk(chunkText);
    }

    // Save model response to history
    this.history.push({ role: 'model', parts: [{ text: completeResponse }] });
    return completeResponse;
  }

  /**
   * Run compilation of mistakes, vocabulary upgrades, and email reports at the end of the session
   */
  async compileSessionSummary() {
    if (this.history.length < 2) {
      console.log('Not enough conversation history to compile session summary.');
      return;
    }

    console.log('Compiling session summary (errors, vocabulary & email report)...');
    
    // Format the conversation transcript for analysis
    const transcript = this.history.map(msg => 
      `${msg.role === 'user' ? 'User' : 'Tutor'}: ${msg.parts[0].text}`
    ).join('\n');

    // Prompt to extract JSON database updates
    const dbUpdatePrompt = `Analyze the following transcript of an English tutoring session.
Extract two lists:
1. Grammatical, syntax, lexical, or pronunciation errors made by the User. For each error, provide:
   - "incorrect": the incorrect phrase the user said.
   - "correct": the corrected version in natural English.
   - "explanation": a very brief explanation in Italian of why it was wrong and the rule.
2. New vocabulary words, idioms, or advanced expressions introduced by the Tutor during the session, or useful words suggested to improve Ivan's vocabulary. For each:
   - "word": the english word or phrase.
   - "meaning": a brief translation/explanation in Italian.
   - "context": a short example sentence related to the user's digital projects.

Return ONLY a valid JSON object matching the following schema. Do not output any markdown wrapper like \`\`\`json. Respond with raw JSON text only:
{
  "grammar_errors": [
    { "incorrect": "...", "correct": "...", "explanation": "..." }
  ],
  "vocabulary_upgrades": [
    { "word": "...", "meaning": "...", "context": "..." }
  ]
}

Here is the transcript:
${transcript}`;

    // Prompt to extract HTML email report
    const emailPrompt = `You are a professional English tutor compiling a "Daily Progress Report" email for your student Ivan based on the following conversation transcript.
Generate a beautiful, clean HTML email body (do not include standard <html>, <head> or <body> tags, just a styled <div> wrapper with modern CSS padding and styling).

The email must contain ONLY these three sections:
1. **Errori Grammaticali e di Pronuncia**: A neat table or list showing the errors Ivan committed, their corrections, and a brief explanation in Italian.
2. **Upgrade Vocabolario (3 Nuovi Vocaboli)**: Exactly 3 new advanced words or idioms suggested during the session (or highly relevant to the project discussions), with their Italian meaning, and a short example sentence contextualized with his digital projects.
3. **Feedback sulla Fluidità**: A brief, encouraging 3-4 sentence paragraph in Italian reviewing his speaking flow, pauses, or pronunciation patterns.

Use a professional, clean layout (dark theme matching the app or simple corporate look, e.g. background #fafafa or #070714 with readable contrast, colored highlights, nice typography). Do not use any markdown wrapping (\`\`\`). Respond only with the HTML code.

Here is the transcript:
${transcript}`;

    try {
      // 1. Compile DB Updates
      const summaryModel = this.genAI.getGenerativeModel({ 
        model: 'gemini-1.5-flash',
        generationConfig: { responseMimeType: 'application/json' }
      });
      
      const dbResponse = await summaryModel.generateContent(dbUpdatePrompt);
      const dbJsonText = dbResponse.response.text();
      const dbSummary = JSON.parse(dbJsonText);
      await this.saveSummaryToDb(dbSummary);
      console.log('Database memory successfully updated.');

      // 2. Generate Email Report HTML
      const reportModel = this.genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const emailResponse = await reportModel.generateContent(emailPrompt);
      const emailHtml = emailResponse.response.text().trim();
      
      // 3. Dispatch Email Report
      const { sendEmailReport } = await import('./email.js');
      const today = new Date().toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
      const subject = `Daily Progress Report - ${today}`;
      await sendEmailReport(subject, emailHtml);

      console.log('Session evaluation and report dispatch completed!');

    } catch (err) {
      console.error('Failed to compile session summary and dispatch email:', err);
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
          // Avoid exact duplicates
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
