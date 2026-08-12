// ar-ai.js — 에이전트 두뇌 (Firebase AI Logic / Gemini 2.5 Flash)
//
// 응답 + 셀프러닝(reflection)을 한 번의 호출로 처리한다:
// 모델이 STRICT JSON { reply, learned } 를 반환 →
//   reply  : 채널에 게시할 답변
//   learned: 이번 대화에서 새로 알게 된, 앞으로 기억할 지식 한 줄 (없으면 null)
import { ai } from "./firebase-config.js";
import { getGenerativeModel } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-ai.js";

const TIMEOUT_MS = 25000;
let _model = null;
let _initError = null;

function model() {
  if (_model || _initError) return _model;
  try {
    _model = getGenerativeModel(ai, {
      model: "gemini-flash-latest",
      generationConfig: { responseMimeType: "application/json", temperature: 0.8 },
    });
  } catch (e) {
    _initError = e;
  }
  return _model;
}

function withTimeout(p, ms) {
  let t;
  const to = new Promise((_, rej) => (t = setTimeout(() => rej(Object.assign(new Error("timeout"), { isTimeout: true })), ms)));
  return Promise.race([p, to]).finally(() => clearTimeout(t));
}

function parseJson(text) {
  if (typeof text !== "string") return null;
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch (_) {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) {} }
  return null;
}

// ================= 두뇌 프로바이더 계층 (Gemini ↔ Hermes) =================
// 인프라(프록시 서버)가 아직 없으므로 BYOK(Bring Your Own Key) 방식:
// 사용자가 ⚙️ 두뇌 설정에서 자기 API 키를 넣으면 이 브라우저(localStorage)에만 저장되고,
// OpenRouter 등 OpenAI 호환 API로 직접 호출한다(연산은 전부 외부에서 처리).
// Hermes 실패 시 Gemini로 자동 폴백 → 데모가 중간에 죽지 않는다.
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_HERMES_MODEL = "nousresearch/hermes-3-llama-3.1-70b";
const BRAIN_KEY = "agentroom_brain_v1";

export function getBrainConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(BRAIN_KEY) || "null");
    return c && c.provider ? c : { provider: "gemini" };
  } catch (_) { return { provider: "gemini" }; }
}
export function setBrainConfig(cfg) {
  try { localStorage.setItem(BRAIN_KEY, JSON.stringify(cfg || { provider: "gemini" })); } catch (_) {}
}
export function brainLabel() {
  const c = getBrainConfig();
  return c.provider === "hermes" ? `Hermes · ${c.model || DEFAULT_HERMES_MODEL}` : "Gemini (기본)";
}
export const HERMES_DEFAULTS = { endpoint: OPENROUTER_URL, model: DEFAULT_HERMES_MODEL };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gemini 경로 — 429(무료 쿼터)면 자동 재시도(최대 2회, 백오프)
async function callGemini(prompt) {
  const m = model();
  if (!m) throw new Error("Gemini 미연결");
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await withTimeout(m.generateContent(prompt), TIMEOUT_MS);
      return res.response.text();
    } catch (e) {
      lastErr = e;
      if (e && e.isTimeout) throw e;
      if (isQuotaError(e) && i < 2) { await sleep(2800 + i * 4000); continue; }
      throw e;
    }
  }
  throw lastErr;
}

