// ar-app.js — AgentRoom 메인 컨트롤러
import { auth } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js";
import * as store from "./ar-store.js";
import * as ai from "./ar-ai.js";
import * as exporter from "./ar-export.js";
import { EXP, levelForExp, levelInfo, progress } from "./ar-game.js";
import { drawPet, hueFrom } from "./ar-sprites.js";

// ---------- 상태 ----------
const state = {
  user: null,
  workspaces: [], currentWsId: null,
  channels: [], currentChId: null,
  agents: [], selectedAgentId: null,
  memories: [],
  messages: [],
  pending: [], // 응답 대기 중 에이전트 [{id,name,hue}]
  unsub: { ws: null, channels: null, agents: null, messages: null, memories: null, profiles: null },
  promptedCreate: false,
  roomProfiles: {}, // uid -> {emoji, displayName} (현재 방 기준)
  myAvatar: "",     // 내 전역 이모지 아바타
};

const HUES = [265, 210, 330, 150, 30, 190, 300, 100];
const AVATAR_PRESETS = ["😀", "😎", "🤓", "🦊", "🐱", "🐶", "🐼", "🐧", "🦄", "🐯", "🐸", "🐵", "🚀", "🔥", "⭐", "🌱", "🍀", "🎯", "💡", "👑"];
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// 이모지(서로게이트 쌍) 안전하게 첫 글자 추출 — charAt(0)은 이모지를 반쪽 내서 깨짐
const firstGrapheme = (s) => [...String(s ?? "").trim()][0] || "?";
// 방 프로필(이모지/닉네임) 우선, 없으면 이름 첫 글자
function avatarEmojiFor(uid) {
  const p = state.roomProfiles[uid];
  if (p && p.emoji) return p.emoji;
  if (uid === state.user?.uid && state.myAvatar) return state.myAvatar;
  return null;
}
function nameFor(uid, fallback) {
  const p = state.roomProfiles[uid];
  return (p && p.displayName) ? p.displayName : fallback;
}
function isMe(uid) { return uid && uid === state.user?.uid; }

function toast(msg, cls = "") {
  const t = document.createElement("div");
  t.className = "toast " + cls;
  t.textContent = msg;
  $("toaster").appendChild(t);
  setTimeout(() => t.remove(), cls === "levelup" ? 4200 : 2600);
}

function fmtTime(ts) {
  const d = ts && ts.seconds ? new Date(ts.seconds * 1000) : new Date();
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

// ======================= 인증 =======================
let authMode = "login";
let pendingDisplayName = null; // 회원가입 시 표시이름을 onAuthStateChanged로 전달
function setAuthMode(mode) {
  authMode = mode;
  $("tab-login").classList.toggle("is-active", mode === "login");
  $("tab-signup").classList.toggle("is-active", mode === "signup");
  $("name-field").hidden = mode !== "signup";
  $("au-submit").textContent = mode === "signup" ? "회원가입" : "로그인";
  $("au-pass").autocomplete = mode === "signup" ? "new-password" : "current-password";
  $("auth-msg").textContent = "";
}
$("tab-login").onclick = () => setAuthMode("login");
$("tab-signup").onclick = () => setAuthMode("signup");

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("au-email").value.trim();
  const pass = $("au-pass").value;
  const name = $("au-name").value.trim();
  const msg = $("auth-msg");
  msg.className = "auth-msg";
  msg.textContent = "처리 중…";
  $("au-submit").disabled = true;
  try {
    if (authMode === "signup") {
      pendingDisplayName = name || null;
      await createUserWithEmailAndPassword(auth, email, pass);
      // 사용자 문서 생성은 onAuthStateChanged가 단독으로 처리(레이스 방지)
    } else {
      await signInWithEmailAndPassword(auth, email, pass);
    }
  } catch (err) {
    msg.textContent = authError(err);
  } finally {
    $("au-submit").disabled = false;
  }
});

function authError(err) {
  const c = err?.code || "";
  if (c.includes("email-already-in-use")) return "이미 가입된 이메일입니다. 로그인해 주세요.";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "이메일 또는 비밀번호가 올바르지 않습니다.";
  if (c.includes("weak-password")) return "비밀번호는 6자 이상이어야 합니다.";
  if (c.includes("invalid-email")) return "이메일 형식이 올바르지 않습니다.";
  return "오류: " + (err?.message || c || "알 수 없음");
}

$("logout-btn").onclick = () => signOut(auth);
$("me-chip").onclick = openProfileModal;

function renderMe() {
  const ava = $("me-ava"); if (!ava || !state.user) return;
  const uid = state.user.uid;
  const emoji = avatarEmojiFor(uid);
  ava.textContent = emoji || firstGrapheme(nameFor(uid, state.user.email || "?")).toUpperCase();
  ava.classList.toggle("emoji", !!emoji);
  $("me-email").textContent = nameFor(uid, (state.user.email || "").split("@")[0]);
}

function openProfileModal() {
  if (!state.user) return;
  const uid = state.user.uid;
  const roomP = state.roomProfiles[uid] || {};
  const curEmoji = roomP.emoji || state.myAvatar || "";
  const curNick = roomP.displayName || "";
  const presets = AVATAR_PRESETS.map((e) => `<button type="button" class="emoji-preset${e === curEmoji ? " is-active" : ""}" data-e="${e}">${e}</button>`).join("");
  openModal(`
    <h3>내 프로필</h3>
    <p class="sub">이모지 아바타를 골라 '내가 누군지' 표시해요. 전역 기본으로 쓰거나, 이 방에서만 다르게 쓸 수 있어요.</p>
    <div class="field"><span>이모지 아바타</span>
      <div class="emoji-grid" id="emoji-grid">${presets}</div>
      <input id="pf-emoji" maxlength="8" value="${esc(curEmoji)}" placeholder="또는 직접 입력/붙여넣기 (예: 🐯)" /></div>
    <div class="field"><span>이 방에서 쓸 닉네임 (선택)</span><input id="pf-nick" maxlength="40" value="${esc(curNick)}" placeholder="비우면 기본 이름" /></div>
    <div class="modal-actions">
      <button class="btn" id="pf-cancel">취소</button>
      <button class="btn" id="pf-global">전역 저장</button>
      <button class="btn btn-primary" id="pf-room">이 방에 적용</button>
    </div>`);
  const setE = (e) => { $("pf-emoji").value = e; $("emoji-grid").querySelectorAll(".emoji-preset").forEach((b) => b.classList.toggle("is-active", b.dataset.e === e)); };
  $("emoji-grid").querySelectorAll(".emoji-preset").forEach((b) => b.onclick = () => setE(b.dataset.e));
  $("pf-cancel").onclick = closeModal;
  $("pf-global").onclick = async () => {
    const e = $("pf-emoji").value.trim();
    try { await store.setGlobalAvatar(uid, e); state.myAvatar = e; closeModal(); renderMe(); renderMessages(); toast("전역 아바타를 저장했어요."); }
    catch (err) { toast("저장 실패: " + (err.message || err)); }
  };
  $("pf-room").onclick = async () => {
    if (!state.currentWsId) { toast("먼저 워크스페이스를 선택하세요."); return; }
    try { await store.setRoomProfile(state.currentWsId, uid, { emoji: $("pf-emoji").value.trim(), displayName: $("pf-nick").value.trim() }); closeModal(); toast("이 방 프로필을 적용했어요."); }
    catch (err) { toast("적용 실패: " + (err.message || err)); }
  };
}

// ======================= ⚙️ 두뇌 설정 (Gemini ↔ Hermes, BYOK) =======================
$("brain-btn").onclick = openBrainModal;
function openBrainModal() {
  const cfg = ai.getBrainConfig();
  const isH = cfg.provider === "hermes";
  openModal(`
    <h3>⚙️ 두뇌 설정</h3>
    <p class="sub">에이전트들의 두뇌(LLM)를 고릅니다. 현재: <b>${esc(ai.brainLabel())}</b></p>
    <div class="field"><span>프로바이더</span>
      <select id="br-provider">
        <option value="gemini"${isH ? "" : " selected"}>Gemini (기본 · Firebase 내장, 키 불필요)</option>
        <option value="hermes"${isH ? " selected" : ""}>Hermes (오픈모델 · 외부 API, 내 키 사용)</option>
      </select></div>
    <div id="br-hermes" ${isH ? "" : "hidden"}>
      <div class="field"><span>API 엔드포인트 (OpenAI 호환)</span>
        <input id="br-endpoint" value="${esc(cfg.endpoint || ai.HERMES_DEFAULTS.endpoint)}" placeholder="${esc(ai.HERMES_DEFAULTS.endpoint)}" /></div>
      <div class="field"><span>모델 ID</span>
        <input id="br-model" value="${esc(cfg.model || ai.HERMES_DEFAULTS.model)}" placeholder="${esc(ai.HERMES_DEFAULTS.model)}" /></div>
      <div class="field"><span>API 키 (OpenRouter·Together 등에서 발급)</span>
        <input id="br-key" type="password" value="${esc(cfg.apiKey || "")}" placeholder="sk-or-..." autocomplete="off" /></div>
      <p class="sub" style="margin:0 0 12px">🔐 키는 <b>이 브라우저(localStorage)에만</b> 저장되고 서버로 전송되지 않아요. 연산은 전부 외부 API에서 처리됩니다. Hermes 호출이 실패하면 자동으로 Gemini로 폴백합니다. (정식 인프라가 생기면 키를 서버 프록시로 옮기는 걸 권장)</p>
    </div>
    <p class="sub" id="br-test-result" style="min-height:1.2em"></p>
    <div class="modal-actions">
      <button class="btn" id="br-cancel">취소</button>
      <button class="btn" id="br-test">연결 테스트</button>
      <button class="btn btn-primary" id="br-save">저장</button>
    </div>`);
  $("br-provider").onchange = () => { $("br-hermes").hidden = $("br-provider").value !== "hermes"; };
  const readCfg = () => {
    const provider = $("br-provider").value;
    if (provider !== "hermes") return { provider: "gemini" };
    return {
      provider: "hermes",
      endpoint: $("br-endpoint").value.trim() || ai.HERMES_DEFAULTS.endpoint,
      model: $("br-model").value.trim() || ai.HERMES_DEFAULTS.model,
      apiKey: $("br-key").value.trim(),
    };
  };
  $("br-cancel").onclick = closeModal;
  $("br-test").onclick = async () => {
    const el = $("br-test-result");
    const cur = readCfg();
    if (cur.provider === "hermes" && !cur.apiKey) { el.textContent = "⚠️ Hermes를 쓰려면 API 키가 필요해요."; return; }
    ai.setBrainConfig(cur);
    el.textContent = "테스트 중…";
    $("br-test").disabled = true;
    try { const r = await ai.testBrain(); el.textContent = `✅ 연결 성공 (${r.ms}ms) — "${r.reply}"`; }
    catch (e) { el.textContent = "❌ 실패: " + (e.message || e).slice(0, 120); }
    finally { $("br-test").disabled = false; }
  };
  $("br-save").onclick = () => {
    const cur = readCfg();
    if (cur.provider === "hermes" && !cur.apiKey) { $("br-test-result").textContent = "⚠️ Hermes를 쓰려면 API 키가 필요해요."; return; }
    ai.setBrainConfig(cur);
    closeModal();
    toast("두뇌 설정 저장: " + ai.brainLabel());
  };
}

