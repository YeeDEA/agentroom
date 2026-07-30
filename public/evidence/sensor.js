// evidence/sensor.js — 카메라 센서 흔적 분석
//
// ⚠️ 정직한 고지: 이 코드는 교육용 휴리스틱입니다.
// 진짜 카메라는 베이어(Bayer) 모자이크 센서에서 색을 계산(디모자이킹)하기 때문에
// 픽셀 노이즈에 특유의 "센서 지문"이 남습니다. 생성형 AI 이미지는 이런 지문이
// 없거나 다른 형태를 보이는 경향이 있습니다. 다만:
//
// ★ 중요한 한계: 메신저(카톡 등) 전송·리사이즈·재압축은 CFA 흔적을 지워버립니다.
//   따라서 "센서 흔적이 없다"는 것만으로는 AI 생성이라고 단정할 수 없습니다.
//   (전송 사진에서는 흔적 부재가 정상일 수 있음.) 이 때문에 CFA 부재의 가중치를
//   0.4로 '중간' 수준에 묶어 두었고, verdictText에도 이 가능성을 명시합니다.
//   여기서는 재압축 여부를 직접 감지할 수 없으므로 문서화로 대신합니다.
//
// 세 가지 고전적 포렌식 통계량 (중앙 256x256 크롭에서 계산해 비용 제한):
//  1. CFA(베이어 패턴) 주기성 — 녹색 채널 고주파 잔차의 (x+y) 짝/홀 위치 분산 불균형.
//     진짜 디모자이킹 사진은 2픽셀 주기의 불균형이 남고, AI/강한 리사이즈는 거의 0.
//  2. 채널 간 노이즈 독립성 — R/G/B 잔차의 피어슨 상관.
//     카메라: 디모자이킹 후에도 부분 독립(대략 0.3~0.7).
//     AI: RGB를 한 번에 합성하므로 매우 높음(>0.9)이거나, 디노이징으로 거의 0.
//  3. 잔차 노이즈 첨도(kurtosis) — 휘도 잔차의 첨도.
//     자연 센서 노이즈는 대략 3~10 (가우시안~약간 두꺼운 꼬리).
//     AI: 지나치게 매끈(첨도 매우 낮음) 또는 희소한 인공 흔적(매우 높음).
//
// 최종 signal = 0.4*CFA부재 + 0.35*채널상관이상 + 0.25*첨도이상 (경험적 가중치,
// 과학적 근거가 있는 것은 아닙니다).

const CROP = 256; // 중앙 크롭 최대 크기 (계산 비용 제한)
const EPS = 1e-12;

// ---- 점수 매핑 상수 (Node 합성 이미지 테스트로 보정) ----
// CFA: 불균형 0 → 부재점수 1, 불균형 >= CFA_FULL → 0
const CFA_FULL = 0.06;
// 채널 상관 자연 구간 [CORR_LO, CORR_HI]. 벗어난 정도를 점수화.
const CORR_LO = 0.3;
const CORR_HI = 0.7;
const CORR_HI_SPAN = 0.25; // 0.7→0.95 에서 0→1
const CORR_LO_SPAN = 0.3;  // 0.3→0.0 에서 0→1
// 첨도 자연 구간 [KURT_LO, KURT_HI]
const KURT_LO = 3;
const KURT_HI = 10;
const KURT_LO_SPAN = 2.5;  // 3→0.5 에서 0→1
const KURT_HI_SPAN = 20;   // 10→30 에서 0→1
// 가중치
const W_CFA = 0.4;   // 리사이즈/재압축이 CFA를 지우므로 '중간' 수준으로 제한
const W_CORR = 0.35;
const W_KURT = 0.25;

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

