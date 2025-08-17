// server.js — единый файл сервера (ESM)
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
//import multer from "multer";
import dotenv from "dotenv";
import { Telegraf, Markup } from "telegraf";
import pg from "pg";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const WEBHOOK_PATH = `telegraf-${Math.random().toString(36).slice(2, 7)}`;
const SIX_HOURS = 6 * 60 * 60 * 1000;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// === static
const WEB_DIR = path.join(__dirname, "webapp");
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(express.static(WEB_DIR));
app.get("/", (_, res) => res.sendFile(path.join(WEB_DIR, "index.html")));

// === DB (pg) + in‑memory fallback
let db = null;
const hasDB = !!process.env.DATABASE_URL;
if (hasDB) {
  const { Pool } = pg;
  db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  db.on("error", e => console.error("pg error:", e));
  console.log("✅ Postgres pool created");
}

fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });

async function ensureSchema() {
  if (!db) return;
  const sql = `
create table if not exists public."Game"(
  id bigserial primary key,
  code text not null unique,
  "gmId" text not null default '',
  title text,
  started boolean not null default false,
  "createdAt" timestamptz not null default now(),
  "expiresAt" timestamptz not null default (now() + interval '6 hours')
);

create table if not exists public."Player"(
  id bigserial primary key,
  "gameId" bigint not null references public."Game"(id) on delete cascade,
  "tgId" text not null,
  name text not null,
  avatar text,
  hp int not null default 10,
  gold int not null default 0,
  "isGM" boolean not null default false,
  "locationId" bigint,
  "revealCount" int not null default 0,
  bio text,
  sheet text,
  "createdAt" timestamptz not null default now(),
  unique ("gameId","tgId")
);

create table if not exists public."Location"(
  id bigserial primary key,
  "gameId" bigint not null references public."Game"(id) on delete cascade,
  name text not null,
  descr text,
  "imageUrl" text,
  "createdAt" timestamptz not null default now()
);

create table if not exists public."Item"(
  id bigserial primary key,
  "gameId" bigint not null references public."Game"(id) on delete cascade,
  "ownerId" bigint references public."Player"(id) on delete set null,
  "onFloor" boolean not null default false,
  "locationId" bigint references public."Location"(id) on delete set null,
  name text not null,
  qty int not null default 1,
  type text not null default 'misc',
  "createdAt" timestamptz not null default now()
);
create index if not exists idx_item_game on public."Item"("gameId");
create index if not exists idx_item_owner on public."Item"("ownerId");

create table if not exists public."Message"(
  id bigserial primary key,
  "gameId" bigint not null references public."Game"(id) on delete cascade,
  "authorId" bigint references public."Player"(id) on delete set null,
  text text not null,
  at timestamptz not null default now()
);
create index if not exists idx_message_game on public."Message"("gameId");

create table if not exists public."Roll"(
  id bigserial primary key,
  "gameId" bigint not null references public."Game"(id) on delete cascade,
  "playerId" bigint references public."Player"(id) on delete set null,
  die int not null,
  result int not null,
  at timestamptz not null default now()
);
create index if not exists idx_roll_game on public."Roll"("gameId");
`;
  await db.query(sql);
  console.log("✅ Schema ensured");
}
await ensureSchema().catch(e => console.error("ensureSchema:", e.message));

// — helpers
const mem = { games: new Map(), byId: new Map(), seq: 1 };
const now = () => Date.now();
const newCode = () => {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  let s = ""; for (let i=0;i<6;i++) s += a[Math.floor(Math.random()*a.length)];
  return s;
};