onAuthStateChanged(auth, async (user) => {
  teardownAll();
  state.user = user;
  if (user) {
    const prof = await store.ensureUserDoc(user, pendingDisplayName);
    state.myAvatar = prof?.avatarEmoji || "";
    pendingDisplayName = null;
    $("auth-view").hidden = true;
    $("app-view").hidden = false;
    renderMe();
    startWorkspaces();
  } else {
    $("auth-view").hidden = false;
    $("app-view").hidden = true;
    state.promptedCreate = false;
  }
});

function teardownAll() {
  for (const k of Object.keys(state.unsub)) {
    if (state.unsub[k]) { state.unsub[k](); state.unsub[k] = null; }
  }
  state.workspaces = []; state.channels = []; state.agents = [];
  state.messages = []; state.memories = []; state.pending = [];
  state.roomProfiles = {};
  state.currentWsId = state.currentChId = state.selectedAgentId = null;
}

// ======================= 워크스페이스 =======================
function startWorkspaces() {
  state.unsub.ws = store.listenWorkspaces(state.user.uid, (list) => {
    state.workspaces = list;
    renderWsRail();
    if (!state.currentWsId && list.length) selectWorkspace(list[0].id);
    if (state.currentWsId && !list.find((w) => w.id === state.currentWsId)) {
      list.length ? selectWorkspace(list[0].id) : clearWorkspace();
    }
    if (!list.length && !state.promptedCreate) { state.promptedCreate = true; openWorkspaceModal(); }
  });
}

function renderWsRail() {
  const rail = $("ws-rail");
  rail.innerHTML = "";
  for (const ws of state.workspaces) {
    const b = document.createElement("button");
    b.className = "ws-icon" + (ws.id === state.currentWsId ? " is-active" : "");
    b.textContent = firstGrapheme(ws.name).toUpperCase();
    b.title = ws.name;
    b.onclick = () => selectWorkspace(ws.id);
    rail.appendChild(b);
  }
  const add = document.createElement("button");
  add.className = "ws-icon ws-add";
  add.textContent = "＋";
  add.title = "워크스페이스 추가 / 참여";
  add.onclick = openWorkspaceModal;
  rail.appendChild(add);
}

function selectWorkspace(wsId) {
  if (state.currentWsId === wsId) return;
  // 하위 리스너 정리
  ["channels", "agents", "messages", "memories", "profiles"].forEach((k) => { if (state.unsub[k]) { state.unsub[k](); state.unsub[k] = null; } });
  state.currentWsId = wsId;
  state.currentChId = null; state.selectedAgentId = null;
  state.channels = []; state.agents = []; state.messages = []; state.memories = [];
  state.roomProfiles = {};
  state.unsub.profiles = store.listenRoomProfiles(wsId, (map) => { state.roomProfiles = map; renderMessages(); renderMe(); });
  const ws = state.workspaces.find((w) => w.id === wsId);
  $("ws-name").textContent = ws?.name || "워크스페이스";
  renderWsRail();
  renderPanel();
  $("chat-title").textContent = "# 채널을 선택하세요";
  $("chat-agents").innerHTML = "";
  $("messages").innerHTML = "";

  state.unsub.channels = store.listenChannels(wsId, (list) => {
    state.channels = list;
    renderChannels();
    if (!state.currentChId && list.length) selectChannel(list[0].id);
    if (state.currentChId && !list.find((c) => c.id === state.currentChId) && list.length) selectChannel(list[0].id);
    renderMessages();
  });
  state.unsub.agents = store.listenAgents(wsId, (list) => {
    state.agents = list;
    renderAgents();
    renderChannels();
    renderChatAgents();
    renderMessages();
    if (state.selectedAgentId) renderPanel();
  });
}

function clearWorkspace() {
  state.currentWsId = null;
  $("ws-name").textContent = "워크스페이스";
  $("channel-list").innerHTML = "";
  $("agent-list").innerHTML = "";
  $("messages").innerHTML = "";
  $("chat-title").textContent = "# 채널을 선택하세요";
  renderPanel();
}

// ======================= 채널 =======================
function renderChannels() {
  const ul = $("channel-list");
  ul.innerHTML = "";
  for (const ch of state.channels) {
    const li = document.createElement("li");
    li.className = "chan-item" + (ch.id === state.currentChId ? " is-active" : "");
    const n = (ch.agentIds || []).length;
    li.innerHTML = `<span class="chan-hash">#</span><span>${esc(ch.name)}</span>` + (n ? `<span style="margin-left:auto;font-size:10px;color:var(--txt-mute)">🤖${n}</span>` : "");
    li.onclick = () => selectChannel(ch.id);
    ul.appendChild(li);
  }
  updateChannelControls();
}

function updateChannelControls() {
  const has = !!state.currentChId;
  $("summarize-btn").hidden = !has;
  $("export-btn").hidden = !has;
  $("auto-toggle-wrap").hidden = !has;
  if (has) $("auto-toggle").checked = !!(currentChannel() && currentChannel().autoIntervene);
}

function selectChannel(chId) {
  state.currentChId = chId;
  if (state.unsub.messages) { state.unsub.messages(); state.unsub.messages = null; }
  state.messages = [];
  const ch = state.channels.find((c) => c.id === chId);
  $("chat-title").textContent = "# " + (ch?.name || "");
  renderChannels();
  renderChatAgents();
  updateChannelControls();
  state.unsub.messages = store.listenMessages(state.currentWsId, chId, (list) => {
    state.messages = list;
    renderMessages();
  });
}

function currentChannel() { return state.channels.find((c) => c.id === state.currentChId) || null; }
function channelAgents() {
  const ch = currentChannel();
  if (!ch) return [];
  return state.agents.filter((a) => (ch.agentIds || []).includes(a.id));
}

function renderChatAgents() {
  const wrap = $("chat-agents");
  wrap.innerHTML = "";
  if (!state.currentChId) return;
  for (const a of channelAgents()) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `<canvas width="32" height="32"></canvas>${esc(a.name)}`;
    chip.title = `${a.name} · Lv.${a.level}`;
    drawPet(chip.querySelector("canvas"), a.level, a.hue ?? hueFrom(a.name));
    chip.onclick = () => selectAgent(a.id);
    wrap.appendChild(chip);
  }
  const add = document.createElement("span");
  add.className = "chip addchip";
  add.textContent = "＋ 에이전트";
  add.onclick = openAddAgentToChannelModal;
  wrap.appendChild(add);
}

// ======================= 에이전트 (사이드바) =======================
function renderAgents() {
  const ul = $("agent-list");
  ul.innerHTML = "";
  if (!state.agents.length) {
    const li = document.createElement("li");
    li.className = "empty-hint";
    li.style.margin = "8px";
    li.innerHTML = `아직 에이전트가 없어요.<br>＋로 만들거나, 한 번에 시작하세요.<br><button class="btn btn-primary" id="sample-team-btn" style="margin-top:10px;font-size:13px">🎁 샘플 팀 불러오기</button>`;
    ul.appendChild(li);
    const btn = li.querySelector("#sample-team-btn");
    if (btn) btn.onclick = seedSampleTeam;
    return;
  }
  for (const a of state.agents) {
    const li = document.createElement("li");
    li.className = "agent-item" + (a.id === state.selectedAgentId ? " is-active" : "");
    li.innerHTML = `<canvas class="agent-ava" width="32" height="32"></canvas>
      <div class="agent-meta"><div class="agent-nm">${esc(a.name)}</div>
      <div class="agent-lv">Lv.${a.level} ${esc(levelInfo(a.level).name)} · 🧠${a.knowledgeCount || 0}</div></div>`;
    drawPet(li.querySelector("canvas"), a.level, a.hue ?? hueFrom(a.name));
    li.onclick = () => selectAgent(a.id);
    ul.appendChild(li);
  }
}

// 🎁 1클릭 샘플 팀 — 빈 워크스페이스 콜드스타트 해소
async function seedSampleTeam() {
  if (!state.currentWsId) return;
  const btn = $("sample-team-btn");
  if (btn) { btn.disabled = true; btn.textContent = "불러오는 중…"; }
  try {
    const presets = [
      { name: "기획봇", hue: 265, tone: "논리적이고 명확하게", verbosity: "보통",
        persona: "너는 제품 전략가(PM)야. 문제 정의와 타깃, 핵심 가치에 집중하고 아이디어를 실행 범위로 좁혀." },
      { name: "마케터", hue: 150, tone: "에너지 넘치고 실행 중심", verbosity: "보통",
        persona: "너는 그로스 마케터야. 저비용 고객 획득과 바이럴에 밝고, 항상 구체적 채널·액션·지표를 제시해." },
      { name: "재무봇", hue: 30, tone: "냉정하고 분석적으로, 숫자 중심", verbosity: "간결",
        persona: "너는 재무 전문가야. 유닛 이코노믹스와 수익모델에 밝고 숫자엔 늘 근거를 붙여." },
    ];
    for (const p of presets) {
      const id = await store.createAgent(state.currentWsId, state.user.uid, p);
      if (state.currentChId) await store.addAgentToChannel(state.currentWsId, state.currentChId, id);
    }
    toast("🎁 샘플 팀 3인이 도착했어요! @기획봇 하고 말을 걸어보세요.");
  } catch (err) { toast("불러오기 실패: " + (err.message || err)); if (btn) { btn.disabled = false; btn.textContent = "🎁 샘플 팀 불러오기"; } }
}

function selectAgent(agentId) {
  state.selectedAgentId = agentId;
  if (state.unsub.memories) { state.unsub.memories(); state.unsub.memories = null; }
  state.memories = [];
  renderAgents();
  renderPanel();
  state.unsub.memories = store.listenMemories(state.currentWsId, agentId, (list) => {
    state.memories = list;
    renderMemories();
  });
}

