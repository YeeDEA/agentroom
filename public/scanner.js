// scanner.js — 히어로 인터랙티브 포렌식 스캐너
// 이미지 위로 스캔 라인이 지나가며, 실제 검사(evidence 모듈)에서 걸린 흔적을
// 마커로 드러내고 검사 칩이 실시간으로 채워진 뒤 신호등 판정을 애니메이션합니다.
// 로컬 4종 검사만 사용(비용/지연 이유로 Gemini 제외). 브라우저 안에서만 계산됩니다.

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- 결정적 난수 + 샘플 생성 (landing.js와 동일 규칙) ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSampleCanvas(kind, seed) {
  const rand = mulberry32(seed);
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const g = canvas.getContext("2d");
  const grad = g.createLinearGradient(0, 0, size, size);
  const base = [80 + rand() * 80, 90 + rand() * 80, 110 + rand() * 80].map(Math.round);
  grad.addColorStop(0, `rgb(${base[0]}, ${base[1]}, ${base[2]})`);
  grad.addColorStop(1, `rgb(${Math.round(base[0] * 0.5)}, ${Math.round(base[1] * 0.6)}, ${Math.round(base[2] * 0.7)})`);
  g.fillStyle = grad; g.fillRect(0, 0, size, size);
  const bx = size * (0.3 + rand() * 0.4), by = size * (0.3 + rand() * 0.4), br = size * (0.15 + rand() * 0.15);
  const blob = g.createRadialGradient(bx, by, br * 0.1, bx, by, br);
  blob.addColorStop(0, `rgba(${Math.round(150 + rand() * 100)}, ${Math.round(150 + rand() * 100)}, ${Math.round(150 + rand() * 100)}, 0.9)`);
  blob.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = blob; g.fillRect(0, 0, size, size);
  const img = g.getImageData(0, 0, size, size); const d = img.data; const TWO_PI = Math.PI * 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    let delta = (rand() * 2 - 1) * 12;
    if (kind === "ai") delta += Math.sin((TWO_PI * x) / 8) * Math.sin((TWO_PI * y) / 8) * 15;
    d[i] = Math.max(0, Math.min(255, d[i] + delta));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + delta));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + delta));
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