// Hermes 경로 — OpenAI 호환 chat/completions (OpenRouter·Together 등)
async function callHermes(cfg, prompt, useJsonFormat = true) {
  const body = {
    model: cfg.model || DEFAULT_HERMES_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.8,
  };
  if (useJsonFormat) body.response_format = { type: "json_object" };
  const res = await withTimeout(fetch(cfg.endpoint || OPENROUTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.apiKey },
    body: JSON.stringify(body),
  }), TIMEOUT_MS);
  if (res.status === 400 && useJsonFormat) return callHermes(cfg, prompt, false); // response_format 미지원 모델 폴백
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Hermes HTTP ${res.status} ${t.slice(0, 160)}`);
  }
  const data = await res.json();
  const out = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";
  if (!out) throw new Error("Hermes 빈 응답");
  return out;
}

// 통합 진입점 — 모든 AI 기능이 이 함수만 호출한다
// 전역 직렬 큐 — 동시 호출이 무료 RPM을 넘어 후반 에이전트가 전부 사과문을
// 백는 데모 사망 시나리오 방지. 호출 사이 1.2초 간격.
let llmChain = Promise.resolve();
function callLLM(prompt) {
  const run = llmChain.then(() => callLLMNow(prompt));
  llmChain = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 1200)));
  return run;
}

async function callLLMNow(prompt) {
  const cfg = getBrainConfig();
  if (cfg.provider === "hermes" && cfg.apiKey) {
    try { return await callHermes(cfg, prompt); }
    catch (e) {
      console.warn("[AgentRoom] Hermes 실패 → Gemini 폴백:", e.message);
      try { return await callGemini(prompt); }
      catch (e2) { throw (isQuotaError(e2) ? e2 : e); }
    }
  }
  return callGemini(prompt);
}

// ⚙️ 두뇌 설정 모달의 연결 테스트
export async function testBrain() {
  const t0 = performance.now();
  const text = await callLLM('아래 STRICT JSON만 출력하라(코드펜스 금지): {"ok": true, "hello": "짧은 한국어 인사 한 문장"}');
  const p = parseJson(text);
  return { ms: Math.round(performance.now() - t0), reply: (p && p.hello) ? p.hello : String(text).slice(0, 80) };
}

function buildPrompt({ agent, memories, recent, userName, userText, levelName, meeting }) {
  const mem = memories.length
    ? memories.map((m, i) => `  ${i + 1}. ${m}`).join("\n")
    : "  (아직 학습한 지식이 없습니다. 이번 대화가 첫 배움일 수 있습니다.)";
  const convo = recent.length
    ? recent.map((m) => `${m.senderName}: ${m.content}`).join("\n")
    : "(이전 대화 없음)";

  // 원탁회의 모드: 다른 에이전트들과 함께 토론
  const meetingBlock = meeting
    ? `

[지금은 여러 에이전트가 함께하는 원탁회의다]
회의 주제: ${meeting.topic}
참여 에이전트: ${meeting.others.length ? meeting.others.join(", ") + ", 그리고 너" : "너"}
${meeting.soFar && meeting.soFar.length ? "이번 회의에서 이미 나온 발언:\n" + meeting.soFar.map((s) => `${s.name}: ${s.content}`).join("\n") : "네가 첫 발언자다."}

회의 지침:
- 앞선 발언이 있으면 그 사람 이름을 부르며 동의/보완하거나 근거를 들어 반박하라. 그냥 원론 반복 금지.
- 네 역할(정체성) 관점에서 회의 주제에 기여하라. 1~3문장으로 짧게.`
    : "";

  const style = [];
  if (agent.tone) style.push(`말투/톤: ${agent.tone}`);
  if (agent.verbosity === "간결") style.push("답변은 1~2문장으로 아주 간결하게.");
  else if (agent.verbosity === "자세히") style.push("필요하면 충분히 상세하게 설명하고 목록을 적극 활용하라.");
  const styleBlock = style.length ? `\n\n[답변 스타일]\n${style.join("\n")}` : "";

  return `너는 "${agent.name}"라는 이름의 AI 에이전트다. 팀 협업 워크스페이스(디스코드 같은 채널)에 살고 있으며, 팀원들과 대화하며 지식을 축적해 성장한다.
현재 성장 단계: ${levelName}.

[너의 정체성/역할]
${agent.persona || "특별히 지정된 역할이 없다. 팀에게 도움이 되는 친근한 조수로 행동하라."}${styleBlock}

[네가 지금까지 팀에게서 학습해 기억하는 지식]
${mem}

[최근 대화 흐름]
${convo}
${meetingBlock}

[방금 "${userName}"이(가) 너를 부르며 한 말]
${userText}

