// 위변조 판별 데모 페이지 로직
import analyzers, { overallVerdict } from "./evidence/registry.js";
import { db } from "./firebase-config.js";
import {
  collection,
  addDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.3.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);

const dropzone = $("dropzone");
const fileInput = $("file-input");
const errorMsg = $("error-msg");
const previewWrap = $("preview-wrap");
const previewImg = $("preview-img");
const previewName = $("preview-name");
const analyzeBtn = $("analyze-btn");
const resultsSection = $("results-section");
const overallCard = $("overall-card");
const evidenceCards = $("evidence-cards");

let currentFile = null;
let currentSource = "upload"; // "sample" | "upload"

/* ---------------- 샘플 이미지 생성기 (절차적, 외부 의존 없음) ---------------- */

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

// 부드러운 하늘-지평선 장면: 저주파 위주의 자연스러운 구성
function drawNaturalScene(ctx, w, h) {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, "#7db3e8");
  sky.addColorStop(0.6, "#cfe3f5");
  sky.addColorStop(0.62, "#7a8f5a");
  sky.addColorStop(1, "#4d6138");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // 부드러운 blob 몇 개 (구름/수풀 느낌)
  for (let i = 0; i < 6; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const r = 30 + Math.random() * 80;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const light = y < h * 0.6;
    g.addColorStop(0, light ? "rgba(255,255,255,0.5)" : "rgba(40,60,25,0.5)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 불규칙 랜덤 노이즈: 실제 센서 노이즈처럼 격자성 없는 잡음
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

function makeNaturalSample() {
  const w = 512, h = 384;
  const c = makeCanvas(w, h);
  drawNaturalScene(c.getContext("2d"), w, h);
  return c;
}

// AI 흔적: 같은 장면에 주기 8px의 미세 격자를 덧입혀 주파수 분석이 반응하게 함
function makeAiSample() {
  const w = 512, h = 384;
  const c = makeCanvas(w, h);
  const ctx = c.getContext("2d");
  drawNaturalScene(ctx, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v =
        Math.sin((2 * Math.PI * x) / 8) * Math.sin((2 * Math.PI * y) / 8) * 15;
      const i = (y * w + x) * 4;
      d[i] += v;
      d[i + 1] += v;
      d[i + 2] += v;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// 영수증: 균일한 흰 배경 + 텍스트 → 균일도/텍스트 특성이 드러남
function makeReceiptSample() {
  const w = 400, h = 560;
  const c = makeCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fdfdf8";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#222";
  ctx.textAlign = "center";
  ctx.font = "bold 26px monospace";
  ctx.fillText("연세 분식", w / 2, 60);
  ctx.font = "14px monospace";
  ctx.fillText("서울시 서대문구 연세로 50", w / 2, 90);
  ctx.fillText("2026-07-15 12:34", w / 2, 112);
  ctx.textAlign = "left";
  const items = [
    ["김밥", "3,500"],
    ["라면", "4,500"],
    ["떡볶이", "5,000"],
    ["오뎅", "2,000"],
  ];
  let y = 170;
  ctx.font = "16px monospace";
  for (const [name, price] of items) {
    ctx.fillText(name, 40, y);
    ctx.textAlign = "right";
    ctx.fillText(price, w - 40, y);
    ctx.textAlign = "left";
    y += 34;
  }
  ctx.beginPath();
  ctx.moveTo(40, y);
  ctx.lineTo(w - 40, y);
  ctx.strokeStyle = "#222";
  ctx.stroke();
  y += 36;
  ctx.font = "bold 20px monospace";
  ctx.fillText("합계", 40, y);
  ctx.textAlign = "right";
  ctx.fillText("15,000원", w - 40, y);
  ctx.textAlign = "center";
  ctx.font = "13px monospace";
  ctx.fillStyle = "#666";
  ctx.fillText("감사합니다. 또 오세요!", w / 2, y + 50);
  return c;
}

function canvasToFile(canvas, name) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("blob failed"));
      resolve(new File([blob], name, { type: "image/png" }));
    }, "image/png");
  });
}

