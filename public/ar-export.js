// ar-export.js — 채널 대화·산출물 내보내기 (여러 파일 형식)
// 순수 함수: (messages[], meta{workspace, channel}) → 문자열. 다운로드는 download()로.

function ts(m) {
  const t = m.createdAt;
  const d = t && t.seconds ? new Date(t.seconds * 1000) : null;
  return d ? d.toLocaleString("ko-KR") : "";
}
function oneLine(s) { return String(s ?? "").replace(/\s+/g, " ").trim(); }

// 카드(system 메시지)를 마크다운 블록으로
function cardMd(m) {
  let d; try { d = JSON.parse(m.content); } catch (_) { return `> ${m.content}`; }
  if (m.kind === "summary" || m.kind === "meeting") {
    const title = m.kind === "meeting" ? "🤝 회의 결론" : "🧵 대화 요약";
    let s = `#### ${title}\n` + (d.points || []).map((p) => `- ${p}`).join("\n");
    if ((d.issues || []).length) s += `\n\n**남은 쟁점**\n` + d.issues.map((i) => `- ${i}`).join("\n");
    return s;
  }
  if (m.kind === "diagram") return `#### 📊 ${d.title || "시각화"}\n\n\`\`\`mermaid\n${d.code || ""}\n\`\`\``;
  if (m.kind === "scores") {
    const avg = (d.scores || []).length ? ((d.scores.reduce((a, b) => a + (b.score || 0), 0) / d.scores.length).toFixed(1)) : "-";
    return `#### ⭐ 평가: ${d.topic || ""}  (평균 ${avg}/10)\n\n` +
      `| 에이전트 | 점수 | 근거 |\n|---|---|---|\n` +
      (d.scores || []).map((s) => `| ${s.name} | ${s.score}/10 | ${oneLine(s.reason)} |`).join("\n");
  }
  if (m.kind === "doc") {
    let s = `#### ${d.emoji || "📋"} ${d.title || ""}\n`;
    (d.sections || []).forEach((sec) => {
      s += `\n**${sec.heading}**\n` + (sec.items || []).map((i) => `- ${i}`).join("\n") + "\n";
    });
    return s;
  }
  return `> ${m.content}`;
}

export function toMarkdown(messages, meta) {
  const head = `# ${meta.workspace} / #${meta.channel}\n\n> AgentRoom에서 내보냄 · ${new Date().toLocaleString("ko-KR")} · 메시지 ${messages.length}개\n\n---\n`;
  const body = messages.map((m) => {
    if (m.senderType === "system") return `\n${cardMd(m)}\n`;
    const who = m.senderType === "agent" ? `🤖 **${m.senderName}**` : `**${m.senderName}**`;
    const img = m.image ? "\n\n[🖼️ 이미지 첨부]" : "";
    return `${who}  \`${ts(m)}\`\n\n${m.content}${img}\n`;
  }).join("\n");
  return head + body + `\n`;
}