지침:
- 팀원에게 도움이 되도록 한국어로 자연스럽고 간결하게(2~5문장) 답하라. 필요하면 목록을 써도 된다.
- 위 "학습한 지식"과 관련 있으면 적극 활용하라(팀의 집단지성을 반영).
- 이번 대화에서 앞으로 계속 기억할 가치가 있는 사실/결정/선호/맥락을 하나 배웠다면 "learned"에 한국어 한 줄로 요약하라. 인사·잡담처럼 기억할 가치가 없으면 learned는 null로 둬라(아무거나 지어내지 마라).
- 답변에 위 "학습한 지식"을 실제로 활용했다면 그 번호들을 "sources"에 담아라(활용 안 했으면 빈 배열, 최대 3개).

반드시 아래 STRICT JSON만 출력하라(코드펜스·설명 금지):
{"reply": "채널에 올릴 답변(한국어)", "learned": "기억할 지식 한 줄(한국어) 또는 null", "sources": [활용한 지식 번호]}`;
}

const UNAVAILABLE_MSG =
  "지금은 두뇌에 연결하지 못했어요. 사이드바 하단 ⚙️ 두뇌 설정에서 연결 상태를 확인해 주세요. 그전까지는 알 속에서 여러분의 대화를 듣고 있을게요. 🥚";
const QUOTA_MSG =
  "지금 무료 사용량 한도(분당·일일)를 초과했어요. ⏳ 잠시 뒤 다시 불러주시면 돼요. (사용량이 많으면 Firebase Blaze 요금제로 한도를 올릴 수 있어요.)";

function isQuotaError(e) {
  const s = String((e && (e.message || e.code)) || "");
  return s.includes("429") || /quota|rate.?limit|resource.?exhausted/i.test(s);
}

/**
 * 에이전트 응답 생성.
 * @returns {Promise<{reply:string, learned:string|null, sources:number[], ok:boolean}>}
 * sources: 답변에 실제 활용한 학습 지식의 번호(1-based) — "출처 각주"용
 */
export async function respond({ agent, memories, recent, userName, userText, levelName, meeting }) {
  let text = null;
  try {
    text = await callLLM(buildPrompt({ agent, memories, recent, userName, userText, levelName, meeting }));
  } catch (e) {
    if (e && e.isTimeout) return { reply: "음... 생각이 너무 길어졌어요. 다시 한 번 불러주실래요?", learned: null, sources: [], ok: false };
    if (isQuotaError(e)) return { reply: QUOTA_MSG, learned: null, sources: [], ok: false };
    return { reply: UNAVAILABLE_MSG, learned: null, sources: [], ok: false };
  }

  const parsed = parseJson(text);
  if (!parsed || typeof parsed.reply !== "string") {
    // JSON 파싱 실패 시에도 raw 텍스트라도 답으로
    const fallback = (text && text.trim()) ? text.trim().slice(0, 800) : "답을 정리하지 못했어요. 다시 물어봐 주세요.";
    return { reply: fallback, learned: null, sources: [], ok: true };
  }
  const learned =
    typeof parsed.learned === "string" && parsed.learned.trim() && parsed.learned.trim().toLowerCase() !== "null"
      ? parsed.learned.trim()
      : null;
  const sources = Array.isArray(parsed.sources)
    ? parsed.sources.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= memories.length).slice(0, 3)
    : [];
  return { reply: parsed.reply.trim(), learned, sources, ok: true };
}

export function aiAvailable() {
  const cfg = getBrainConfig();
  if (cfg.provider === "hermes" && cfg.apiKey) return true;
  return !!model();
}

/**
 * 대화 맥락 압축(Dynamic Context Compressor).
 * @returns {Promise<{points:string[], issues:string[]}|null>}
 */
export async function summarize(messages) {
  const convo = messages.map((x) => `${x.senderName}: ${x.content}`).join("\n").slice(0, 8000);
  try {
    const text = await callLLM(
`다음은 팀 협업 채널의 대화다. 맥락을 잃지 않도록 압축해 STRICT JSON으로만 출력하라(코드펜스·설명 금지).
{"points": ["지금까지의 핵심 결정/합의/정보를 한국어 불릿 3~6개"], "issues": ["아직 미해결이거나 결정이 필요한 쟁점 0~4개(없으면 빈 배열)"]}

