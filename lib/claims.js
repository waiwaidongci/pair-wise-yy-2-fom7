// 认领裁决：失鸽找回认领的状态机与判定规则。
// 与持久化（store）和页面入口（server）分开维护，所有规则都在这里。
//
// 案件状态：
//   pending    审理中（未结）—— 一只鸽同时只能有一笔未结认领
//   settled    已结案 —— 双方确认后新归属生效，不得再转让/报名
//   withdrawn  已作废 —— 撤回或被父母档案改动作废，可在再次提交时沿用原案号重判
//
// 轮次 round：首案为 1。作废后重判轮次 +1，案号（首案编号）始终不变。

export const PARTIES = ["owner", "finder"]; // 鸽主 / 拾获人（现鸽主）
export const PARTY_LABEL = { owner: "鸽主", finder: "拾获人" };

export class HttpError extends Error {
  constructor(status, error, extra = {}) {
    super(error);
    this.status = status;
    this.error = error;
    for (const [k, v] of Object.entries(extra)) this[k] = v;
  }
}

function now() { return new Date().toISOString(); }
function today() { return new Date().toISOString().slice(0, 10); }

function nextCaseNo(db) {
  db.claimSeq += 1;
  return "CLAIM-" + String(db.claimSeq).padStart(4, "0");
}

function findPigeon(db, ringNo) {
  const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
  if (!pigeon) throw new HttpError(404, "pigeon_not_found");
  return pigeon;
}

function findClaim(db, caseNo) {
  const claim = db.claims.find(item => item.caseNo === caseNo);
  if (!claim) throw new HttpError(404, "claim_not_found");
  return claim;
}

// 取该鸽当前「生效中」的案件：未结优先，否则取最近一笔。
function activeClaim(db, ringNo) {
  const list = db.claims
    .filter(item => item.ringNo === ringNo)
    .sort((a, b) => (b.round - a.round) || String(b.createdAt).localeCompare(String(a.createdAt)));
  return list.find(item => item.status === "pending") || list[0] || null;
}

function addHistory(claim, action, by, detail) {
  claim.history.push({ at: now(), action, by: by || "", detail: detail || null });
}

function freshConfirmations() {
  return { owner: false, finder: false };
}

// 结案：新归属生效。只有双方都确认后才调用。
function settle(db, claim) {
  const pigeon = findPigeon(db, claim.ringNo);
  const from = pigeon.owner;
  pigeon.owner = claim.finder;
  pigeon.transfers.push({
    date: today(),
    from,
    to: claim.finder,
    reason: "认领结案",
    caseNo: claim.caseNo
  });
  claim.status = "settled";
  claim.settledAt = now();
  addHistory(claim, "settled", "", { from, to: claim.finder });
  return { from, to: claim.finder };
}

// 拾获登记。并发/重复提交幂等：
//   已有未结案件 → 直接返回首案编号（后来者不另立一案）；
//   案件已作废   → 沿用原案号重判（轮次 +1）；
//   已结案或无案 → 立新案。
export function registerClaim(db, input) {
  const ringNo = String(input.ringNo || "").trim();
  const finder = String(input.finder || "").trim();
  if (!ringNo) throw new HttpError(400, "ring_no_required");
  if (!finder) throw new HttpError(400, "finder_required");
  findPigeon(db, ringNo); // 校验鸽只存在
  const materials = Array.isArray(input.materials)
    ? input.materials.map(String).filter(Boolean)
    : (input.materials ? [String(input.materials)] : []);

  const existing = activeClaim(db, ringNo);
  if (existing && existing.status === "pending") {
    addHistory(existing, "register_reused", finder, { materials, round: existing.round });
    return { claim: existing, reused: true, caseNo: existing.caseNo };
  }
  if (existing && existing.status === "withdrawn") {
    existing.status = "pending";
    existing.round += 1;
    existing.confirmations = freshConfirmations();
    existing.ruling = null;
    existing.materials = materials.length ? materials : existing.materials;
    addHistory(existing, "reactivated", finder, { materials, round: existing.round });
    return { claim: existing, reused: true, caseNo: existing.caseNo };
  }

  const claim = {
    caseNo: nextCaseNo(db),
    ringNo,
    finder,
    materials,
    status: "pending",
    round: 1,
    confirmations: freshConfirmations(),
    ruling: null,
    createdAt: now(),
    settledAt: null,
    history: []
  };
  addHistory(claim, "registered", finder, { materials });
  db.claims.push(claim);
  return { claim, reused: false, caseNo: claim.caseNo };
}

