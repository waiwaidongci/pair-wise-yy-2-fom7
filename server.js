import http from "node:http";
import { loadDb, saveDb } from "./lib/store.js";
import {
  HttpError,
  PARTY_LABEL,
  registerClaim,
  confirmClaim,
  withdrawClaim,
  adjudicateClaim,
  voidClaimsForParentChange,
  assertClaimNotLocked,
  listClaims
} from "./lib/claims.js";

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
function sendError(res, err) {
  if (err instanceof HttpError) {
    const { status, error, ...extra } = err;
    return sendJson(res, status, { error, ...extra });
  }
  sendJson(res, 500, { error: err.message });
}
function relation(db, ringNo) {
  const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
  if (!pigeon) return null;
  const father = db.pigeons.find(item => item.ringNo === pigeon.fatherRing) || null;
  const mother = db.pigeons.find(item => item.ringNo === pigeon.motherRing) || null;
  const children = db.pigeons.filter(item => item.fatherRing === ringNo || item.motherRing === ringNo);
  return { pigeon, father, mother, children };
}
function today() { return new Date().toISOString().slice(0, 10); }

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>赛鸽血统环号登记站</title>
  <style>
    :root { --bg:#eff2f5; --panel:#fff; --ink:#1f2833; --muted:#697786; --line:#d3dce4; --accent:#315f83; --red:#9b3f35; --green:#3f7a4e; --amber:#8a6d1f; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; }
    textarea { min-height:64px; resize:vertical; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.ghost { background:#eef2f5; color:var(--ink); } button.danger { background:var(--red); } button.ok { background:var(--green); } button.warn { background:var(--amber); }
    button:disabled { opacity:.45; cursor:not-allowed; }
    .toolbar { display:grid; grid-template-columns:1fr auto; gap:10px; margin-bottom:14px; } .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; }
    .card { display:grid; gap:8px; } .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.pending { background:#fdf3d8; border-color:#e6d48a; color:var(--amber); } .pill.settled { background:#e2f0e6; border-color:#a9d0b5; color:var(--green); } .pill.withdrawn { background:#f0e3e1; border-color:#d9b3ad; color:var(--red); }
    .lock { color:var(--red); font-size:12px; font-weight:700; }
    .section { margin-top:14px; } .relation { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px; } .small { background:#f8fafb; border:1px solid var(--line); border-radius:8px; padding:10px; }
    .claim-actions { display:flex; flex-wrap:wrap; gap:6px; } .claim-actions button { padding:7px 9px; font-size:12px; }
    .banner { background:#fdf3d8; border:1px solid #e6d48a; color:var(--amber); border-radius:6px; padding:8px 10px; font-size:13px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .relation{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header><div><h1>赛鸽血统环号登记站</h1><div class="meta">档案、血统、转让、归巢成绩与失鸽认领</div></div><button id="reload">刷新</button></header>
  <main>
    <div>
      <form id="form">
        <h2>创建鸽只档案</h2>
        <label>足环号</label><input name="ringNo" required>
        <label>鸽主</label><input name="owner" required>
        <label>父鸽足环号</label><input name="fatherRing">
        <label>母鸽足环号</label><input name="motherRing">
        <label>羽色</label><input name="color" required>
        <label>出生棚号</label><input name="loft" required>
        <button>保存档案</button>
      </form>
      <form id="claimForm" style="margin-top:16px">
        <h2>失鸽拾获登记</h2>
        <label>足环号</label><input name="ringNo" required>
        <label>拾获人（现鸽主）</label><input name="finder" required>
        <label>见证材料（每行一条）</label><textarea name="materials" placeholder="足环照片&#10;棚号照片&#10;目击证人联系方式"></textarea>
        <button>登记认领</button>
        <div class="meta" style="margin-top:6px">一只鸽只挂一笔未结认领；重复提交沿用首案编号。</div>
      </form>
    </div>
    <section>
      <div class="toolbar"><input id="search" placeholder="输入足环号查询血统"><button id="searchBtn">查询</button></div>
      <div class="panel" id="detail"></div>
      <div class="section grid" id="cards"></div>
      <div class="panel" style="margin-top:16px">
        <h2>失鸽认领案件</h2>
        <div class="grid" id="claimCards"></div>
      </div>
    </section>
  </main>
  <script>
    const form = document.querySelector("#form");
    const claimForm = document.querySelector("#claimForm");
    const cards = document.querySelector("#cards");
    const claimCards = document.querySelector("#claimCards");
    const detail = document.querySelector("#detail");
    const search = document.querySelector("#search");
    let pigeons = [];
    let claims = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败" + (data.message ? "："+data.message : ""));
      return data;
    }
    const claimStatusLabel = { pending:"审理中", settled:"已结案", withdrawn:"已作废" };
    function lockedRingSet(){ return new Set(claims.filter(c => c.status === "pending").map(c => c.ringNo)); }
    function renderCards() {
      const locked = lockedRingSet();
      cards.innerHTML = pigeons.map(p => {
        const isLocked = locked.has(p.ringNo);
        return '<article class="card"><h3>'+p.ringNo+'</h3>'+(isLocked ? '<span class="lock">认领未结案 · 暂停转让/报名</span>' : '')+'<span class="pill">'+p.owner+'</span><div class="meta">'+p.color+' · '+p.loft+'</div><div>父：'+(p.fatherRing || "未登记")+'</div><div>母：'+(p.motherRing || "未登记")+'</div>'
        +'<label>录入转让</label><input data-to="'+p.ringNo+'" placeholder="新归属人" '+(isLocked?'disabled':'')+'><button data-transfer="'+p.ringNo+'" '+(isLocked?'disabled':'')+'>保存转让</button>'
        +'<label>赛事报名</label><input data-entry="'+p.ringNo+'" placeholder="赛事/放飞日期，如200公里/2026-10-20" '+(isLocked?'disabled':'')+'><button data-entry-save="'+p.ringNo+'" '+(isLocked?'disabled':'')+'>保存报名</button>'
        +'<label>归巢成绩</label><input data-race="'+p.ringNo+'" placeholder="赛事/距离/名次，如200公里/200/6"><button data-score="'+p.ringNo+'">保存成绩</button>'
        +'<div class="meta">报名：'+((p.entries||[]).map(e=>e.event+'('+e.raceDate+')').join("、")||"暂无")+'</div>'
        +'<div class="meta">往期名次：'+((p.races||[]).map(r=>r.event+" 第"+r.rank+"名（"+(r.owner||p.owner)+"）").join(" / ")||"暂无")+'</div>'
        +'</article>';
      }).join("");
      document.querySelectorAll("[data-transfer]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.transfer; const to = document.querySelector('[data-to="'+ringNo+'"]').value;
        try { await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/transfers', { method:'POST', body: JSON.stringify({ to }) }); await load(); }
        catch(e){ alert(e.message); }
      });
      document.querySelectorAll("[data-entry-save]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.entrySave; const raw = document.querySelector('[data-entry="'+ringNo+'"]').value.split("/");
        try { await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/entries', { method:'POST', body: JSON.stringify({ event: raw[0] || "未命名赛事", raceDate: raw[1] || "" }) }); await load(); }
        catch(e){ alert(e.message); }
      });
      document.querySelectorAll("[data-score]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.score; const raw = document.querySelector('[data-race="'+ringNo+'"]').value.split("/");
        try { await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/races', { method:'POST', body: JSON.stringify({ event: raw[0] || "未命名赛事", distance: Number(raw[1] || 0), rank: Number(raw[2] || 0) }) }); await load(); }
        catch(e){ alert(e.message); }
      });
    }
    function renderClaimCards() {
      if (!claims.length) { claimCards.innerHTML = '<p class="meta">暂无认领案件。</p>'; return; }
      claimCards.innerHTML = claims.map(c => {
        const open = c.status === "pending";
        const mats = (c.materials||[]).length ? c.materials.map(m=>'<span class="pill">'+m+'</span>').join(" ") : '<span class="meta">无</span>';
        return '<article class="card"><h3>'+c.caseNo+'</h3><span class="pill '+c.status+'">'+claimStatusLabel[c.status]+'</span>'
        +'<div class="meta">足环：<b>'+c.ringNo+'</b> · 拾获人：'+c.finder+' · 第'+c.round+'轮</div>'
        +'<div class="meta">确认：鸽主 '+(c.confirmations.owner?'✓':'○')+' · 拾获人 '+(c.confirmations.finder?'✓':'○')+'</div>'
        +'<div class="meta">见证材料：'+mats+'</div>'
        +(c.ruling ? '<div class="meta">裁决：'+(c.ruling==='approved'?'批准结案':'驳回重判')+'</div>' : '')
        +(c.settledAt ? '<div class="meta">结案：'+new Date(c.settledAt).toLocaleString()+'</div>' : '')
        +'<div class="claim-actions">'
        +'<button data-confirm="'+c.caseNo+'" data-party="owner" '+(open&&!c.confirmations.owner?'':'disabled')+'>鸽主确认</button>'
        +'<button data-confirm="'+c.caseNo+'" data-party="finder" '+(open&&!c.confirmations.finder?'':'disabled')+'>拾获人确认</button>'
        +'<button class="danger" data-withdraw="'+c.caseNo+'" '+(open?'':'disabled')+'>撤回</button>'
        +'<button class="ok" data-adjudicate="'+c.caseNo+'" data-decision="approve" '+(open?'':'disabled')+'>裁决批准</button>'
        +'<button class="warn" data-adjudicate="'+c.caseNo+'" data-decision="reject" '+(open?'':'disabled')+'>裁决驳回</button>'
        +'</div></article>';
      }).join("");
      document.querySelectorAll("[data-confirm]").forEach(btn => btn.onclick = async () => {
        try { await api('/api/claims/'+encodeURIComponent(btn.dataset.confirm)+'/confirm', { method:'POST', body: JSON.stringify({ party: btn.dataset.party }) }); await load(); }
        catch(e){ alert(e.message); }
      });
      document.querySelectorAll("[data-withdraw]").forEach(btn => btn.onclick = async () => {
        if (!confirm('确认撤回该认领？撤回后案件作废，再次提交沿用原案号。')) return;
        try { await api('/api/claims/'+encodeURIComponent(btn.dataset.withdraw)+'/withdraw', { method:'POST', body: JSON.stringify({ by: "登记员" }) }); await load(); }
        catch(e){ alert(e.message); }
      });
      document.querySelectorAll("[data-adjudicate]").forEach(btn => btn.onclick = async () => {
        const ok = btn.dataset.decision === 'approve' ? '确认裁决批准结案？须双方均已确认。' : '确认驳回？驳回后回滚首案状态，可再次提交。';
        if (!confirm(ok)) return;
        try { await api('/api/claims/'+encodeURIComponent(btn.dataset.adjudicate)+'/adjudicate', { method:'POST', body: JSON.stringify({ decision: btn.dataset.decision, by: "登记员" }) }); await load(); }
        catch(e){ alert(e.message); }
      });
    }
    function renderRelation(data) {
      if (!data) { detail.innerHTML = '<h2>血统查询</h2><p class="meta">请输入足环号查看父母、子代、转让和成绩。</p>'; return; }
      const p = data.pigeon;
      detail.innerHTML = '<h2>'+p.ringNo+' 血统档案</h2><div class="relation"><div class="small"><b>父鸽</b><br>'+(data.father?.ringNo || p.fatherRing || "未登记")+'</div><div class="small"><b>本鸽</b><br>'+p.owner+' · '+p.color+'</div><div class="small"><b>母鸽</b><br>'+(data.mother?.ringNo || p.motherRing || "未登记")+'</div></div><div><b>子代</b> '+(data.children.map(c => c.ringNo).join("、") || "暂无")+'</div><div class="meta">转让：'+(p.transfers.map(t => t.from+"→"+t.to+(t.reason?"（"+t.reason+"）":"")).join(" / ") || "暂无")+'</div><div class="meta">归巢：'+(p.races.map(r => r.event+" 第"+r.rank+"名（"+(r.owner||p.owner)+"）").join(" / ") || "暂无")+'</div>';
    }
    async function load(){
      pigeons = await api("/api/pigeons");
      claims = await api("/api/claims");
      renderCards(); renderClaimCards(); renderRelation(null);
    }
    document.querySelector("#searchBtn").onclick = async () => {
      try { renderRelation(await api('/api/pigeons/'+encodeURIComponent(search.value)+'/relation')); }
      catch(e){ alert(e.message); }
    };
    document.querySelector("#reload").onclick = load;
    form.onsubmit = async event => {
      event.preventDefault();
      try { await api("/api/pigeons", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset(); await load(); } catch(e){ alert(e.message); }
    };
    claimForm.onsubmit = async event => {
      event.preventDefault();
      const fd = new FormData(claimForm);
      const materials = String(fd.get("materials")||"").split(/\\n/).map(s=>s.trim()).filter(Boolean);
      try {
        const res = await api("/api/claims", { method:"POST", body: JSON.stringify({ ringNo: fd.get("ringNo"), finder: fd.get("finder"), materials }) });
        claimForm.reset(); await load();
        if (res.reused) alert('该鸽已有未结认领，沿用首案编号：'+res.caseNo);
      } catch(e){ alert(e.message); }
    };
    load();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
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
      const pigeon = { ...input, vaccines: [], transfers: [], races: [], entries: [] };
      db.pigeons.unshift(pigeon);
      await saveDb(db);
      return sendJson(res, 201, pigeon);
    }

    if (req.method === "GET" && url.pathname === "/api/claims") {
      return sendJson(res, 200, listClaims(db));
    }

    if (req.method === "POST" && url.pathname === "/api/claims") {
      const input = await body(req);
      const result = registerClaim(db, input); // 同步建案，并发提交不会产生第二案
      await saveDb(db);
      return sendJson(res, 201, result);
    }

    const claimAction = url.pathname.match(/^\/api\/claims\/([^/]+)\/(confirm|withdraw|adjudicate)$/);
    if (claimAction && req.method === "POST") {
      const caseNo = decodeURIComponent(claimAction[1]);
      const action = claimAction[2];
      const input = await body(req);
      let result;
      if (action === "confirm") result = confirmClaim(db, caseNo, input.party);
      else if (action === "withdraw") result = withdrawClaim(db, caseNo, input.by);
      else result = adjudicateClaim(db, caseNo, input.decision, input.by);
      await saveDb(db);
      return sendJson(res, 200, result);
    }

    const claimDetail = url.pathname.match(/^\/api\/claims\/([^/]+)$/);
    if (claimDetail && req.method === "GET") {
      const claim = db.claims.find(item => item.caseNo === decodeURIComponent(claimDetail[1]));
      return claim ? sendJson(res, 200, claim) : sendJson(res, 404, { error: "claim_not_found" });
    }

    const relationMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/relation$/);
    if (relationMatch && req.method === "GET") {
      const data = relation(db, decodeURIComponent(relationMatch[1]));
      return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found" });
    }

    const actionMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/(transfers|races|vaccines|entries)$/);
    if (actionMatch && req.method === "POST") {
      const ringNo = decodeURIComponent(actionMatch[1]);
      const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
      const kind = actionMatch[2];
      const input = await body(req);

      if (kind === "transfers") {
        assertClaimNotLocked(db, ringNo); // 结案前不能转让
        pigeon.transfers.push({ date: input.date || today(), from: pigeon.owner, to: input.to });
        pigeon.owner = input.to;
      } else if (kind === "entries") {
        assertClaimNotLocked(db, ringNo); // 结案前不能报名
        pigeon.entries.push({ date: input.date || today(), event: input.event, raceDate: input.raceDate || "", location: input.location || "" });
      } else if (kind === "races") {
        // 往期名次仍归比赛当天鸽主：快照当日鸽主，之后认领结案换主也不影响该成绩归属。
        pigeon.races.push({ date: input.date || today(), event: input.event, distance: Number(input.distance || 0), returnTime: input.returnTime || "", rank: Number(input.rank || 0), owner: pigeon.owner });
      } else if (kind === "vaccines") {
        pigeon.vaccines.push({ date: input.date || today(), name: input.name });
      }
      await saveDb(db);
      return sendJson(res, 200, pigeon);
    }

    // 父母档案改动：触发相关未结认领作废并重判。
    const pigeonUpdate = url.pathname.match(/^\/api\/pigeons\/([^/]+)$/);
    if (pigeonUpdate && req.method === "PUT") {
      const ringNo = decodeURIComponent(pigeonUpdate[1]);
      const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
      const input = await body(req);
      const parentChanged = ["fatherRing", "motherRing"].some(k => k in input && input[k] !== pigeon[k]);
      for (const k of ["fatherRing", "motherRing", "color", "loft"]) {
        if (k in input) pigeon[k] = input[k];
      }
      let affected = 0;
      if (parentChanged) affected = voidClaimsForParentChange(db, pigeon);
      await saveDb(db);
      return sendJson(res, 200, { pigeon, claimsAffected: affected });
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendError(res, error);
  }
});

server.listen(port, () => console.log(`Racing pigeon registry app listening on http://localhost:${port}`));
