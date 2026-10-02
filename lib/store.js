// 档案保存：鸽只档案与认领案件的持久化。
// 数据在进程内缓存一份，所有读写都围绕同一对象同步进行，
// 这样并发的认领请求在「查无未结案件 → 建案」之间不会互相穿插，
// 保证后来者拿到的是首案编号而不是又立一案。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "..", "data", "pigeons.json");

export const seed = {
  pigeons: [
    { ringNo: "CHN-2026-001", owner: "北岸棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚", vaccines: [{ date: "2026-04-01", name: "新城疫" }], transfers: [{ date: "2026-04-15", from: "育种棚", to: "北岸棚" }], races: [{ date: "2026-06-01", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18 }], entries: [] },
    { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [], transfers: [], races: [], entries: [] },
    { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", vaccines: [], transfers: [], races: [], entries: [] }
  ],
  claims: [],
  claimSeq: 0
};

let dbPromise = null;

function migrate(db) {
  if (!Array.isArray(db.pigeons)) db.pigeons = [];
  if (!Array.isArray(db.claims)) db.claims = [];
  if (typeof db.claimSeq !== "number") db.claimSeq = db.claims.length;
  for (const p of db.pigeons) {
    if (!Array.isArray(p.vaccines)) p.vaccines = [];
    if (!Array.isArray(p.transfers)) p.transfers = [];
    if (!Array.isArray(p.races)) p.races = [];
    if (!Array.isArray(p.entries)) p.entries = [];
    // 往期名次仍归比赛当天鸽主：旧数据补快照，缺失时以当前鸽主兜底。
    for (const r of p.races) if (!r.owner) r.owner = p.owner;
  }
  return db;
}

export async function loadDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      if (!existsSync(dbPath)) {
        await mkdir(dirname(dbPath), { recursive: true });
        await writeFile(dbPath, JSON.stringify(seed, null, 2));
      }
      return migrate(JSON.parse(await readFile(dbPath, "utf8")));
    })();
  }
  return dbPromise;
}

export async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}
