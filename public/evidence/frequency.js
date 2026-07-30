// evidence/frequency.js — 사진의 결(주파수 스펙트럼) 분석
//
// ⚠️ 정직한 고지: 이 코드는 교육용 휴리스틱입니다.
// FFT 스펙트럼의 몇 가지 통계량으로 "생성형 AI 흔적"을 추정할 뿐,
// 실제 딥페이크/생성 이미지 탐지 모델이 아닙니다. 결과는 참고용입니다.
//
// 아래 fft1d / fft2dMagnitude / analyzeSpectrum / periodicity / clamp01 은
// public/detect.js에서 검증된 코드를 그대로 옮긴 것입니다(수학 변경 금지).

const SIZE = 256; // 2의 거듭제곱 — radix-2 FFT용

// ---------- radix-2 FFT (in-place, 반복형) ----------
// re/im: 길이 n(2의 거듭제곱)의 Float64Array
function fft1d(re, im) {
  const n = re.length;
  // 비트 반전 재배열
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // 버터플라이
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k], aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

// 2D FFT: 행 방향 → 열 방향. 크기 SIZE x SIZE의 진폭 스펙트럼을 반환.
function fft2dMagnitude(gray) {
  const re = Float64Array.from(gray);
  const im = new Float64Array(SIZE * SIZE);

  const rowRe = new Float64Array(SIZE);
  const rowIm = new Float64Array(SIZE);

  // 행 FFT
  for (let y = 0; y < SIZE; y++) {
    rowRe.set(re.subarray(y * SIZE, (y + 1) * SIZE));
    rowIm.set(im.subarray(y * SIZE, (y + 1) * SIZE));
    fft1d(rowRe, rowIm);
    re.set(rowRe, y * SIZE);
    im.set(rowIm, y * SIZE);
  }
  // 열 FFT
  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      rowRe[y] = re[y * SIZE + x];
      rowIm[y] = im[y * SIZE + x];
    }
    fft1d(rowRe, rowIm);
    for (let y = 0; y < SIZE; y++) {
      re[y * SIZE + x] = rowRe[y];
      im[y * SIZE + x] = rowIm[y];
    }
  }

  // 진폭 스펙트럼 (DC를 중앙으로 fftshift)
  const mag = new Float64Array(SIZE * SIZE);
  const half = SIZE / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const sy = (y + half) % SIZE;
      const sx = (x + half) % SIZE;
      const i = y * SIZE + x;
      mag[sy * SIZE + sx] = Math.hypot(re[i], im[i]);
    }
  }
  return mag;
}

// ---------- 스펙트럼 휴리스틱 ----------
function analyzeSpectrum(gray) {
  const mag = fft2dMagnitude(gray);
  const c = SIZE / 2; // 중앙(DC)

  // (a) 고주파 에너지 비율: 반경 SIZE/8 밖의 에너지 / 전체 에너지
  const lowRadius = SIZE / 8;
  let totalE = 0, highE = 0;
  // (c) 고주파 대역(반경 > SIZE/4) 진폭의 균일도 계산용
  const highBand = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const r = Math.hypot(x - c, y - c);
      const e = mag[y * SIZE + x] ** 2;
      totalE += e;
      if (r > lowRadius) highE += e;
      if (r > SIZE / 4) highBand.push(mag[y * SIZE + x]);
    }
  }
  const highFreqRatio = totalE > 0 ? highE / totalE : 0;

  // (b) 격자 주기성 점수: 생성 모델의 업샘플링 아티팩트는 축 방향에
  // 규칙적인 간격의 스펙트럼 피크를 만드는 경향이 있음.
  const axisH = new Float64Array(c); // 중앙에서 +x 방향
  const axisV = new Float64Array(c); // 중앙에서 +y 방향
  for (let k = 0; k < c; k++) {
    axisH[k] = Math.log1p(mag[c * SIZE + (c + k)]);
    axisV[k] = Math.log1p(mag[(c + k) * SIZE + c]);
  }
  const gridScore = Math.max(periodicity(axisH), periodicity(axisV));

  // (c) 노이즈 균일도: 고주파 대역 로그 진폭의 변동계수(CV).
  // 자연 사진의 센서 노이즈는 불균일 — 생성 이미지는 지나치게 매끈(균일)한 경향.
  let mean = 0;
  for (const v of highBand) mean += Math.log1p(v);
  mean /= highBand.length;
  let variance = 0;
  for (const v of highBand) variance += (Math.log1p(v) - mean) ** 2;
  variance /= highBand.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
  // CV가 낮을수록(균일할수록) 의심 ↑. 경험적으로 [0.15, 0.6] 구간을 [1, 0]으로 매핑.
  const uniformity = clamp01((0.6 - cv) / (0.6 - 0.15));

  // 고주파 비율도 [0.02, 0.35] 구간을 [0, 1]로 매핑 (과도한 고주파 = 의심 ↑)
  const highFreqNorm = clamp01((highFreqRatio - 0.02) / (0.35 - 0.02));

  // ---- 최종 위변조 확률 (휴리스틱 가중 합) ----
  // probability = 0.4 * highFreqNorm + 0.35 * gridScore + 0.25 * uniformity
  // 가중치는 경험적으로 정한 것으로 과학적 근거가 있는 것은 아닙니다.
  const probability = clamp01(
    0.4 * highFreqNorm + 0.35 * gridScore + 0.25 * uniformity
  );

  return { probability, highFreqRatio, gridScore, uniformity, cv, highFreqNorm };
}

