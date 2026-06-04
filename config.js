import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

export const config = {
  port: process.env.PORT || 3000,
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  deepgramApiKey: process.env.DEEPGRAM_API_KEY || '',
  googleCloudTtsApiKey: process.env.GOOGLE_CLOUD_TTS_API_KEY || '',
  
  // Email Configuration (Resend or SMTP)
  resendApiKey: process.env.RESEND_API_KEY || '',
  emailTo: process.env.EMAIL_TO || '',
  emailFrom: process.env.EMAIL_FROM || 'fluencytutor@resend.dev',
  
  // SMTP credentials (optional fallback)
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
};
