// evidence/registry.js — 증거 분석기 레지스트리
//
// 새 분석기를 추가하려면: 같은 형태({ id, title, order, available, analyze })의
// 모듈을 만들고 아래 배열에 넣으면 결과 카드가 자동으로 늘어납니다.

import metadata from "./metadata.js";
import frequency from "./frequency.js";
import recompression from "./recompression.js";
import sensor from "./sensor.js";
import gemini from "./gemini.js";

const analyzers = [metadata, frequency, recompression, sensor, gemini].sort(
  (a, b) => a.order - b.order
);
export default analyzers;

// 종합 판정 — 가중 다수결 휴리스틱입니다.
// signal >= 0.6 → "의심(suspicious)", 0.35 ~ 0.6 → "불명확(unclear)", null은 집계 제외.
// Gemini(내용 기반 정밀 분석)는 로컬 휴리스틱보다 신뢰도가 높아 2표로 계산합니다.
// red: 의심 2표 이상 / amber: 의심 1표 또는 불명확 2개 이상 / green: 그 외
export function overallVerdict(reports) {
  const valid = reports.filter((r) => typeof r.signal === "number");
  const suspicious = valid.filter((r) => r.signal >= 0.6);
  const unclear = valid.filter((r) => r.signal >= 0.35 && r.signal < 0.6);
  const weight = (r) => (r.id === "gemini" ? 2 : 1);
  const suspiciousVotes = suspicious.reduce((n, r) => n + weight(r), 0);

  let level, label;
  if (suspiciousVotes >= 2) {
    level = "red";
    label = "여러 의심 정황이 발견됐습니다";
  } else if (suspiciousVotes === 1 || unclear.length >= 2) {
    level = "amber";
    label = "추가 확인이 필요한 신호가 있습니다";
  } else {
    level = "green";
    label = "뚜렷한 특이점이 보이지 않습니다";
  }

  // 실제로 수행된 검사 수 기준으로 요약 (실행 불가였던 검사는 제외하고 언급)
  const total = valid.length;
  const skipped = reports.length - total;
  const skippedNote = skipped > 0 ? ` (${skipped}가지 검사는 이번에 수행되지 못했습니다.)` : "";
  let summary;
  if (suspicious.length > 0) {
    const names = suspicious.map((r) => r.title).join(", ");
    summary = `${total}가지 검사 중 ${suspicious.length}가지(${names})에서 의심 신호가 나왔습니다.${skippedNote}`;
  } else if (unclear.length > 0) {
    const names = unclear.map((r) => r.title).join(", ");
    summary = `${total}가지 검사 중 ${unclear.length}가지(${names})에서 애매한 신호가 있어 추가 확인을 권장합니다.${skippedNote}`;
  } else {
    summary = `${total}가지 검사 모두에서 뚜렷한 의심 신호가 없었습니다. (휴리스틱 검사이므로 100% 보장은 아닙니다.)${skippedNote}`;
  }

  const flagged = suspicious.length > 0 ? suspicious.length : unclear.length;
  const flaggedLabel = suspicious.length > 0 ? "의심 신호" : unclear.length > 0 ? "애매한 신호" : "의심 신호";

  return { level, label, summary, flagged, flaggedLabel, total, skipped };
}
