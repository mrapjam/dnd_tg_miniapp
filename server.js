import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { Telegraf, Markup } from 'telegraf';

const {
  BOT_TOKEN,
  PORT = 3000
} = process.env;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is required');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ===== In-memory storage (MVP) =====
const games = new Map(); // code -> { gmTgId, players: Map<tgId,{hp,gold,skills,photo}> , rolls: [] }

// ===== Bot commands =====
bot.start((ctx) => {
  ctx.reply('DnD Mini App. Выбери действие:', Markup.inlineKeyboard([
    [Markup.button.webApp('Открыть мини‑апп', `${process.env.APP_URL || 'http://localhost:'+PORT'}/`)]
  ]));
});

bot.command('new', (ctx) => {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  games.set(code, { gmTgId: String(ctx.from.id), players: new Map(), rolls: [] });
  ctx.reply(`Игра создана. Код: ${code}`, Markup.inlineKeyboard([
    [Markup.button.webApp('Панель мастера', `${process.env.APP_URL || 'http://localhost:'+PORT'}/?code=${code}`)]
  ]));
});

bot.command('join', (ctx) => {
  ctx.reply('Введи код комнаты (6 символов):');
  const handler = async (ctx2) => {
    const code = (ctx2.message.text || '').trim().toUpperCase();
    const game = games.get(code);
    if (!game) return ctx2.reply('Игры с таким кодом нет. Проверь код.');
    const tgId = String(ctx2.from.id);
    if (!game.players.has(tgId)) {
      game.players.set(tgId, { hp: 10, gold: 0, skills: [], photo: null, name: ctx2.from.first_name });
    }
    ctx2.reply('Заходим!', Markup.inlineKeyboard([
      [Markup.button.webApp('Открыть игру', `${process.env.APP_URL || 'http://localhost:'+PORT'}/?code=${code}`)]
    ]));
    bot.off('text', handler);
  };
  bot.on('text', handler);
});

bot.hears(/^\/roll (d6|d8|d20)$/i, (ctx) => {
  const die = Number(ctx.match[1].slice(1));
  const result = 1 + Math.floor(Math.random() * die);
  ctx.reply(`🎲 ${ctx.from.first_name} бросил d${die}: *${result}*`, { parse_mode: 'Markdown' });
});

// ===== Web server (mini-app + API) =====
const app = express();
app.use(cors());
app.use(bodyParser.json());

// Static mini-app
app.use(express.static('webapp'));

// Simple API
app.post('/api/games', (req, res) => {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  const { gmTgId } = req.body || {};
  games.set(code, { gmTgId, players: new Map(), rolls: [] });
  res.json({ code });
});

app.post('/api/games/:code/join', (req, res) => {
  const game = games.get(req.params.code);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const { tgId, name } = req.body;
  if (!game.players.has(tgId)) game.players.set(tgId, { hp: 10, gold: 0, skills: [], photo: null, name });
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
  const { tgId, die } = req.body;
  const d = Number(die);
  const result = 1 + Math.floor(Math.random() * d);
  const roll = { tgId, die: d, result, at: Date.now() };
  game.rolls.unshift(roll);
  game.rolls = game.rolls.slice(0, 100);
  res.json(roll);
});

app.listen(PORT, async () => {
  console.log('Server on', PORT);
  bot.launch().then(() => console.log('Bot started'));
});
