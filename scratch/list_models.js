import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config.js';

async function main() {
  try {
    console.log('Testing Gemini API key with gemini-2.0-flash...');
    const genAI = new GoogleGenerativeAI(config.geminiApiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const response = await model.generateContent('Hi');
    console.log('SUCCESS! Response from gemini-2.0-flash:', response.response.text());
  } catch (err) {
    console.error('ERROR during testing:', err);
  }
}

main();
