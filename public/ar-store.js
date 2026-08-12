// ar-store.js — AgentRoom Firestore 데이터 계층 (실시간)
import { db } from "./firebase-config.js";
import {
  collection, doc, addDoc, setDoc, getDoc, getDocs,
  updateDoc, deleteDoc, onSnapshot, query, where, orderBy, limit, limitToLast,
  serverTimestamp, arrayUnion, arrayRemove, increment,
} from "https://www.gstatic.com/firebasejs/12.3.0/firebase-firestore.js";

// 실시간 구독 헬퍼: 방금 생성한 상위 문서를 규칙 get()이 아직 못 보는
// 일시적 permission-denied 레이스를 자동 재시도로 흡수한다.
function watch(ref, onData) {
  let stopped = false, unsub = null, tries = 0;
  const attach = () => {
    unsub = onSnapshot(
      ref,
      (snap) => { tries = 0; onData(snap); },
      (err) => {
        if (stopped) return;
        if ((err.code === "permission-denied" || err.code === "unavailable") && tries < 5) {
          tries++;
          setTimeout(() => { if (!stopped) attach(); }, 400 * tries);
        } else {
          console.warn("[AgentRoom] snapshot error:", err.code, err.message);
        }
      }
    );
  };
  attach();
  return () => { stopped = true; if (unsub) unsub(); };
}

// ---------- 사용자 ----------
export async function ensureUserDoc(user, displayName) {
  const ref = doc(db, "users", user.uid);
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        uid: user.uid,
        email: user.email,
        displayName: (displayName || user.email.split("@")[0]).slice(0, 100),
        createdAt: serverTimestamp(),
      });
      return { avatarEmoji: "" };
    }
    return { avatarEmoji: snap.data().avatarEmoji || "" };
  } catch (err) {
    console.warn("[AgentRoom] ensureUserDoc:", err.code || err.message);
    return { avatarEmoji: "" };
  }
}

// 전역 프로필 이모지(내 users 문서)
export async function setGlobalAvatar(uid, emoji) {
  try { await updateDoc(doc(db, "users", uid), { avatarEmoji: (emoji || "").slice(0, 8) }); } catch (e) { console.warn(e); }
}

// 6자리 초대코드 (특수문자 없음 — 대문자+숫자만, 혼동 문자 IO01 제외)
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function genInviteCode() {
  let c = "";
  for (let i = 0; i < 6; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}
// 4자리 방 비밀번호
export function genPin() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, "0");
}

// ---------- 워크스페이스 ----------
// 초대 비밀: 문서 ID 자체가 "CODE-PIN" (규칙이 해시를 계산할 수 없으므로
// 문서 ID를 비밀로 쓴다. get만 허용·list 금지 → 열거 불가)
export function inviteSecret(code, pin) {
  return `${String(code || "").trim().toUpperCase()}-${String(pin || "").trim()}`;
}

// 초대 문서 생성 — 내용에는 비밀을 담지 않는다(wsId/이름만)
async function writeInvite(secret, wsId, wsName) {
  await setDoc(doc(db, "invites", secret), {
    wsId,
    wsName: String(wsName || "").slice(0, 80),
    createdAt: serverTimestamp(),
  });
}

export async function createWorkspace(uid, name) {
  const wsName = name.slice(0, 80);
  const code = genInviteCode(), pin = genPin();
  const ref = await addDoc(collection(db, "workspaces"), {
    name: wsName,
    ownerId: uid,
    memberIds: [uid],
    code,
    pin,
    createdAt: serverTimestamp(),
  });
  // 초대 문서도 함께 생성 (없으면 코드 참여 불가)
  await writeInvite(inviteSecret(code, pin), ref.id, wsName);
  return ref.id;
}

// 기존 워크스페이스에 코드/비밀번호가 없으면 생성하고, 초대 문서도 보장한다
export async function ensureWorkspaceCode(wsId, existing) {
  let code = existing?.code, pin = existing?.pin;
  const patch = {};
  if (!code) { code = genInviteCode(); patch.code = code; }
  if (!pin) { pin = genPin(); patch.pin = pin; }
  if (Object.keys(patch).length) {
    try { await updateDoc(doc(db, "workspaces", wsId), patch); } catch (e) { console.warn(e); }
  }
  // 초대 문서 없으면(구 데이터 마이그레이션) 생성
  const secret = inviteSecret(code, pin);
  try {
    const inv = await getDoc(doc(db, "invites", secret));
    if (!inv.exists()) await writeInvite(secret, wsId, existing?.name);
  } catch (e) { console.warn("[AgentRoom] ensureInvite:", e.code || e.message); }
  return { code, pin };
}

