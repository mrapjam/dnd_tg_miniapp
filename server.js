import express from "express";
import { Telegraf } from "telegraf";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config();
const prisma = new PrismaClient();

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

// --- Команда /new ---
bot.command("new", async (ctx) => {
  const tgId = String(ctx.from.id);
  const code = Math.random().toString(36).substring(2, 7).toUpperCase();

  const game = await prisma.game.create({
    data: {
      code,
      gmId: tgId,
      title: "Новая игра",
      players: {
        create: {
          tgId,
          name: ctx.from.first_name || "GM",
          isGM: true,
          hp: 999,
          gold: 0,
        },
      },
    },
    include: { players: true },
  });

  await ctx.reply(`🎲 Игра создана! Код: ${code}\nТы назначен ГМ.`);
});

// --- Команда /join <code> ---
bot.command("join", async (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply("❌ Используй: /join <код_игры>");
  }

  const code = args[1].toUpperCase();
  const game = await prisma.game.findUnique({ where: { code } });

  if (!game) return ctx.reply("❌ Игра с таким кодом не найдена");

  const tgId = String(ctx.from.id);
  const existing = await prisma.player.findFirst({
    where: { gameId: game.id, tgId },
  });

  if (existing) {
    return ctx.reply("⚠️ Ты уже в этой игре!");
  }

  await prisma.player.create({
    data: {
      gameId: game.id,
      tgId,
      name: ctx.from.first_name || "Игрок",
      isGM: false,
    },
  });

  await ctx.reply(`✅ Ты присоединился к игре ${game.code}`);
});

// --- Проверка ---
bot.command("whoami", async (ctx) => {
  const tgId = String(ctx.from.id);
  const player = await prisma.player.findFirst({ where: { tgId } });
  if (!player) return ctx.reply("Ты пока не в игре");
  ctx.reply(`Ты ${player.isGM ? "🎩 ГМ" : "🧙 Игрок"} — ${player.name}`);
});

// --- Express для вебхука ---
app.use(express.json());
app.use(bot.webhookCallback(`/telegraf/${bot.secretPathSegment}`));

const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
  await bot.telegram.setWebhook(`${process.env.RENDER_EXTERNAL_URL}/telegraf/${bot.secretPathSegment}`);
  console.log(`🌍 Server started on ${PORT}`);
});
