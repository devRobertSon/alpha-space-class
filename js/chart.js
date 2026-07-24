// chart.js — 순수 SVG 꺾은선 그래프 (본인 점수 vs 전체 평균 — 두 학원 합산)
// 외부 라이브러리 없음. 색 + 선 스타일(실선/점선) 이중 부호화로 색각 이상에도 안전.
import { el, clear } from "./ui.js";

const COLOR = {
  mine: "#2a78d6", // series-1 blue
  avg: "#52514e", // secondary ink (비교 기준선은 절제된 회색 점선)
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  tick: "#898781",
  surface: "#fcfcfb",
};

// weeks: [{id, label}], mine/avg: (number|null)[], yMax: number
export function renderScoreChart(container, { weeks, mine, avg, yMax = 100 }) {
  clear(container);
  const n = weeks.length;
  if (!n || mine.every((v) => v == null)) {
    container.appendChild(
      el("p", { class: "empty", text: "아직 표시할 퀴즈 점수가 없습니다." })
    );
    return;
  }

  const W = 360;
  const fontX = 9;
  const lineH = fontX + 3;
  const charW = fontX * 0.95;

  // X 라벨: 모든 단원을 같은 높이에서 시작해 표시한다.
  // 각 라벨의 가로 폭은 점 간격 안으로 좁게 잡고, 이름이 길면 단어 단위로
  // 계속 줄바꿈해 아래로 길어진다 (겹침 없음).
  const iw0 = W - 34 - 14;
  const slot0 = n === 1 ? iw0 : iw0 / (n - 1);
  const budget = Math.max(18, Math.min(slot0 - 6, 90)); // 라벨 한 줄 최대 폭(px)
  const maxChars = Math.max(2, Math.floor(budget / charW));
  const half = (maxChars * charW) / 2;
  // 라벨이 가운데 정렬이므로 양 끝 라벨이 잘리지 않게 여백을 라벨 반폭만큼 확보
  const M = { top: 14, right: Math.max(14, half + 2), bottom: 30, left: Math.max(34, half + 2) };
  const iw = W - M.left - M.right;

  const labelLines = weeks.map((w) =>
    wrapLabel(String(w.label).replace(/\s*\(.*\)\s*/, ""), maxChars, 99)
  );
  const maxLines = Math.max(1, ...labelLines.map((l) => l.length));
  M.bottom = 14 + maxLines * lineH + 4;

  const ih = 186;
  const H = M.top + ih + M.bottom;
  const x = (i) => M.left + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => M.top + ih - (Math.max(0, Math.min(v, yMax)) / yMax) * ih;

  let s = "";
  // 가로 그리드 (hairline, 5분할)
  const step = yMax / 5;
  for (let g = 0; g <= 5; g++) {
    const gy = y(g * step);
    s += `<line x1="${M.left}" y1="${gy}" x2="${W - M.right}" y2="${gy}" stroke="${
      g === 0 ? COLOR.axis : COLOR.grid
    }" stroke-width="1"/>`;
    s += `<text x="${M.left - 6}" y="${gy + 3.5}" text-anchor="end" font-size="10" fill="${
      COLOR.tick
    }">${Math.round(g * step)}</text>`;
  }
  // X 라벨 렌더: 모두 같은 높이에서 시작, 가운데 정렬, 줄바꿈은 아래로
  for (let i = 0; i < n; i++) {
    const tx = x(i);
    const baseY = M.top + ih + 13;
    const spans = labelLines[i]
      .map((ln, k) => `<tspan x="${tx}" dy="${k === 0 ? 0 : lineH}">${escapeXML(ln)}</tspan>`)
      .join("");
    s += `<text x="${tx}" y="${baseY}" text-anchor="middle" font-size="${fontX}" fill="${COLOR.tick}">${spans}</text>`;
  }

  // null이 끼면 선을 끊는다 (0으로 그리지 않음)
  const segments = (vals) => {
    const segs = [];
    let cur = [];
    vals.forEach((v, i) => {
      if (v == null) {
        if (cur.length) segs.push(cur);
        cur = [];
      } else cur.push([x(i), y(v)]);
    });
    if (cur.length) segs.push(cur);
    return segs;
  };
  const path = (segs, stroke, dash) =>
    segs
      .map((seg) =>
        seg.length === 1
          ? "" // 점 하나는 마커가 담당
          : `<polyline points="${seg.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${
              dash ? ` stroke-dasharray="${dash}"` : ""
            }/>`
      )
      .join("");

  s += path(segments(avg), COLOR.avg, "5 4");
  s += path(segments(mine), COLOR.mine, null);

  // 본인 점수 마커: r=4 + 표면색 2px 링 (선 위에서도 또렷하게)
  mine.forEach((v, i) => {
    if (v == null) return;
    s += `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="${COLOR.mine}" stroke="${
      COLOR.surface
    }" stroke-width="2"><title>${escapeXML(weeks[i].label)} · 내 점수 ${v}${
      avg[i] != null ? ` · 전체 평균 ${avg[i]}` : ""
    }</title></circle>`;
  });

  const svg = el("div", { class: "chart-svg" });
  svg.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="내 점수와 전체 평균 추이 그래프" style="width:100%;height:auto;display:block">${s}</svg>`;

  // 터치/클릭 → 캡션 갱신 (주차 세로 구간 전체를 히트 영역으로)
  const caption = el("div", { class: "chart-caption", text: "점을 누르면 자세한 값이 표시됩니다." });
  const svgEl = svg.querySelector("svg");
  const hitLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  for (let i = 0; i < n; i++) {
    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    const half = n === 1 ? iw / 2 : iw / (n - 1) / 2;
    r.setAttribute("x", x(i) - half);
    r.setAttribute("y", M.top);
    r.setAttribute("width", half * 2);
    r.setAttribute("height", ih);
    r.setAttribute("fill", "transparent");
    r.style.cursor = "pointer";
    const show = () => {
      const parts = [weeks[i].label];
      parts.push(mine[i] != null ? `내 점수 ${mine[i]}` : "내 점수 없음");
      if (avg[i] != null) parts.push(`전체 평균 ${avg[i]}`);
      caption.textContent = parts.join(" · ");
    };
    r.addEventListener("click", show);
    r.addEventListener("mouseenter", show);
    hitLayer.appendChild(r);
  }
  svgEl.appendChild(hitLayer);

  // 범례 (2계열 → 항상 표시, 텍스트는 잉크 색)
  const legend = el("div", { class: "chart-legend" }, [
    el("span", { class: "legend-item" }, [
      el("span", { class: "legend-swatch", html: legendLine(COLOR.mine, false) }),
      "내 점수",
    ]),
    el("span", { class: "legend-item" }, [
      el("span", { class: "legend-swatch", html: legendLine(COLOR.avg, true) }),
      "전체 평균",
    ]),
  ]);

  container.appendChild(svg);
  container.appendChild(legend);
  container.appendChild(caption);
}

// 점수 분포 히스토그램 (선생님 열람용): 만점 기준 10% 구간 막대
export function renderHistogram(container, { scores, max = 100 }) {
  clear(container);
  if (!scores.length) {
    container.appendChild(el("p", { class: "empty", text: "입력된 점수가 없습니다." }));
    return;
  }
  const buckets = new Array(10).fill(0);
  for (const s of scores) buckets[Math.min(9, Math.max(0, Math.floor((s / max) * 10)))]++;
  const peak = Math.max(...buckets);

  const W = 360;
  const H = 140;
  const M = { top: 16, right: 8, bottom: 20, left: 8 };
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;
  const slot = iw / 10;
  const barW = Math.min(24, slot - 4);

  let s = `<line x1="${M.left}" y1="${H - M.bottom}" x2="${W - M.right}" y2="${H - M.bottom}" stroke="${COLOR.axis}" stroke-width="1"/>`;
  buckets.forEach((count, i) => {
    const bx = M.left + i * slot + (slot - barW) / 2;
    const bh = peak ? (count / peak) * (ih - 6) : 0;
    const by = H - M.bottom - bh;
    if (count > 0) {
      // 위쪽만 둥근 막대 (바닥은 각지게)
      const r = Math.min(4, bh);
      s += `<path d="M${bx},${H - M.bottom} L${bx},${by + r} Q${bx},${by} ${bx + r},${by} L${bx + barW - r},${by} Q${bx + barW},${by} ${bx + barW},${by + r} L${bx + barW},${H - M.bottom} Z" fill="${COLOR.mine}"/>`;
      s += `<text x="${bx + barW / 2}" y="${by - 4}" text-anchor="middle" font-size="10" fill="#0b0b0b">${count}</text>`;
    }
    if (i % 2 === 0) {
      s += `<text x="${M.left + i * slot}" y="${H - M.bottom + 14}" text-anchor="middle" font-size="9" fill="${COLOR.tick}">${Math.round((i * max) / 10)}</text>`;
    }
  });
  s += `<text x="${W - M.right}" y="${H - M.bottom + 14}" text-anchor="end" font-size="9" fill="${COLOR.tick}">${max}</text>`;

  const box = el("div", { class: "chart-svg" });
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="점수 분포 히스토그램" style="width:100%;height:auto;display:block">${s}</svg>`;
  container.appendChild(box);
}