// ======================= 메시지 / 채팅 =======================
function mentionMatch(text) {
  // 현재 채널 에이전트 중 @이름 으로 언급된 것
  const hits = [];
  const agents = [...channelAgents()].sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  for (const a of agents) {
    if (lower.includes("@" + a.name.toLowerCase())) hits.push(a);
  }
  return hits;
}

function highlightMentions(text) {
  let html = esc(text);
  const agents = [...channelAgents()].sort((a, b) => b.name.length - a.name.length);
  for (const a of agents) {
    const token = "@" + a.name;
    html = html.split(esc(token)).join(`<span class="mention">${esc(token)}</span>`);
  }
  return html;
}

function renderMessages() {
  const box = $("messages");
  if (!state.currentChId) {
    box.innerHTML = state.channels.length
      ? `<p class="empty-hint">채널을 선택하세요.</p>`
      : `<p class="empty-hint">아직 채널이 없어요.<br>왼쪽 <b>채널 ＋</b>로 첫 채널을 만들어보세요.</p>`;
    return;
  }
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  let html = "";
  if (!state.messages.length && !state.pending.length) {
    const ca = channelAgents();
    html = `<p class="empty-hint">첫 메시지를 남겨보세요.` +
      (ca.length ? `<br>에이전트를 부르려면 <b>@${esc(ca[0].name)}</b> 처럼 멘션하세요.`
                 : `<br>이 채널엔 아직 에이전트가 없어요. 위 <b>＋ 에이전트</b>로 초대하세요.`) + `</p>`;
  }
  for (const m of state.messages) html += msgHtml(m);
  for (const p of state.pending) html += thinkingHtml(p);
  box.innerHTML = html;

  // 아바타 캔버스 렌더
  box.querySelectorAll("canvas[data-hue]").forEach((cv) => {
    drawPet(cv, +cv.dataset.level || 1, +cv.dataset.hue || 265);
  });
  renderDiagrams();
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function summaryHtml(m) {
  let data = { points: [], issues: [] };
  try { data = JSON.parse(m.content); } catch (_) {}
  const isMeeting = m.kind === "meeting";
  const title = isMeeting ? "🤝 회의 결론" : "🧵 대화 맥락 요약";
  const ptsLabel = isMeeting ? "합의/결정" : "";
  const pts = (data.points || []).map((p) => `<li>${esc(p)}</li>`).join("") || `<li>정리된 내용이 없습니다.</li>`;
  const iss = (data.issues || []).length
    ? `<div class="sc-issues-title">🔎 남은 쟁점</div><ul class="sc-issues">${data.issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`
    : "";
  return `<div class="summary-card${isMeeting ? " meeting" : ""}"><h4>${title} <span class="sc-time">${fmtTime(m.createdAt)}</span></h4>${ptsLabel ? `<div class="sc-issues-title" style="color:var(--accent-2);margin-top:0">${ptsLabel}</div>` : ""}<ul>${pts}</ul>${iss}</div>`;
}

// ---- 시각화(mermaid) ----
const diagramCache = {};
let _mermaid = null, _mmdPromise = null;
async function getMermaid() {
  if (_mermaid) return _mermaid;
  if (!_mmdPromise) {
    _mmdPromise = import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs").then((mod) => {
      _mermaid = mod.default;
      _mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict", fontFamily: "inherit" });
      return _mermaid;
    });
  }
  return _mmdPromise;
}

function diagramHtml(m) {
  let d = { title: "시각화", code: "" };
  try { d = JSON.parse(m.content); } catch (_) {}
  const body = diagramCache[m.id] || `<div class="mmd-loading">그리는 중…</div>`;
  return `<div class="summary-card diagram-card"><h4>📊 ${esc(d.title || "시각화")} <span class="sc-time">${fmtTime(m.createdAt)}</span></h4><div class="mermaid-holder" data-id="${esc(m.id)}" data-code="${esc(d.code || "")}">${body}</div></div>`;
}

async function renderDiagrams() {
  const holders = [...document.querySelectorAll(".mermaid-holder")].filter((h) => !diagramCache[h.dataset.id]);
  if (!holders.length) return;
  let mm;
  try { mm = await getMermaid(); } catch (_) { return; }
  for (const h of holders) {
    const id = h.dataset.id, code = h.dataset.code || "";
    try {
      const { svg } = await mm.render("mmd" + id.replace(/[^a-zA-Z0-9]/g, ""), code);
      diagramCache[id] = svg; h.innerHTML = svg;
    } catch (_) {
      const fb = `<div class="mmd-err">다이어그램을 그리지 못했어요. 원본 코드:</div><pre class="mmd-code">${esc(code)}</pre>`;
      diagramCache[id] = fb; h.innerHTML = fb;
    }
  }
}

function scoresHtml(m) {
  let d = { topic: "", scores: [] };
  try { d = JSON.parse(m.content); } catch (_) {}
  const list = d.scores || [];
  const avg = list.length ? (list.reduce((a, b) => a + (b.score || 0), 0) / list.length).toFixed(1) : "-";
  const rows = list.map((s) => `<div class="score-row"><span class="score-name">${esc(s.name)}</span><span class="score-badge">${s.score}/10</span><span class="score-reason">${esc(s.reason || "")}</span></div>`).join("");
  return `<div class="summary-card scores-card"><h4>⭐ 평가: ${esc(d.topic || "")} <span class="sc-time">${fmtTime(m.createdAt)}</span></h4><div class="score-avg">평균 ${avg} / 10</div>${rows}</div>`;
}

