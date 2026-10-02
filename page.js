// 页面入口：单页 HTML。认领裁决见 claims.js，档案保存见 store.js。
export const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>赛鸽血统环号登记站</title>
  <style>
    :root { --bg:#eff2f5; --panel:#fff; --ink:#1f2833; --muted:#697786; --line:#d3dce4; --accent:#315f83; --red:#9b3f35; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    .toolbar { display:grid; grid-template-columns:1fr auto; gap:10px; margin-bottom:14px; } .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; }
    .card { display:grid; gap:8px; } .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .section { margin-top:14px; } .relation { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px; } .small { background:#f8fafb; border:1px solid var(--line); border-radius:8px; padding:10px; }
    .col { display:grid; gap:22px; align-content:start; } .row { display:flex; gap:8px; flex-wrap:wrap; } .row input { flex:1; min-width:120px; }
    #msg { background:#fdf6e3; border:1px solid #e3d9b8; border-radius:8px; padding:10px 14px; margin-bottom:14px; } #msg:empty { display:none; }
    .lock { color:var(--red); font-weight:700; } details { margin-top:4px; } summary { cursor:pointer; color:var(--muted); font-size:13px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .relation{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header><div><h1>赛鸽血统环号登记站</h1><div class="meta">档案、血统、转让、归巢成绩与失鸽认领</div></div><button id="reload">刷新</button></header>
  <main>
    <div class="col">
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
      <form id="claimForm">
        <h2>拾获认领登记</h2>
        <label>足环号</label><input name="ringNo" required>
        <label>现鸽主（拾获保管人）</label><input name="holder" required>
        <label>认领人</label><input name="claimant" required>
        <label>见证材料</label><input name="witness" required placeholder="照片、见证人、拾获时间地点">
        <button>提交认领</button>
        <div class="meta">一只鸽只挂一笔未结认领；重复提交只回首案编号。</div>
      </form>
    </div>
    <section>
      <div class="toolbar"><input id="search" placeholder="输入足环号查询血统"><button id="searchBtn">查询</button></div>
      <div id="msg"></div>
      <div class="panel" id="detail"></div>
      <div class="panel section" id="claimPanel"></div>
      <div class="section grid" id="cards"></div>
    </section>
  </main>
  <script>
    const form = document.querySelector("#form");
    const claimForm = document.querySelector("#claimForm");
    const cards = document.querySelector("#cards");
    const detail = document.querySelector("#detail");
    const claimPanel = document.querySelector("#claimPanel");
    const search = document.querySelector("#search");
    const msg = document.querySelector("#msg");
    let pigeons = [];
    let claims = [];
    let lastRing = "";
    const STATUS = { open: "未结", closed: "结案", void: "作废" };
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    function say(text) { msg.textContent = text || ""; }
    function claimOf(ringNo) { return claims.find(item => item.ringNo === ringNo) || null; }
    function renderCards() {
      cards.innerHTML = pigeons.map(p => {
        const claim = claimOf(p.ringNo);
        const locked = claim && claim.status === "open";
        const ops = locked
          ? '<div class="meta lock">认领未结（'+claim.id+'），结案前暂停转让与报名</div>'
          : '<label>录入转让</label><input data-to="'+p.ringNo+'" placeholder="新归属人"><button data-transfer="'+p.ringNo+'">保存转让</button><label>归巢成绩</label><input data-race="'+p.ringNo+'" placeholder="赛事/距离/名次，如200公里/200/6"><button data-score="'+p.ringNo+'">保存成绩</button>';
        return '<article class="card"><h3>'+p.ringNo+'</h3><span class="pill">'+p.owner+'</span><div class="meta">'+p.color+' · '+p.loft+'</div><div>父：'+(p.fatherRing || "未登记")+'</div><div>母：'+(p.motherRing || "未登记")+'</div>'+ops+'</article>';
      }).join("");
      document.querySelectorAll("[data-transfer]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.transfer; const to = document.querySelector('[data-to="'+ringNo+'"]').value;
        try { await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/transfers', { method:'POST', body: JSON.stringify({ to }) }); say(""); await load(); } catch (e) { say(e.message); }
      });
      document.querySelectorAll("[data-score]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.score; const raw = document.querySelector('[data-race="'+ringNo+'"]').value.split("/");
        try { await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/races', { method:'POST', body: JSON.stringify({ event: raw[0] || "未命名赛事", distance: Number(raw[1] || 0), rank: Number(raw[2] || 0) }) }); say(""); await load(); } catch (e) { say(e.message); }
      });
    }
    function renderRelation(data) {
      if (!data) { detail.innerHTML = '<h2>血统查询</h2><p class="meta">请输入足环号查看父母、子代、转让和成绩。</p>'; return; }
      const p = data.pigeon;
      const claim = data.claim;
      detail.innerHTML = '<h2>'+p.ringNo+' 血统档案</h2>'
        + '<div class="relation"><div class="small"><b>父鸽</b><br>'+(data.father?.ringNo || p.fatherRing || "未登记")+'</div><div class="small"><b>本鸽</b><br>'+p.owner+' · '+p.color+'</div><div class="small"><b>母鸽</b><br>'+(data.mother?.ringNo || p.motherRing || "未登记")+'</div></div>'
        + '<div><b>子代</b> '+(data.children.map(c => c.ringNo).join("、") || "暂无")+'</div>'
        + '<div class="meta">转让：'+(p.transfers.map(t => t.from+"→"+t.to).join(" / ") || "暂无")+'</div>'
        + '<div class="meta">归巢：'+(p.races.map(r => r.event+" 第"+r.rank+"名（当日鸽主："+(r.owner || "未记录")+"）").join(" / ") || "暂无")+'</div>'
        + (claim ? '<div class="meta">认领案：'+claim.id+'（'+STATUS[claim.status]+'）'+claim.holder+' → '+claim.claimant+'</div>' : "")
        + '<div class="section"><label>父母档案（改动会让相关认领作废并重判）</label><div class="row"><input id="editFather" placeholder="父鸽足环号" value="'+(p.fatherRing || "")+'"><input id="editMother" placeholder="母鸽足环号" value="'+(p.motherRing || "")+'"><button id="savePedigree">保存血统</button></div></div>';
      document.querySelector("#savePedigree").onclick = async () => {
        try {
          const res = await api('/api/pigeons/'+encodeURIComponent(p.ringNo)+'/pedigree', { method:'PUT', body: JSON.stringify({ fatherRing: document.querySelector("#editFather").value, motherRing: document.querySelector("#editMother").value }) });
          say(res.claim ? "血统已保存；认领案 "+res.claim.id+" 重判结果："+STATUS[res.claim.status] : "血统已保存");
          await load(); await refreshDetail();
        } catch (e) { say(e.message); }
      };
    }
    function renderClaims() {
      claimPanel.innerHTML = '<h2>认领案卷</h2>' + (claims.length ? claims.map(c =>
        '<article class="card"><h3>'+c.id+' · '+c.ringNo+'</h3><span class="pill">'+STATUS[c.status]+'</span>'
        + '<div class="meta">现鸽主：'+c.holder+' · 认领人：'+c.claimant+'</div>'
        + '<div class="meta">见证材料：'+c.witness+'</div>'
        + '<div class="meta">确认：现鸽主 '+(c.confirmations.holder ? "✓" : "未确认")+' · 认领人 '+(c.confirmations.claimant ? "✓" : "未确认")+'</div>'
        + (c.status === "open" ? '<div class="row"><button data-confirm="'+c.id+'|'+c.holder+'">现鸽主确认</button><button data-confirm="'+c.id+'|'+c.claimant+'">认领人确认</button><button data-withdraw="'+c.id+'">撤回认领</button></div>' : "")
        + '<details><summary>流转记录</summary><div class="meta">'+c.history.map(h => h.at+' '+h.action+' '+(h.note || "")).join("<br>")+'</div></details>'
        + '</article>').join("") : '<p class="meta">暂无认领案。</p>');
      document.querySelectorAll("[data-confirm]").forEach(btn => btn.onclick = async () => {
        const [id, name] = btn.dataset.confirm.split("|");
        try {
          const c = await api('/api/claims/'+encodeURIComponent(id)+'/confirm', { method:'POST', body: JSON.stringify({ name }) });
          say(c.status === "closed" ? "双方确认完成，新归属已生效" : "已记录确认，等待另一方");
          await load(); await refreshDetail();
        } catch (e) { say(e.message); }
      });
      document.querySelectorAll("[data-withdraw]").forEach(btn => btn.onclick = async () => {
        try {
          const c = await api('/api/claims/'+encodeURIComponent(btn.dataset.withdraw)+'/withdraw', { method:'POST', body: "{}" });
          say(c.status === "void" ? "认领已撤回，案卷作废" : "撤回重判不成立，已回滚到首案状态");
          await load(); await refreshDetail();
        } catch (e) { say(e.message); }
      });
    }
    async function refreshDetail() {
      if (!lastRing) return;
      try { renderRelation(await api('/api/pigeons/'+encodeURIComponent(lastRing)+'/relation')); } catch (e) { /* 档案可能已不存在 */ }
    }
    async function load(){
      [pigeons, claims] = await Promise.all([api("/api/pigeons"), api("/api/claims")]);
      renderCards(); renderClaims();
    }
    document.querySelector("#searchBtn").onclick = async () => {
      lastRing = search.value.trim();
      try { renderRelation(await api('/api/pigeons/'+encodeURIComponent(lastRing)+'/relation')); say(""); } catch (e) { say(e.message); }
    };
    document.querySelector("#reload").onclick = async () => { await load(); await refreshDetail(); };
    form.onsubmit = async event => {
      event.preventDefault();
      try {
        await api("/api/pigeons", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        say(""); form.reset(); await load();
      } catch (e) { say(e.message); }
    };
    claimForm.onsubmit = async event => {
      event.preventDefault();
      try {
        const res = await api("/api/claims", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(claimForm).entries())) });
        say(res.deduped ? "该鸽已有未结认领，后来者只拿到首案编号："+res.claim.id
          : res.reopened ? "再次提交沿用首案 "+res.claim.id+"，已重新开庭"
          : "已立案 "+res.claim.id);
        claimForm.reset(); await load(); await refreshDetail();
      } catch (e) { say(e.message); }
    };
    renderRelation(null);
    load();
  </script>
</body>
</html>`;
