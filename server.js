import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { Telegraf, Markup } from 'telegraf';
import { PrismaClient } from '@prisma/client';

const {
  BOT_TOKEN,
  BOT_SECRET_PATH = 'telegraf-9f2c1a',
  APP_URL,
  DATABASE_URL,
  PORT = 3000,
} = process.env;

if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN is required'); }
if (!DATABASE_URL) { console.error('❌ DATABASE_URL is required'); }

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(bodyParser.json());

const bot = new Telegraf(BOT_TOKEN);
const baseUrl = (APP_URL || `http://localhost:${PORT}`).replace(/\/+$/,'');
const webhookPath = `/telegraf/${BOT_SECRET_PATH}`;

// ===== устойчивые глобальные обработчики
process.on('unhandledRejection', (e) => {
  console.error('UNHANDLED REJECTION:', e);
});
process.on('uncaughtException', (e) => {
  console.error('UNCAUGHT EXCEPTION:', e);
});

// ===== утилиты
async function dbOk() {
  try { await prisma.$queryRaw`select 1`; return true; }
  catch(e){ console.error('DB check fail:', e?.code || e?.message); return false; }
}
function serviceUnavailable(res, e) {
  console.error('DB error:', e?.code || e?.message);
  return res.status(503).json({ error: 'db_unavailable' });
}

// ===== BOT
bot.use((ctx, next) => { console.log('Update:', ctx.updateType); return next(); });

bot.start((ctx) =>
  ctx.reply('DnD Mini App. Выбери действие:',
    Markup.inlineKeyboard([[Markup.button.webApp('Открыть мини‑апп', `${baseUrl}/`)]])
  )
);

bot.command('ping', (ctx) => ctx.reply('pong'));

// простая память для /join
const pendingJoin = new Map();

bot.command(['new','startgame'], async (ctx) => {
  try {
    const ok = await dbOk(); if (!ok) return ctx.reply('База недоступна. Попробуй позже.');
    const code = Math.random().toString(36).slice(2,8).toUpperCase();
    await prisma.game.create({ data: { code, gmTgId: String(ctx.from.id) } });
    await ctx.reply(
      `Игра создана. Код: ${code}`,
      Markup.inlineKeyboard([[Markup.button.webApp('Панель мастера', `${baseUrl}/?code=${code}`)]])
    );
  } catch(e){ console.error('/new error', e); ctx.reply('Не удалось создать игру.'); }
});

bot.command(['app','open'], async (ctx) => {
  const code = (ctx.message.text.split(/\s+/)[1] || '').toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return ctx.reply('Использование: /app ABC123');
  try {
    const ok = await dbOk(); if (!ok) return ctx.reply('База недоступна. Попробуй позже.');
    const game = await prisma.game.findUnique({ where: { code } });
    if (!game) return ctx.reply('Игра не найдена.');
    return ctx.reply('Открой мини‑аппу:',
      Markup.inlineKeyboard([[Markup.button.webApp('Открыть мини‑апп', `${baseUrl}/?code=${code}`)]])
    );
  } catch(e){ console.error('/app error', e); ctx.reply('Ошибка.'); }
});

bot.command('join', async (ctx) => {
  pendingJoin.set(ctx.from.id, true);
  ctx.reply('Введи код комнаты (6 символов):');
});

bot.on('text', async (ctx) => {
  if (!pendingJoin.get(ctx.from.id)) return;
  const code = (ctx.message.text || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return ctx.reply('Код должен быть из 6 символов. Попробуй снова:');
  try {
    const ok = await dbOk(); if (!ok) return ctx.reply('База недоступна. Попробуй позже.');
    const game = await prisma.game.findUnique({ where: { code } });
    if (!game) return ctx.reply('Игра не найдена. Введи другой код:');
    pendingJoin.delete(ctx.from.id);
    return ctx.reply(
      `Код принят: ${code}. Открой мини‑аппу:`,
      Markup.inlineKeyboard([[Markup.button.webApp('Открыть мини‑апп', `${baseUrl}/?code=${code}`)]])
    );
  } catch(e){ console.error('/join flow error', e); ctx.reply('Ошибка.'); }
});

// ===== Webhook endpoints
app.post(webhookPath, (req, res) => bot.webhookCallback(webhookPath)(req, res));
app.get(webhookPath, (_req, res) => res.status(200).send('ok'));

// ===== Static & health
app.use(express.static('webapp'));
app.get('/health', (_req, res) => res.send('ok'));
app.get('/db-check', async (_req, res) => res.send((await dbOk()) ? 'db: ok' : 'db: fail'));

// ===== API (как было) — в опасных местах оборачиваем в try/catch с 503 при падении БД
async function safe(res, fn) { try { return await fn(); } catch(e){ return serviceUnavailable(res, e); } }

app.post('/api/games', (req,res)=>safe(res, async()=>{
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  const { gmTgId } = req.body || {};
  await prisma.game.create({ data: { code, gmTgId: String(gmTgId || '0') } });
  res.json({ code });
}));

app.post('/api/games/:code/join', (req,res)=>safe(res, async()=>{
  const game = await prisma.game.findUnique({ where: { code: req.params.code } });
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const { tgId, name } = req.body || {};
  if (!tgId) return res.status(400).json({ error: 'tgId required' });
  await prisma.player.upsert({
    where: { gameId_userTgId: { gameId: game.id, userTgId: String(tgId) } },
    create: { gameId: game.id, userTgId: String(tgId), name: name || 'Hero' },
    update: name ? { name } : {}
  });
  res.json({ ok: true });
}));

app.get('/api/games/:code', (req,res)=>safe(res, async()=>{
  const game = await prisma.game.findUnique({
    where: { code: req.params.code },
    include: { players: true, rolls: { orderBy: { at: 'desc' }, take: 50 } }
  });
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const qTgId = req.query.tgId ? String(req.query.tgId) : null;
  const isGM = qTgId ? (game.gmTgId === qTgId) : false;

  let currentLocation = null;
  if (game.currentLocationId) {
    const rows = await prisma.$queryRaw`
      select id, title, description from "Location" where id = ${game.currentLocationId} limit 1
    `;
    currentLocation = rows?.[0] || null;
  }

  res.json({
    code: game.code,
    status: game.status,
    isGM,
    gmTgId: game.gmTgId,
    currentLocation,
    players: game.players.map(p => ({
      id: p.id, tgId: p.userTgId, name: p.name, hp: p.hp, gold: p.gold, skills: p.skills, photo: p.photo
    })),
    rolls: game.rolls
  });
}));

// … остальные API как у тебя (inventory/locations/rolls) можно оставить без изменений,
// но оберни каждый handler через safe(res, async()=>{ ... }) как выше — чтобы при недоступной БД
// возвращался 503, а не падал процесс.


// ===== Webhook setup с ретраем, без process.exit
async function setWebhookWithRetry() {
  const url = `${baseUrl}${webhookPath}`;
  for (let i=0; i<10; i++) {
    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(()=>{});
      await bot.telegram.setWebhook(url);
      console.log('🔗 Webhook set:', url);
      return;
    } catch (e) {
      console.error(`Webhook set failed (try ${i+1}/10):`, e?.response?.description || e.message);
      await new Promise(r => setTimeout(r, 3000 * (i+1))); // увеличиваем паузу
    }
  }
  console.error('⚠️ Could not set webhook after retries, продолжаю без падения.');
}

const server = app.listen(PORT, async () => {
  console.log('🌐 Web server on', PORT);
  await setWebhookWithRetry();
});

process.once('SIGINT', () => server.close(() => process.exit(0)));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
