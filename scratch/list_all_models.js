import fetch from 'node-fetch';
import { config } from '../config.js';

async function main() {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${config.geminiApiKey}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.models) {
      const names = data.models.map(m => m.name);
      console.log('Available gemini models:', names.filter(n => n.includes('gemini')));
    } else {
      console.log('Response did not contain models:', data);
    }
  } catch (err) {
    console.error('Error fetching models:', err);
  }
}

main();