// 6자리 코드 + 4자리 비밀번호로 참여
// 규칙이 exists(invites/{CODE-PIN})로 "둘 다 앎"을 검증하므로 joinSecret을 함께 쓴다.
export async function joinByCode(uid, rawCode, rawPin) {
  const code = String(rawCode || "").trim().toUpperCase();
  const pin = String(rawPin || "").trim();
  if (!code) throw new Error("초대코드를 입력하세요.");
  if (!pin) throw new Error("방 비밀번호(4자리)를 입력하세요.");

  const secret = inviteSecret(code, pin);
  let inv;
  try {
    inv = await getDoc(doc(db, "invites", secret));
  } catch (e) {
    throw new Error("초대 확인에 실패했어요. 잠시 후 다시 시도해 주세요.");
  }
  if (!inv.exists()) throw new Error("초대코드 또는 비밀번호가 올바르지 않아요.");

  const { wsId, wsName } = inv.data();
  await updateDoc(doc(db, "workspaces", wsId), {
    memberIds: arrayUnion(uid),
    joinSecret: secret, // 규칙이 이 값으로 초대 문서 존재를 검증
  });
  return wsName || "워크스페이스";
}

// ---------- 멤버 관리 ----------
// owner 전용 강퇴 (규칙 (d))
export async function kickMember(wsId, targetUid) {
  await updateDoc(doc(db, "workspaces", wsId), { memberIds: arrayRemove(targetUid) });
}
// 본인 탈퇴 (규칙 (c))
export async function leaveWorkspace(wsId, uid) {
  await updateDoc(doc(db, "workspaces", wsId), { memberIds: arrayRemove(uid) });
}

// ---------- 방 프로필(방별 이모지/닉네임) ----------
export async function setRoomProfile(wsId, uid, { emoji, displayName }) {
  await setDoc(doc(db, "workspaces", wsId, "profiles", uid), {
    emoji: (emoji || "").slice(0, 8),
    displayName: (displayName || "").slice(0, 40),
    updatedAt: serverTimestamp(),
  }, { merge: true });
}
export function listenRoomProfiles(wsId, cb) {
  return watch(collection(db, "workspaces", wsId, "profiles"), (snap) => {
    const map = {};
    snap.docs.forEach((d) => { map[d.id] = d.data(); });
    cb(map);
  });
}

export function listenWorkspaces(uid, cb) {
  const q = query(collection(db, "workspaces"), where("memberIds", "array-contains", uid));
  return watch(q, (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    list.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
    cb(list);
  });
}