// 3x3 이웃 평균(중심 포함)을 뺀 고주파 잔차. 내부 픽셀만 (가장자리 제외).
// 입력: 길이 w*h Float64Array. 출력: 길이 (w-2)*(h-2) Float64Array.
function highPassResidual(ch, w, h) {
  const out = new Float64Array((w - 2) * (h - 2));
  let o = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) sum += ch[(y + dy) * w + (x + dx)];
      out[o++] = ch[y * w + x] - sum / 9;
    }
  }
  return out;
}

// (x+y) 짝/홀 위치별 잔차 분산 불균형: |var_even - var_odd| / (var_even + var_odd + eps)
// 잔차 배열은 (w-2)x(h-2)이고 원본 좌표 (x+1, y+1)에 대응하므로 parity는 (x+y)와 동일 규칙 유지.
function cfaParityImbalance(res, rw, rh) {
  let sE = 0, sE2 = 0, nE = 0;
  let sO = 0, sO2 = 0, nO = 0;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const v = res[y * rw + x];
      // 원본 좌표 parity: (x+1)+(y+1) ≡ x+y (mod 2)
      if (((x + y) & 1) === 0) { sE += v; sE2 += v * v; nE++; }
      else { sO += v; sO2 += v * v; nO++; }
    }
  }
  const vE = nE > 1 ? sE2 / nE - (sE / nE) ** 2 : 0;
  const vO = nO > 1 ? sO2 / nO - (sO / nO) ** 2 : 0;
  return Math.abs(vE - vO) / (vE + vO + EPS);
}

// 피어슨 상관계수
function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  return cov / (Math.sqrt(va * vb) + EPS);
}

// 초과가 아닌 '보통' 첨도: m4 / m2^2 (가우시안 = 3)
function kurtosis(arr) {
  const n = arr.length;
  let m = 0;
  for (let i = 0; i < n; i++) m += arr[i];
  m /= n;
  let m2 = 0, m4 = 0;
  for (let i = 0; i < n; i++) {
    const d = arr[i] - m;
    const d2 = d * d;
    m2 += d2; m4 += d2 * d2;
  }
  m2 /= n; m4 /= n;
  return m4 / (m2 * m2 + EPS);
}

// ---- 핵심 분석 (순수 함수: canvas 없이 테스트 가능) ----
// 입력: { r, g, b, width, height } — 각 채널 Float64Array (0~255)
export function analyzeSensorStats({ r, g, b, width, height }) {
  if (width < 16 || height < 16) {
    throw new Error("이미지가 너무 작아 센서 흔적을 분석할 수 없습니다");
  }
  const rw = width - 2, rh = height - 2;

  const resR = highPassResidual(r, width, height);
  const resG = highPassResidual(g, width, height);
  const resB = highPassResidual(b, width, height);

  // 1) CFA 주기성 (녹색 채널)
  const cfaImbalance = cfaParityImbalance(resG, rw, rh);
  // 불균형이 클수록 '카메라답다' → 부재 점수는 반대 방향
  const cfaAbsence = clamp01(1 - cfaImbalance / CFA_FULL);

  // 2) 채널 간 노이즈 상관 (세 쌍 평균의 절대값)
  const corrRG = pearson(resR, resG);
  const corrRB = pearson(resR, resB);
  const corrGB = pearson(resG, resB);
  const meanCorr = Math.abs((corrRG + corrRB + corrGB) / 3);
  let corrAnomaly = 0;
  if (meanCorr > CORR_HI) corrAnomaly = clamp01((meanCorr - CORR_HI) / CORR_HI_SPAN);
  else if (meanCorr < CORR_LO) corrAnomaly = clamp01((CORR_LO - meanCorr) / CORR_LO_SPAN);

  // 3) 휘도 잔차 첨도
  const lumRes = new Float64Array(resR.length);
  for (let i = 0; i < lumRes.length; i++) {
    lumRes[i] = 0.299 * resR[i] + 0.587 * resG[i] + 0.114 * resB[i];
  }
  const kurt = kurtosis(lumRes);
  let kurtAnomaly = 0;
  if (kurt < KURT_LO) kurtAnomaly = clamp01((KURT_LO - kurt) / KURT_LO_SPAN);
  else if (kurt > KURT_HI) kurtAnomaly = clamp01((kurt - KURT_HI) / KURT_HI_SPAN);

  const signal = clamp01(
    W_CFA * cfaAbsence + W_CORR * corrAnomaly + W_KURT * kurtAnomaly
  );

  return { signal, cfaImbalance, cfaAbsence, meanCorr, corrAnomaly, kurt, kurtAnomaly };
}

