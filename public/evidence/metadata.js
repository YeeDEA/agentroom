// evidence/metadata.js — 촬영 정보(EXIF/PNG 텍스트) 확인
//
// ⚠️ 정직한 고지: 메타데이터는 쉽게 지워지거나 조작될 수 있는 "정황 증거"입니다.
// 아래 점수는 단순 휴리스틱이며, 메타데이터가 없다는 것만으로 AI 생성이라
// 단정할 수 없습니다. (메신저 전송·화면 캡처만으로도 EXIF는 사라집니다.)
//
// 외부 라이브러리 없이 파일 바이트를 직접 파싱합니다.

// AI 생성 도구 이름 — Software 태그에 이 문자열이 있으면 강한 의심 신호
const GENERATORS = ["midjourney", "stable diffusion", "dall-e", "dalle", "firefly", "imagen"];
// 편집 도구 이름 — 편집 자체가 위조는 아니므로 중간 수준 신호
const EDITORS = ["photoshop", "gimp"];

// ---------- JPEG EXIF 파싱 (IFD0의 ASCII 태그만) ----------
// 반환: { Make, Model, Software, DateTime } (없으면 undefined) 또는 null(EXIF 없음)
function parseJpegExif(bytes) {
  // JPEG SOI 확인
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let pos = 2;
  // 마커를 순회하며 APP1(Exif) 탐색 — 모든 오프셋은 경계 검사
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) break;
    const marker = bytes[pos + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2; // 길이 없는 마커
      continue;
    }
    if (marker === 0xda) break; // 이미지 데이터 시작 — 이후엔 EXIF 없음
    const segLen = (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (segLen < 2 || pos + 2 + segLen > bytes.length) break;
    if (marker === 0xe1) {
      // "Exif\0\0" 시그니처 확인
      const p = pos + 4;
      if (
        segLen >= 8 &&
        bytes[p] === 0x45 && bytes[p + 1] === 0x78 && bytes[p + 2] === 0x69 &&
        bytes[p + 3] === 0x66 && bytes[p + 4] === 0x00 && bytes[p + 5] === 0x00
      ) {
        return parseTiff(bytes, p + 6, segLen - 8);
      }
    }
    pos += 2 + segLen;
  }
  return null;
}

// TIFF 헤더 + IFD0에서 관심 태그(ASCII)만 읽는다.
function parseTiff(bytes, tiffStart, tiffLen) {
  try {
    const end = Math.min(bytes.length, tiffStart + tiffLen);
    if (tiffStart + 8 > end) return null;
    const b0 = bytes[tiffStart], b1 = bytes[tiffStart + 1];
    let little;
    if (b0 === 0x49 && b1 === 0x49) little = true;       // "II"
    else if (b0 === 0x4d && b1 === 0x4d) little = false; // "MM"
    else return null;

    const u16 = (off) => {
      if (off + 2 > end) return null;
      return little ? bytes[off] | (bytes[off + 1] << 8) : (bytes[off] << 8) | bytes[off + 1];
    };
    const u32 = (off) => {
      if (off + 4 > end) return null;
      return little
        ? (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16)) + bytes[off + 3] * 0x1000000
        : bytes[off] * 0x1000000 + ((bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]);
    };

    if (u16(tiffStart + 2) !== 42) return null;
    const ifdOffset = u32(tiffStart + 4);
    if (ifdOffset === null) return null;
    const ifd = tiffStart + ifdOffset;
    const count = u16(ifd);
    if (count === null || count > 500) return null;

    const WANT = { 0x010f: "Make", 0x0110: "Model", 0x0131: "Software", 0x0132: "DateTime" };
    const out = {};
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      if (entry + 12 > end) break;
      const tag = u16(entry);
      const name = WANT[tag];
      if (!name) continue;
      const type = u16(entry + 2);
      const num = u32(entry + 4);
      if (type !== 2 || num === null || num === 0 || num > 1024) continue; // ASCII만
      // 값이 4바이트 이하이면 엔트리에 인라인, 아니면 오프셋
      let valOff = num <= 4 ? entry + 8 : tiffStart + u32(entry + 8);
      if (valOff === null || valOff < tiffStart || valOff + num > end) continue;
      let s = "";
      for (let k = 0; k < num; k++) {
        const ch = bytes[valOff + k];
        if (ch === 0) break;
        s += String.fromCharCode(ch);
      }
      s = s.trim();
      if (s) out[name] = s;
    }
    return out;
  } catch {
    return null;
  }
}

// ---------- PNG 텍스트 청크 파싱 ----------
// tEXt/iTXt 청크의 키워드를 수집. Stable Diffusion 계열은 tEXt "parameters"에
// 생성 프롬프트/설정을 그대로 기록한다.
function parsePngText(bytes) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) return null;

  const texts = []; // { keyword, textSnippet }
  let pos = 8;
  try {
    while (pos + 12 <= bytes.length) {
      const len =
        bytes[pos] * 0x1000000 + ((bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]);
      const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      const dataStart = pos + 8;
      if (len < 0 || dataStart + len + 4 > bytes.length) break;
      if (type === "tEXt" || type === "iTXt") {
        // 키워드는 널 바이트 전까지
        let kwEnd = dataStart;
        const kwMax = Math.min(dataStart + 80, dataStart + len);
        while (kwEnd < kwMax && bytes[kwEnd] !== 0) kwEnd++;
        let keyword = "";
        for (let k = dataStart; k < kwEnd; k++) keyword += String.fromCharCode(bytes[k]);
        // 값 앞부분만 스니펫으로 (iTXt는 압축 플래그 등이 섞일 수 있으나 스니펫 용도로 충분)
        let snippet = "";
        const snipEnd = Math.min(kwEnd + 1 + 120, dataStart + len);
        for (let k = kwEnd + 1; k < snipEnd; k++) {
          const ch = bytes[k];
          if (ch >= 32 && ch < 127) snippet += String.fromCharCode(ch);
        }
        if (keyword) texts.push({ keyword, snippet });
      }
      if (type === "IEND") break;
      pos = dataStart + len + 4; // 데이터 + CRC
    }
  } catch {
    // 손상된 청크 — 지금까지 수집한 것만 사용
  }
  return texts;
}