export function toText(messages, meta) {
  return toMarkdown(messages, meta)
    .replace(/^#+\s*/gm, "").replace(/\*\*/g, "").replace(/`/g, "").replace(/^\>\s?/gm, "");
}

export function toJSON(messages, meta) {
  return JSON.stringify({
    workspace: meta.workspace, channel: meta.channel, exportedAt: new Date().toISOString(),
    messages: messages.map((m) => {
      const base = { at: ts(m), senderType: m.senderType, senderName: m.senderName, kind: m.kind || "message" };
      if (m.senderType === "system") { try { base.card = JSON.parse(m.content); } catch (_) { base.content = m.content; } }
      else base.content = m.content;
      return base;
    }),
  }, null, 2);
}

export function toCSV(messages) {
  const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const rows = [["time", "type", "name", "kind", "content"]];
  for (const m of messages) {
    let content = m.content;
    if (m.senderType === "system") { try { const d = JSON.parse(m.content); content = JSON.stringify(d); } catch (_) {} }
    rows.push([ts(m), m.senderType, m.senderName, m.kind || "message", oneLine(content)]);
  }
  return rows.map((r) => r.map(q).join(",")).join("\r\n");
}

export function toHTML(messages, meta) {
  const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const cardHtml = (m) => {
    let d; try { d = JSON.parse(m.content); } catch (_) { return `<blockquote>${esc(m.content)}</blockquote>`; }
    if (m.kind === "summary" || m.kind === "meeting") {
      const t = m.kind === "meeting" ? "🤝 회의 결론" : "🧵 대화 요약";
      return `<div class="card"><h4>${t}</h4><ul>${(d.points || []).map((p) => `<li>${esc(p)}</li>`).join("")}</ul>${(d.issues || []).length ? `<p class="lbl">남은 쟁점</p><ul>${d.issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}</div>`;
    }
    if (m.kind === "diagram") return `<div class="card"><h4>📊 ${esc(d.title || "시각화")}</h4><pre class="mermaid">${esc(d.code || "")}</pre></div>`;
    if (m.kind === "scores") return `<div class="card"><h4>⭐ 평가: ${esc(d.topic || "")}</h4>${(d.scores || []).map((s) => `<p><b>${esc(s.name)}</b> — ${s.score}/10 · ${esc(s.reason || "")}</p>`).join("")}</div>`;
    if (m.kind === "doc") return `<div class="card"><h4>${esc(d.emoji || "📋")} ${esc(d.title || "")}</h4>${(d.sections || []).map((sec) => `<p class="lbl">${esc(sec.heading)}</p><ul>${(sec.items || []).map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`).join("")}</div>`;
    return `<blockquote>${esc(m.content)}</blockquote>`;
  };
  const body = messages.map((m) => {
    if (m.senderType === "system") return cardHtml(m);
    const cls = m.senderType === "agent" ? "msg agent" : "msg";
    const tag = m.senderType === "agent" ? "🤖 " : "";
    const img = m.image ? `<img src="${m.image}" alt="첨부 이미지" style="max-width:320px;border-radius:8px;display:block;margin-top:6px">` : "";
    return `<div class="${cls}"><div class="meta">${tag}<b>${esc(m.senderName)}</b> <span>${esc(ts(m))}</span></div><div class="body">${esc(m.content).replace(/\n/g, "<br>")}${img}</div></div>`;
  }).join("\n");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(meta.workspace)} / #${esc(meta.channel)}</title>
<style>
body{font-family:-apple-system,'Segoe UI','Noto Sans KR',sans-serif;max-width:780px;margin:0 auto;padding:32px 20px;color:#1a1730;background:#faf9ff;line-height:1.6}
h1{font-size:22px} .sub{color:#6f6795;font-size:13px;margin-bottom:24px}
.msg{margin:14px 0;padding:12px 14px;background:#fff;border:1px solid #eae7f7;border-radius:12px}
.msg.agent{border-left:3px solid #8b7cf6}
.msg .meta{font-size:12px;color:#8b7cf6} .msg .meta span{color:#a49dc8;margin-left:6px}
.msg .body{margin-top:4px}
.card{margin:14px 0;padding:14px 16px;background:#f3f1ff;border:1px solid #d8d2ff;border-radius:12px}
.card h4{margin:0 0 8px;color:#5b3fae} .card .lbl{font-weight:700;color:#6f5fe0;margin:8px 0 2px;font-size:13px}
.card ul{margin:4px 0;padding-left:20px} .mermaid{background:#fff;padding:10px;border-radius:8px;overflow:auto;font-size:12px}
blockquote{border-left:3px solid #ccc;margin:8px 0;padding-left:12px;color:#555}
</style></head><body>
<h1>${esc(meta.workspace)} / #${esc(meta.channel)}</h1>
<div class="sub">AgentRoom에서 내보냄 · ${new Date().toLocaleString("ko-KR")} · 메시지 ${messages.length}개</div>
${body}
</body></html>`;
}

export const FORMATS = {
  md: { label: "Markdown (.md)", ext: "md", mime: "text/markdown", fn: (m, meta) => toMarkdown(m, meta) },
  html: { label: "웹페이지 (.html)", ext: "html", mime: "text/html", fn: (m, meta) => toHTML(m, meta) },
  json: { label: "데이터 (.json)", ext: "json", mime: "application/json", fn: (m, meta) => toJSON(m, meta) },
  csv: { label: "표 (.csv)", ext: "csv", mime: "text/csv", fn: (m) => toCSV(m) },
  txt: { label: "텍스트 (.txt)", ext: "txt", mime: "text/plain", fn: (m, meta) => toText(m, meta) },
};

export function download(filename, mime, content) {
  const blob = new Blob([content], { type: mime + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 500);
}