// 鸽主 / 拾获人 确认。双方都确认后新归属才生效。
export function confirmClaim(db, caseNo, party) {
  const claim = findClaim(db, caseNo);
  if (claim.status !== "pending") throw new HttpError(409, "claim_not_open", { caseNo, status: claim.status });
  if (!PARTIES.includes(party)) throw new HttpError(400, "invalid_party", { valid: PARTIES });
  if (claim.confirmations[party]) {
    return { claim, settled: false, already: true };
  }
  claim.confirmations[party] = true;
  addHistory(claim, "confirmed", party, { party });
  let settled = false;
  if (claim.confirmations.owner && claim.confirmations.finder) {
    settle(db, claim);
    settled = true;
  }
  return { claim, settled };
}

// 撤回认领：案件作废，等待再次提交时沿用原案号重判。
export function withdrawClaim(db, caseNo, by) {
  const claim = findClaim(db, caseNo);
  if (claim.status !== "pending") throw new HttpError(409, "claim_not_open", { caseNo, status: claim.status });
  claim.status = "withdrawn";
  addHistory(claim, "withdrawn", by || "");
  return claim;
}

// 登记员裁决。
//   approve：双方已确认才结案（新归属生效），否则不允许裁决；
//   reject ：失败后回滚到首案状态（保留原案号、清空确认），可再次提交。
export function adjudicateClaim(db, caseNo, decision, by) {
  const claim = findClaim(db, caseNo);
  if (claim.status !== "pending") throw new HttpError(409, "claim_not_open", { caseNo, status: claim.status });
  if (decision === "approve") {
    if (!claim.confirmations.owner || !claim.confirmations.finder) {
      throw new HttpError(409, "awaiting_confirmation", {
        caseNo,
        confirmations: { ...claim.confirmations },
        message: "双方尚未确认，不能裁决结案"
      });
    }
    claim.ruling = "approved";
    addHistory(claim, "adjudicated", by || "", { decision });
    settle(db, claim);
    return { claim, settled: true };
  }
  if (decision === "reject") {
    claim.ruling = "rejected";
    claim.status = "pending"; // 回滚到首案状态
    claim.confirmations = freshConfirmations();
    addHistory(claim, "adjudicated", by || "", { decision, rollback: true });
    return { claim, settled: false, rolledBack: true };
  }
  throw new HttpError(400, "invalid_decision", { valid: ["approve", "reject"] });
}

// 父母档案改动：该鸽未结认领一律作废，旧轮确认清空、进入重判（轮次 +1）。
// 已结案的认领不再翻案。
export function voidClaimsForParentChange(db, pigeon) {
  let affected = 0;
  for (const claim of db.claims) {
    if (claim.ringNo !== pigeon.ringNo || claim.status !== "pending") continue;
    claim.round += 1;
    claim.confirmations = freshConfirmations();
    claim.ruling = null;
    addHistory(claim, "parent_changed", "", { reason: "父母档案改动，认领作废并重判", round: claim.round });
    affected += 1;
  }
  return affected;
}

// 结案前不能转让、不能报名：存在未结认领则拒绝。
export function assertClaimNotLocked(db, ringNo) {
  const claim = db.claims.find(item => item.ringNo === ringNo && item.status === "pending");
  if (claim) {
    throw new HttpError(409, "claim_open", {
      caseNo: claim.caseNo,
      message: "认领未结案，暂不能转让或报名"
    });
  }
}

export function listClaims(db) {
  return [...db.claims].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