async function buildCtx(sourceCanvas) {
  const file = await new Promise((res, rej) =>
    sourceCanvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/png"));
  const small = document.createElement("canvas");
  small.width = 256; small.height = 256;
  const sg = small.getContext("2d");
  sg.drawImage(sourceCanvas, 0, 0, 256, 256);
  const data = sg.getImageData(0, 0, 256, 256).data;
  const gray256 = new Float64Array(256 * 256);
  for (let p = 0; p < gray256.length; p++) {
    const i = p * 4;
    gray256[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return { file, gray256, canvas: sourceCanvas };
}

// ---------- evidence 모듈 (지연 로드, 실패해도 위젯은 동작) ----------
let evidencePromise = null;
function loadEvidence() {
  if (!evidencePromise) {
    evidencePromise = import("./evidence/registry.js").then((m) => ({
      analyzers: m.default.filter((a) => a.id !== "gemini"),
      overallVerdict: m.overallVerdict,
    }));
  }
  return evidencePromise;
}

// 검사 id → 마커에 쓸 짧은 흔적 라벨
const TRACE_LABEL = {
  metadata: "촬영 정보 없음",
  frequency: "규칙적 격자 무늬",
  recompression: "재압축 오차 불균일",
  sensor: "센서 흔적 없음",
};
const CHECK_SHORT = {
  metadata: "촬영 정보",
  frequency: "사진의 결",
  recompression: "재압축 오차",
  sensor: "센서 흔적",
};
const LEVEL_EMOJI = { green: "🟢", amber: "🟡", red: "🔴" };

// ---------- DOM ----------
const stage = document.getElementById("scanner-stage");
const canvasEl = document.getElementById("scanner-canvas");
const scanLine = document.getElementById("scan-line");
const markersEl = document.getElementById("scan-markers");
const hintEl = document.getElementById("scan-hint");
const checksEl = document.getElementById("scanner-checks");
const verdictEl = document.getElementById("scanner-verdict");
const goBtn = document.getElementById("scan-go");
const segBtns = Array.from(document.querySelectorAll(".seg-btn"));

if (stage && canvasEl && goBtn) {
  let currentKind = "normal";
  let seedCounter = 1;
  let busy = false;
  const cctx = canvasEl.getContext("2d");
  canvasEl.width = 512; canvasEl.height = 512;

  let sampleCanvas = makeSampleCanvas(currentKind, 101);
  drawSample();

  function drawSample() {
    cctx.clearRect(0, 0, 512, 512);
    cctx.drawImage(sampleCanvas, 0, 0, 512, 512);
  }

  function regenerate() {
    seedCounter += 1;
    sampleCanvas = makeSampleCanvas(currentKind, (currentKind === "ai" ? 900 : 100) + seedCounter * 7);
    drawSample();
    markersEl.innerHTML = "";
    verdictEl.hidden = true;
    verdictEl.className = "scanner-verdict";
    checksEl.innerHTML = "";
    hintEl.style.opacity = "1";
    hintEl.textContent = currentKind === "ai"
      ? "AI 생성 샘플 준비됨 — 스캔해서 흔적을 찾아보세요"
      : "실제 촬영에 가까운 샘플 준비됨 — 스캔해 보세요";
  }

  // 검사 칩 초기화(대기 상태)
  function renderCheckChips(ids) {
    checksEl.innerHTML = "";
    return ids.map((id) => {
      const chip = document.createElement("div");
      chip.className = "check-chip is-pending";
      chip.innerHTML = `<span class="chip-dot"></span><span class="chip-name">${CHECK_SHORT[id] || id}</span>`;
      checksEl.appendChild(chip);
      return { id, el: chip };
    });
  }

  function settleChip(chip, flagged) {
    chip.el.classList.remove("is-pending");
    chip.el.classList.add(flagged ? "is-flag" : "is-clear");
  }

  function placeMarker(pct, label, flagged) {
    const m = document.createElement("div");
    m.className = "scan-marker" + (flagged ? " is-flag" : " is-clear");
    m.style.left = pct.x + "%";
    m.style.top = pct.y + "%";
    m.innerHTML = `<span class="marker-ring"></span><span class="marker-label">${label}</span>`;
    markersEl.appendChild(m);
    // 등장 애니메이션
    requestAnimationFrame(() => m.classList.add("show"));
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function animateScanLine(durationMs) {
    return new Promise((resolve) => {
      if (reduceMotion) { scanLine.style.opacity = "0"; resolve(); return; }
      const start = performance.now();
      scanLine.style.opacity = "1";
      stage.classList.add("scanning");
      function frame(now) {
        const t = Math.min(1, (now - start) / durationMs);
        scanLine.style.top = (t * 100) + "%";
        if (t < 1) requestAnimationFrame(frame);
        else { scanLine.style.opacity = "0"; stage.classList.remove("scanning"); resolve(); }
      }
      requestAnimationFrame(frame);
    });
  }

  async function runScan() {
    if (busy) return;
    busy = true;
    goBtn.disabled = true;
    segBtns.forEach((b) => (b.disabled = true));
    markersEl.innerHTML = "";
    verdictEl.hidden = true;
    hintEl.style.opacity = "0";

    let result = null, evErr = false;
    const ctxPromise = buildCtx(sampleCanvas)
      .then((ctx) => loadEvidence().then(async ({ analyzers, overallVerdict }) => {
        const reports = [];
        for (const a of analyzers) reports.push(await a.analyze(ctx));
        return { reports, verdict: overallVerdict(reports) };
      }))
      .catch((e) => { evErr = true; console.error(e); return null; });

    // 스캔 라인 스윕 (분석과 병렬)
    await animateScanLine(reduceMotion ? 0 : 1300);
    result = await ctxPromise;

    if (evErr || !result) {
      hintEl.style.opacity = "1";
      hintEl.textContent = "검사 모듈을 불러오지 못했습니다.";
      resetControls();
      return;
    }

    const { reports, verdict } = result;

    // 검사 칩 하나씩 확정 (스태거)
    const chips = renderCheckChips(reports.map((r) => r.id));
    const flaggedReports = [];
    for (let i = 0; i < reports.length; i++) {
      const r = reports[i];
      const flagged = typeof r.signal === "number" && r.signal >= 0.35;
      if (!reduceMotion) await sleep(160);
      settleChip(chips[i], flagged);
      if (flagged) flaggedReports.push(r);
    }

    // 걸린 흔적을 이미지 위 마커로 표시 (분산 배치, 결정적)
    const spots = [
      { x: 30, y: 34 }, { x: 66, y: 52 }, { x: 44, y: 70 }, { x: 72, y: 26 },
    ];
    for (let i = 0; i < flaggedReports.length; i++) {
      if (!reduceMotion) await sleep(120);
      const r = flaggedReports[i];
      placeMarker(spots[i % spots.length], TRACE_LABEL[r.id] || "이상 신호", true);
    }
    if (flaggedReports.length === 0) {
      placeMarker({ x: 50, y: 48 }, "특이 흔적 없음", false);
    }

    // 신호등 판정 등장
    verdictEl.className = "scanner-verdict verdict-" + verdict.level;
    verdictEl.innerHTML =
      `<span class="sv-emoji">${LEVEL_EMOJI[verdict.level] || "⚪"}</span>` +
      `<div class="sv-body"><strong class="sv-label"></strong>` +
      `<span class="sv-count mono">${verdict.total}개 검사 중 ${verdict.flagged}개 ${verdict.flaggedLabel}</span></div>`;
    verdictEl.querySelector(".sv-label").textContent = verdict.label;
    verdictEl.hidden = false;
    if (!reduceMotion) {
      verdictEl.animate(
        [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "translateY(0)" }],
        { duration: 320, easing: "cubic-bezier(.2,.7,.2,1)" }
      );
    }
    resetControls();
  }

  function resetControls() {
    busy = false;
    goBtn.disabled = false;
    segBtns.forEach((b) => (b.disabled = false));
  }

  goBtn.addEventListener("click", runScan);
  segBtns.forEach((b) =>
    b.addEventListener("click", () => {
      if (busy) return;
      segBtns.forEach((x) => x.classList.remove("is-active"));
      b.classList.add("is-active");
      currentKind = b.dataset.kind;
      regenerate();
    })
  );

  // 첫 등장 시 자동으로 한 번 AI 스캔 → 첫인상에서 바로 페이오프 (모션 존중)
  if (!reduceMotion) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          io.disconnect();
          segBtns.forEach((x) => x.classList.remove("is-active"));
          const aiBtn = segBtns.find((x) => x.dataset.kind === "ai");
          if (aiBtn) aiBtn.classList.add("is-active");
          currentKind = "ai";
          regenerate();
          setTimeout(runScan, 500);
        }
      });
    }, { threshold: 0.4 });
    io.observe(stage);
  }
}
