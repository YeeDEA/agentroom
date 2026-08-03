// ar-sprites.js — 절차적 8-bit 픽셀 펫 렌더러 (canvas)
//
// 하드코딩 스프라이트 대신 그리드에 도형을 채워 픽셀아트를 생성한다.
// image-rendering:pixelated 로 확대해 8-bit 느낌을 낸다.
// 레벨(1~4) + 에이전트 고유 hue + mood('idle'|'eat') 로 그린다.

const GRID = 32; // 논리 픽셀 그리드

function hsl(h, s, l) {
  return `hsl(${((h % 360) + 360) % 360}, ${s}%, ${l}%)`;
}

// 타원 내부 판정
function inEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy;
}

function px(ctx, x, y, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 1, 1);
}

// 채운 타원 + 외곽선
function fillEllipse(ctx, cx, cy, rx, ry, body, outline, hi) {
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const d = inEllipse(x, y, cx, cy, rx, ry);
      if (d <= 1) {
        // 좌상단은 하이라이트
        const isHi = hi && (x - cx) < -rx * 0.15 && (y - cy) < -ry * 0.15 && d < 0.55;
        px(ctx, x, y, isHi ? hi : body);
      } else if (d <= 1.28) {
        px(ctx, x, y, outline);
      }
    }
  }
}

function eye(ctx, x, y, open, outline, ink) {
  if (open) {
    px(ctx, x, y - 1, "#ffffff");
    px(ctx, x - 1, y, "#ffffff");
    px(ctx, x, y, "#ffffff");
    px(ctx, x + 1, y, "#ffffff");
    px(ctx, x, y + 1, "#ffffff");
    px(ctx, x, y, ink); // 동공
    px(ctx, x + 1, y - 1, "#ffffff");
  } else {
    // 감은 눈(-)
    px(ctx, x - 1, y, outline);
    px(ctx, x, y, outline);
    px(ctx, x + 1, y, outline);
  }
}

/**
 * 펫을 그린다.
 * @param {HTMLCanvasElement} canvas
 * @param {number} level 1..4
 * @param {number} hue 0..360 (에이전트 고유색)
 * @param {string} mood 'idle' | 'eat'
 */