대화:
${convo}`);
    const parsed = parseJson(text);
    if (!parsed) return null;
    return {
      points: Array.isArray(parsed.points) ? parsed.points.slice(0, 6) : [],
      issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 4) : [],
    };
  } catch (_) {
    return null;
  }
}

/**
 * 시각화: 주제/대화를 mermaid 다이어그램으로.
 * @returns {Promise<{title:string, code:string}|null>}
 */
export async function visualize({ topic, recent }) {
  const convo = (recent || []).map((x) => `${x.senderName}: ${x.content}`).join("\n").slice(0, 4000);
  try {
    const text = await callLLM(
`아래 주제(및 대화 맥락)를 한눈에 보이는 다이어그램으로 만들어라. mermaid.js 문법으로 작성한다.
- 주제: ${topic}
- 대화 맥락:
${convo || "(없음)"}

규칙:
- 관계/흐름이면 flowchart(예: graph TD), 아이디어 확장이면 mindmap 을 골라라.
- 노드 라벨은 한국어로 짧게. 노드 텍스트에 (), :, ;, # 같은 특수문자는 넣지 말고, 꼭 필요하면 큰따옴표로 감싸라.
- 반드시 파싱 가능한 유효한 mermaid 코드여야 한다. 5~12개 노드 정도로 간결하게.
- STRICT JSON만 출력(코드펜스·설명 금지): {"title":"제목(한국어, 12자 내외)","code":"mermaid 코드"}`);
    const p = parseJson(text);
    if (!p || typeof p.code !== "string") return null;
    let code = p.code.trim().replace(/^```(?:mermaid)?\s*/i, "").replace(/```$/, "").trim();
    return { title: (p.title || "시각화").slice(0, 40), code };
  } catch (_) {
    return null;
  }
}

/**
 * 범용 구조화 카드 생성 — 어떤 지시든 {title, sections:[{heading, items[]}]} 로 반환.
 * plan/swot/tasks/pitch/name/canvas/brainstorm/decide 등 산출물 명령의 공용 엔진.
 */
export async function structuredCard(instruction) {
  try {
    const text = await callLLM(
      instruction +
      `\n\n반드시 아래 STRICT JSON만 출력하라(코드펜스·설명 금지). 모든 텍스트는 한국어:
{"title":"카드 제목(짧게)","sections":[{"heading":"소제목","items":["항목1","항목2"]}]}`);
    const p = parseJson(text);
    if (!p || !Array.isArray(p.sections)) return null;
    const sections = p.sections
      .filter((s) => s && s.heading)
      .map((s) => ({
        heading: String(s.heading).slice(0, 80),
        items: Array.isArray(s.items) ? s.items.map((x) => String(x)).filter(Boolean).slice(0, 12) : [],
      }))
      .slice(0, 8);
    if (!sections.length) return null;
    return { title: String(p.title || "").slice(0, 80), sections };
  } catch (_) {
    return null;
  }
}

/**
 * 평가: 에이전트가 대상을 1~10점으로 채점.
 * @returns {Promise<{score:number, reason:string}|null>}
 */
export async function score({ agent, memories, item }) {
  const mem = (memories && memories.length) ? memories.map((x, i) => `${i + 1}. ${x}`).join("\n") : "(없음)";
  try {
    const text = await callLLM(
`너는 "${agent.name}"이며 역할은 다음과 같다: ${agent.persona || "팀의 조력자"}.
아래 "평가 대상"을 너의 역할 관점에서 냉정하게 1~10점으로 평가하라(10=탁월, 1=매우 부족). 후하게 주지 마라.
[네가 아는 팀 지식]
${mem}
[평가 대상]
${item}
STRICT JSON만 출력(코드펜스 금지): {"score": 1에서 10 사이 정수, "reason": "핵심 근거 한국어 1~2문장"}`);
    const p = parseJson(text);
    if (!p) return null;
    let s = Number(p.score);
    if (!isFinite(s)) s = 5;
    s = Math.max(1, Math.min(10, Math.round(s)));
    return { score: s, reason: typeof p.reason === "string" ? p.reason.trim() : "" };
  } catch (_) {
    return null;
  }
}