// canvas에서 중앙 크롭(최대 CROP x CROP)의 RGB 채널 추출
function extractChannels(canvas) {
  const w = Math.min(CROP, canvas.width);
  const h = Math.min(CROP, canvas.height);
  const sx = Math.floor((canvas.width - w) / 2);
  const sy = Math.floor((canvas.height - h) / 2);
  const ctx2d = canvas.getContext("2d");
  const data = ctx2d.getImageData(sx, sy, w, h).data;
  const n = w * h;
  const r = new Float64Array(n);
  const g = new Float64Array(n);
  const b = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    r[i] = data[i * 4];
    g[i] = data[i * 4 + 1];
    b[i] = data[i * 4 + 2];
  }
  return { r, g, b, width: w, height: h };
}

// ---------- EvidenceReport 생성 ----------
async function analyze(ctx) {
  const t0 = performance.now();
  try {
    const { canvas } = ctx;
    if (!canvas || !canvas.width || !canvas.height) {
      throw new Error("이미지 캔버스가 준비되지 않았습니다");
    }
    const m = analyzeSensorStats(extractChannels(canvas));
    const signal = m.signal;

    let verdictText;
    if (signal < 0.35) {
      verdictText = "카메라로 찍힌 사진에서 기대되는 센서 특성이 보입니다";
    } else if (signal <= 0.65) {
      verdictText = "센서 흔적이 약합니다 — 전송 과정에서 지워졌거나 AI 생성일 수 있습니다";
    } else {
      verdictText = "카메라 센서 흔적이 거의 없습니다 — AI 생성 또는 강한 후처리 의심";
    }

    return {
      id: "sensor",
      title: "카메라 센서 흔적 분석",
      signal,
      verdictText,
      details: [
        {
          label: "베이어 패턴 흔적",
          value: m.cfaImbalance.toFixed(4),
          meaning:
            "진짜 카메라는 색을 모자이크 센서에서 계산해내기 때문에 2픽셀 간격의 미세한 무늬가 남습니다. 다만 메신저 전송·리사이즈로도 지워질 수 있어 이것만으로 판단하지 않습니다",
        },
        {
          label: "채널 노이즈 상관",
          value: m.meanCorr.toFixed(3),
          meaning:
            "카메라 노이즈는 빨강·초록·파랑이 서로 조금씩 다르게 생기지만, AI는 세 색을 한꺼번에 그려서 너무 똑같거나(1에 가까움) 너무 깨끗합니다(0에 가까움)",
        },
        {
          label: "노이즈 첨도",
          value: m.kurt.toFixed(2),
          meaning:
            "노이즈 알갱이의 분포 모양입니다. 카메라 노이즈는 대략 3~10 사이인데, AI 이미지는 너무 매끈하거나 유난히 튀는 값이 많습니다",
        },
      ],
      available: true,
      elapsedMs: performance.now() - t0,
    };
  } catch (err) {
    return {
      id: "sensor",
      title: "카메라 센서 흔적 분석",
      signal: null,
      verdictText: `이 검사를 수행하지 못했습니다: ${err && err.message ? err.message : "알 수 없는 오류"}`,
      details: [],
      available: true,
      elapsedMs: performance.now() - t0,
    };
  }
}

export default {
  id: "sensor",
  title: "카메라 센서 흔적 분석",
  order: 3,
  available: true,
  analyze,
};
