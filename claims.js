// 认领裁决：认领案状态机、双方确认结案、作废重判与回滚。
// 本模块只裁决内存中的 db，不写盘；档案保存见 store.js，页面入口见 page.js。

const today = () => new Date().toISOString().slice(0, 10);

export class ClaimError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code) => { throw new ClaimError(status, code); };

export function findPigeon(db, ringNo) {
  return db.pigeons.find(item => item.ringNo === ringNo) || null;
}
// 一只鸽只挂一笔未结认领
export function openClaimFor(db, ringNo) {
  return db.claims.find(item => item.ringNo === ringNo && item.status === "open") || null;
}
export function claimById(db, id) {
  return db.claims.find(item => item.id === id) || null;
}

function nextClaimId(db) {
  const max = db.claims.reduce((n, item) => Math.max(n, Number(String(item.id).replace(/\D/g, "")) || 0), 0);
  return `CLM-${String(max + 1).padStart(4, "0")}`;
}

function log(kase, action, note) {
  kase.history.push({ at: today(), action, note });
  kase.updatedAt = today();
}

// 拾获登记并提交认领：足环、现鸽主（拾获保管人）、见证材料、认领人。
// 已有未结案时后来者只拿到首案编号；已结案不再受理；已作废的首案再次提交时沿用该案重开。
export function submitClaim(db, input) {
  const { ringNo, holder, witness, claimant } = input;
  if (!ringNo || !holder || !witness || !claimant) fail(400, "missing_fields");
  const pigeon = findPigeon(db, ringNo);
  if (!pigeon) fail(404, "pigeon_not_found");

  const existing = db.claims.find(item => item.ringNo === ringNo) || null;
  if (existing) {
    if (existing.status === "open") return { claim: existing, deduped: true };
    if (existing.status === "closed") fail(409, "case_closed");
    existing.status = "open";
    existing.holder = holder;
    existing.witness = witness;
    existing.claimant = claimant;
    existing.confirmations = { holder: false, claimant: false };
    existing.pedigreeSnapshot = { fatherRing: pigeon.fatherRing || "", motherRing: pigeon.motherRing || "" };
    log(existing, "reopened", "作废后再次提交，沿用首案重开");
    return { claim: existing, reopened: true };
  }

  const claim = {
    id: nextClaimId(db),
    ringNo,
    holder,
    witness,
    claimant,
    status: "open",
    confirmations: { holder: false, claimant: false },
    pedigreeSnapshot: { fatherRing: pigeon.fatherRing || "", motherRing: pigeon.motherRing || "" },
    history: [],
    createdAt: today(),
    updatedAt: today(),
    closedAt: ""
  };
  log(claim, "created", "拾获登记并提交认领");
  db.claims.push(claim);
  return { claim, created: true };
}

// 双方确认：现鸽主与认领人各确认一次，齐全后结案，新归属生效并记一笔“认领结案”转让。
// 往期名次不动，仍归比赛当天鸽主。
export function confirmClaim(db, id, name) {
  const kase = claimById(db, id);
  if (!kase) fail(404, "claim_not_found");
  if (kase.status !== "open") fail(409, "case_not_open");
  if (!name || (name !== kase.holder && name !== kase.claimant)) fail(403, "party_mismatch");

  const roles = name === kase.holder && name === kase.claimant
    ? ["holder", "claimant"]
    : [name === kase.holder ? "holder" : "claimant"];
  for (const role of roles) {
    if (!kase.confirmations[role]) {
      kase.confirmations[role] = true;
      log(kase, `confirm_${role}`, `${name} 确认`);
    }
  }
  if (kase.confirmations.holder && kase.confirmations.claimant) {
    const pigeon = findPigeon(db, kase.ringNo);
    kase.status = "closed";
    kase.closedAt = today();
    pigeon.transfers.push({ date: today(), from: pigeon.owner, to: kase.claimant, reason: "认领结案", claimId: kase.id });
    pigeon.owner = kase.claimant;
    log(kase, "closed", "双方确认，新归属生效");
  }
  return kase;
}

// 重判：作废理由是否成立。成立返回 true（案卷作废），不成立返回 false（回滚到首案状态）。
function rejudge(db, kase, reason) {
  if (reason === "withdrawn") {
    // 现鸽主已确认即认领获保管方认可，单方撤回不成立
    return !kase.confirmations.holder;
  }
  if (reason === "pedigree_changed") {
    // 父母档案与立案快照不一致，认领所依据的血统已变，作废成立
    const pigeon = findPigeon(db, kase.ringNo);
    return Boolean(pigeon)
      && (pigeon.fatherRing !== kase.pedigreeSnapshot.fatherRing
        || pigeon.motherRing !== kase.pedigreeSnapshot.motherRing);
  }
  return false;
}

function voidAndRejudge(db, kase, reason, note) {
  if (rejudge(db, kase, reason)) {
    kase.status = "void";
    log(kase, "voided", note);
  } else {
    log(kase, "rollback", `${note}：重判不成立，回滚到首案状态`);
  }
  return kase;
}

// 认领人撤回：作废并重判
export function withdrawClaim(db, id) {
  const kase = claimById(db, id);
  if (!kase) fail(404, "claim_not_found");
  if (kase.status !== "open") fail(409, "case_not_open");
  return voidAndRejudge(db, kase, "withdrawn", "认领人撤回");
}

// 父母档案改动：相关未结认领作废并重判
export function rejudgeForPedigree(db, ringNo) {
  const kase = openClaimFor(db, ringNo);
  if (!kase) return null;
  return voidAndRejudge(db, kase, "pedigree_changed", "父母档案改动");
}
