import fetch from 'node-fetch';
import nodemailer from 'nodemailer';
import { config } from '../config.js';

/**
 * Sends a HTML email report to the user
 * @param {string} subject - The subject of the email
 * @param {string} htmlContent - The HTML body content of the email
 * @returns {Promise<boolean>} - True if successful, false otherwise
 */
export async function sendEmailReport(subject, htmlContent) {
  const toEmail = config.emailTo;
  if (!toEmail) {
    console.warn('Recipient email (EMAIL_TO) is not configured. Skipping email report dispatch.');
    return false;
  }

  // 1. Try Resend API if API Key is configured
  if (config.resendApiKey) {
    try {
      console.log('Attempting to send email via Resend API...');
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: config.emailFrom || 'fluencytutor@resend.dev',
          to: toEmail,
          subject: subject,
          html: htmlContent,
        }),
      });

      if (response.ok) {
        const resData = await response.json();
        console.log('Email successfully sent via Resend. ID:', resData.id);
        return true;
      } else {
        const errorText = await response.text();
        console.error(`Resend API error response: ${errorText}`);
      }
    } catch (err) {
      console.error('Failed to send email via Resend:', err);
    }
  }

  // 2. Fallback to Nodemailer SMTP if SMTP details are configured
  if (config.smtpHost && config.smtpUser && config.smtpPass) {
    try {
      console.log('Attempting to send email via Nodemailer SMTP...');
      const transporter = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpPort === 465, // True for port 465, false for others
        auth: {
          user: config.smtpUser,
          pass: config.smtpPass,
        },
      });

      const info = await transporter.sendMail({
        from: config.emailFrom || '"Fluency Tutor" <fluencytutor@resend.dev>',
        to: toEmail,
        subject: subject,
        html: htmlContent,
      });

      console.log('Email successfully sent via SMTP. Message ID:', info.messageId);
      return true;
    } catch (err) {
      console.error('Failed to send email via SMTP:', err);
    }
  }

  console.warn('Email dispatch skipped: Neither Resend nor SMTP credentials are fully configured.');
  return false;
}