export function drawPet(canvas, level, hue, mood = "idle") {
  const ctx = canvas.getContext("2d");
  canvas.width = GRID;
  canvas.height = GRID;
  ctx.clearRect(0, 0, GRID, GRID);
  ctx.imageSmoothingEnabled = false;

  // 파스텔 팔레트 — 업무용 밝은 UI에 어울리도록 채도↓ 명도↑ (윤곽선도 부드럽게)
  const body = hsl(hue, 68, 74);
  const outline = hsl(hue, 38, 44);
  const hi = hsl(hue, 80, 88);
  const belly = hsl(hue, 60, 95);
  const ink = hsl(hue, 30, 34); // 눈·입 — 새까만 대신 톤다운
  const eating = mood === "eat";

  if (level <= 1) {
    // 알: 세로로 긴 타원 + 반점 + 흔들림용 정지 자세
    fillEllipse(ctx, 16, 18, 8.5, 11, body, outline, hi);
    // 반점(지그재그 무늬)
    ctx.fillStyle = belly;
    for (const [sx, sy] of [[12, 20], [18, 16], [15, 24], [20, 22], [13, 14]]) {
      px(ctx, sx, sy, belly);
      px(ctx, sx + 1, sy, belly);
      px(ctx, sx, sy + 1, belly);
    }
    return;
  }

  if (level === 2) {
    // 부화: 둥근 몸 + 큰 눈 + 발 + 깨진 껍질 조각
    fillEllipse(ctx, 16, 18, 9, 8.5, body, outline, hi);
    // 배
    fillEllipse(ctx, 16, 21, 5, 4.5, belly, belly, null);
    eye(ctx, 13, 16, true, outline, ink);
    eye(ctx, 19, 16, true, outline, ink);
    // 입
    if (eating) { px(ctx, 16, 20, ink); px(ctx, 15, 21, ink); px(ctx, 17, 21, ink); px(ctx, 16, 22, ink); }
    else { px(ctx, 15, 20, outline); px(ctx, 16, 21, outline); px(ctx, 17, 20, outline); }
    // 발
    px(ctx, 13, 27, outline); px(ctx, 14, 27, outline);
    px(ctx, 18, 27, outline); px(ctx, 19, 27, outline);
    // 깨진 껍질 조각
    px(ctx, 6, 26, "#e8e2f7"); px(ctx, 7, 25, "#e8e2f7"); px(ctx, 8, 26, "#cfc7ea");
    px(ctx, 25, 26, "#e8e2f7"); px(ctx, 24, 25, "#e8e2f7");
    return;
  }

  if (level === 3) {
    // 성장기: 더 큰 몸 + 팔 + 새싹 안테나
    fillEllipse(ctx, 16, 18, 10, 10, body, outline, hi);
    fillEllipse(ctx, 16, 21, 6, 6, belly, belly, null);
    eye(ctx, 12, 15, true, outline, ink);
    eye(ctx, 20, 15, true, outline, ink);
    // 볼터치
    px(ctx, 10, 18, hsl(hue + 20, 70, 72)); px(ctx, 22, 18, hsl(hue + 20, 70, 72));
    if (eating) { for (const [mx, my] of [[15,19],[16,19],[17,19],[15,20],[16,21],[17,20],[16,22]]) px(ctx, mx, my, ink); }
    else { px(ctx, 14, 20, outline); px(ctx, 15, 21, outline); px(ctx, 16, 21, outline); px(ctx, 17, 21, outline); px(ctx, 18, 20, outline); }
    // 팔
    px(ctx, 5, 19, outline); px(ctx, 6, 19, body); px(ctx, 6, 20, outline);
    px(ctx, 26, 19, outline); px(ctx, 25, 19, body); px(ctx, 25, 20, outline);
    // 발
    px(ctx, 12, 28, outline); px(ctx, 13, 28, outline);
    px(ctx, 19, 28, outline); px(ctx, 20, 28, outline);
    // 새싹 안테나
    px(ctx, 16, 6, "#6bd66b"); px(ctx, 16, 5, "#6bd66b"); px(ctx, 15, 5, "#8ee88e"); px(ctx, 17, 6, "#8ee88e"); px(ctx, 16, 7, outline);
    return;
  }

  // level 4 성숙기: 최대 크기 + 왕관 + 팔 + 반짝임
  fillEllipse(ctx, 16, 19, 11, 10.5, body, outline, hi);
  fillEllipse(ctx, 16, 22, 7, 6.5, belly, belly, null);
  eye(ctx, 12, 16, true, outline, ink);
  eye(ctx, 20, 16, true, outline, ink);
  px(ctx, 9, 19, hsl(hue + 20, 70, 72)); px(ctx, 23, 19, hsl(hue + 20, 70, 72));
  if (eating) { for (const [mx, my] of [[15,20],[16,20],[17,20],[15,21],[16,22],[17,21],[16,23]]) px(ctx, mx, my, ink); }
  else { px(ctx, 13, 21, outline); px(ctx, 14, 22, outline); px(ctx, 16, 22, outline); px(ctx, 18, 22, outline); px(ctx, 19, 21, outline); }
  // 팔
  px(ctx, 3, 20, outline); px(ctx, 4, 20, body); px(ctx, 4, 21, outline);
  px(ctx, 28, 20, outline); px(ctx, 27, 20, body); px(ctx, 27, 21, outline);
  // 발
  px(ctx, 11, 30, outline); px(ctx, 12, 30, outline);
  px(ctx, 20, 30, outline); px(ctx, 21, 30, outline);
  // 왕관(금색)
  const gold = "#ffd23f", goldD = "#d9a406";
  for (let x = 10; x <= 22; x++) px(ctx, x, 8, gold);
  px(ctx, 10, 7, gold); px(ctx, 10, 6, goldD);
  px(ctx, 16, 6, gold); px(ctx, 16, 5, goldD);
  px(ctx, 22, 7, gold); px(ctx, 22, 6, goldD);
  px(ctx, 13, 7, gold); px(ctx, 19, 7, gold);
  // 반짝임
  px(ctx, 26, 10, "#fff7cc"); px(ctx, 6, 12, "#fff7cc");
}

// 에이전트 이름/색 문자열에서 안정적인 hue 도출
export function hueFrom(str) {
  let h = 0;
  const s = String(str || "agent");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}