async function getGameByCode(code, meId="") {
  if (db) {
    const g = await db.query(`select * from "Game" where code=$1`, [code]);
    if (g.rowCount===0) return { exists:false };
    const game = g.rows[0];
    const players = (await db.query(`select * from "Player" where "gameId"=$1 order by id`, [game.id])).rows;
    const locations = (await db.query(`select * from "Location" where "gameId"=$1 order by id`, [game.id])).rows;
    const items = (await db.query(`select * from "Item" where "gameId"=$1 order by id`, [game.id])).rows;
    const msgs = (await db.query(`select * from "Message" where "gameId"=$1 order by id desc limit 50`, [game.id])).rows.reverse();
    const you = players.find(p => String(p.tgid)===String(meId)) || null;

    let floorItems = items.filter(i => i.onfloor);
    if (you) {
      floorItems = floorItems
        .filter(i => !i.locationid || i.locationid===you.locationid)
        .slice(0, you.revealcount || 0);
    } else floorItems = [];

    return { ok:true, exists:true, ...game, players, locations, items, messages:msgs, you, floorItems };
  } else {
    const game = mem.games.get(code);
    if (!game) return { exists:false };
    const you = game.players.find(p => p.tgId===String(meId)) || null;
    let floorItems = game.items.filter(i => i.onFloor && (!you || !i.locationId || i.locationId===you.locationId));
    if (you) floorItems = floorItems.slice(0, you.revealCount||0);
    return { ok:true, exists:true, ...game, you, floorItems };
  }
}

// cleanup DB
setInterval(async () => {
  if (!db) return;
  try { await db.query(`delete from "Game" where "expiresAt" < now()`); }
  catch(e){ console.error("cleanupExpired(DB):", e.code||e.message); }
}, 10*60*1000);

// === API

app.get("/api/state", async (req,res)=>{
  const code=(req.query.code||"").toUpperCase();
  const me=String(req.query.me||"");
  const data=await getGameByCode(code, me);
  res.json(data);
});

// ⬇️ ФИКС ЛОББИ: можно создать игру и стать ГМ при первом входе
app.post("/api/lobby/join", async (req,res)=>{
  let { code, tgId, name, avatar, asGM=false } = req.body || {};
  code = (code||"").toUpperCase();
  if (!code || !tgId) return res.status(400).json({ ok:false, error:"NO_CODE_OR_TGID" });

  if (db) {
    // upsert game
    let g = await db.query(`select * from "Game" where code=$1`, [code]);
    if (g.rowCount===0) {
      const ins = await db.query(
        `insert into "Game"(code,"gmId","createdAt","expiresAt") values ($1,$2,now(), now()+ interval '6 hours') returning *`,
        [code, asGM ? String(tgId) : ""]
      );
      g = { rows: ins.rows };
    } else {
      await db.query(`update "Game" set "expiresAt"=now()+ interval '6 hours' where code=$1`, [code]);
    }
    const game = g.rows[0];

    // если у игры нет gmId и пользователь просит asGM, назначаем
    if ((game.gmid||"") === "" && asGM) {
      await db.query(`update "Game" set "gmId"=$1 where id=$2`, [String(tgId), game.id]);
      game.gmid = String(tgId);
    }

    // upsert player + пометка isGM если tgId == gmId
    const p = await db.query(`select * from "Player" where "gameId"=$1 and "tgId"=$2`, [game.id, String(tgId)]);
    const makeGM = String(game.gmid||"") === String(tgId);
    if (p.rowCount===0) {
      await db.query(
        `insert into "Player"("gameId","tgId",name,avatar,hp,gold,"isGM","revealCount","createdAt")
         values ($1,$2,$3,$4,10,0,$5,0,now())`,
        [game.id, String(tgId), name||"Hero", avatar||"🙂", makeGM]
      );
    } else {
      await db.query(
        `update "Player" set name=$1, avatar=$2, "isGM"=$3 where id=$4`,
        [name||p.rows[0].name, avatar||p.rows[0].avatar, makeGM || p.rows[0].isgm, p.rows[0].id]
      );
    }
    return res.json({ ok:true });
  } else {
    // memory
    let game = mem.games.get(code);
    if (!game) {
      game = {
        id: mem.seq++, code, gmId: asGM ? String(tgId) : "", title:"",
        started:false, createdAt: now(), expiresAt: now()+SIX_HOURS,
        players:[], locations:[], items:[], messages:[]
      };
      mem.games.set(code, game); mem.byId.set(game.id, game);
    } else { game.expiresAt = now() + SIX_HOURS; }
    let p = game.players.find(p => p.tgId===String(tgId));
    const makeGM = (game.gmId||"")==="" ? !!asGM : game.gmId===String(tgId);
    if ((game.gmId||"")==="" && asGM) game.gmId = String(tgId);

    if (!p) {
      p = { id: mem.seq++, gameId: game.id, tgId:String(tgId), name:name||"Hero", avatar:avatar||"🙂",
            hp:10, gold:0, isGM: makeGM, locationId:null, revealCount:0, bio:"", sheet:"" };
      game.players.push(p);
    } else {
      p.name = name || p.name; p.avatar = avatar || p.avatar; p.isGM = p.isGM || makeGM;
    }
    return res.json({ ok:true });
  }
});

