import express from "express";
import { Telegraf } from "telegraf";
import { PrismaClient } from "@prisma/client";

const app = express();
const prisma = new PrismaClient();

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ Укажи BOT_TOKEN в .env");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// === Утилита: случайный код для игры ===
function genCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

// === Команда: создать новую игру ===
bot.command("new", async (ctx) => {
  try {
    const code = genCode();

    const game = await prisma.game.create({
      data: {
        code,
        gmId: String(ctx.from.id),
        title: "Новая игра",
      },
    });

    await prisma.player.create({
      data: {
        gameId: game.id,
        tgId: String(ctx.from.id),
        name: ctx.from.first_name || "GM",
        isGM: true,
      },
    });

    await ctx.reply(
      `🎲 Игра создана!\nКод: *${code}*\n\nИгроки могут присоединиться командой:\n/join ${code}`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    console.error("DB error on /new", e);
    await ctx.reply("❌ Ошибка при создании игры");
  }
});

// === Команда: присоединиться к игре ===
bot.command("join", async (ctx) => {
  const parts = ctx.message.text.split(" ");
  if (parts.length < 2) {
    await ctx.reply("⚠️ Используй: /join КОД");
    return;
  }
  const code = parts[1].trim().toUpperCase();

  try {
    const game = await prisma.game.findUnique({
      where: { code },
    });

    if (!game) {
      await ctx.reply("❌ Игра с таким кодом не найдена");
      return;
    }

    const existing = await prisma.player.findFirst({
      where: { gameId: game.id, tgId: String(ctx.from.id) },
    });
    if (existing) {
      await ctx.reply("⚠️ Ты уже в этой игре");
      return;
    }

    await prisma.player.create({
      data: {
        gameId: game.id,
        tgId: String(ctx.from.id),
        name: ctx.from.first_name || "Игрок",
      },
    });

    await ctx.reply(`✅ Ты присоединился к игре *${game.code}*`, {
      parse_mode: "Markdown",
    });
  } catch (e) {
    console.error("DB error on /join", e);
    await ctx.reply("❌ Ошибка при присоединении");
  }
});

// === Команда: проверить статус ===
bot.command("start", async (ctx) => {
  const player = await prisma.player.findFirst({
    where: { tgId: String(ctx.from.id) },
    include: { game: true },
  });

  if (!player) {
    await ctx.reply("Ты пока не в игре.\nСоздай новую: /new\nИли присоединись: /join КОД");
    return;
  }

  if (player.isGM) {
    await ctx.reply(`👑 Ты ГМ игры ${player.game.code}`);
  } else {
    await ctx.reply(`🙋 Ты игрок в игре ${player.game.code}`);
  }
});

// === Очистка старых игр ===
async function cleanupExpired() {
  try {
    const deleted = await prisma.game.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });
    if (deleted.count > 0) {
      console.log(`🧹 Удалено игр: ${deleted.count}`);
    }
  } catch (e) {
    console.error("cleanupExpired error:", e);
  }
}
setInterval(cleanupExpired, 60 * 60 * 1000); // раз в час

// === Express + Webhook для Render ===
app.use(express.json());
app.use(bot.webhookCallback(`/telegraf/${BOT_TOKEN}`));

const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
  console.log(`🌐 Web server on ${PORT}`);
  try {
    await bot.telegram.setWebhook(
      `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/telegraf/${BOT_TOKEN}`
    );
    console.log("🔗 Webhook set");
  } catch (err) {
    console.error("Webhook error:", err);
  }
});
