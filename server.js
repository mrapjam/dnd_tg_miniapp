// server.js
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { Telegraf, Markup } from "telegraf";

dotenv.config();

/* -------------------- PATHS / ENV -------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 10000);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const BOT_SECRET_PATH =
  process.env.BOT_SECRET_PATH || `telegraf-${Math.random().toString(36).slice(2)}`;

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/* -------------------- EXPRESS -------------------- */
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Раздаём мини‑аппу из /webapp
const WEB_DIR = path.join(__dirname, "webapp");
app.use("/assets", express.static(path.join(WEB_DIR, "assets")));
app.get("/", (_req, res) => res.sendFile(path.join(WEB_DIR, "index.html")));

/* -------------------- PRISMA (ленивое подключение) + IN-MEMORY -------------------- */
let prisma = null;
(async () => {
  try {
    prisma = new PrismaClient();
    await prisma.$connect();
    console.log("✅ Prisma connected");
  } catch (e) {
    prisma = null;
    console.warn("⚠️ Prisma unavailable, memory fallback:", e?.code || e?.message);
  }
})();

// Память (резерв)
const mem = {
  games: new Map(), // code -> { code, gmId, started, createdAt, expiresAt, players(Map), messages([]) }
};

const nowTs = () => Date.now();
const addMs = (d, ms) => new Date(d.getTime() + ms);
const genCode = () =>
  Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(2, 8).padEnd(6, "0");

/* -------------------- DAL (DB + fallback memory) -------------------- */
const DAL = {
  // Создать игру (устойчиво: БД -> при ошибке память)
  async createGame(gmId) {
    const now = new Date();

    // Если базы нет — сразу в память
    if (!prisma) {
      let code = genCode();
      while (mem.games.has(code)) code = genCode();
      mem.games.set(code, {
        code,
        gmId,
        started: false,
        createdAt: nowTs(),
        expiresAt: nowTs() + SIX_HOURS_MS,
        players: new Map(),
        messages: [],
      });
      return { code, storage: "memory" };
    }

    // Пробуем до 10 раз (на случай коллизий кода)
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = genCode();
      try {
        const game = await prisma.game.create({
          data: {
            code,
            gmId,
            started: false,
            createdAt: now,
            lastActivity: now,
            expiresAt: addMs(now, SIX_HOURS_MS),
          },
          select: { code: true },
        });
        return { code: game.code, storage: "db" };
      } catch (e) {
        if (e?.code === "P2002") continue; // уникальный код занят — пробуем другой
        // Любая другая ошибка БД — создаём в памяти
        console.warn("DB down, fallback to memory for /new:", e?.code || e?.message);
        mem.games.set(code, {
          code,
          gmId,
          started: false,
          createdAt: nowTs(),
          expiresAt: nowTs() + SIX_HOURS_MS,
          players: new Map(),
          messages: [],
        });
        return { code, storage: "memory-fallback" };
      }
    }
    throw new Error("FAILED_UNIQUE_CODE");
  },

  // Получить игру по коду
  async getGame(code) {
    if (!code) return null;

    // Память
    if (mem.games.has(code)) {
      const g = mem.games.get(code);
      return {
        code: g.code,
        gmId: g.gmId,
        started: g.started,
        createdAt: new Date(g.createdAt),
        expiresAt: new Date(g.expiresAt),
        players: Array.from(g.players.entries()).map(([id, p]) => ({
          id,
          name: p.name,
          avatar: p.avatar,
          joinedAt: new Date(p.joinedAt),
        })),
        messages: g.messages.map((m) => ({ text: m.text, createdAt: new Date(m.createdAt) })),
        storage: "memory",
      };
    }

    // База
    if (!prisma) return null;
    const g = await prisma.game.findUnique({
      where: { code },
      include: { players: true, messages: true },
    });
    if (!g) return null;
    return { ...g, storage: "db" };
  },

  // Вход в лобби (создаёт Player)
  async joinLobby(code, { name, avatar }) {
    const game = await this.getGame(code);
    if (!game) throw new Error("GAME_NOT_FOUND");

    if (game.storage === "memory") {
      const pid = `p_${Math.random().toString(36).slice(2)}`;
      const g = mem.games.get(code);
      g.players.set(pid, { name, avatar, joinedAt: nowTs() });
      return { id: pid, name, avatar };
    }

    const player = await prisma.player.create({
      data: { name, avatar, gameId: game.id },
      select: { id: true, name: true, avatar: true },
    });
    await prisma.game.update({
      where: { id: game.id },
      data: { lastActivity: new Date() },
    });
    return player;
  },

  // Сообщение в чат
  async addMessage(code, text) {
    const game = await this.getGame(code);
    if (!game) throw new Error("GAME_NOT_FOUND");

    if (game.storage === "memory") {
      mem.games.get(code).messages.push({ text, createdAt: nowTs() });
      return;
    }

    await prisma.message.create({ data: { text, gameId: game.id } });
    await prisma.game.update({
      where: { id: game.id },
      data: { lastActivity: new Date() },
    });
  },

  // Очистка просроченных
  async cleanupExpired() {
    const now = new Date();

    // Память
    for (const [code, g] of mem.games.entries()) {
      if (g.expiresAt <= nowTs()) mem.games.delete(code);
    }

    // База
    if (prisma) {
      try {
        await prisma.message.deleteMany({ where: { game: { expiresAt: { lt: now } } } });
        await prisma.player.deleteMany({ where: { game: { expiresAt: { lt: now } } } });
        await prisma.game.deleteMany({ where: { expiresAt: { lt: now } } });
      } catch (e) {
        console.warn("cleanupExpired(DB):", e?.code || e?.message);
      }
    }
  },
};