// чат
app.post("/api/message", async (req,res)=>{
  const { gameId, authorId, text } = req.body||{};
  if (!text) return res.status(400).json({ ok:false });
  if (db) {
    await db.query(`insert into "Message"("gameId","authorId",text,at) values ($1,$2,$3,now())`,
      [gameId, authorId||null, text]);
  } else {
    const g = mem.byId.get(gameId); if (!g) return res.json({ ok:false });
    g.messages.push({ id: mem.seq++, gameId, authorId:authorId||null, text, at:new Date().toISOString() });
  }
  res.json({ ok:true });
});

// бросок
app.post("/api/roll", async (req,res)=>{
  const { gameId, playerId, die=20 } = req.body||{};
  const result = 1 + Math.floor(Math.random() * Number(die||20));
  if (db) {
    const ins = await db.query(
      `insert into "Roll"("gameId","playerId",die,result,at) values ($1,$2,$3,$4,now()) returning *`,
      [gameId, playerId||null, Number(die||20), result]
    );
    return res.json({ ok:true, roll: ins.rows[0] });
  } else {
    return res.json({ ok:true, roll: { id: mem.seq++, gameId, playerId, die, result, at:new Date().toISOString() } });
  }
});

// осмотреться (+1 предмет игроку)
app.post("/api/look", async (req,res)=>{
  const { gameId, playerId } = req.body||{};
  if (db) {
    await db.query(`update "Player" set "revealCount"=coalesce("revealCount",0)+1 where id=$1 and "gameId"=$2`, [playerId, gameId]);
  } else {
    const g = mem.byId.get(gameId); if (!g) return res.json({ ok:false });
    const p = g.players.find(p=>p.id===Number(playerId)); if (!p) return res.json({ ok:false });
    p.revealCount = (p.revealCount||0)+1;
  }
  res.json({ ok:true });
});

// ГМ: HP/Gold
app.post("/api/gm/grant-hp", async (req,res)=>{
  const { playerId, delta } = req.body||{};
  if (db) await db.query(`update "Player" set hp = greatest(0, hp + $1) where id=$2`, [Number(delta||0), Number(playerId)]);
  else for (const g of mem.games.values()) { const p=g.players.find(p=>p.id===Number(playerId)); if (p) p.hp=Math.max(0,p.hp+Number(delta||0)); }
  res.json({ ok:true });
});
app.post("/api/gm/grant-gold", async (req,res)=>{
  const { playerId, delta } = req.body||{};
  if (db) await db.query(`update "Player" set gold = greatest(0, gold + $1) where id=$2`, [Number(delta||0), Number(playerId)]);
  else for (const g of mem.games.values()) { const p=g.players.find(p=>p.id===Number(playerId)); if (p) p.gold=Math.max(0,p.gold+Number(delta||0)); }
  res.json({ ok:true });
});

// ГМ: описание/инвентарь игрока
app.post("/api/gm/set-player-info", async (req,res)=>{
  const { playerId, bio="", sheet="" } = req.body||{};
  if (db) await db.query(`update "Player" set bio=$1, sheet=$2 where id=$3`, [bio, sheet, Number(playerId)]);
  else for (const g of mem.games.values()) { const p=g.players.find(p=>p.id===Number(playerId)); if (p) { p.bio=bio; p.sheet=sheet; } }
  res.json({ ok:true });
});

