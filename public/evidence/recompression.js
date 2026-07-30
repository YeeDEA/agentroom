// evidence/recompression.js — 재압축 오차(ELA, Error Level Analysis) 분석
//
// ⚠️ 정직한 고지: ELA는 고전적인 포렌식 휴리스틱입니다.
// 다시 압축했을 때 원본과 얼마나 어긋나는지 봅니다. 한 번에 찍힌 사진은
// 고르게 어긋나고, 일부만 합성한 사진은 그 부분만 다르게 어긋납니다.
// 다만 텍스처가 많은 영역은 원래 오차가 크므로 오탐이 가능합니다.

const BLOCK = 16; // 블록 크기 (16x16)
const JPEG_QUALITY = 0.75; // 재압축 품질

// canvas → JPEG blob (Promise 래핑)
function canvasToJpegBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("JPEG 재인코딩 실패"))),
      "image/jpeg",
      JPEG_QUALITY
    );
  });
}

async function analyze(ctx) {
  const t0 = performance.now();
  const fail = (reason) => ({
    id: "recompression",
    title: "재압축 오차(ELA) 분석",
    signal: null,
    verdictText: `이 검사를 수행하지 못했습니다: ${reason}`,
    details: [],
    available: true,
    elapsedMs: performance.now() - t0,
  });

  try {
    const src = ctx.canvas; // 호출 측이 자연 크기(긴 변 최대 512px)로 그려 둔 캔버스
    if (!src || !src.width || !src.height) return fail("분석용 캔버스가 준비되지 않았습니다");
    const w = src.width, h = src.height;

    const srcCtx = src.getContext("2d", { willReadFrequently: true });
    const orig = srcCtx.getImageData(0, 0, w, h).data;

    // 1) JPEG 품질 0.75로 재인코딩 → 디코딩 → 두 번째 캔버스에 그리기
    const blob = await canvasToJpegBlob(src);
    const bitmap = await createImageBitmap(blob);
    const c2 = document.createElement("canvas");
    c2.width = w;
    c2.height = h;
    const ctx2 = c2.getContext("2d", { willReadFrequently: true });
    ctx2.drawImage(bitmap, 0, 0, w, h);
    const recomp = ctx2.getImageData(0, 0, w, h).data;

    // 2) 픽셀별 휘도 차이의 절댓값
    const n = w * h;
    const diff = new Float64Array(n);
    let meanErr = 0;
    for (let i = 0; i < n; i++) {
      const o = 0.299 * orig[i * 4] + 0.587 * orig[i * 4 + 1] + 0.114 * orig[i * 4 + 2];
      const r = 0.299 * recomp[i * 4] + 0.587 * recomp[i * 4 + 1] + 0.114 * recomp[i * 4 + 2];
      const d = Math.abs(o - r);
      diff[i] = d;
      meanErr += d;
    }
    meanErr /= n;

    // 3) 16x16 블록별 평균 오차 → 블록 간 불균일도
    const bw = Math.floor(w / BLOCK), bh = Math.floor(h / BLOCK);
    if (bw < 2 || bh < 2) return fail("이미지가 너무 작아 블록 분석을 할 수 없습니다");
    const blockMeans = [];
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let s = 0;
        for (let y = 0; y < BLOCK; y++) {
          const row = (by * BLOCK + y) * w + bx * BLOCK;
          for (let x = 0; x < BLOCK; x++) s += diff[row + x];
        }
        blockMeans.push(s / (BLOCK * BLOCK));
      }
    }
    const bn = blockMeans.length;
    let bMean = 0;
    for (const v of blockMeans) bMean += v;
    bMean /= bn;
    let bVar = 0, hot = 0;
    for (const v of blockMeans) {
      bVar += (v - bMean) ** 2;
      if (v > 2 * bMean) hot++;
    }
    bVar /= bn;
    const hotFrac = hot / bn;
    // 블록 평균의 변동계수(CV): 오차가 고를수록 낮고, 일부만 어긋날수록 높음
    const cv = bMean > 1e-6 ? Math.sqrt(bVar) / bMean : 0;

    // ---- 휴리스틱 점수 매핑 ----
    // 경험적 임계값: CV 0.4 이하 = 균일(단일 소스에 가까움) → 0,
    // CV 1.2 이상 = 국소적으로 크게 어긋남(합성/편집 의심) → 1. 선형 매핑.
    const signal = Math.min(1, Math.max(0, (cv - 0.4) / (1.2 - 0.4)));

    let verdictText;
    if (signal < 0.35) {
      verdictText = "재압축 오차가 고르게 퍼져 있습니다 — 한 번에 만들어진 이미지에 가깝습니다";
    } else if (signal <= 0.65) {
      verdictText = "일부 영역의 오차가 다른 곳과 다릅니다 — 편집 여부를 확대해 확인해 보세요";
    } else {
      verdictText = "특정 영역만 오차가 크게 다릅니다 — 부분 합성·편집이 의심됩니다";
    }

    const isJpeg = ctx.file && /jpe?g$/i.test(ctx.file.type || "");
    const details = [
      {
        label: "평균 재압축 오차",
        value: meanErr.toFixed(2),
        meaning:
          "다시 압축했을 때 원본과 얼마나 어긋나는지 봅니다. 한 번에 찍힌 사진은 고르게 어긋나고, 일부만 합성한 사진은 그 부분만 다르게 어긋납니다.",
      },
      {
        label: "블록 불균일도 (CV)",
        value: cv.toFixed(3),
        meaning: "구역별 오차가 얼마나 들쭉날쭉한지 — 높을수록 일부만 손댄 흔적일 수 있습니다",
      },
      {
        label: "오차 급증 구역 비율",
        value: `${(hotFrac * 100).toFixed(1)}%`,
        meaning: "평균의 2배 넘게 어긋난 구역의 비율 — 합성 경계에서 흔히 나타납니다",
      },
    ];
    if (!isJpeg) {
      details.push({
        label: "원본 형식",
        value: ctx.file && ctx.file.type ? ctx.file.type : "JPEG 아님",
        meaning: "PNG는 무손실 형식이라 재압축 오차 해석에 주의가 필요합니다 (참고용으로만 보세요)",
      });
    }

    return {
      id: "recompression",
      title: "재압축 오차(ELA) 분석",
      signal,
      verdictText,
      details,
      available: true,
      elapsedMs: performance.now() - t0,
    };
  } catch (err) {
    return fail(err && err.message ? err.message : "알 수 없는 오류");
  }
}

export default {
  id: "recompression",
  title: "재압축 오차(ELA) 분석",
  order: 2,
  available: true,
  analyze,
};
