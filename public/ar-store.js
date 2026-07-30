// ar-store.js — AgentRoom Firestore 데이터 계층 (실시간)
import { db } from "./firebase-config.js";
import {
  collection, doc, addDoc, setDoc, getDoc, getDocs,
  updateDoc, deleteDoc, onSnapshot, query, where, orderBy, limit,
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
export async function createWorkspace(uid, name) {
  const ref = await addDoc(collection(db, "workspaces"), {
    name: name.slice(0, 80),
    ownerId: uid,
    memberIds: [uid],
    code: genInviteCode(),
    pin: genPin(),
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

// 기존 워크스페이스에 코드/비밀번호가 없으면 생성해서 채움
export async function ensureWorkspaceCode(wsId, existing) {
  let code = existing?.code, pin = existing?.pin;
  const patch = {};
  if (!code) { code = genInviteCode(); patch.code = code; }
  if (!pin) { pin = genPin(); patch.pin = pin; }
  if (Object.keys(patch).length) {
    try { await updateDoc(doc(db, "workspaces", wsId), patch); } catch (e) { console.warn(e); }
  }
  return { code, pin };
}

export async function joinWorkspace(uid, wsId) {
  const ref = doc(db, "workspaces", wsId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("존재하지 않는 워크스페이스입니다.");
  await updateDoc(ref, { memberIds: arrayUnion(uid) });
  return snap.data().name;
}

// 6자리 코드 + 4자리 비밀번호로 참여 (긴 ID 폴백 허용)
export async function joinByCode(uid, raw, pin) {
  const code = String(raw || "").trim();
  if (!code) throw new Error("코드를 입력하세요.");
  // 1) 6자리 코드로 조회
  const up = code.toUpperCase();
  const q = query(collection(db, "workspaces"), where("code", "==", up));
  const snap = await getDocs(q);
  if (!snap.empty) {
    const d = snap.docs[0];
    const data = d.data();
    if (data.pin && data.pin !== String(pin || "").trim()) {
      throw new Error("비밀번호(4자리)가 맞지 않아요.");
    }
    await updateDoc(doc(db, "workspaces", d.id), { memberIds: arrayUnion(uid) });
    return data.name;
  }
  // 2) 긴 워크스페이스 ID로 폴백
  return joinWorkspace(uid, code);
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
  await addDoc(collection(db, "workspaces", wsId, "channels", chId, "messages"), {
    senderId: msg.senderId,
    senderType: msg.senderType, // 'user' | 'agent'
    senderName: msg.senderName,
    content: msg.content,
    mentions: msg.mentions || [],
    reactions: 0,
    agentId: msg.agentId || null,
    ...(msg.image ? { image: msg.image } : {}),
    createdAt: serverTimestamp(),
  });
}

export async function deleteMessage(wsId, chId, msgId) {
  await deleteDoc(doc(db, "workspaces", wsId, "channels", chId, "messages", msgId));
}

export function listenMessages(wsId, chId, cb) {
  const q = query(
    collection(db, "workspaces", wsId, "channels", chId, "messages"),
    orderBy("createdAt", "asc"), limit(200)
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

// ---------- 에이전트 메모리(셀프러닝) ----------
export async function addMemory(wsId, agentId, { content, sourceChannelId, importance = 0.6 }) {
  await addDoc(collection(db, "workspaces", wsId, "agents", agentId, "memories"), {
    content: content.slice(0, 500),
    sourceChannelId: sourceChannelId || null,
    importance,
    createdAt: serverTimestamp(),
  });
}

export function listenMemories(wsId, agentId, cb) {
  const q = query(
    collection(db, "workspaces", wsId, "agents", agentId, "memories"),
    orderBy("createdAt", "desc"), limit(50)
  );
  return watch(q, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
}

// 컨텍스트 주입용: 최근 메모리 top-K (1회성 조회)
export async function fetchTopMemories(wsId, agentId, k = 6) {
  const q = query(
    collection(db, "workspaces", wsId, "agents", agentId, "memories"),
    orderBy("createdAt", "desc"), limit(k)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data().content);
}