// локации
app.post("/api/location", async (req,res)=>{
  const { gameId, name, descr="", imageUrl=null } = req.body||{};
  if (!gameId || !name) return res.status(400).json({ ok:false });
  if (db) {
    const ins = await db.query(
      `insert into "Location"("gameId",name,descr,"imageUrl","createdAt") values ($1,$2,$3,$4,now()) returning *`,
      [gameId, name, descr, imageUrl]
    );
    return res.json({ ok:true, location: ins.rows[0] });
  } else {
    const g = mem.byId.get(gameId); if (!g) return res.json({ ok:false });
    const loc = { id: mem.seq++, gameId, name, descr, imageUrl, createdAt:new Date().toISOString() };
    g.locations.push(loc); res.json({ ok:true, location: loc });
  }
});
//const upload = multer({ dest: path.join(__dirname, "uploads") });
//app.post("/api/location/upload", upload.single("file"), (req,res)=>{
  if (!req.file) return res.status(400).json({ ok:false });
  const url = `${APP_URL}/uploads/${req.file.filename}`;
  res.json({ ok:true, url });
});

// предметы
app.post("/api/item", async (req,res)=>{
  const { gameId, name, qty=1, ownerId=null, onFloor=false, locationId=null } = req.body||{};
  if (!gameId || !name) return res.status(400).json({ ok:false });
  if (db) {
    const ins = await db.query(
      `insert into "Item"("gameId","ownerId","onFloor","locationId",name,qty,"createdAt")
       values ($1,$2,$3,$4,$5,$6,now()) returning *`,
      [gameId, ownerId, onFloor, locationId, name, Number(qty||1)]
    );
    res.json({ ok:true, item: ins.rows[0] });
  } else {
    const g = mem.byId.get(gameId); if (!g) return res.json({ ok:false });
    const it = { id: mem.seq++, gameId, ownerId, onFloor: !!onFloor, locationId, name, qty:Number(qty||1), createdAt:new Date().toISOString() };
    g.items.push(it); res.json({ ok:true, item: it });
  }
});

// старт игры
app.post("/api/game/:id/start", async (req,res)=>{
  const id = Number(req.params.id);
  const { locationId=null } = req.body||{};
  if (db) {
    await db.query(`update "Game" set started=true where id=$1`, [id]);
    if (locationId) await db.query(`update "Player" set "locationId"=$1 where "gameId"=$2`, [locationId, id]);
  } else {
    const g = mem.byId.get(id); if (!g) return res.json({ ok:false });
    g.started=true; if (locationId) g.players.forEach(p=>p.locationId=locationId);
  }
  res.json({ ok:true });
});

// Telegram (минимум)
let bot=null;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);
  bot.start(ctx => ctx.reply("Команды:\n/new — создать игру\n/join ABC123 — войти кодом"));
  bot.command("new", async ctx=>{
    const code = newCode();
    if (db) {
      await db.query(`insert into "Game"(code,"gmId","createdAt","expiresAt") values ($1,$2,now(),now()+ interval '6 hours')`, [code, String(ctx.from.id)]);
    } else {
      const g = { id:mem.seq++, code, gmId:String(ctx.from.id), title:"", started:false, createdAt:now(), expiresAt:now()+SIX_HOURS, players:[], locations:[], items:[], messages:[] };
      mem.games.set(code,g); mem.byId.set(g.id,g);
    }
    ctx.reply(`Создана игра. Код: ${code}\nОткрой мини‑апп и продолжай.`, Markup.button.webApp("Открыть мини‑апп", `${APP_URL}/?code=${code}`));
  });
  const wh = `/telegraf/${WEBHOOK_PATH}`;
  app.use(wh, bot.webhookCallback(wh));
  await bot.telegram.setWebhook(`${APP_URL}${wh}`);
  console.log("🔗 Webhook set:", `${APP_URL}${wh}`);
} else {
  console.log("⚠️ BOT_TOKEN не задан — бот выключен");
}

app.listen(PORT, ()=> console.log("🌐 Web server on", PORT));
