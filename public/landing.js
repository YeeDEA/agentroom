import { db } from "./firebase-config.js";
import { collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-firestore.js";

// ---------------------------------------------------------------------------
// Waitlist (Firestore leads) — must always work, even if the demo modules fail
// ---------------------------------------------------------------------------
const form = document.getElementById("waitlist-form");
const emailInput = document.getElementById("waitlist-email");
const statusEl = document.getElementById("waitlist-status");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusEl.textContent = "";
  try {
    await addDoc(collection(db, "leads"), {
      email: emailInput.value,
      createdAt: serverTimestamp(),
    });
    statusEl.textContent = "등록 완료! 가장 먼저 소식을 보내드릴게요.";
    form.reset();
  } catch (error) {
    statusEl.textContent = "등록에 실패했습니다: " + error.message;
  }
});

// ---------------------------------------------------------------------------
// Sample image generation (canvas)
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// kind: "normal" | "ai". Returns a canvas (512x512).
function makeSampleCanvas(kind, seed) {
  const rand = mulberry32(seed);
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d");

  // Soft gradient background
  const grad = g.createLinearGradient(0, 0, size, size);
  const base = [80 + rand() * 80, 90 + rand() * 80, 110 + rand() * 80].map(Math.round);
  grad.addColorStop(0, `rgb(${base[0]}, ${base[1]}, ${base[2]})`);
  grad.addColorStop(1, `rgb(${Math.round(base[0] * 0.5)}, ${Math.round(base[1] * 0.6)}, ${Math.round(base[2] * 0.7)})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);

  // Soft blob (fake "object")
  const bx = size * (0.3 + rand() * 0.4);
  const by = size * (0.3 + rand() * 0.4);
  const br = size * (0.15 + rand() * 0.15);
  const blob = g.createRadialGradient(bx, by, br * 0.1, bx, by, br);
  blob.addColorStop(0, `rgba(${Math.round(150 + rand() * 100)}, ${Math.round(150 + rand() * 100)}, ${Math.round(150 + rand() * 100)}, 0.9)`);
  blob.addColorStop(1, "rgba(0, 0, 0, 0)");
  g.fillStyle = blob;
  g.fillRect(0, 0, size, size);

  // Pixel-level pass: irregular noise, plus periodic grid for "ai"
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  const TWO_PI = Math.PI * 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let delta = (rand() * 2 - 1) * 12; // irregular sensor-like noise
      if (kind === "ai") {
        delta += Math.sin((TWO_PI * x) / 8) * Math.sin((TWO_PI * y) / 8) * 15;
      }
      d[i] = Math.max(0, Math.min(255, d[i] + delta));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + delta));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + delta));
    }
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

// Build the evidence ctx contract: { file, gray256, canvas }
async function buildCtx(sourceCanvas) {
  const file = await new Promise((resolve, reject) => {
    sourceCanvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("toBlob failed"));
    }, "image/png");
  });

  // canvas at natural size capped 512px long edge — sourceCanvas is 512x512 already
  const canvas = sourceCanvas;

  // gray256: 256x256 luminance, image drawn ignoring aspect
  const small = document.createElement("canvas");
  small.width = 256;
  small.height = 256;
  const sg = small.getContext("2d");
  sg.drawImage(sourceCanvas, 0, 0, 256, 256);
  const data = sg.getImageData(0, 0, 256, 256).data;
  const gray256 = new Float64Array(256 * 256);
  for (let p = 0; p < gray256.length; p++) {
    const i = p * 4;
    gray256[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return { file, gray256, canvas };
}

// ---------------------------------------------------------------------------
// Evidence module loading (dynamic — waitlist must never break)
// ---------------------------------------------------------------------------
let evidencePromise = null;
function loadEvidence() {
  if (!evidencePromise) {
    evidencePromise = import("./evidence/registry.js").then((mod) => ({
      // 랜딩 미니 데모·벤치마크는 외부 API 호출 없이 로컬(브라우저) 검사만 사용합니다.
      // Gemini 정밀 분석은 판별 데모 전체 화면(detect.html)에서 실행됩니다.
      analyzers: mod.default.filter((a) => a.id !== "gemini"),
      overallVerdict: mod.overallVerdict,
    }));
  }
  return evidencePromise;
}

async function analyzeCtx(ctx) {
  const { analyzers, overallVerdict } = await loadEvidence();
  const start = performance.now();
  const reports = [];
  for (const analyzer of analyzers) {
    reports.push(await analyzer.analyze(ctx));
  }
  const elapsedMs = performance.now() - start;
  const verdict = overallVerdict(reports);
  return { reports, verdict, elapsedMs };
}

const LEVEL_EMOJI = { green: "🟢", amber: "🟡", red: "🔴" };

// ---------------------------------------------------------------------------
// Mini demo widget
// ---------------------------------------------------------------------------
const demoResult = document.getElementById("demo-result");
const demoNormalBtn = document.getElementById("demo-normal-btn");
const demoAiBtn = document.getElementById("demo-ai-btn");

function setDemoBusy(busy) {
  demoNormalBtn.disabled = busy;
  demoAiBtn.disabled = busy;
}

async function runMiniDemo(kind) {
  setDemoBusy(true);
  demoResult.innerHTML = '<p class="demo-placeholder">샘플을 만들고 검사하는 중…</p>';
  try {
    const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    const sample = makeSampleCanvas(kind, seed);
    const ctx = await buildCtx(sample);
    const { verdict, elapsedMs } = await analyzeCtx(ctx);
    const emoji = LEVEL_EMOJI[verdict.level] || "⚪";
    demoResult.innerHTML =
      '<div class="verdict verdict-' + verdict.level + '">' +
      '<span class="verdict-emoji">' + emoji + "</span>" +
      '<div class="verdict-text">' +
      '<strong class="verdict-label"></strong>' +
      '<p class="verdict-summary"></p>' +
      '<p class="verdict-meta">검사 시간: ' + elapsedMs.toFixed(0) + "ms · 브라우저에서만 계산됨</p>" +
      "</div></div>";
    demoResult.querySelector(".verdict-label").textContent = verdict.label;
    demoResult.querySelector(".verdict-summary").textContent = verdict.summary;
  } catch (error) {
    demoResult.innerHTML = '<p class="demo-error">데모 모듈을 불러오지 못했습니다. (얼리엑세스 등록은 정상 동작합니다)</p>';
    console.error(error);
  } finally {
    setDemoBusy(false);
  }
}

if (demoNormalBtn && demoAiBtn && demoResult) {
  demoNormalBtn.addEventListener("click", () => runMiniDemo("normal"));
  demoAiBtn.addEventListener("click", () => runMiniDemo("ai"));
}

// ---------------------------------------------------------------------------
// In-browser benchmark (10 normal + 10 ai samples)
// ---------------------------------------------------------------------------
const benchBtn = document.getElementById("bench-btn");
const benchProgress = document.getElementById("bench-progress");
const benchResultBox = document.getElementById("bench-result");
const benchTpr = document.getElementById("bench-tpr");
const benchFpr = document.getElementById("bench-fpr");
const benchTime = document.getElementById("bench-time");

async function runBenchmark() {
  benchBtn.disabled = true;
  benchResultBox.hidden = true;
  const total = 20;
  const kinds = [];
  for (let i = 0; i < 10; i++) kinds.push("normal");
  for (let i = 0; i < 10; i++) kinds.push("ai");

  let aiFlagged = 0;
  let normalFlagged = 0;
  let totalMs = 0;
  try {
    for (let i = 0; i < total; i++) {
      benchProgress.textContent = "측정 중… " + (i + 1) + "/" + total;
      const kind = kinds[i];
      const seed = (Date.now() + i * 7919 + Math.floor(Math.random() * 100000)) >>> 0;
      const ctx = await buildCtx(makeSampleCanvas(kind, seed));
      const { verdict, elapsedMs } = await analyzeCtx(ctx);
      totalMs += elapsedMs;
      const flagged = verdict.level === "amber" || verdict.level === "red";
      if (kind === "ai" && flagged) aiFlagged++;
      if (kind === "normal" && flagged) normalFlagged++;
      // Give the browser a frame to repaint the progress text
      await new Promise((r) => setTimeout(r, 0));
    }
    benchTpr.textContent = aiFlagged + "/10 (" + (aiFlagged * 10) + "%)";
    benchFpr.textContent = normalFlagged + "/10 (" + (normalFlagged * 10) + "%)";
    benchTime.textContent = (totalMs / total).toFixed(1) + "ms";
    benchProgress.textContent = "측정 완료 (샘플 " + total + "장)";
    benchResultBox.hidden = false;
  } catch (error) {
    benchProgress.textContent = "데모 모듈을 불러오지 못했습니다. (얼리엑세스 등록은 정상 동작합니다)";
    console.error(error);
  } finally {
    benchBtn.disabled = false;
  }
}

if (benchBtn && benchProgress && benchResultBox) {
  benchBtn.addEventListener("click", runBenchmark);
}
