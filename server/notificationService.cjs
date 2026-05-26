'use strict';

/**
 * notificationService — Telegram + Email alerts
 */

const https = require('https');
const http = require('http');

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

class NotificationService {
  constructor() {
    this.settings = {};
    this.lastDailyReport = 0;
  }

  updateSettings(s) {
    this.settings = { ...this.settings, ...s };
  }

  async sendTelegram(text) {
    const token = this.settings.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || '';
    const chatId = this.settings.telegramChatId || process.env.TELEGRAM_CHAT_ID || '';
    if (!token || !chatId) return false;
    try {
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      const res = await postJson(url, { chat_id: chatId, text, parse_mode: 'HTML' });
      return res.status === 200;
    } catch (err) {
      console.warn('[Notify] Telegram failed:', err.message);
      return false;
    }
  }

  async sendEmail(subject, body) {
    const host = this.settings.smtpHost || process.env.SMTP_HOST || '';
    const user = this.settings.smtpUser || process.env.SMTP_USER || '';
    const pass = this.settings.smtpPass || process.env.SMTP_PASS || '';
    const to = this.settings.notifyEmail || process.env.NOTIFY_EMAIL || '';
    if (!host || !user || !to) return false;

    // Lightweight: use a simple HTTP mail API if configured, else log-only fallback
    const mailApi = this.settings.mailApiUrl || process.env.MAIL_API_URL || '';
    if (mailApi) {
      try {
        await postJson(mailApi, { to, subject, body, user, pass });
        return true;
      } catch (err) {
        console.warn('[Notify] Email API failed:', err.message);
      }
    }

    console.log(`[Notify:Email] ${subject}\n${body.slice(0, 500)}`);
    return false;
  }

  async alert(level, title, message) {
    const icon = level === 'critical' ? '🔴' : level === 'warning' ? '⚠️' : 'ℹ️';
    const text = `${icon} <b>${title}</b>\n${message}`;
    const tasks = [this.sendTelegram(text)];
    if (level === 'critical' || level === 'daily') {
      tasks.push(this.sendEmail(`${icon} ${title}`, message));
    }
    await Promise.allSettled(tasks);
  }

  async critical(title, message) {
    return this.alert('critical', title, message);
  }

  async warning(title, message) {
    return this.alert('warning', title, message);
  }

  async info(title, message) {
    return this.alert('info', title, message);
  }

  async dailyReport(stats) {
    const now = Date.now();
    if (now - this.lastDailyReport < 20 * 60 * 60 * 1000) return;
    this.lastDailyReport = now;
    const msg = [
      `Views: ${stats.totalViews || 0}`,
      `Watch time: ${Math.round((stats.totalWatchTime || 0) / 60)} min`,
      `Likes: ${stats.totalLikes || 0}`,
      `YT Agents active: ${stats.activeAgents || 0}`,
      `Uptime: OK`,
    ].join('\n');
    await this.alert('daily', 'MMB YT Agent — Daily Report', msg);
  }

  async milestone(label, value) {
    await this.info('Milestone', `${label}: ${value}`);
  }
}

const notificationService = new NotificationService();
module.exports = { NotificationService, notificationService };
