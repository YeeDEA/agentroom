// ⚠️ 개인정보 고지: 이 분석기는 이미지(축소본)를 Google 서버(Firebase AI Logic / Gemini)로 전송하여 분석합니다. 다른 검사와 달리 로컬에서만 처리되지 않습니다.
//
// evidence/gemini.js — AI 시각 정밀 분석 (Gemini 2.5 Flash)
//
// ⚠️ 정직한 고지: LLM의 시각 판단 역시 확률적 추정일 뿐, 법적 증거가 아닙니다.

import { getGenerativeModel } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-ai.js";
import { ai } from "../firebase-config.js";

const ID = "gemini";
const TITLE = "AI 시각 정밀 분석 (Gemini)";
const TIMEOUT_MS = 25000;

// 모듈 수준 캐시 — 첫 analyze 호출 때 한 번만 초기화
let _model = null;
let _modelInitError = null;

function getModel() {
  if (_model || _modelInitError) return _model;
  try {
    _model = getGenerativeModel(ai, {
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
      },
    });
  } catch (err) {
    _modelInitError = err;
  }
  return _model;
}

const PROMPT = `당신은 이미지 위변조 감식 전문가입니다. 이 이미지가 생성형 AI로 만들어졌거나 조작되었는지 시각적 내용을 근거로 평가하세요.

반드시 검사할 항목:
① 텍스트/글자 왜곡·비문 (영수증·라벨·간판의 이상한 글자, 깨진 문자)
② 기하/광학 모순 (그림자 방향, 반사, 원근의 불일치)
③ 해부학적 이상 (손가락 개수·형태, 눈, 치아)
④ 질감 이상 (과도하게 매끈한 피부/표면, 반복 패턴)
⑤ 배경-피사체 경계 이상 (부자연스러운 합성 경계)

아래 형식의 STRICT JSON만 출력하세요. 마크다운 코드 펜스나 다른 텍스트를 절대 포함하지 마세요:
{
  "aiLikelihood": 0과 1 사이 숫자,
  "confidence": "low" | "medium" | "high",
  "observations": [
    { "aspect": "검사 항목 이름(한국어)", "finding": "발견 내용(한국어)", "suspicious": true 또는 false }
  ],
  "summary": "한 문장 한국어 요약"
}
observations는 최대 5개까지만 작성하세요.`;

// ---------- 유틸 ----------

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

function canvasToJpegBase64(canvas) {
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  const comma = dataUrl.indexOf(",");
  return dataUrl.slice(comma + 1);
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error("timeout");
      e.isTimeout = true;
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 응답 텍스트에서 JSON을 방어적으로 추출
function parseModelJson(text) {
  if (typeof text !== "string") return null;
  let t = text.trim();
  // ```json ... ``` 펜스 제거
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch (_) {
    // 텍스트 안에 섞여 있으면 첫 { 부터 마지막 } 까지 시도
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

const METHOD_DETAIL = {
  label: "검사 방식",
  value: "Gemini 2.5 Flash",
  meaning: "이미지가 Google 서버로 전송되어 내용 기반 분석을 수행합니다",
};

function report(signal, verdictText, details, t0) {
  return {
    id: ID,
    title: TITLE,
    signal,
    verdictText,
    details,
    available: true,
    elapsedMs: performance.now() - t0,
  };
}

function unavailableReport(t0) {
  return report(
    null,
    "Gemini 검사를 사용할 수 없습니다. Firebase 콘솔 > AI Logic에서 활성화하면 이 카드가 켜집니다.",
    [
      {
        label: "활성화 방법",
        value: "콘솔 1클릭",
        meaning:
          "https://console.firebase.google.com/project/yonsei-yongjun-biz-prototype/ailogic 에서 시작하기를 누르면 됩니다",
      },
      METHOD_DETAIL,
    ],
    t0
  );
}

// ---------- EvidenceReport 생성 ----------

async function analyze(ctx) {
  const t0 = performance.now();
  try {
    const model = getModel();
    if (!model) {
      // SDK/모델 초기화 실패 → API 미활성화 등으로 간주
      return unavailableReport(t0);
    }

    if (!ctx || !ctx.canvas) {
      return report(null, "분석할 이미지가 준비되지 않았습니다.", [METHOD_DETAIL], t0);
    }

    const data = canvasToJpegBase64(ctx.canvas);

    let result;
    try {
      result = await withTimeout(
        model.generateContent([
          { inlineData: { data, mimeType: "image/jpeg" } },
          { text: PROMPT },
        ]),
        TIMEOUT_MS
      );
    } catch (err) {
      if (err && err.isTimeout) {
        return report(
          null,
          "응답 시간 초과 — 잠시 후 다시 시도해 주세요.",
          [METHOD_DETAIL],
          t0
        );
      }
      // 403 / API 미활성화 / 네트워크 오류 등
      return unavailableReport(t0);
    }

    let text = null;
    try {
      text = result.response.text();
    } catch (_) {
      text = null;
    }

    const parsed = parseModelJson(text);
    if (!parsed || typeof parsed !== "object") {
      return report(null, "분석 결과를 해석하지 못했습니다.", [METHOD_DETAIL], t0);
    }

    const signal =
      typeof parsed.aiLikelihood === "number" && isFinite(parsed.aiLikelihood)
        ? clamp01(parsed.aiLikelihood)
        : null;

    let verdictText =
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : "분석 요약을 받지 못했습니다.";
    if (parsed.confidence === "low") {
      verdictText += " (모델 확신도 낮음 — 참고용)";
    }

    const observations = Array.isArray(parsed.observations)
      ? parsed.observations.slice(0, 5)
      : [];
    const details = observations
      .filter((o) => o && typeof o === "object")
      .map((o) => ({
        label: typeof o.aspect === "string" ? o.aspect : "관찰",
        value: o.suspicious ? "의심" : "정상",
        meaning: typeof o.finding === "string" ? o.finding : "",
      }));
    details.push(METHOD_DETAIL);

    return report(signal, verdictText, details, t0);
  } catch (err) {
    // 어떤 경우에도 throw하지 않음
    return report(
      null,
      `이 검사를 수행하지 못했습니다: ${err && err.message ? err.message : "알 수 없는 오류"}`,
      [METHOD_DETAIL],
      t0
    );
  }
}

export default {
  id: ID,
  title: TITLE,
  order: 4,
  available: true,
  analyze,
};