/* ---------------- ctx 준비 (계약: file, gray256, canvas) ---------------- */

async function decodeToBitmap(file) {
  if ("createImageBitmap" in window) {
    return await createImageBitmap(file);
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode failed"));
    };
    img.src = url;
  });
}

async function buildCtx(file) {
  const bmp = await decodeToBitmap(file);
  const nw = bmp.naturalWidth || bmp.width;
  const nh = bmp.naturalHeight || bmp.height;

  // 자연 크기를 긴 변 512px로 캡한 canvas
  const scale = Math.min(1, 512 / Math.max(nw, nh));
  const cw = Math.max(1, Math.round(nw * scale));
  const ch = Math.max(1, Math.round(nh * scale));
  const canvas = makeCanvas(cw, ch);
  canvas.getContext("2d").drawImage(bmp, 0, 0, cw, ch);

  // 256x256으로 비율 무시하고 그린 뒤 휘도 배열 생성
  const g = makeCanvas(256, 256);
  const gc = g.getContext("2d");
  gc.drawImage(bmp, 0, 0, 256, 256);
  const data = gc.getImageData(0, 0, 256, 256).data;
  const gray256 = new Float64Array(256 * 256);
  for (let i = 0; i < gray256.length; i++) {
    const j = i * 4;
    gray256[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  }
  if (bmp.close) bmp.close();
  return { file, gray256, canvas };
}

/* ---------------- UI 렌더링 ---------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function renderPendingCards() {
  evidenceCards.innerHTML = "";
  const nodes = new Map();
  for (const a of analyzers) {
    const card = document.createElement("div");
    card.className = "card evidence-card";
    card.innerHTML = `<h3>${escapeHtml(a.title)}</h3><p><span class="spinner"></span>검사 중…</p>`;
    evidenceCards.appendChild(card);
    nodes.set(a.id, card);
  }
  return nodes;
}

function gaugeColor(signal) {
  if (signal >= 0.66) return "#f87171";
  if (signal >= 0.33) return "#fbbf24";
  return "var(--accent)";
}

function renderReport(card, report) {
  const pct = report.signal == null ? null : Math.round(report.signal * 100);
  const gauge =
    pct == null
      ? `<p class="gauge-caption">수치화할 신호 없음</p>`
      : `<div class="gauge"><div class="gauge-fill" style="width:${pct}%;background:${gaugeColor(report.signal)}"></div></div>
         <div class="gauge-caption"><span>의심 신호 ${pct}%</span><span>0% 안심 · 100% 의심</span></div>`;
  const details = (report.details || [])
    .map(
      (d) =>
        `<li><strong>${escapeHtml(d.label)}</strong>: ${escapeHtml(d.value)}<span class="detail-meaning">${escapeHtml(d.meaning)}</span></li>`
    )
    .join("");
  card.innerHTML = `
    <h3>${escapeHtml(report.title)} <span class="elapsed-tag">${Math.round(report.elapsedMs)}ms</span></h3>
    <p class="verdict-text">${escapeHtml(report.verdictText)}</p>
    ${gauge}
    ${details ? `<details><summary>자세한 수치 보기</summary><ul class="detail-list">${details}</ul></details>` : ""}
  `;
}

function renderOverall(verdict, totalMs) {
  overallCard.className = `verdict-card verdict-${verdict.level}`;
  overallCard.innerHTML = `
    <div class="verdict-label">${escapeHtml(verdict.label)}</div>
    <div class="verdict-count" aria-label="${verdict.total}개 검사 중 ${verdict.flagged}개 ${escapeHtml(verdict.flaggedLabel)}">
      <strong>${verdict.flagged}</strong><span>/ ${verdict.total}</span>
      <small>수행 검사에서 ${escapeHtml(verdict.flaggedLabel)}</small>
    </div>
    <div class="verdict-summary">${escapeHtml(verdict.summary)}</div>
    <div class="verdict-time">총 검사 시간: ${(totalMs / 1000).toFixed(2)}초</div>
  `;
}

/* ---------------- 분석 실행 ---------------- */

let analyzing = false;

async function runAnalysis(file, source) {
  if (analyzing) return;
  analyzing = true;
  analyzeBtn.disabled = true;
  errorMsg.textContent = "";
  resultsSection.classList.remove("hidden");
  overallCard.classList.add("hidden");
  const cardNodes = renderPendingCards();
  resultsSection.scrollIntoView({ behavior: "smooth" });

  const t0 = performance.now();
  try {
    const ctx = await buildCtx(file);
    const reports = [];
    for (const analyzer of analyzers) {
      const report = await analyzer.analyze(ctx);
      reports.push(report);
      const card = cardNodes.get(analyzer.id);
      if (card) renderReport(card, report);
    }
    const totalMs = performance.now() - t0;
    const verdict = overallVerdict(reports);
    renderOverall(verdict, totalMs);
    logDetection(reports, verdict, source, totalMs);
  } catch (e) {
    console.error(e);
    errorMsg.textContent =
      "이미지를 읽지 못했습니다. 손상되지 않은 이미지 파일(JPG, PNG 등)인지 확인해 주세요.";
    resultsSection.classList.add("hidden");
  } finally {
    analyzing = false;
    analyzeBtn.disabled = false;
  }
}

// Firestore 로깅: 실패해도 사용자 경험에 영향 없음
async function logDetection(reports, verdict, source, elapsedMs) {
  try {
    const bySignal = (id) => {
      const r = reports.find((rep) => rep.id === id);
      return r && r.signal != null ? r.signal : null;
    };
    await addDoc(collection(db, "detections"), {
      signals: {
        metadata: bySignal("metadata"),
        frequency: bySignal("frequency"),
        recompression: bySignal("recompression"),
        sensor: bySignal("sensor"),
        gemini: bySignal("gemini"),
      },
      verdict: verdict.level,
      source,
      elapsedMs: Math.round(elapsedMs),
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    console.warn("detection logging failed:", e);
  }
}

/* ---------------- 파일 선택/미리보기 ---------------- */

function setFile(file, source) {
  if (!file || !file.type.startsWith("image/")) {
    errorMsg.textContent = "이미지 파일만 검사할 수 있습니다. JPG나 PNG 사진을 선택해 주세요.";
    return;
  }
  errorMsg.textContent = "";
  currentFile = file;
  currentSource = source;
  if (previewImg.src) URL.revokeObjectURL(previewImg.src);
  previewImg.src = URL.createObjectURL(file);
  previewName.textContent = source === "sample" ? `샘플 이미지: ${file.name}` : file.name;
  previewWrap.classList.remove("hidden");
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) setFile(file, "upload");
});
fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files[0]) setFile(fileInput.files[0], "upload");
});

analyzeBtn.addEventListener("click", () => {
  if (currentFile) runAnalysis(currentFile, currentSource);
});

// 샘플 버튼: 생성 → 미리보기 → 바로 분석 (1초 체험)
async function handleSample(maker, name) {
  try {
    const file = await canvasToFile(maker(), name);
    setFile(file, "sample");
    await runAnalysis(file, "sample");
  } catch (e) {
    console.error(e);
    errorMsg.textContent = "샘플 이미지를 만들지 못했습니다. 다시 시도해 주세요.";
  }
}

$("sample-natural").addEventListener("click", () =>
  handleSample(makeNaturalSample, "sample-natural.png")
);
$("sample-ai").addEventListener("click", () =>
  handleSample(makeAiSample, "sample-ai.png")
);
$("sample-receipt").addEventListener("click", () =>
  handleSample(makeReceiptSample, "sample-receipt.png")
);