// 축 방향 스펙트럼에서 규칙적 간격 피크의 세기를 0~1로 점수화.
function periodicity(axis) {
  const n = axis.length;
  let globalMean = 0;
  for (let k = 8; k < n; k++) globalMean += axis[k]; // 저주파 근처 제외
  globalMean /= n - 8;
  if (globalMean <= 0) return 0;

  let best = 0;
  for (let s = 4; s <= 32; s++) {
    let sum = 0, count = 0;
    for (let k = s; k < n; k += s) {
      if (k < 8) continue;
      sum += axis[k];
      count++;
    }
    if (count < 3) continue;
    const ratio = sum / count / globalMean;
    if (ratio > best) best = ratio;
  }
  // ratio 1.0(피크 없음)~1.6(강한 규칙적 피크)을 [0,1]로 매핑
  return clamp01((best - 1.0) / 0.6);
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

// ---------- EvidenceReport 생성 ----------
async function analyze(ctx) {
  const t0 = performance.now();
  try {
    const { gray256 } = ctx;
    if (!gray256 || gray256.length !== SIZE * SIZE) {
      throw new Error("256x256 휘도 데이터가 준비되지 않았습니다");
    }
    const m = analyzeSpectrum(gray256);
    const signal = m.probability;

    let verdictText;
    if (signal < 0.35) {
      verdictText = "자연스러운 사진의 결에 가깝습니다";
    } else if (signal <= 0.65) {
      verdictText = "일부 규칙적인 무늬가 보입니다 — 확대 확인 권장";
    } else {
      verdictText = "AI 생성물에서 자주 보이는 무늬가 뚜렷합니다";
    }

    return {
      id: "frequency",
      title: "사진의 결 분석",
      signal,
      verdictText,
      details: [
        {
          label: "고주파 에너지",
          value: `${(m.highFreqRatio * 100).toFixed(2)}%`,
          meaning: "사진 가장자리·질감에 해당하는 신호가 얼마나 많은지",
        },
        {
          label: "격자 무늬 점수",
          value: m.gridScore.toFixed(3),
          meaning: "AI 업스케일링이 남기는 일정한 간격의 픽셀 무늬",
        },
        {
          label: "노이즈 균일도",
          value: m.uniformity.toFixed(3),
          meaning: "카메라 노이즈는 불규칙하지만 AI 노이즈는 균일한 경향",
        },
      ],
      available: true,
      elapsedMs: performance.now() - t0,
    };
  } catch (err) {
    return {
      id: "frequency",
      title: "사진의 결 분석",
      signal: null,
      verdictText: `이 검사를 수행하지 못했습니다: ${err && err.message ? err.message : "알 수 없는 오류"}`,
      details: [],
      available: true,
      elapsedMs: performance.now() - t0,
    };
  }
}

export default {
  id: "frequency",
  title: "사진의 결 분석",
  order: 1,
  available: true,
  analyze,
};
