// server.js — webhook-режим для Telegraf + мини‑апп
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { Telegraf, Markup } from 'telegraf';

const {
  BOT_TOKEN,
  BOT_SECRET_PATH = 'telegraf-secret',   // добавь в Render переменную с рандомом
  PORT = 3000,
  APP_URL,
} = process.env;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is required');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ===== In-memory storage (MVP) =====
const games = new Map(); // code -> { gmTgId, players: Map, rolls: [] }

// ===== Bot (webhook) =====
const bot = new Telegraf(BOT_TOKEN);
const baseUrl = APP_URL || `http://localhost:${PORT}`;
const webhookPath = `/telegraf/${BOT_SECRET_PATH}`;

// Команды
bot.start((ctx) => {
  return ctx.reply(
    'DnD Mini App. Выбери действие:',
    Markup.inlineKeyboard([[Markup.button.webApp('Открыть мини‑апп', `${baseUrl}/`)]])
  );
});

bot.command('new', (ctx) => {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  games.set(code, { gmTgId: String(ctx.from.id), players: new Map(), rolls: [] });
  return ctx.reply(
    `Игра создана. Код: ${code}`,
    Markup.inlineKeyboard([[Markup.button.webApp('Панель мастера', `${baseUrl}/?code=${code}`)]])
  );
});

bot.command('join', (ctx) => {
  ctx.reply('Введи код комнаты (6 символов):');
  const handler = async (ctx2) => {
    const code = (ctx2.message.text || '').trim().toUpperCase();
    const game = games.get(code);
    if (!game) {
      await ctx2.reply('Игры с таким кодом нет. Проверь код.');
      return;
    }
    const tgId = String(ctx2.from.id);
    if (!game.players.has(tgId)) {
      game.players.set(tgId, { hp: 10, gold: 0, skills: [], photo: null, name: ctx2.from.first_name });
    }
    await ctx2.reply('Заходим!', Markup.inlineKeyboard([[Markup.button.webApp('Открыть игру', `${baseUrl}/?code=${code}`)]]));
    bot.off('text', handler);
  };
  bot.on('text', handler);
});

bot.hears(/^\/roll (d6|d8|d20)$/i, (ctx) => {
  const die = Number(ctx.match[1].slice(1));
  const result = 1 + Math.floor(Math.random() * die);
  return ctx.reply(`🎲 ${ctx.from.first_name} бросил d${die}: *${result}*`, { parse_mode: 'Markdown' });
});

// ===== Mini‑app (static) + API =====
app.use(express.static('webapp'));
app.get('/health', (_, res) => res.send('ok'));

app.post('/api/games', (req, res) => {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  const { gmTgId } = req.body || {};
  games.set(code, { gmTgId, players: new Map(), rolls: [] });
  res.json({ code });
});

app.post('/api/games/:code/join', (req, res) => {
  const game = games.get(req.params.code);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const { tgId, name } = req.body || {};
  if (!tgId) return res.status(400).json({ error: 'tgId required' });
  if (!game.players.has(tgId)) game.players.set(tgId, { hp: 10, gold: 0, skills: [], photo: null, name: name || 'Player' });
  res.json({ ok: true });
});

app.get('/api/games/:code', (req, res) => {
  const game = games.get(req.params.code);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const players = [...game.players.entries()].map(([tgId, p]) => ({ tgId, ...p }));
  res.json({ code: req.params.code, players, rolls: game.rolls });
});

app.post('/api/games/:code/roll', (req, res) => {
  const game = games.get(req.params.code);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const { tgId, die } = req.body || {};
  const d = Number(die);
  if (!tgId || ![6, 8, 20].includes(d)) return res.status(400).json({ error: 'Invalid params' });
  const result = 1 + Math.floor(Math.random() * d);
  const roll = { tgId, die: d, result, at: Date.now() };
  game.rolls.unshift(roll);
  game.rolls = game.rolls.slice(0, 100);
  res.json(roll);
});

// ===== Поднимаем веб‑сервер и настраиваем вебхук =====
app.use(webhookPath, bot.webhookCallback(webhookPath));

const server = app.listen(PORT, async () => {
  console.log('🌐 Web server on', PORT);

  try {
    // чистим старые режимы и ставим новый вебхук
    await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
    await bot.telegram.setWebhook(`${baseUrl}${webhookPath}`);
    console.log('🔗 Webhook set:', `${baseUrl}${webhookPath}`);
  } catch (e) {
    console.error('❌ Failed to set webhook:', e?.response?.description || e.message);
    process.exit(1);
  }
});

// корректное завершение
process.once('SIGINT', () => server.close(() => process.exit(0)));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
