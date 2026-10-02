import http from "node:http";
import { loadDb, saveDb } from "./store.js";
import { page } from "./page.js";
import { ClaimError, submitClaim, confirmClaim, withdrawClaim, rejudgeForPedigree, openClaimFor } from "./claims.js";

const port = Number(process.env.PORT || 3024);

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function relation(db, ringNo) {
  const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
  if (!pigeon) return null;
  const father = db.pigeons.find(item => item.ringNo === pigeon.fatherRing) || null;
  const mother = db.pigeons.find(item => item.ringNo === pigeon.motherRing) || null;
  const children = db.pigeons.filter(item => item.fatherRing === ringNo || item.motherRing === ringNo);
  const claim = db.claims.find(item => item.ringNo === ringNo) || null;
  return { pigeon, father, mother, children, claim };
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/api/pigeons") return sendJson(res, 200, db.pigeons);
    if (req.method === "POST" && url.pathname === "/api/pigeons") {
      const input = await body(req);
      if (db.pigeons.some(item => item.ringNo === input.ringNo)) return sendJson(res, 409, { error: "ring_exists" });
      const pigeon = { ...input, vaccines: [], transfers: [], races: [] };
      db.pigeons.unshift(pigeon);
      await saveDb(db);
      return sendJson(res, 201, pigeon);
    }
    const relationMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/relation$/);
    if (relationMatch && req.method === "GET") {
      const data = relation(db, decodeURIComponent(relationMatch[1]));
      return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found" });
    }
    const pedigreeMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/pedigree$/);
    if (pedigreeMatch && req.method === "PUT") {
      const pigeon = db.pigeons.find(item => item.ringNo === decodeURIComponent(pedigreeMatch[1]));
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
      const input = await body(req);
      pigeon.fatherRing = input.fatherRing || "";
      pigeon.motherRing = input.motherRing || "";
      const claim = rejudgeForPedigree(db, pigeon.ringNo); // 父母档案改动，相关认领作废并重判
      await saveDb(db);
      return sendJson(res, 200, { pigeon, claim });
    }
    const actionMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/(transfers|races|vaccines)$/);
    if (actionMatch && req.method === "POST") {
      const pigeon = db.pigeons.find(item => item.ringNo === decodeURIComponent(actionMatch[1]));
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
      const action = actionMatch[2];
      const pending = (action === "transfers" || action === "races") && openClaimFor(db, pigeon.ringNo);
      if (pending) return sendJson(res, 409, { error: "claim_pending", claimId: pending.id }); // 结案前不能再转让或报名
      const input = await body(req);
      if (action === "transfers") {
        const transfer = { date: input.date || new Date().toISOString().slice(0, 10), from: pigeon.owner, to: input.to };
        pigeon.owner = input.to;
        pigeon.transfers.push(transfer);
      }
      // 成绩按比赛当天鸽主存档，归属日后变动不影响往期名次
      if (action === "races") pigeon.races.push({ date: input.date || new Date().toISOString().slice(0, 10), event: input.event, distance: Number(input.distance || 0), returnTime: input.returnTime || "", rank: Number(input.rank || 0), owner: pigeon.owner });
      if (action === "vaccines") pigeon.vaccines.push({ date: input.date || new Date().toISOString().slice(0, 10), name: input.name });
      await saveDb(db);
      return sendJson(res, 200, pigeon);
    }
    if (req.method === "GET" && url.pathname === "/api/claims") return sendJson(res, 200, db.claims);
    if (req.method === "POST" && url.pathname === "/api/claims") {
      const result = submitClaim(db, await body(req));
      await saveDb(db);
      return sendJson(res, result.created ? 201 : 200, result);
    }
    const claimActionMatch = url.pathname.match(/^\/api\/claims\/(.+)\/(confirm|withdraw)$/);
    if (claimActionMatch && req.method === "POST") {
      const id = decodeURIComponent(claimActionMatch[1]);
      const input = await body(req);
      const claim = claimActionMatch[2] === "confirm" ? confirmClaim(db, id, input.name) : withdrawClaim(db, id);
      await saveDb(db);
      return sendJson(res, 200, claim);
    }
    const claimMatch = url.pathname.match(/^\/api\/claims\/(.+)$/);
    if (claimMatch && req.method === "GET") {
      const claim = db.claims.find(item => item.id === decodeURIComponent(claimMatch[1]));
      return claim ? sendJson(res, 200, claim) : sendJson(res, 404, { error: "claim_not_found" });
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof ClaimError) return sendJson(res, error.status, { error: error.code });
    sendJson(res, 500, { error: error.message });
  }
}

// 档案是单文件，读写串行化：两位认领人同时提交时，后来者只会拿到首案编号
let queue = Promise.resolve();
const server = http.createServer((req, res) => {
  queue = queue.then(() => handle(req, res));
});

server.listen(port, () => console.log(`Racing pigeon registry app listening on http://localhost:${port}`));
