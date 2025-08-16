// server.js
import express from "express";
import bodyParser from "body-parser";
import { PrismaClient } from "@prisma/client";
import { Telegraf } from "telegraf";

const app = express();
const prisma = new PrismaClient();

app.use(bodyParser.json());
app.use(express.static("webapp"));

// =============== TELEGRAM BOT ===============
const bot = new Telegraf(process.env.BOT_TOKEN);

// /new — создаёт новую игру
bot.command("new", async (ctx) => {
  const code = Math.random().toString(36).substring(2, 7).toUpperCase();
  const game = await prisma.game.create({
    data: { code, gmId: ctx.from.id.toString(), title: "Новая игра" }
  });
  await ctx.reply(`🎲 Игра создана!\nКод: ${code}\nОткрой в миниапп`);
});

// /join CODE — подключение игрока
bot.command("join", async (ctx) => {
  const code = ctx.message.text.split(" ")[1];
  if (!code) return ctx.reply("❌ Укажи код игры: /join ABCDE");

  const game = await prisma.game.findUnique({ where: { code } });
  if (!game) return ctx.reply("❌ Игра не найдена");

  await prisma.player.upsert({
    where: { gameId_tgId: { gameId: game.id, tgId: ctx.from.id.toString() } },
    update: {},
    create: {
      gameId: game.id,
      tgId: ctx.from.id.toString(),
      name: ctx.from.first_name || "Игрок"
    }
  });

  await ctx.reply(`✅ Ты в игре ${game.title}!`);
});

app.use(bot.webhookCallback("/telegraf"));

// =============== API ===============

// Лобби (игра + игроки + чат)
app.get("/api/lobby/:code", async (req, res) => {
  const game = await prisma.game.findUnique({
    where: { code: req.params.code },
    include: { players: true, locations: true, items: true, messages: true }
  });
  res.json(game);
});

// Обновление игрока
app.post("/api/player/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  let player;
  if (id === 0) {
    player = await prisma.player.create({ data: req.body });
  } else {
    player = await prisma.player.update({ where: { id }, data: req.body });
  }
  res.json(player);
});

// Новая локация
app.post("/api/location", async (req, res) => {
  const loc = await prisma.location.create({ data: req.body });
  res.json(loc);
});

// Новый предмет
app.post("/api/item", async (req, res) => {
  const item = await prisma.item.create({ data: req.body });
  res.json(item);
});

// Чат
app.post("/api/message", async (req, res) => {
  const msg = await prisma.message.create({ data: req.body });
  res.json(msg);
});

// Броски кубиков
app.post("/api/roll", async (req, res) => {
  const { gameId, playerId, die } = req.body;
  const result = 1 + Math.floor(Math.random() * die);
  const roll = await prisma.roll.create({
    data: { gameId, playerId, die, result }
  });
  res.json(roll);
});

// Старт игры
app.post("/api/game/:id/start", async (req, res) => {
  const gameId = parseInt(req.params.id);
  const { locationId } = req.body;

  await prisma.game.update({ where: { id: gameId }, data: { started: true } });

  // Раскидываем игроков в стартовую локацию
  await prisma.player.updateMany({
    where: { gameId },
    data: { locationId }
  });

  res.json({ ok: true });
});

// =============== START SERVER ===============
const port = process.env.PORT || 10000;

app.listen(port, async () => {
  console.log("🌐 Web server on " + port);
  if (process.env.BOT_TOKEN) {
    await bot.telegram.setWebhook(
      (process.env.RENDER_EXTERNAL_URL || "https://example.com") + "/telegraf"
    );
    console.log("🤖 Bot webhook set");
  }
});