function legendLine(color, dashed) {
  return `<svg viewBox="0 0 28 10" width="28" height="10" aria-hidden="true"><line x1="1" y1="5" x2="27" y2="5" stroke="${color}" stroke-width="2"${
    dashed ? ' stroke-dasharray="5 4"' : ""
  }/>${dashed ? "" : `<circle cx="14" cy="5" r="3.5" fill="${color}" stroke="#fcfcfb" stroke-width="1.5"/>`}</svg>`;
}

// 단어 단위 줄바꿈 (한 줄 maxChars 이내, 최대 maxLines줄 — 넘치면 마지막 줄에 …)
function wrapLabel(text, maxChars, maxLines = 3) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  const push = () => {
    if (cur) {
      lines.push(cur);
      cur = "";
    }
  };
  for (let wd of words) {
    while (wd.length > maxChars) {
      push();
      lines.push(wd.slice(0, maxChars));
      wd = wd.slice(maxChars);
    }
    if (!wd) continue;
    if (!cur) cur = wd;
    else if (cur.length + 1 + wd.length <= maxChars) cur += " " + wd;
    else {
      push();
      cur = wd;
    }
  }
  push();
  if (!lines.length) lines.push("");
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    cut[maxLines - 1] = cut[maxLines - 1].slice(0, Math.max(1, maxChars - 1)) + "…";
    return cut;
  }
  return lines;
}

function escapeXML(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