function docHtml(m) {
  let d = { emoji: "📋", title: "", sections: [] };
  try { d = JSON.parse(m.content); } catch (_) {}
  const secs = (d.sections || []).map((s) =>
    `<div class="doc-sec"><div class="doc-h">${esc(s.heading)}</div>${(s.items || []).length ? `<ul>${s.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}</div>`
  ).join("");
  return `<div class="summary-card doc-card"><h4>${esc(d.emoji || "📋")} ${esc(d.title || "")} <span class="sc-time">${fmtTime(m.createdAt)}</span></h4>${secs}</div>`;
}

function msgHtml(m) {
  if (m.senderType === "system" || m.kind === "summary") {
    if (m.kind === "diagram") return diagramHtml(m);
    if (m.kind === "scores") return scoresHtml(m);
    if (m.kind === "doc") return docHtml(m);
    return summaryHtml(m);
  }
  const isAgent = m.senderType === "agent";
  const mine = !isAgent && isMe(m.senderId);
  const dispName = isAgent ? m.senderName : nameFor(m.senderId, m.senderName);
  const emoji = isAgent ? null : avatarEmojiFor(m.senderId);
  const ava = isAgent
    ? `<div class="msg-ava"><canvas data-hue="${agentHue(m.agentId, m.senderName)}" data-level="${agentLevel(m.agentId)}" width="32" height="32"></canvas></div>`
    : (emoji
        ? `<div class="msg-ava user emoji">${esc(emoji)}</div>`
        : `<div class="msg-ava user">${esc(firstGrapheme(dispName).toUpperCase())}</div>`);
  const badge = isAgent ? `<span class="msg-badge">AI</span>` : (mine ? `<span class="msg-badge me">나</span>` : "");
  const praise = isAgent && m.agentId
    ? `<div class="msg-actions"><button class="praise-btn" data-msg="${m.id}" data-agent="${m.agentId}">👍 도움이 됐어요${m.reactions ? " · " + m.reactions : ""}</button></div>`
    : "";
  // 호버 툴바: 복사(모든 메시지) + 삭제(내 메시지, 보낸 지 5분 이내)
  const ageMs = m.createdAt && m.createdAt.seconds ? Date.now() - m.createdAt.seconds * 1000 : 0;
  const canDel = mine && ageMs < 5 * 60 * 1000;
  // 🧠 승격: 이 메시지를 채널 에이전트들의 '팀 승격 기억'으로 (자동 학습과 병행되는 절충 모델)
  const promote = m.content
    ? (m.promotedToMemory
        ? `<button class="msg-tool promoted" title="이미 팀 기억으로 승격됨" disabled>🧠✓</button>`
        : `<button class="msg-tool msg-promote" data-msg="${m.id}" title="팀 기억으로 승격 — 채널 에이전트들이 우선 기억합니다">🧠</button>`)
    : "";
  const del = `<div class="msg-tools">` + promote +
    (m.content ? `<button class="msg-tool msg-copy" data-msg="${m.id}" title="내용 복사">📋</button>` : "") +
    (canDel ? `<button class="msg-tool msg-del" data-msg="${m.id}" title="내 메시지 삭제 (5분 이내만)">🗑</button>` : "") +
    `</div>`;
  const img = m.image ? `<img class="msg-img" src="${esc(m.image)}" alt="첨부 이미지" loading="lazy">` : "";
  // 🧠 근거 각주: 에이전트가 실제로 활용한 팀 학습 지식 표시 (신뢰 + "진짜 기억한다" 증명)
  const srcs = isAgent && Array.isArray(m.sources) && m.sources.length
    ? `<div class="msg-sources">🧠 근거: ${m.sources.map((s) => `<span>${esc(s)}</span>`).join(" · ")}</div>` : "";
  return `<div class="msg${mine ? " mine" : ""}">${ava}<div class="msg-body">
    <div class="msg-top"><span class="msg-name ${isAgent ? "agent" : ""}${mine ? " me" : ""}">${esc(dispName)}</span>${badge}<span class="msg-time">${fmtTime(m.createdAt)}</span></div>
    ${m.content ? `<div class="msg-text">${highlightMentions(m.content)}</div>` : ""}${img}${srcs}${praise}</div>${del}</div>`;
}

function thinkingHtml(p) {
  return `<div class="msg thinking"><div class="msg-ava"><canvas data-hue="${p.hue}" data-level="${p.level}" width="32" height="32"></canvas></div>
    <div class="msg-body"><div class="msg-top"><span class="msg-name agent">${esc(p.name)}</span></div>
    <div class="msg-text"><span class="dots"></span></div></div></div>`;
}

function agentHue(agentId, name) {
  const a = state.agents.find((x) => x.id === agentId);
  return a ? (a.hue ?? hueFrom(a.name)) : hueFrom(name || "agent");
}
function agentLevel(agentId) {
  const a = state.agents.find((x) => x.id === agentId);
  return a ? a.level : 1;
}

// 👍 / 🧠 / 📋 / 🗑 이벤트 위임
$("messages").addEventListener("click", async (e) => {
  // 🧠 팀 기억으로 승격 — 채널의 모든 에이전트에게 우선 기억으로 저장 (AI 호출 없음)
  const proBtn = e.target.closest(".msg-promote");
  if (proBtn) {
    const msg = state.messages.find((x) => x.id === proBtn.dataset.msg);
    if (!msg) return;
    const cas = channelAgents();
    if (!cas.length) { toast("이 채널에 기억할 에이전트가 없어요. 먼저 에이전트를 추가하세요."); return; }
    proBtn.disabled = true;
    try {
      const content = `${msg.senderName}: ${msg.content}`;
      for (const a of cas) {
        await store.addMemory(state.currentWsId, a.id, {
          content, sourceChannelId: state.currentChId,
          importance: 1, promoted: true, promotedBy: state.user.uid,
        });
        await awardExp(a.id, EXP.LEARN, 1);
      }
      await store.markMessagePromoted(state.currentWsId, state.currentChId, msg.id);
      toast(`🧠 팀 기억으로 승격 — ${cas.map((a) => a.name).join(", ")}이(가) 우선 기억합니다.`);
    } catch (err) { toast("승격 실패: " + (err.message || err)); proBtn.disabled = false; }
    return;
  }
  // 메시지 내용 복사
  const copyBtn = e.target.closest(".msg-copy");
  if (copyBtn) {
    const msg = state.messages.find((x) => x.id === copyBtn.dataset.msg);
    const text = msg ? msg.content : "";
    try { await navigator.clipboard.writeText(text); }
    catch (_) {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (_) {}
      ta.remove();
    }
    copyBtn.textContent = "✓";
    setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = "📋"; }, 1200);
    toast("메시지를 복사했어요.");
    return;
  }
  // 내 메시지 삭제 (2단계 확인)
  const delBtn = e.target.closest(".msg-del");
  if (delBtn) {
    if (delBtn.dataset.armed !== "1") {
      delBtn.dataset.armed = "1";
      delBtn.textContent = "삭제?";
      setTimeout(() => { if (delBtn.isConnected) { delBtn.dataset.armed = ""; delBtn.textContent = "🗑"; } }, 2500);
      return;
    }
    try { await store.deleteMessage(state.currentWsId, state.currentChId, delBtn.dataset.msg); toast("메시지를 삭제했어요."); }
    catch (err) { toast("삭제 실패: " + (err.message || err)); }
    return;
  }
  const btn = e.target.closest(".praise-btn");
  if (!btn) return;
  const msgId = btn.dataset.msg, agentId = btn.dataset.agent;
  btn.disabled = true;
  try {
    await store.praiseMessage(state.currentWsId, state.currentChId, msgId);
    await awardExp(agentId, EXP.PRAISE, 0);
    flyBubble("👍");
  } catch (err) { console.error(err); }
});

// 컴포저
const input = $("composer-input");
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(160, input.scrollHeight) + "px";
  updateCmdPalette();
  updateMentionPalette();
});
// 팔레트 공용 키보드 내비 (↑↓ 이동, Tab/Enter 선택, Esc 닫기)
function paletteNav(pal, e, enterSelects) {
  const items = [...pal.querySelectorAll(".cmd-item")];
  let idx = items.findIndex((x) => x.classList.contains("active"));
  if (e.key === "ArrowDown") { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); items.forEach((x, i) => x.classList.toggle("active", i === idx)); return true; }
  if (e.key === "ArrowUp") { e.preventDefault(); idx = Math.max(0, idx - 1); items.forEach((x, i) => x.classList.toggle("active", i === idx)); return true; }
  if ((e.key === "Tab" || (enterSelects && e.key === "Enter")) && idx >= 0) { e.preventDefault(); items[idx].click(); return true; }
  if (e.key === "Escape") { pal.hidden = true; return true; }
  return false;
}
input.addEventListener("keydown", (e) => {
  const mpal = $("mention-palette");
  if (mpal && !mpal.hidden && paletteNav(mpal, e, true)) return; // 멘션: Enter=선택 (전송 아님)
  const pal = $("cmd-palette");
  if (pal && !pal.hidden && paletteNav(pal, e, false)) return;
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("composer").requestSubmit(); }
});
input.addEventListener("blur", () => setTimeout(() => {
  const p = $("cmd-palette"); if (p) p.hidden = true;
  const mp = $("mention-palette"); if (mp) mp.hidden = true;
}, 160));

// ======================= @ 멘션 자동완성 =======================
function mentionCandidates() {
  const ags = channelAgents().map((a) => ({ type: "agent", name: a.name, level: a.level, hue: a.hue ?? hueFrom(a.name) }));
  // 사람: 방 프로필 닉네임 + 이 채널 대화에 등장한 사용자
  const humans = new Set();
  Object.values(state.roomProfiles).forEach((p) => { if (p && p.displayName) humans.add(p.displayName); });
  state.messages.forEach((m) => { if (m.senderType === "user" && m.senderName) humans.add(nameFor(m.senderId, m.senderName)); });
  const agNames = new Set(ags.map((a) => a.name));
  return [...ags, ...[...humans].filter((n) => !agNames.has(n)).map((n) => ({ type: "user", name: n }))];
}

function updateMentionPalette() {
  const pal = $("mention-palette");
  if (!pal) return;
  if (!state.currentChId) { pal.hidden = true; return; }
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos);
  const m = before.match(/@([^\s@]*)$/);
  if (!m) { pal.hidden = true; return; }
  const q = m[1].toLowerCase();
  const cands = mentionCandidates().filter((c) => !q || c.name.toLowerCase().includes(q)).slice(0, 8);
  if (!cands.length) { pal.hidden = true; return; }
  pal.innerHTML = cands.map((c, i) =>
    `<div class="cmd-item${i === 0 ? " active" : ""}" data-name="${esc(c.name)}">` +
    (c.type === "agent"
      ? `<canvas class="mention-ava" width="32" height="32" data-hue="${c.hue}" data-level="${c.level}"></canvas>`
      : `<span class="mention-user-dot">${esc(firstGrapheme(c.name).toUpperCase())}</span>`) +
    `<code>@${esc(c.name)}</code><span>${c.type === "agent" ? "AI 에이전트 · 부르면 답해요" : "팀원"}</span></div>`
  ).join("");
  pal.hidden = false;
  pal.querySelectorAll("canvas[data-hue]").forEach((cv) => drawPet(cv, +cv.dataset.level || 1, +cv.dataset.hue || 265));
  pal.querySelectorAll(".cmd-item").forEach((el) => el.onclick = () => applyMention(el.dataset.name));
}

function applyMention(name) {
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos).replace(/@[^\s@]*$/, "@" + name + " ");
  input.value = before + input.value.slice(pos);
  $("mention-palette").hidden = true;
  input.focus();
  input.setSelectionRange(before.length, before.length);
  input.style.height = "auto"; input.style.height = Math.min(160, input.scrollHeight) + "px";
}

// 📎 이미지 첨부 — 클라이언트에서 압축(최대 800px JPEG) 후 인라인 저장 (Storage 없이, 데모용)
async function compressImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  let q = 0.75, url = c.toDataURL("image/jpeg", q);
  while (url.length > 450000 && q > 0.3) { q -= 0.15; url = c.toDataURL("image/jpeg", q); }
  if (url.length > 700000) throw new Error("이미지가 너무 커요. 더 작은 이미지로 시도해 주세요.");
  return url;
}
$("attach-btn").onclick = () => { if (!state.currentChId) { toast("먼저 채널을 선택하세요."); return; } $("attach-input").click(); };
$("attach-input").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file || !state.currentChId) return;
  toast("🖼️ 이미지를 압축해서 보내는 중…");
  try {
    const url = await compressImage(file);
    await store.sendMessage(state.currentWsId, state.currentChId, {
      senderId: state.user.uid, senderType: "user", senderName: meName(), content: "", image: url,
    });
  } catch (err) { toast(err.message || "이미지 전송 실패"); }
});

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || !state.currentChId) return;
  input.value = ""; input.style.height = "auto"; hideCmdPalette();

  // 슬래시 명령어
  if (text.startsWith("/")) {
    const parsed = parseCommand(text);
    if (!parsed || !parsed.cmd) { toast("알 수 없는 명령이에요. /help 를 입력해 보세요."); return; }
    if (parsed.cmd.arg && !parsed.arg) { toast(`사용법: ${parsed.cmd.usage}`); return; }
    try { await parsed.cmd.run(parsed.arg); } catch (err) { console.error(err); toast("명령 실행 실패: " + (err.message || err)); }
    return;
  }

  // 일반 메시지
  const mentioned = mentionMatch(text);
  try {
    await store.sendMessage(state.currentWsId, state.currentChId, {
      senderId: state.user.uid, senderType: "user",
      senderName: meName(), content: text, mentions: mentioned.map((a) => a.id),
    });
  } catch (err) { toast("메시지 전송 실패: " + (err.message || err)); return; }

  if (mentioned.length >= 2) runRoundtable(mentioned, text, text);
  else if (mentioned.length === 1) triggerAgent(mentioned[0], text);
  else {
    const ch = currentChannel();
    const cas = channelAgents();
    if (ch && ch.autoIntervene && cas.length && /[?？]\s*$/.test(text)) triggerAgent(cas[0], text);
  }
});

// ======================= 슬래시 명령어 =======================
// 이름은 영어 기준(영어 사용자 배려), 한국어/약어는 alias로 지원.
const COMMANDS = [
  { name: "help", aliases: ["도움", "도움말", "명령어", "commands", "cmds", "?"], usage: "/help", desc: "command list · 명령어 목록", run: () => { openHelpModal(); } },
  // 협업형(여러 에이전트가 각자 발언 → 대화가 보임)
  { name: "discuss", aliases: ["토의", "회의", "debate"], arg: true, tag: "collab", usage: "/discuss <topic>", desc: "roundtable debate · 원탁 토론 → 결론", run: runDiscuss },
  { name: "brainstorm", aliases: ["브레인스토밍", "ideas", "bs"], arg: true, tag: "collab", usage: "/brainstorm <topic>", desc: "idea board · 에이전트별 아이디어 발산", run: (a) => runBrainstorm(a) },
  { name: "score", aliases: ["평가", "점수", "rate", "sharktank"], arg: true, tag: "collab", usage: "/score <target>", desc: "agents rate 1–10 · 샤크탱크식 채점", run: runEvaluate },
  // 합성형(팀 지식 기반 AI 1회 합성 → 카드)
  { name: "decide", aliases: ["결정", "choose"], arg: true, tag: "synth", usage: "/decide <question>", desc: "decision · 의사결정 정리", run: (a) => produceDoc("✅", `질문 "${a}"에 대한 의사결정을 도와라. 참고 대화:\n${ctxRecent()}\nsection은 정확히: "추천 결정"(items 1~2), "근거"(items 2~4), "리스크·반대의견"(items 1~3), "다음 행동"(items 2~3).`, "✅ 결정을 정리하는 중…") },
  { name: "swot", aliases: ["스왓"], arg: true, tag: "synth", usage: "/swot <target>", desc: "SWOT analysis · 강점·약점·기회·위협", run: (a) => produceDoc("🔍", `"${a}"에 대한 SWOT 분석. section은 정확히 4개: "강점(Strengths)","약점(Weaknesses)","기회(Opportunities)","위협(Threats)". 각 items 2~4개. 참고:\n${ctxRecent()}`, "🔍 SWOT 분석 중…") },
  { name: "summary", aliases: ["요약", "정리", "sum", "tldr", "recap"], usage: "/summary", desc: "compress chat · 대화 맥락 압축", run: () => doSummarize() },
  // 산출물(창업 프로젝트) — 합성형
  { name: "plan", aliases: ["기획", "roadmap"], arg: true, tag: "synth", usage: "/plan <goal>", desc: "roadmap · 단계별 실행 계획", run: (a) => produceDoc("📋", `목표 "${a}"의 실행 계획(로드맵)을 만들어라. 참고 대화:\n${ctxRecent()}\n3~5개 단계(section heading=단계명·시기), 각 items=구체 실행항목 2~4개. 마지막 section heading="성공지표(KPI)"로 핵심 지표 items.`, "📋 실행 계획을 짜는 중…") },
  { name: "tasks", aliases: ["할일", "todo"], arg: true, tag: "synth", usage: "/tasks <goal>", desc: "action checklist · 할 일 분해", run: (a) => produceDoc("✔️", `목표 "${a}"를 실행 가능한 할 일로 분해하라. 팀 역할:\n${teamRoles()}\n우선순위/영역별 section, items는 "[ ] 구체 액션 — (담당 역할)" 형식.`, "✔️ 할 일로 쪼개는 중…") },
  { name: "pitch", aliases: ["피치"], arg: true, tag: "synth", usage: "/pitch <idea>", desc: "elevator pitch · 투자용 한 장 피치", run: (a) => produceDoc("🎤", `아이디어 "${a}"의 엘리베이터 피치. 참고:\n${ctxRecent()}\nsection: "한 줄 소개","문제","해결책","차별점","목표 고객","시장 기회". 각 items 1~3개, 간결하고 설득력 있게.`, "🎤 피치를 다듬는 중…") },
  { name: "name", aliases: ["네이밍", "naming"], arg: true, tag: "synth", usage: "/name <description>", desc: "brand names · 이름 후보", run: (a) => produceDoc("🏷️", `"${a}"에 어울리는 제품/서비스 이름 후보를 지어라. section 1개 heading="이름 후보", items는 "이름 — 한 줄 이유" 6개. 한국어/영어 섞어도 됨. 상표 흔한 단어는 피해라.`, "🏷️ 이름을 짓는 중…") },
  { name: "canvas", aliases: ["캔버스", "lean"], arg: true, tag: "synth", usage: "/canvas <idea>", desc: "lean canvas · 린 캔버스", run: (a) => produceDoc("🧩", `"${a}"의 린 캔버스를 작성하라. 참고:\n${ctxRecent()}\nsection: "문제","고객군","가치 제안","솔루션","수익 모델","핵심 지표","차별적 우위","비용 구조". 각 items 1~3개.`, "🧩 린 캔버스를 채우는 중…") },
  // 시각화
  { name: "viz", aliases: ["시각화", "diagram", "chart", "graph"], arg: true, usage: "/viz <topic>", desc: "diagram · 다이어그램으로 시각화", run: runVisualize },
  // 결정 타임라인 (AI 불필요 — 회의결론·결정 카드를 시간순으로 모아봄)
  { name: "decisions", aliases: ["결정로그", "결정모음", "timeline", "log"], usage: "/decisions", desc: "decision log · 이 채널의 결정 모아보기", run: runDecisionLog },
  // 내보내기
  { name: "export", aliases: ["내보내기", "저장", "download", "dl"], usage: "/export [md|html|json|csv|txt]", desc: "channel to file · 대화·산출물 내보내기", run: (a) => { const k = (a || "").trim().toLowerCase(); if (exporter.FORMATS[k]) doExport(k); else openExportModal(); } },
];

// 결정 타임라인 — 팀 기억의 본질은 "우리가 뭘 결정했나"
async function runDecisionLog() {
  const found = [];
  for (const m of state.messages) {
    let d; try { d = JSON.parse(m.content); } catch (_) { continue; }
    const when = m.createdAt && m.createdAt.seconds ? new Date(m.createdAt.seconds * 1000).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" }) : "";
    if (m.kind === "meeting" && Array.isArray(d.points)) {
      d.points.forEach((p) => found.push(`[${when}] ${p}`));
    } else if (m.kind === "doc" && d.emoji === "✅" && Array.isArray(d.sections)) {
      const rec = d.sections.find((s) => (s.heading || "").includes("추천 결정"));
      (rec?.items || []).forEach((p) => found.push(`[${when}] ${p}`));
    }
  }
  if (!found.length) { toast("아직 이 채널에 기록된 결정이 없어요. /discuss 나 /decide 로 결정을 만들어 보세요."); return; }
  await store.addDocCard(state.currentWsId, state.currentChId, {
    emoji: "🗂️", title: "결정 타임라인 — 이 채널이 확정한 것들",
    sections: [{ heading: `총 ${found.length}건 (시간순)`, items: found.slice(-14) }],
  });
}

function parseCommand(text) {
  const m = text.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
  if (!m) return null;
  const key = m[1].toLowerCase();
  const arg = (m[2] || "").trim();
  const cmd = COMMANDS.find((c) => c.name === key || c.aliases.includes(key));
  return { cmd, key, arg };
}

// 산출물 명령 공용 엔진
function ctxRecent(n = 10) {
  return state.messages.filter((m) => !m.kind && m.senderType !== "system").slice(-n).map((m) => `${m.senderName}: ${m.content}`).join("\n") || "(참고할 대화 없음)";
}
function teamRoles() {
  const cas = channelAgents();
  return cas.length ? cas.map((a) => `- ${a.name}: ${a.persona || "조력자"}`).join("\n") : "(채널에 에이전트 없음)";
}
async function produceDoc(emoji, instruction, loadingMsg) {
  if (!state.currentChId) return;
  toast(loadingMsg || "만드는 중…");
  const data = await ai.structuredCard(instruction);
  if (!data || !data.sections.length) { toast("결과를 만들지 못했어요 (AI 연결을 확인하세요)."); return; }
  await store.addDocCard(state.currentWsId, state.currentChId, { emoji, title: data.title, sections: data.sections });
}

// 🗣️ 협업형: 각 에이전트가 '보이는 메시지'로 아이디어를 냄 → 투명하게 확인 가능
function splitIdeas(text) {
  return String(text || "").split(/\n+/).map((s) => s.replace(/^[\s\-*\d.)·•]+/, "").trim()).filter((s) => s.length > 3).slice(0, 5);
}
async function agentSpeak(agent, userText, awardAnswer = true) {
  const wsId = state.currentWsId, chId = state.currentChId;
  const hue = agent.hue ?? hueFrom(agent.name);
  state.pending.push({ id: agent.id, name: agent.name, hue, level: agent.level });
  renderMessages();
  let res = null;
  try {
    const memories = await store.fetchTopMemories(wsId, agent.id, 4);
    const recent = state.messages.slice(-8).map((m) => ({ senderName: m.senderName, content: m.content }));
    res = await ai.respond({ agent, memories, recent, userName: meName(), userText, levelName: levelInfo(agent.level).name });
    await store.sendMessage(wsId, chId, { senderId: agent.id, senderType: "agent", senderName: agent.name, content: res.reply, agentId: agent.id,
      sources: (res.sources || []).map((n) => String(memories[n - 1] || "").slice(0, 70)).filter(Boolean) });
    if (res.ok && awardAnswer) await awardExp(agent.id, EXP.ANSWER, 0, 1);
  } catch (err) { console.error(err); }
  finally { state.pending = state.pending.filter((p) => p.id !== agent.id); renderMessages(); }
  return res;
}
async function runBrainstorm(topic) {
  const cas = channelAgents();
  if (!cas.length) { toast("브레인스토밍할 에이전트가 채널에 없어요. 먼저 에이전트를 추가하세요."); return; }
  await store.sendMessage(state.currentWsId, state.currentChId, {
    senderId: state.user.uid, senderType: "user", senderName: meName(), content: `💡 브레인스토밍 — ${topic}`, mentions: [],
  });
  toast("💡 각 에이전트가 아이디어를 내는 중…");
  const sections = [];
  for (const a of cas) {
    const res = await agentSpeak(a, `브레인스토밍: "${topic}"에 대해 네 역할 관점에서 참신하고 구체적인 아이디어 3가지를 각각 한 줄로 제안해. 번호를 붙여.`);
    if (res && res.reply) sections.push({ heading: a.name, items: splitIdeas(res.reply) });
  }
  if (sections.length) {
    await store.addDocCard(state.currentWsId, state.currentChId, { emoji: "💡", title: `아이디어 보드 — ${topic}`, sections });
  }
}

function hideCmdPalette() { const p = $("cmd-palette"); if (p) { p.hidden = true; p.innerHTML = ""; } }

function updateCmdPalette() {
  const pal = $("cmd-palette");
  if (!pal) return;
  const v = input.value;
  if (!v.startsWith("/") || /\s/.test(v)) { pal.hidden = true; return; }
  const q = v.slice(1).toLowerCase();
  const matches = COMMANDS.filter((c) => q === "" || c.name.startsWith(q) || c.aliases.some((a) => a.startsWith(q)));
  if (!matches.length) { pal.hidden = true; return; }
  pal.innerHTML = matches.map((c, i) => `<div class="cmd-item${i === 0 ? " active" : ""}" data-name="${c.name}"><code>${esc(c.usage)}</code><span>${esc(c.desc)}</span>${tagBadge(c.tag)}</div>`).join("");
  pal.hidden = false;
  pal.querySelectorAll(".cmd-item").forEach((el) => el.onclick = () => {
    const c = COMMANDS.find((x) => x.name === el.dataset.name);
    input.value = "/" + c.name + (c.arg ? " " : "");
    hideCmdPalette(); input.focus();
    input.style.height = "auto"; input.style.height = Math.min(160, input.scrollHeight) + "px";
  });
}

function tagBadge(t) {
  if (t === "collab") return `<span class="cmd-tag collab">🗣️ 협업</span>`;
  if (t === "synth") return `<span class="cmd-tag synth">🤖 합성</span>`;
  return "";
}
function openHelpModal() {
  const rows = COMMANDS.map((c) => `<div class="cmd-row"><code>${esc(c.usage)}</code><span>${esc(c.desc)}</span>${tagBadge(c.tag)}</div>`).join("");
  openModal(`
    <h3>⌨️ 명령어</h3>
    <p class="sub">입력창에 <code>/</code>를 치면 자동완성이 떠요. 방향키·Enter로 선택할 수 있어요.</p>
    <div class="cmd-list">${rows}</div>
    <p class="sub" style="margin-top:4px"><span class="cmd-tag collab">🗣️ 협업</span> 여러 에이전트가 각자 발언 → <b>대화가 그대로 보입니다</b> · <span class="cmd-tag synth">🤖 합성</span> 팀 지식으로 AI가 1회 정리.<br>＊ <b>@에이전트 2명 이상</b>을 한 번에 부르면 <code>/discuss</code> 없이도 원탁회의가 열립니다.</p>
    <div class="modal-actions"><button class="btn btn-primary" id="help-close">닫기</button></div>`);
  $("help-close").onclick = closeModal;
}

async function runDiscuss(arg) {
  const cas = channelAgents();
  if (cas.length < 2) { toast("토의는 이 채널에 에이전트가 2명 이상일 때 열려요."); return; }
  await store.sendMessage(state.currentWsId, state.currentChId, {
    senderId: state.user.uid, senderType: "user", senderName: meName(), content: `🗣️ 토의 주제 — ${arg}`, mentions: [],
  });
  runRoundtable(cas, arg, arg);
}

async function runVisualize(arg) {
  const wsId = state.currentWsId, chId = state.currentChId;
  toast("📊 시각화를 그리는 중…");
  const recent = state.messages.filter((m) => !m.kind && m.senderType !== "system").slice(-12).map((m) => ({ senderName: m.senderName, content: m.content }));
  const data = await ai.visualize({ topic: arg, recent });
  if (!data || !data.code) { toast("시각화를 만들지 못했어요 (AI 연결을 확인하세요)."); return; }
  await store.addDiagramCard(wsId, chId, data);
}

async function runEvaluate(arg) {
  const cas = channelAgents();
  if (!cas.length) { toast("평가할 에이전트가 이 채널에 없어요."); return; }
  await store.sendMessage(state.currentWsId, state.currentChId, {
    senderId: state.user.uid, senderType: "user", senderName: meName(), content: `⭐ 평가 요청 — ${arg}`, mentions: [],
  });
  toast("⭐ 에이전트들이 평가 중…");
  const scores = [];
  for (const a of cas) {
    try {
      const memories = await store.fetchTopMemories(state.currentWsId, a.id, 4);
      const r = await ai.score({ agent: a, memories, item: arg });
      if (r) { scores.push({ name: a.name, score: r.score, reason: r.reason }); await awardExp(a.id, EXP.ANSWER, 0, 1); }
    } catch (err) { console.error(err); }
  }
  if (!scores.length) { toast("평가를 만들지 못했어요 (AI 연결을 확인하세요)."); return; }
  await store.addScoreCard(state.currentWsId, state.currentChId, { topic: arg, scores });
}

function meName() {
  return (state.user?.email || "나").split("@")[0];
}

// 에이전트 응답 파이프라인
async function triggerAgent(agent, userText) {
  const chId = state.currentChId, wsId = state.currentWsId;
  const hue = agent.hue ?? hueFrom(agent.name);
  state.pending.push({ id: agent.id, name: agent.name, hue, level: agent.level });
  renderMessages();
  try {
    const memories = await store.fetchTopMemories(wsId, agent.id, 6);
    const recent = state.messages.slice(-12).map((m) => ({ senderName: m.senderName, content: m.content }));
    const res = await ai.respond({
      agent, memories, recent, userName: meName(), userText,
      levelName: levelInfo(agent.level).name,
    });
    await store.sendMessage(wsId, chId, {
      senderId: agent.id, senderType: "agent", senderName: agent.name,
      content: res.reply, agentId: agent.id,
      sources: (res.sources || []).map((n) => String(memories[n - 1] || "").slice(0, 70)).filter(Boolean),
    });
    if (res.ok) {
      let learnedDelta = 0;
      if (res.learned) {
        await store.addMemory(wsId, agent.id, { content: res.learned, sourceChannelId: chId });
        learnedDelta = 1;
        toast(`🧠 ${agent.name}이(가) 새로운 걸 배웠어요!`);
      }
      await awardExp(agent.id, EXP.ANSWER + (res.learned ? EXP.LEARN : 0), learnedDelta, 1);
    }
  } catch (err) {
    console.error(err);
    try {
      await store.sendMessage(wsId, chId, {
        senderId: agent.id, senderType: "agent", senderName: agent.name,
        content: "앗, 방금은 대답을 못했어요. 잠시 후 다시 불러주세요.", agentId: agent.id,
      });
    } catch (_) {}
  } finally {
    state.pending = state.pending.filter((p) => p.id !== agent.id);
    renderMessages();
  }
}

// 🤝 원탁회의(부가 기능) — 여러 에이전트가 순서대로 서로를 보고 토론 → 결론 카드
async function runRoundtable(participants, topic, userText) {
  const wsId = state.currentWsId, chId = state.currentChId;
  const soFar = [];
  toast(`🤝 원탁회의 시작 — ${participants.map((a) => a.name).join(", ")}`);
  const baseRecent = state.messages.slice(-10).map((m) => ({ senderName: m.senderName, content: m.content }));
  for (const agent of participants) {
    const hue = agent.hue ?? hueFrom(agent.name);
    state.pending.push({ id: agent.id, name: agent.name, hue, level: agent.level });
    renderMessages();
    try {
      const memories = await store.fetchTopMemories(wsId, agent.id, 5);
      const others = participants.filter((a) => a.id !== agent.id).map((a) => a.name);
      const res = await ai.respond({
        agent, memories, recent: baseRecent, userName: meName(), userText,
        levelName: levelInfo(agent.level).name,
        meeting: { topic, others, soFar: [...soFar] },
      });
      await store.sendMessage(wsId, chId, {
        senderId: agent.id, senderType: "agent", senderName: agent.name, content: res.reply, agentId: agent.id,
        sources: (res.sources || []).map((n) => String(memories[n - 1] || "").slice(0, 70)).filter(Boolean),
      });
      soFar.push({ name: agent.name, content: res.reply });
      if (res.ok) {
        let learnedDelta = 0;
        if (res.learned) { await store.addMemory(wsId, agent.id, { content: res.learned, sourceChannelId: chId }); learnedDelta = 1; }
        await awardExp(agent.id, EXP.ANSWER + (res.learned ? EXP.LEARN : 0), learnedDelta, 1);
      }
    } catch (err) { console.error(err); }
    finally {
      state.pending = state.pending.filter((p) => p.id !== agent.id);
      renderMessages();
    }
  }
  // 회의 결론 카드
  try {
    if (soFar.length) {
      const data = await ai.summarize([{ senderName: meName(), content: "회의 주제: " + topic }, ...soFar.map((s) => ({ senderName: s.name, content: s.content }))]);
      if (data) await store.addSummaryCard(wsId, chId, data, "meeting");
    }
  } catch (err) { console.error(err); }
}

// 경험치 + 레벨업 처리
async function awardExp(agentId, expDelta, knowledgeDelta, answerDelta = 0) {
  const a = state.agents.find((x) => x.id === agentId);
  if (!a) return;
  const before = a.level;
  const newExp = (a.exp || 0) + expDelta;
  const after = levelForExp(newExp).level;
  await store.applyGrowth(state.currentWsId, agentId, {
    expDelta, knowledgeDelta, answerDelta, newLevel: after !== before ? after : undefined,
  });
  if (state.selectedAgentId === agentId) { triggerEat(); }
  if (after > before) {
    toast(`🎉 ${a.name} 진화! ${levelInfo(before).name} → ${levelInfo(after).name}`, "levelup");
    // 진화 연출은 패널에서만(업무 채팅창엔 아무것도 안 남김) — 부가 요소로 절제
    if (state.selectedAgentId === agentId) celebrateEvolution(after, a);
  }
}

// ======================= 에이전트 패널 =======================
function renderPanel() {
  const a = state.agents.find((x) => x.id === state.selectedAgentId);
  if (!a) { $("panel-empty").hidden = false; $("panel-body").hidden = true; return; }
  $("panel-empty").hidden = true; $("panel-body").hidden = false;
  const hue = a.hue ?? hueFrom(a.name);
  drawPet($("pet-canvas"), a.level, hue);
  $("pet-name").textContent = a.name;
  const info = levelInfo(a.level);
  $("pet-level").textContent = `Lv.${a.level} · ${info.name}`;
  const pr = progress(a.exp || 0);
  $("exp-bar").style.width = Math.round(pr.ratio * 100) + "%";
  $("exp-text").textContent = pr.next ? `EXP ${a.exp || 0} · 다음 진화까지 ${pr.next.cumExp - (a.exp || 0)}` : `EXP ${a.exp || 0} · 최종 진화 완료 👑`;
  $("pet-blurb").textContent = info.blurb;
  $("pet-stats").innerHTML =
    `<div class="stat"><b>${a.knowledgeCount || 0}</b><span>학습 지식</span></div>
     <div class="stat"><b>${a.answerCount || 0}</b><span>도움 답변</span></div>
     <div class="stat"><b>${(a.channelIds || []).length}</b><span>참여 채널</span></div>`;
  renderPetActions(a);
  renderMemories();
}

let delArmed = false;
function renderPetActions(a) {
  delArmed = false;
  const inChan = state.currentChId && (currentChannel()?.agentIds || []).includes(a.id);
  $("pet-actions").innerHTML =
    `<button class="mini-btn" id="pa-edit">✏️ 편집</button>` +
    (state.currentChId ? `<button class="mini-btn" id="pa-chan">${inChan ? "➖ 채널에서 빼기" : "➕ 이 채널에 추가"}</button>` : "") +
    `<button class="mini-btn" id="pa-clone">📤 복제</button>` +
    `<button class="mini-btn danger" id="pa-del">🗑️ 삭제</button>`;
  $("pa-edit").onclick = () => openEditAgentModal(a);
  $("pa-clone").onclick = () => openCloneAgentModal(a);
  const paChan = $("pa-chan");
  if (paChan) paChan.onclick = async () => {
    try {
      if (inChan) { await store.removeAgentFromChannel(state.currentWsId, state.currentChId, a.id); toast("채널에서 뺐어요."); }
      else { await store.addAgentToChannel(state.currentWsId, state.currentChId, a.id); toast("채널에 추가했어요."); }
    } catch (e) { toast("실패: " + (e.message || e)); }
  };
  $("pa-del").onclick = async () => {
    if (!delArmed) { delArmed = true; $("pa-del").textContent = "정말 삭제? (한 번 더)"; return; }
    try {
      await store.deleteAgent(state.currentWsId, a.id, a.channelIds || []);
      state.selectedAgentId = null;
      if (state.unsub.memories) { state.unsub.memories(); state.unsub.memories = null; }
      renderPanel();
      toast(`'${a.name}'을(를) 삭제했어요.`);
    } catch (e) { toast("삭제 실패: " + (e.message || e)); }
  };
}

function verbOpts(cur) {
  return ["간결", "보통", "자세히"].map((v) => `<option value="${v}"${(cur || "보통") === v ? " selected" : ""}>${v}</option>`).join("");
}

// 📤 에이전트 복제 — 역할·튜닝(레시피)만 복사, 학습 지식은 안 가져감 (기밀 유출 방지)
function openCloneAgentModal(a) {
  const targets = state.workspaces;
  if (!targets.length) { toast("복제할 워크스페이스가 없어요."); return; }
  const list = targets.map((w) => `<button class="btn export-fmt clone-target" data-ws="${w.id}">${esc(firstGrapheme(w.name).toUpperCase())} ${esc(w.name)}${w.id === state.currentWsId ? " (현재)" : ""}</button>`).join("");
  openModal(`
    <h3>📤 '${esc(a.name)}' 복제</h3>
    <p class="sub">역할·말투·설정(레시피)만 복사돼요. <b>학습한 지식(메모리)은 복사되지 않아</b> 기밀 유출 걱정이 없고, 새 방에서 알부터 다시 자랍니다.</p>
    <div class="export-grid">${list}</div>
    <div class="modal-actions"><button class="btn" id="cl-close">닫기</button></div>`);
  $("cl-close").onclick = closeModal;
  $("modal").querySelectorAll(".clone-target").forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try {
      await store.createAgent(b.dataset.ws, state.user.uid, {
        name: a.name, persona: a.persona || "", hue: a.hue ?? hueFrom(a.name),
        tone: a.tone || "", verbosity: a.verbosity || "보통",
      });
      closeModal();
      toast(`'${a.name}' 복제 완료 — 새 방에서 알(🥚)부터 시작해요.`);
    } catch (err) { toast("복제 실패: " + (err.message || err)); b.disabled = false; }
  });
}
function openEditAgentModal(a) {
  const cur = a.hue ?? hueFrom(a.name);
  const hueDots = HUES.map((h) => `<div class="hue-dot${cur === h ? " is-active" : ""}" data-hue="${h}" style="background:hsl(${h},62%,60%)"></div>`).join("");
  openModal(`
    <h3>에이전트 편집</h3>
    <p class="sub">역할을 바꾸면 다음 답변부터 반영돼요(학습한 지식은 유지).</p>
    <div class="field"><span>이름</span><input id="ed-name" maxlength="40" value="${esc(a.name)}" /></div>
    <div class="field"><span>역할 · 성격 (시스템 프롬프트)</span><textarea id="ed-persona">${esc(a.persona || "")}</textarea></div>
    <div class="field"><span>말투 · 톤 (선택)</span><input id="ed-tone" maxlength="120" value="${esc(a.tone || "")}" placeholder="예: 친근하고 격려하는 톤 / 냉정하고 분석적으로" /></div>
    <div class="field"><span>답변 길이</span><select id="ed-verb">${verbOpts(a.verbosity)}</select></div>
    <div class="field"><span>색</span><div class="hue-row" id="ed-hue">${hueDots}</div></div>
    <div class="modal-actions"><button class="btn" id="ed-cancel">취소</button><button class="btn btn-primary" id="ed-save">저장</button></div>`);
  let hue = cur;
  $("ed-hue").querySelectorAll(".hue-dot").forEach((d) => d.onclick = () => {
    hue = +d.dataset.hue; $("ed-hue").querySelectorAll(".hue-dot").forEach((x) => x.classList.remove("is-active")); d.classList.add("is-active");
  });
  $("ed-cancel").onclick = closeModal;
  $("ed-save").onclick = async () => {
    const name = $("ed-name").value.trim();
    if (!name) { toast("이름을 입력하세요."); return; }
    $("ed-save").disabled = true;
    try { await store.updateAgent(state.currentWsId, a.id, { name, persona: $("ed-persona").value.trim(), hue, tone: $("ed-tone").value.trim(), verbosity: $("ed-verb").value }); closeModal(); toast("에이전트를 수정했어요."); }
    catch (e) { toast("수정 실패: " + (e.message || e)); $("ed-save").disabled = false; }
  };
}

function renderMemories() {
  $("mem-count").textContent = state.memories.length;
  const ul = $("mem-list");
  if (!state.memories.length) { ul.innerHTML = `<li class="mem-empty">아직 학습한 지식이 없어요. 대화에서 배운 내용이 여기 쌓이고, 메시지의 🧠 버튼으로 직접 승격할 수도 있어요.</li>`; return; }
  ul.innerHTML = state.memories.map((m) => `<li class="mem-item${m.promoted ? " promoted" : ""}">
    <div class="mem-meta"><span class="mem-badge${m.promoted ? " p" : ""}">${m.promoted ? "🧠 승격" : "자동"}</span>
      <span class="mem-acts">${m.promoted ? "" : `<button class="mem-act mem-up" data-id="${m.id}" title="팀 기억으로 승격 — 답변에 우선 반영">🧠</button>`}<button class="mem-act mem-del" data-id="${m.id}" title="이 기억 삭제">✕</button></span></div>
    ${esc(m.content)}</li>`).join("");
  ul.querySelectorAll(".mem-up").forEach((b) => b.onclick = async () => {
    try { await store.promoteMemory(state.currentWsId, state.selectedAgentId, b.dataset.id, state.user.uid); toast("🧠 승격했어요 — 답변에 우선 반영됩니다."); }
    catch (e) { toast("승격 실패: " + (e.message || e)); }
  });
  ul.querySelectorAll(".mem-del").forEach((b) => b.onclick = async () => {
    try {
      await store.deleteMemory(state.currentWsId, state.selectedAgentId, b.dataset.id);
      await store.applyGrowth(state.currentWsId, state.selectedAgentId, { knowledgeDelta: -1 });
      toast("기억을 삭제했어요.");
    } catch (e) { toast("삭제 실패: " + (e.message || e)); }
  });
}

function triggerEat() {
  const cv = $("pet-canvas");
  cv.classList.remove("eating"); void cv.offsetWidth; cv.classList.add("eating");
  const a = state.agents.find((x) => x.id === state.selectedAgentId);
  if (a) { const hue = a.hue ?? hueFrom(a.name); drawPet(cv, a.level, hue, "eat"); setTimeout(() => drawPet(cv, a.level, hue, "idle"), 480); }
  flyBubble("💬");
}

// ✨ 진화의 순간(부가 연출) — 패널 글로우 + 은은한 스파크 8개, 새 단계로 즉시 리드로우
function celebrateEvolution(afterLevel, agent) {
  const stage = $("pet-stage");
  if (!stage) return;
  stage.classList.remove("evolving"); void stage.offsetWidth; stage.classList.add("evolving");
  drawPet($("pet-canvas"), afterLevel, agent.hue ?? hueFrom(agent.name));
  const host = $("pet-bubbles");
  if (!host) return;
  for (let i = 0; i < 8; i++) {
    const s = document.createElement("div");
    s.className = "spark";
    const ang = (Math.PI * 2 * i) / 8;
    const dist = 40 + (i % 3) * 12;
    s.style.setProperty("--sx", Math.cos(ang) * dist + "px");
    s.style.setProperty("--sy", Math.sin(ang) * dist + "px");
    host.appendChild(s);
    requestAnimationFrame(() => s.classList.add("go"));
    setTimeout(() => s.remove(), 850);
  }
}

function flyBubble(emoji) {
  const stage = $("pet-bubbles");
  if (!stage) return;
  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = emoji + " +EXP";
  b.style.left = (10 + Math.random() * 40) + "%";
  b.style.top = "70%";
  stage.appendChild(b);
  requestAnimationFrame(() => {
    b.style.setProperty("--dx", (10 + Math.random() * 20) + "px");
    b.style.setProperty("--dy", "-46px");
    b.classList.add("fly");
  });
  setTimeout(() => b.remove(), 1200);
}

// ======================= 모달 =======================
function openModal(html) { $("modal").innerHTML = html; $("modal-backdrop").hidden = false; }
function closeModal() { $("modal-backdrop").hidden = true; $("modal").innerHTML = ""; }
$("modal-backdrop").addEventListener("click", (e) => { if (e.target === $("modal-backdrop")) closeModal(); });

function openWorkspaceModal() {
  openModal(`
    <h3>워크스페이스</h3>
    <p class="sub">새로 만들거나, 초대받은 ID로 참여하세요.</p>
    <div class="field"><span>새 워크스페이스 이름</span><input id="mk-ws-name" placeholder="예: 연세 UX 캠프" maxlength="80" /></div>
    <div class="modal-actions"><button class="btn btn-primary" id="mk-ws-go">만들기</button></div>
    <hr style="border:0;border-top:1px solid var(--line);margin:18px 0" />
    <div class="field"><span>초대코드로 참여</span><input id="join-ws-id" placeholder="6자리 코드 (예: A7K2QX)" maxlength="40" style="text-transform:uppercase" /></div>
    <div class="field"><span>방 비밀번호 (4자리)</span><input id="join-ws-pin" placeholder="예: 0424" maxlength="4" inputmode="numeric" /></div>
    <div class="modal-actions">
      <button class="btn" id="ws-cancel">닫기</button>
      <button class="btn btn-primary" id="join-ws-go">참여</button>
    </div>`);
  $("ws-cancel").onclick = closeModal;
  $("mk-ws-go").onclick = async () => {
    const name = $("mk-ws-name").value.trim();
    if (!name) return;
    $("mk-ws-go").disabled = true;
    try {
      const wsId = await store.createWorkspace(state.user.uid, name);
      await store.createChannel(wsId, "일반", state.user.uid);
      closeModal();
      setTimeout(() => selectWorkspace(wsId), 300);
      toast("워크스페이스를 만들었어요 🎉");
    } catch (err) { toast("생성 실패: " + (err.message || err)); $("mk-ws-go").disabled = false; }
  };
  $("join-ws-go").onclick = async () => {
    const code = $("join-ws-id").value.trim();
    if (!code) return;
    $("join-ws-go").disabled = true;
    try {
      const name = await store.joinByCode(state.user.uid, code, $("join-ws-pin").value);
      closeModal();
      toast(`'${name}'에 참여했어요!`);
    } catch (err) { toast(err.message || "참여 실패 — 코드를 확인하세요."); $("join-ws-go").disabled = false; }
  };
}

$("ws-invite-btn").onclick = async () => {
  if (!state.currentWsId) return;
  const ws = state.workspaces.find((w) => w.id === state.currentWsId);
  let code = ws?.code, pin = ws?.pin;
  try { const meta = await store.ensureWorkspaceCode(state.currentWsId, ws); code = meta.code; pin = meta.pin; } catch (_) {}
  openModal(`
    <h3>멤버 초대</h3>
    <p class="sub"><b>6자리 코드</b>와 <b>4자리 비밀번호</b>를 팀원에게 알려주세요. '워크스페이스 ＋ → 참여'에 입력하면 들어옵니다.</p>
    <div class="invite-code" id="invite-code">${esc(code || "------")}</div>
    <div class="invite-pin">🔒 비밀번호 <b>${esc(pin || "----")}</b></div>
    <div class="modal-actions">
      <button class="btn" id="inv-copy">코드+비번 복사</button>
      <button class="btn btn-primary" id="inv-close">닫기</button>
    </div>`);
  $("inv-close").onclick = closeModal;
  $("inv-copy").onclick = async () => {
    try { await navigator.clipboard.writeText(`AgentRoom 초대 — 코드: ${code} / 비밀번호: ${pin}`); } catch (_) {}
    $("inv-copy").textContent = "복사됨!";
  };
};

$("add-channel-btn").onclick = () => {
  if (!state.currentWsId) { toast("먼저 워크스페이스를 선택하세요."); return; }
  openModal(`
    <h3>채널 추가</h3>
    <p class="sub">주제별로 대화를 나눌 채널을 만들어요.</p>
    <div class="field"><span>채널 이름</span><input id="mk-ch-name" placeholder="예: 기획-회의" maxlength="60" /></div>
    <div class="modal-actions"><button class="btn" id="ch-cancel">취소</button><button class="btn btn-primary" id="mk-ch-go">만들기</button></div>`);
  $("ch-cancel").onclick = closeModal;
  $("mk-ch-go").onclick = async () => {
    const name = $("mk-ch-name").value.trim();
    if (!name) return;
    $("mk-ch-go").disabled = true;
    try { const id = await store.createChannel(state.currentWsId, name, state.user.uid); closeModal(); setTimeout(() => selectChannel(id), 250); }
    catch (err) { toast("생성 실패: " + (err.message || err)); $("mk-ch-go").disabled = false; }
  };
};

$("add-agent-btn").onclick = openCreateAgentModal;
function openCreateAgentModal() {
  if (!state.currentWsId) { toast("먼저 워크스페이스를 선택하세요."); return; }
  const hueDots = HUES.map((h, i) => `<div class="hue-dot${i === 0 ? " is-active" : ""}" data-hue="${h}" style="background:hsl(${h},62%,60%)"></div>`).join("");
  openModal(`
    <h3>새 에이전트 만들기 🥚</h3>
    <p class="sub">알에서 시작해 팀과 대화하며 자라납니다. 역할(성격)을 정해주세요.</p>
    <div class="field"><span>이름</span><input id="mk-ag-name" placeholder="예: 재무봇" maxlength="40" /></div>
    <div class="field"><span>역할 · 성격 (시스템 프롬프트)</span>
      <textarea id="mk-ag-persona" placeholder="예: 너는 스타트업 재무 전문가야. 재무제표를 쉽게 풀어 설명하고, 숫자엔 항상 근거를 붙여."></textarea></div>
    <div class="field"><span>말투 · 톤 (선택)</span><input id="mk-ag-tone" maxlength="120" placeholder="예: 친근하고 격려하는 톤 / 냉정하고 분석적으로" /></div>
    <div class="field"><span>답변 길이</span><select id="mk-ag-verb">${verbOpts("보통")}</select></div>
    <div class="field"><span>색</span><div class="hue-row" id="hue-row">${hueDots}</div></div>
    <div class="modal-actions"><button class="btn" id="ag-cancel">취소</button><button class="btn btn-primary" id="mk-ag-go">부화 준비 🥚</button></div>`);
  let hue = HUES[0];
  $("hue-row").querySelectorAll(".hue-dot").forEach((d) => d.onclick = () => {
    hue = +d.dataset.hue; $("hue-row").querySelectorAll(".hue-dot").forEach((x) => x.classList.remove("is-active")); d.classList.add("is-active");
  });
  $("ag-cancel").onclick = closeModal;
  $("mk-ag-go").onclick = async () => {
    const name = $("mk-ag-name").value.trim();
    if (!name) { toast("이름을 입력하세요."); return; }
    $("mk-ag-go").disabled = true;
    try {
      const agentId = await store.createAgent(state.currentWsId, state.user.uid, { name, persona: $("mk-ag-persona").value.trim(), hue, tone: $("mk-ag-tone").value.trim(), verbosity: $("mk-ag-verb").value });
      if (state.currentChId) await store.addAgentToChannel(state.currentWsId, state.currentChId, agentId);
      closeModal();
      setTimeout(() => selectAgent(agentId), 300);
      toast(`${name} 알이 채널에 놓였어요! @${name} 하고 말 걸어보세요 🥚`);
    } catch (err) { toast("생성 실패: " + (err.message || err)); $("mk-ag-go").disabled = false; }
  };
}

function openAddAgentToChannelModal() {
  if (!state.currentChId) return;
  const ch = currentChannel();
  const available = state.agents.filter((a) => !(ch.agentIds || []).includes(a.id));
  const list = available.length
    ? available.map((a) => `<div class="agent-pick" data-id="${a.id}"><canvas width="32" height="32"></canvas><div><div style="font-weight:600">${esc(a.name)}</div><div style="font-size:11px;color:var(--txt-mute)">Lv.${a.level} ${esc(levelInfo(a.level).name)}</div></div></div>`).join("")
    : `<p class="sub">이 워크스페이스의 모든 에이전트가 이미 채널에 있어요.</p>`;
  openModal(`
    <h3># ${esc(ch.name)} 에 에이전트 추가</h3>
    <p class="sub">한 에이전트는 여러 채널에 참여할 수 있어요(집단지성 공유).</p>
    <div style="max-height:280px;overflow:auto;margin-bottom:12px">${list}</div>
    <div class="modal-actions">
      <button class="btn" id="aac-close">닫기</button>
      <button class="btn btn-primary" id="aac-new">＋ 새로 만들기</button>
    </div>`);
  $("modal").querySelectorAll(".agent-pick").forEach((el) => {
    const a = state.agents.find((x) => x.id === el.dataset.id);
    drawPet(el.querySelector("canvas"), a.level, a.hue ?? hueFrom(a.name));
    el.onclick = async () => {
      await store.addAgentToChannel(state.currentWsId, state.currentChId, el.dataset.id);
      closeModal();
      toast(`${a.name}을(를) 채널에 추가했어요.`);
    };
  });
  $("aac-close").onclick = closeModal;
  $("aac-new").onclick = () => { closeModal(); openCreateAgentModal(); };
}

// 대화 맥락 압축(요약 카드) — 헤더 버튼과 /요약 명령에서 공용
async function doSummarize() {
  if (!state.currentChId) return;
  const real = state.messages.filter((m) => m.kind !== "summary" && m.senderType !== "system");
  if (real.length < 2) { toast("요약할 대화가 아직 적어요."); return; }
  const btn = $("summarize-btn"); const old = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "요약 중…"; }
  try {
    const data = await ai.summarize(real.slice(-40).map((m) => ({ senderName: m.senderName, content: m.content })));
    if (!data) { toast("요약을 만들지 못했어요 (AI 연결을 확인하세요)."); return; }
    await store.addSummaryCard(state.currentWsId, state.currentChId, data);
    toast("🧵 대화 맥락을 압축했어요.");
  } catch (e) { toast("요약 실패: " + (e.message || e)); }
  finally { if (btn) { btn.disabled = false; btn.textContent = old; } }
}
$("summarize-btn").addEventListener("click", doSummarize);

// 내보내기(Export)
function currentExportMeta() {
  const ws = state.workspaces.find((w) => w.id === state.currentWsId);
  return { workspace: ws?.name || "AgentRoom", channel: currentChannel()?.name || "channel" };
}
function doExport(fmtKey) {
  const f = exporter.FORMATS[fmtKey];
  if (!f || !state.currentChId) return;
  const meta = currentExportMeta();
  const content = f.fn(state.messages, meta);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const safeCh = (meta.channel || "channel").replace(/[^\w가-힣ㄱ-ㅎ]/g, "_");
  exporter.download(`AgentRoom_${safeCh}_${stamp}.${f.ext}`, f.mime, content);
  toast(`${f.label} 파일로 내보냈어요.`);
  closeModal();
}
function openExportModal() {
  if (!state.currentChId) { toast("먼저 채널을 선택하세요."); return; }
  const btns = Object.entries(exporter.FORMATS).map(([k, f]) => `<button class="btn export-fmt" data-fmt="${k}">${esc(f.label)}</button>`).join("");
  openModal(`
    <h3>⤓ 내보내기</h3>
    <p class="sub"># ${esc(currentExportMeta().channel)} 의 대화와 산출물(요약·회의결론·평가·계획·다이어그램 등)을 파일로 저장합니다.</p>
    <div class="export-grid">${btns}</div>
    <div class="modal-actions"><button class="btn" id="exp-close">닫기</button></div>`);
  $("exp-close").onclick = closeModal;
  $("modal").querySelectorAll(".export-fmt").forEach((b) => b.onclick = () => doExport(b.dataset.fmt));
}
$("export-btn").addEventListener("click", openExportModal);

// 자율개입 토글
$("auto-toggle").addEventListener("change", async (e) => {
  if (!state.currentChId) return;
  try {
    await store.setChannelAuto(state.currentWsId, state.currentChId, e.target.checked);
    toast(e.target.checked ? "자율개입 ON — 질문(?)에 대표 에이전트가 스스로 답해요." : "자율개입 OFF — @멘션할 때만 답합니다.");
  } catch (err) { toast("설정 실패"); e.target.checked = !e.target.checked; }
});

setAuthMode("login");