// ---------- 채널 ----------
export async function createChannel(wsId, name, uid) {
  const ref = await addDoc(collection(db, "workspaces", wsId, "channels"), {
    name: name.replace(/^#/, "").slice(0, 60),
    createdBy: uid,
    agentIds: [],
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export function listenChannels(wsId, cb) {
  const q = query(collection(db, "workspaces", wsId, "channels"), orderBy("createdAt", "asc"));
  return watch(q, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
}

// ---------- 메시지 ----------
export async function sendMessage(wsId, chId, msg) {
  const ref = await addDoc(collection(db, "workspaces", wsId, "channels", chId, "messages"), {
    senderId: msg.senderId,
    senderType: msg.senderType, // 'user' | 'agent'
    senderName: msg.senderName,
    content: msg.content,
    mentions: msg.mentions || [],
    reactions: 0,
    agentId: msg.agentId || null,
    ...(msg.image ? { image: msg.image } : {}),
    ...(msg.sources && msg.sources.length ? { sources: msg.sources.slice(0, 3) } : {}),
    ...(msg.sourceKids && msg.sourceKids.length ? { sourceKids: msg.sourceKids.slice(0, 3) } : {}),
    createdAt: serverTimestamp(),
  });
  // 안읽음 배지용 — 채널의 마지막 활동 시각 (실패해도 메시지 전송엔 영향 없음)
  updateDoc(doc(db, "workspaces", wsId, "channels", chId), { lastMessageAt: serverTimestamp() }).catch(() => {});
  return ref;
}

// ---------- 안읽음 (채널별 마지막 확인 시각) ----------
export async function markChannelSeen(wsId, uid, chId) {
  try {
    await setDoc(doc(db, "workspaces", wsId, "reads", uid), { [chId]: serverTimestamp() }, { merge: true });
  } catch (_) {}
}
export function listenMyReads(wsId, uid, cb) {
  return onSnapshot(doc(db, "workspaces", wsId, "reads", uid),
    (snap) => cb(snap.exists() ? snap.data() : {}), () => cb({}));
}

// 🧠 승격 5초 되돌리기용
export async function unmarkMessagePromoted(wsId, chId, msgId) {
  await updateDoc(doc(db, "workspaces", wsId, "channels", chId, "messages", msgId), { promotedToMemory: false });
}

// 각주 출처 점프용 — 지식 1건 조회
export async function getKnowledge(wsId, kid) {
  const snap = await getDoc(doc(db, "workspaces", wsId, "knowledge", kid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function deleteMessage(wsId, chId, msgId) {
  await deleteDoc(doc(db, "workspaces", wsId, "channels", chId, "messages", msgId));
}

export function listenMessages(wsId, chId, cb) {
  // limitToLast: '최신 200개'를 구독 — limit(asc)이면 가장 오래된 200개에 갇혀
  // 201번째부터 새 메시지가 영영 안 보이는 치명 버그가 됨
  const q = query(
    collection(db, "workspaces", wsId, "channels", chId, "messages"),
    orderBy("createdAt", "asc"), limitToLast(200)
  );
  return watch(q, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
}

export async function praiseMessage(wsId, chId, msgId) {
  await updateDoc(doc(db, "workspaces", wsId, "channels", chId, "messages", msgId), {
    reactions: increment(1),
  });
}

// ---------- 에이전트 ----------
export async function createAgent(wsId, uid, { name, persona, hue, tone, verbosity }) {
  const ref = await addDoc(collection(db, "workspaces", wsId, "agents"), {
    name: name.slice(0, 40),
    persona: (persona || "").slice(0, 2000),
    hue: hue ?? 265,
    tone: (tone || "").slice(0, 120),
    verbosity: verbosity || "보통",
    createdBy: uid,
    exp: 0,
    level: 1,
    knowledgeCount: 0,
    answerCount: 0,
    channelIds: [],
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export function listenAgents(wsId, cb) {
  const q = query(collection(db, "workspaces", wsId, "agents"), orderBy("createdAt", "asc"));
  return watch(q, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
}

export async function getAgent(wsId, agentId) {
  const snap = await getDoc(doc(db, "workspaces", wsId, "agents", agentId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function updateAgent(wsId, agentId, patch) {
  await updateDoc(doc(db, "workspaces", wsId, "agents", agentId), patch);
}

export async function deleteAgent(wsId, agentId, channelIds = []) {
  for (const chId of channelIds) {
    try { await updateDoc(doc(db, "workspaces", wsId, "channels", chId), { agentIds: arrayRemove(agentId) }); } catch (_) {}
  }
  await deleteDoc(doc(db, "workspaces", wsId, "agents", agentId));
}

// 채널 자율개입 on/off
export async function setChannelAuto(wsId, chId, on) {
  await updateDoc(doc(db, "workspaces", wsId, "channels", chId), { autoIntervene: !!on });
}

// 맥락 압축 카드 / 회의 결론 카드(시스템 메시지)
export async function addSummaryCard(wsId, chId, payload, kind = "summary") {
  await addDoc(collection(db, "workspaces", wsId, "channels", chId, "messages"), {
    senderId: "system", senderType: "system",
    senderName: kind === "meeting" ? "🤝 회의 결론" : "🧵 맥락 요약",
    kind, content: JSON.stringify(payload),
    mentions: [], reactions: 0, agentId: null, createdAt: serverTimestamp(),
  });
}

// 시각화 카드(mermaid 다이어그램)
export async function addDiagramCard(wsId, chId, payload) {
  await addDoc(collection(db, "workspaces", wsId, "channels", chId, "messages"), {
    senderId: "system", senderType: "system", senderName: "📊 시각화",
    kind: "diagram", content: JSON.stringify(payload),
    mentions: [], reactions: 0, agentId: null, createdAt: serverTimestamp(),
  });
}

// 범용 산출물 카드(계획/SWOT/피치/캔버스/할일/브레인스토밍/결정 등)
export async function addDocCard(wsId, chId, payload) {
  await addDoc(collection(db, "workspaces", wsId, "channels", chId, "messages"), {
    senderId: "system", senderType: "system",
    senderName: `${payload.emoji || "📋"} ${payload.title || ""}`.slice(0, 60),
    kind: "doc", content: JSON.stringify(payload),
    mentions: [], reactions: 0, agentId: null, createdAt: serverTimestamp(),
  });
}

// 평가 카드(에이전트 채점)
export async function addScoreCard(wsId, chId, payload) {
  await addDoc(collection(db, "workspaces", wsId, "channels", chId, "messages"), {
    senderId: "system", senderType: "system", senderName: "⭐ 평가",
    kind: "scores", content: JSON.stringify(payload),
    mentions: [], reactions: 0, agentId: null, createdAt: serverTimestamp(),
  });
}

export async function addAgentToChannel(wsId, chId, agentId) {
  await updateDoc(doc(db, "workspaces", wsId, "channels", chId), { agentIds: arrayUnion(agentId) });
  await updateDoc(doc(db, "workspaces", wsId, "agents", agentId), { channelIds: arrayUnion(chId) });
}

export async function removeAgentFromChannel(wsId, chId, agentId) {
  await updateDoc(doc(db, "workspaces", wsId, "channels", chId), { agentIds: arrayRemove(agentId) });
  await updateDoc(doc(db, "workspaces", wsId, "agents", agentId), { channelIds: arrayRemove(chId) });
}

// 성장 반영: exp/knowledge/answer 증가 + 레벨 갱신
export async function applyGrowth(wsId, agentId, { expDelta = 0, knowledgeDelta = 0, answerDelta = 0, newLevel }) {
  const patch = {};
  if (expDelta) patch.exp = increment(expDelta);
  if (knowledgeDelta) patch.knowledgeCount = increment(knowledgeDelta);
  if (answerDelta) patch.answerCount = increment(answerDelta);
  if (newLevel != null) patch.level = newLevel;
  if (Object.keys(patch).length) {
    await updateDoc(doc(db, "workspaces", wsId, "agents", agentId), patch);
  }
}

// ===============================================================
// 공동 기억력 (LLM wiki) — workspaces/{ws}/knowledge
// ---------------------------------------------------------------
// 에이전트별 사본이 아니라 워크스페이스 하나의 지식 저장소를 모든
// 에이전트가 함께 읽는다. 새로 합류한 에이전트도 과거 지식을 즉시 얻는다.
// 워크스페이스 전체 공유이므로, 개인정보는 저장 시점에 마스킹한다.
// ===============================================================

// 개인정보 마스킹 — 저장 전에 구조화된 PII를 가린다(한국 포맷 우선)
const PII_RULES = [
  { kind: "주민번호", re: /\b(\d{6})[-\s]?([1-4]\d{6})\b/g, to: (m, a) => `${a}-●●●●●●●` },
  { kind: "카드번호", re: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, to: () => "●●●●-●●●●-●●●●-●●●●" },
  { kind: "전화번호", re: /\b(01[016-9])[-\s]?(\d{3,4})[-\s]?(\d{4})\b/g, to: (m, a) => `${a}-●●●●-●●●●` },
  { kind: "전화번호", re: /\b(0\d{1,2})[-\s](\d{3,4})[-\s](\d{4})\b/g, to: (m, a) => `${a}-●●●-●●●●` },
  { kind: "이메일", re: /\b([\w.+-]{1,2})[\w.+-]*@([\w-]+\.[\w.]+)\b/g, to: (m, a, b) => `${a}●●●@${b}` },
  { kind: "계좌번호", re: /(계좌|입금|송금|은행)([^\d\n]{0,10})(\d[\d-]{8,})/g, to: (m, a, b) => `${a}${b}●●●●●●●●` },
  { kind: "여권번호", re: /\b([A-Z])\d{8}\b/g, to: (m, a) => `${a}●●●●●●●●` },
];
export function maskPII(text) {
  let out = String(text || ""), kinds = [];
  for (const r of PII_RULES) {
    r.re.lastIndex = 0;
    if (r.re.test(out)) {
      r.re.lastIndex = 0;
      out = out.replace(r.re, r.to);
      if (!kinds.includes(r.kind)) kinds.push(r.kind);
    }
  }
  return { text: out, masked: kinds.length > 0, kinds };
}

// 공동 지식 추가 (자동 학습 / 🧠 승격 공용)
export async function addKnowledge(wsId, { content, promoted = false, sourceChannelId, sourceAgentId, sourceAgentName, sourceMessageId, learnedFrom, promotedBy }) {
  const m = maskPII(content);
  return addDoc(collection(db, "workspaces", wsId, "knowledge"), {
    content: m.text.slice(0, 800),
    promoted: !!promoted,
    masked: m.masked,
    ...(m.masked ? { maskedKinds: m.kinds } : {}),
    sourceChannelId: sourceChannelId || null,
    sourceAgentId: sourceAgentId || null,
    sourceAgentName: sourceAgentName || null,
    sourceMessageId: sourceMessageId || null,
    learnedFrom: learnedFrom || null,
    ...(promotedBy ? { promotedBy } : {}),
    createdAt: serverTimestamp(),
  });
}

export function listenKnowledge(wsId, cb) {
  const q = query(collection(db, "workspaces", wsId, "knowledge"), orderBy("createdAt", "desc"), limit(60));
  return watch(q, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
}

export async function promoteKnowledge(wsId, kid, uid) {
  await updateDoc(doc(db, "workspaces", wsId, "knowledge", kid), {
    promoted: true, ...(uid ? { promotedBy: uid } : {}),
  });
}
export async function deleteKnowledge(wsId, kid) {
  await deleteDoc(doc(db, "workspaces", wsId, "knowledge", kid));
}

// 기존 에이전트별 memories → 공동 knowledge 로 1회 이관(중복 방지)
export async function migrateMemoriesToKnowledge(wsId) {
  const existing = await getDocs(collection(db, "workspaces", wsId, "knowledge"));
  const seen = new Set(existing.docs.map((d) => d.data().content));
  const agents = await getDocs(collection(db, "workspaces", wsId, "agents"));
  let moved = 0;
  for (const a of agents.docs) {
    const mems = await getDocs(collection(db, "workspaces", wsId, "agents", a.id, "memories"));
    for (const m of mems.docs) {
      const d = m.data();
      if (seen.has(d.content)) continue;
      seen.add(d.content);
      await addKnowledge(wsId, {
        content: d.content, promoted: !!d.promoted,
        sourceChannelId: d.sourceChannelId, sourceAgentId: a.id,
        sourceAgentName: a.data().name, promotedBy: d.promotedBy,
      });
      moved++;
    }
  }
  return moved;
}

// ---------- 에이전트 메모리(레거시 · 이관 원본 보존용) ----------
// promoted=true: 팀이 명시적으로 승격한 기억 — 답변 컨텍스트에 우선 주입된다.
export async function addMemory(wsId, agentId, { content, sourceChannelId, importance = 0.6, promoted = false, promotedBy = null }) {
  await addDoc(collection(db, "workspaces", wsId, "agents", agentId, "memories"), {
    content: content.slice(0, 500),
    sourceChannelId: sourceChannelId || null,
    importance,
    promoted: !!promoted,
    ...(promotedBy ? { promotedBy } : {}),
    createdAt: serverTimestamp(),
  });
}

export async function promoteMemory(wsId, agentId, memId, uid) {
  await updateDoc(doc(db, "workspaces", wsId, "agents", agentId, "memories", memId), {
    promoted: true, importance: 1, ...(uid ? { promotedBy: uid } : {}),
  });
}

export async function deleteMemory(wsId, agentId, memId) {
  await deleteDoc(doc(db, "workspaces", wsId, "agents", agentId, "memories", memId));
}

// 메시지를 팀 기억으로 승격했음을 표시(🧠 버튼 상태용)
export async function markMessagePromoted(wsId, chId, msgId) {
  await updateDoc(doc(db, "workspaces", wsId, "channels", chId, "messages", msgId), { promotedToMemory: true });
}

export function listenMemories(wsId, agentId, cb) {
  const q = query(
    collection(db, "workspaces", wsId, "agents", agentId, "memories"),
    orderBy("createdAt", "desc"), limit(50)
  );
  return watch(q, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
}

// ===============================================================
// 질문-연관 기억 회수 (전문가 패널 합의안 반영)
// ---------------------------------------------------------------
// 한국어는 조사 탓에 어절 매칭이 깨지므로(배포가/배포를) 음절 bigram으로
// 흡수한다. 임계값 미달이면 승격·최신이어도 주입하지 않는다 — 무관 기억의
// 프롬프트 오염이 flash급 모델 환각의 1순위 원인이기 때문.
// ===============================================================

// 한글은 음절 bigram, 영문/숫자는 토큰 통째로
export function tokenizeGrams(text) {
  const grams = new Set();
  const norm = String(text || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
  for (const w of norm.split(/\s+/)) {
    if (!w) continue;
    if (/[가-힣]/.test(w)) {
      if (w.length === 1) grams.add(w);
      for (let i = 0; i < w.length - 1; i++) grams.add(w.slice(i, i + 2));
    } else if (w.length > 1) grams.add(w);
  }
  return grams;
}

// 골든셋 20문항 그리드서치 결과(2026-08-12): 0.06→0.12로 상향 시 p@1 78→83%
// (recall@4 94%·무관질문 차단 100% 유지). 근거: docs/goldenset.md
const RELEVANCE_GATE = 0.12;
const RECENCY_HALF_LIFE_DAYS = 14;

/**
 * 컨텍스트 주입용 top-K — 워크스페이스 공동 지식에서 질문 연관도로 뽑는다.
 * score = 0.65*연관도(IDF 가중 bigram 겹침) + 0.20*최근성 + 0.15*승격
 * @returns {{texts:string[], meta:{ids:string[], scores:number[], topScore:number, miss:boolean, poolSize:number, mode:string}}}
 */
export async function fetchTopMemories(wsId, agentId, k = 6, queryText = "") {
  const q = query(
    collection(db, "workspaces", wsId, "knowledge"),
    orderBy("createdAt", "desc"), limit(100)
  );
  const snap = await getDocs(q);
  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const fmt = (m) => (m.promoted ? "[팀 승격] " : "") + m.content;

  // 질문이 없으면(레거시 호출) 기존 동작: 승격 우선 → 최신
  const qGrams = tokenizeGrams(queryText);
  if (!qGrams.size) {
    const pick = [...all.filter((m) => m.promoted), ...all.filter((m) => !m.promoted)].slice(0, k);
    return { texts: pick.map(fmt), meta: { ids: pick.map((m) => m.id), scores: [], topScore: 0, miss: false, poolSize: all.length, mode: "recency" } };
  }

  // IDF-lite: 후보 풀 안에서 각 gram의 문서빈도 → "회의","팀" 같은 범용 gram 기여 축소
  const docGrams = all.map((m) => tokenizeGrams(m.content));
  const df = new Map();
  for (const g of docGrams) for (const t of g) df.set(t, (df.get(t) || 0) + 1);
  const N = Math.max(1, all.length);
  const idf = (t) => Math.log(1 + N / (df.get(t) || 1));

  let qWeight = 0;
  for (const t of qGrams) qWeight += idf(t);

  const now = Date.now();
  const scored = all.map((m, i) => {
    // 부패 루프: 👎 누적(trust ≤ -2) 지식은 회수 자체에서 제외 — 자신 있게 틀리는 퇴화 방지
    if ((m.trust || 0) <= -2) return { m, rel: 0, score: -1 };
    let hit = 0;
    for (const t of qGrams) if (docGrams[i].has(t)) hit += idf(t);
    const rel = qWeight ? hit / qWeight : 0;
    const ageDays = m.createdAt?.seconds ? (now - m.createdAt.seconds * 1000) / 86400000 : 0;
    const rec = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
    const trustAdj = 0.05 * Math.max(-1, Math.min(3, m.trust || 0)); // 👍는 살짝 승급, 👎 1회는 살짝 강등
    const score = 0.65 * rel + 0.20 * rec + 0.15 * (m.promoted ? 1 : 0) + trustAdj;
    return { m, rel, score };
  });

  // 게이트: 연관도 미달은 후보에서 제외 — 억지로 k건 채우지 않는다
  const passed = scored.filter((s) => s.rel >= RELEVANCE_GATE).sort((a, b) => b.score - a.score);
  // 연관도 1위는 점수와 무관하게 보존(고연관-저최근 문서 보호)
  const bestRel = scored.reduce((a, b) => (b.rel > a.rel ? b : a), scored[0]);
  if (bestRel && bestRel.rel >= RELEVANCE_GATE && !passed.includes(bestRel)) passed.unshift(bestRel);

  const pick = passed.slice(0, k);
  return {
    texts: pick.map((s) => fmt(s.m)),
    meta: {
      ids: pick.map((s) => s.m.id),
      scores: pick.map((s) => Math.round(s.rel * 1000) / 1000),
      topScore: pick.length ? pick[0].rel : 0,
      miss: pick.length === 0,          // 회수 실패 — 계측 대상
      poolSize: all.length,
      mode: "relevance",
    },
  };
}

// ---------- 계측 (agent_answer 이벤트 1종) ----------
// precision@1 = citedTop1 / (injected>0), TTA = ts→feedbackTs, miss율 등을 이 로그에서 산출
export async function logAnswerMetric(wsId, data) {
  try {
    await addDoc(collection(db, "workspaces", wsId, "metrics"), {
      type: "agent_answer", ts: serverTimestamp(),
      thumbsUp: null, feedbackTs: null,
      ...data,
    });
  } catch (e) { console.warn("metric log 실패(무시):", e.message); }
}

// 👍/👎 시 해당 답변의 metric에 피드백 기록 (msgId로 조인) +
// 그 답변에 인용된 지식의 신뢰도(trust)를 올리거나 내린다.
// "기억 시스템의 어려움은 쓰기가 아니라 잊기" — 👎가 쌓인 지식은 회수에서 강등된다.
export async function attachFeedback(wsId, msgId, up = true) {
  try {
    const snap = await getDocs(query(
      collection(db, "workspaces", wsId, "metrics"),
      where("msgId", "==", msgId), limit(1)
    ));
    if (snap.empty) return;
    await updateDoc(snap.docs[0].ref, { thumbsUp: up, feedbackTs: serverTimestamp() });
    const cited = snap.docs[0].data().citedIds || [];
    for (const kid of cited) {
      try {
        await updateDoc(doc(db, "workspaces", wsId, "knowledge", kid), { trust: increment(up ? 1 : -1) });
      } catch (_) {} // 삭제된 지식이면 무시
    }
  } catch (e) { console.warn("feedback 기록 실패(무시):", e.message); }
}

// 최근 7일 지표 집계 — /metrics 카드용
export async function fetchMetricsSummary(wsId) {
  const since = new Date(Date.now() - 7 * 86400000);
  const snap = await getDocs(query(
    collection(db, "workspaces", wsId, "metrics"),
    orderBy("ts", "desc"), limit(300)
  ));
  const rows = snap.docs.map((d) => d.data())
    .filter((r) => r.ts?.seconds && r.ts.seconds * 1000 >= since.getTime());
  const n = rows.length;
  const injected = rows.filter((r) => (r.injectedCount || 0) > 0);
  const cited1 = injected.filter((r) => r.citedTop1).length;
  const up = rows.filter((r) => r.thumbsUp === true);
  const miss = rows.filter((r) => r.retrievalMiss).length;
  const ttas = up.filter((r) => r.feedbackTs?.seconds).map((r) => r.feedbackTs.seconds - r.ts.seconds).sort((a, b) => a - b);
  return {
    answers: n,
    thumbsUpRate: n ? up.length / n : 0,
    precisionAt1: injected.length ? cited1 / injected.length : null,
    missRate: n ? miss / n : 0,
    medianTTAsec: ttas.length ? ttas[Math.floor(ttas.length / 2)] : null,
    avgLatencyMs: n ? Math.round(rows.reduce((a, r) => a + (r.latencyMs || 0), 0) / n) : 0,
  };
}
