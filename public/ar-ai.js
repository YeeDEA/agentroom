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

반드시 아래 STRICT JSON만 출력하라(코드펜스·설명 금지):
{"reply": "채널에 올릴 답변(한국어)", "learned": "기억할 지식 한 줄(한국어) 또는 null"}`;
}

const UNAVAILABLE_MSG =
  "지금은 두뇌(Gemini)에 연결하지 못했어요. Firebase 콘솔 > AI Logic에서 활성화하면 제가 진짜로 대답할 수 있어요! 그전까지는 알 속에서 여러분의 대화를 듣고 있을게요. 🥚";
const QUOTA_MSG =
  "지금 무료 사용량 한도(분당·일일)를 초과했어요. ⏳ 잠시 뒤 다시 불러주시면 돼요. (사용량이 많으면 Firebase Blaze 요금제로 한도를 올릴 수 있어요.)";

function isQuotaError(e) {
  const s = String((e && (e.message || e.code)) || "");
  return s.includes("429") || /quota|rate.?limit|resource.?exhausted/i.test(s);
}

/**
 * 에이전트 응답 생성.
 * @returns {Promise<{reply:string, learned:string|null, ok:boolean}>}
 */
export async function respond({ agent, memories, recent, userName, userText, levelName, meeting }) {
  const m = model();
  if (!m) return { reply: UNAVAILABLE_MSG, learned: null, ok: false };

  let res;
  try {
    res = await withTimeout(
      m.generateContent(buildPrompt({ agent, memories, recent, userName, userText, levelName, meeting })),
      TIMEOUT_MS
    );
  } catch (e) {
    if (e && e.isTimeout) return { reply: "음... 생각이 너무 길어졌어요. 다시 한 번 불러주실래요?", learned: null, ok: false };
    if (isQuotaError(e)) return { reply: QUOTA_MSG, learned: null, ok: false };
    return { reply: UNAVAILABLE_MSG, learned: null, ok: false };
  }

  let text = null;
  try { text = res.response.text(); } catch (_) {}
  const parsed = parseJson(text);
  if (!parsed || typeof parsed.reply !== "string") {
    // JSON 파싱 실패 시에도 raw 텍스트라도 답으로
    const fallback = (text && text.trim()) ? text.trim().slice(0, 800) : "답을 정리하지 못했어요. 다시 물어봐 주세요.";
    return { reply: fallback, learned: null, ok: true };
  }
  const learned =
    typeof parsed.learned === "string" && parsed.learned.trim() && parsed.learned.trim().toLowerCase() !== "null"
      ? parsed.learned.trim()
      : null;
  return { reply: parsed.reply.trim(), learned, ok: true };
}

export function aiAvailable() {
  return !!model();
}

/**
 * 대화 맥락 압축(Dynamic Context Compressor).
 * @returns {Promise<{points:string[], issues:string[]}|null>}
 */
export async function summarize(messages) {
  const m = model();
  if (!m) return null;
  const convo = messages.map((x) => `${x.senderName}: ${x.content}`).join("\n").slice(0, 8000);
  try {
    const res = await withTimeout(
      m.generateContent(
`다음은 팀 협업 채널의 대화다. 맥락을 잃지 않도록 압축해 STRICT JSON으로만 출력하라(코드펜스·설명 금지).
{"points": ["지금까지의 핵심 결정/합의/정보를 한국어 불릿 3~6개"], "issues": ["아직 미해결이거나 결정이 필요한 쟁점 0~4개(없으면 빈 배열)"]}

대화:
${convo}`),
      TIMEOUT_MS
    );
    const parsed = parseJson(res.response.text());
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
  const m = model();
  if (!m) return null;
  const convo = (recent || []).map((x) => `${x.senderName}: ${x.content}`).join("\n").slice(0, 4000);
  try {
    const res = await withTimeout(
      m.generateContent(
`아래 주제(및 대화 맥락)를 한눈에 보이는 다이어그램으로 만들어라. mermaid.js 문법으로 작성한다.
- 주제: ${topic}
- 대화 맥락:
${convo || "(없음)"}

규칙:
- 관계/흐름이면 flowchart(예: graph TD), 아이디어 확장이면 mindmap 을 골라라.
- 노드 라벨은 한국어로 짧게. 노드 텍스트에 (), :, ;, # 같은 특수문자는 넣지 말고, 꼭 필요하면 큰따옴표로 감싸라.
- 반드시 파싱 가능한 유효한 mermaid 코드여야 한다. 5~12개 노드 정도로 간결하게.
- STRICT JSON만 출력(코드펜스·설명 금지): {"title":"제목(한국어, 12자 내외)","code":"mermaid 코드"}`),
      TIMEOUT_MS
    );
    const p = parseJson(res.response.text());
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
  const m = model();
  if (!m) return null;
  try {
    const res = await withTimeout(
      m.generateContent(
        instruction +
        `\n\n반드시 아래 STRICT JSON만 출력하라(코드펜스·설명 금지). 모든 텍스트는 한국어:
{"title":"카드 제목(짧게)","sections":[{"heading":"소제목","items":["항목1","항목2"]}]}`),
      TIMEOUT_MS
    );
    const p = parseJson(res.response.text());
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
  const m = model();
  if (!m) return null;
  const mem = (memories && memories.length) ? memories.map((x, i) => `${i + 1}. ${x}`).join("\n") : "(없음)";
  try {
    const res = await withTimeout(
      m.generateContent(
`너는 "${agent.name}"이며 역할은 다음과 같다: ${agent.persona || "팀의 조력자"}.
아래 "평가 대상"을 너의 역할 관점에서 냉정하게 1~10점으로 평가하라(10=탁월, 1=매우 부족). 후하게 주지 마라.
[네가 아는 팀 지식]
${mem}
[평가 대상]
${item}
STRICT JSON만 출력(코드펜스 금지): {"score": 1에서 10 사이 정수, "reason": "핵심 근거 한국어 1~2문장"}`),
      TIMEOUT_MS
    );
    const p = parseJson(res.response.text());
    if (!p) return null;
    let s = Number(p.score);
    if (!isFinite(s)) s = 5;
    s = Math.max(1, Math.min(10, Math.round(s)));
    return { score: s, reason: typeof p.reason === "string" ? p.reason.trim() : "" };
  } catch (_) {
    return null;
  }
}
