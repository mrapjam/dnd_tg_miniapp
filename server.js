import express from "express";
import bodyParser from "body-parser";
import { Telegraf } from "telegraf";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config();
const prisma = new PrismaClient();
const app = express();
app.use(bodyParser.json());

// === Telegram bot ===
const bot = new Telegraf(process.env.BOT_TOKEN);

// /new — создаёт игру (только ГМ)
bot.command("new", async (ctx) => {
  const gmId = String(ctx.from.id);
  const code = Math.random().toString(36).substring(2, 7).toUpperCase();

  const game = await prisma.game.create({
    data: {
      code,
      gmId,
      title: `Игра ${code}`,
    },
  });

  await prisma.player.create({
    data: {
      gameId: game.id,
      tgId: gmId,
      name: ctx.from.first_name,
      isGM: true,
    },
  });

  ctx.reply(`Создана игра ${game.title}\nКод для входа: ${code}`);
});

// /join CODE — вход игрока
bot.command("join", async (ctx) => {
  const parts = ctx.message.text.split(" ");
  if (parts.length < 2) return ctx.reply("Используй: /join CODE");

  const code = parts[1].trim();
  const game = await prisma.game.findUnique({ where: { code } });
  if (!game) return ctx.reply("Игра не найдена");

  const exists = await prisma.player.findUnique({
    where: {
      gameId_tgId: { gameId: game.id, tgId: String(ctx.from.id) },
    },
  });
  if (exists) return ctx.reply("Ты уже в игре!");

  await prisma.player.create({
    data: {
      gameId: game.id,
      tgId: String(ctx.from.id),
      name: ctx.from.first_name,
    },
  });

  ctx.reply(`Ты присоединился к игре ${game.title}`);
});

// /startgame — только ГМ
bot.command("startgame", async (ctx) => {
  const gmId = String(ctx.from.id);
  const game = await prisma.game.findFirst({ where: { gmId } });
  if (!game) return ctx.reply("Ты не ГМ");

  // обновляем started
  await prisma.game.update({
    where: { id: game.id },
    data: { started: true },
  });

  ctx.reply("Игра запущена! Игроки перенесены в стартовую локацию (создай её в панели).");
});

bot.launch();

// === API для веб-клиента (миниаппы) ===

// список игроков
app.get("/api/game/:code/players", async (req, res) => {
  const game = await prisma.game.findUnique({ where: { code: req.params.code } });
  if (!game) return res.status(404).json({ error: "Game not found" });

  const players = await prisma.player.findMany({ where: { gameId: game.id } });
  res.json(players);
});

// CRUD локаций
app.post("/api/game/:code/locations", async (req, res) => {
  const game = await prisma.game.findUnique({ where: { code: req.params.code } });
  if (!game) return res.status(404).json({ error: "Game not found" });

  const location = await prisma.location.create({
    data: {
      gameId: game.id,
      name: req.body.name,
      descr: req.body.descr,
    },
  });

  res.json(location);
});

// броски кубиков
app.post("/api/game/:code/roll", async (req, res) => {
  const game = await prisma.game.findUnique({ where: { code: req.params.code } });
  if (!game) return res.status(404).json({ error: "Game not found" });

  const result = Math.floor(Math.random() * req.body.die) + 1;

  const roll = await prisma.roll.create({
    data: {
      gameId: game.id,
      playerId: req.body.playerId,
      die: req.body.die,
      result,
    },
  });

  res.json(roll);
});

// запуск сервера
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌐 Web server on ${PORT}`));