// ---------- EvidenceReport 생성 ----------
async function analyze(ctx) {
  const t0 = performance.now();
  const done = (signal, verdictText, details) => ({
    id: "metadata",
    title: "촬영 정보(메타데이터) 확인",
    signal,
    verdictText,
    details,
    available: true,
    elapsedMs: performance.now() - t0,
  });

  try {
    const buf = await ctx.file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const details = [];

    // ---- PNG 경로 ----
    const pngTexts = parsePngText(bytes);
    if (pngTexts !== null) {
      const suspect = pngTexts.find((t) => {
        const kw = t.keyword.toLowerCase();
        return kw === "parameters" || kw === "prompt" || kw.includes("prompt");
      });
      const software = pngTexts.find((t) => t.keyword.toLowerCase() === "software");
      for (const t of pngTexts) {
        details.push({
          label: `PNG 텍스트: ${t.keyword}`,
          value: t.snippet ? t.snippet.slice(0, 80) : "(내용 있음)",
          meaning: "이미지 파일 안에 저장된 부가 정보입니다",
        });
      }
      if (suspect) {
        // 휴리스틱: 생성 설정이 파일에 그대로 남아 있으면 매우 강한 신호 (0.95)
        return done(0.95, "AI 생성 도구가 남긴 생성 설정이 그대로 들어 있습니다", details);
      }
      if (software) {
        const sw = software.snippet.toLowerCase();
        if (GENERATORS.some((g) => sw.includes(g))) {
          return done(0.9, "AI 생성 도구의 이름이 파일에 기록되어 있습니다", details);
        }
        if (EDITORS.some((e) => sw.includes(e))) {
          return done(0.6, "편집 프로그램을 거친 흔적이 있습니다 — 위조는 아닐 수 있으나 원본은 아닙니다", details);
        }
      }
      details.push({
        label: "형식",
        value: "PNG",
        meaning: "PNG는 보통 카메라 원본이 아니라 저장·편집·캡처를 거친 형식입니다",
      });
      return done(
        0.5,
        "촬영 정보가 전혀 없습니다 — 메신저 전송·캡처로 지워졌을 수도, AI 생성물일 수도 있어 단정할 수 없습니다",
        details
      );
    }

    // ---- JPEG 경로 ----
    const exif = parseJpegExif(bytes);
    if (!exif || Object.keys(exif).length === 0) {
      // 휴리스틱: EXIF 없음 = 약한 증거. 0.5 (판단 유보에 가까움)
      details.push({
        label: "EXIF",
        value: "없음",
        meaning: "카메라가 기록하는 촬영 정보가 파일에 남아 있지 않습니다",
      });
      return done(
        0.5,
        "촬영 정보가 전혀 없습니다 — 메신저 전송·캡처로 지워졌을 수도, AI 생성물일 수도 있어 단정할 수 없습니다",
        details
      );
    }

    const MEANINGS = {
      Make: "사진을 찍은 기기 제조사 (예: Apple, Samsung)",
      Model: "사진을 찍은 기기 모델명",
      DateTime: "파일에 기록된 촬영/수정 시각",
      Software: "이미지를 만들거나 편집한 프로그램 이름",
    };
    const LABELS = { Make: "제조사", Model: "모델", DateTime: "촬영 시각", Software: "소프트웨어" };
    for (const key of ["Make", "Model", "DateTime", "Software"]) {
      if (exif[key]) {
        details.push({ label: LABELS[key], value: exif[key], meaning: MEANINGS[key] });
      }
    }

    const sw = (exif.Software || "").toLowerCase();
    if (sw && GENERATORS.some((g) => sw.includes(g))) {
      // 휴리스틱: 소프트웨어 태그에 생성 도구 이름 = 강한 신호 (0.9)
      return done(0.9, "AI 생성 도구의 이름이 촬영 정보에 기록되어 있습니다", details);
    }
    if (sw && EDITORS.some((e) => sw.includes(e))) {
      // 휴리스틱: 편집 도구 = 중간 신호 (0.6). 보정일 뿐일 수도 있음.
      return done(0.6, "편집 프로그램을 거친 흔적이 있습니다 — 위조는 아닐 수 있으나 원본은 아닙니다", details);
    }
    if (exif.Make && exif.Model && exif.DateTime) {
      // 휴리스틱: 제조사+모델+시각이 온전 = 카메라 원본일 가능성 높음 (0.1)
      return done(0.1, "카메라 촬영 정보가 온전히 남아 있습니다", details);
    }
    // 일부만 남아 있는 경우 — 판단 유보에 가까운 0.4
    return done(0.4, "촬영 정보가 일부만 남아 있습니다 — 전송 과정에서 손실됐을 수 있습니다", details);
  } catch (err) {
    return done(
      null,
      `이 검사를 수행하지 못했습니다: ${err && err.message ? err.message : "알 수 없는 오류"}`,
      []
    );
  }
}

export default {
  id: "metadata",
  title: "촬영 정보(메타데이터) 확인",
  order: 0,
  available: true,
  analyze,
};