/* -------------------- API для мини‑аппы -------------------- */

// Получить состояние игры
app.get("/api/game", async (req, res) => {
  try {
    const code = String(req.query.code || "").trim().toUpperCase();
    const game = await DAL.getGame(code);
    if (!game) return res.status(404).json({ ok: false, error: "GAME_NOT_FOUND" });
    res.json({ ok: true, game });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Войти в лобби (создать игрока)
app.post("/api/lobby/join", async (req, res) => {
  try {
    const { code, name, avatar } = req.body || {};
    if (!code || !name) return res.status(400).json({ ok: false, error: "BAD_INPUT" });
    const player = await DAL.joinLobby(String(code).toUpperCase(), {
      name: String(name).slice(0, 32),
      avatar: String(avatar || "🛡️"),
    });
    res.json({ ok: true, player });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Отправить сообщение в чат
app.post("/api/chat/send", async (req, res) => {
  try {
    const { code, text } = req.body || {};
    if (!code || !text) return res.status(400).json({ ok: false, error: "BAD_INPUT" });
    await DAL.addMessage(String(code).toUpperCase(), String(text).slice(0, 300));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* -------------------- TELEGRAM BOT -------------------- */
let bot = null;

if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  // /start
  bot.start(async (ctx) => {
    await ctx.reply(
      "Dnd Mini App. Выбери действие:",
      Markup.inlineKeyboard([[Markup.button.webApp("Открыть мини‑апп", `${APP_URL}`)]])
    );
  });

  // /new — создать игру (устойчиво)
  bot.command("new", async (ctx) => {
    const gmId = String(ctx.from.id);
    try {
      const g = await DAL.createGame(gmId);
      const note =
        g.storage && g.storage.startsWith("memory")
          ? "\n(временно без БД, игра сохранится на 6 часов)"
          : "";
      await ctx.reply(
        `Создана игра. Код: ${g.code}${note}\nОткрой мини‑апп и продолжай.`,
        Markup.inlineKeyboard([[Markup.button.webApp("Открыть мини‑апп", `${APP_URL}?code=${g.code}`)]])
      );
    } catch (e) {
      console.error("NEW failed:", e?.code || e?.message);
      await ctx.reply("Не удалось создать игру. Попробуй ещё раз.");
    }
  });

  // /join — спросить код и выдать кнопку mini‑app
  bot.command("join", async (ctx) => {
    await ctx.reply("Введи код комнаты (6 символов):");
    bot.once("text", async (ctx2) => {
      const code = ctx2.message.text?.trim().toUpperCase();
      if (!code || code.length !== 6) return ctx2.reply("Код должен быть 6 символов.");
      const g = await DAL.getGame(code);
      if (!g) return ctx2.reply("Игра не найдена.");
      await ctx2.reply(
        `Код принят: ${code}. Открой мини‑апп и войди в лобби.`,
        Markup.inlineKeyboard([[Markup.button.webApp("Открыть мини‑апп", `${APP_URL}?code=${code}`)]])
      );
    });
  });

  // webhook
  app.use(bot.webhookCallback(`/telegraf/${BOT_SECRET_PATH}`, { timeout: 30000 }));
  bot.telegram
    .setWebhook(`${APP_URL}/telegraf/${BOT_SECRET_PATH}`)
    .then(() => console.log("🔗 Webhook set:", `${APP_URL}/telegraf/${BOT_SECRET_PATH}`))
    .catch((e) => console.warn("Webhook error:", e.message));
} else {
  console.warn("⚠️ BOT_TOKEN не задан — Telegram‑бот не будет активен");
}

/* -------------------- SERVER + CRON -------------------- */
app.listen(PORT, () => {
  console.log(`🌐 Web server on ${PORT}`);
});

// чистим истёкшие игры раз в минуту
setInterval(() => {
  DAL.cleanupExpired().catch((e) => console.warn("cleanup error:", e?.message));
}, 60 * 1000);
