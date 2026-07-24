// ui.js — DOM 헬퍼, 토스트, 모달, 탭, 클립보드
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// el("div", {class:"a", onclick:fn}, [children...])
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v; // 신뢰된 정적 마크업 전용
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2), v);
    else if (k === "checked" || k === "disabled" || k === "selected") {
      if (v) node.setAttribute(k, "");
      node[k] = !!v;
    } else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function escapeHTML(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// ---------- 토스트 ----------
let toastTimer = null;
export function toast(msg, kind = "info") {
  let box = $("#toast");
  if (!box) {
    box = el("div", { id: "toast" });
    document.body.appendChild(box);
  }
  box.textContent = msg;
  box.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.className = ""), 3200);
}

// ---------- 모달 확인창 (Promise<boolean>) ----------
export function confirmModal({ title, body, okText = "확인", cancelText = "취소", danger = false }) {
  return new Promise((resolve) => {
    const close = (result) => {
      overlay.remove();
      resolve(result);
    };
    const overlay = el("div", { class: "modal-overlay" }, [
      el("div", { class: "modal", role: "dialog", "aria-modal": "true" }, [
        el("h3", { text: title }),
        el("p", { class: "modal-body", text: body }),
        el("div", { class: "modal-actions" }, [
          el("button", { class: "btn", onclick: () => close(false), text: cancelText }),
          el("button", {
            class: danger ? "btn btn-danger" : "btn btn-primary",
            onclick: () => close(true),
            text: okText,
          }),
        ]),
      ]),
    ]);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
    });
    document.body.appendChild(overlay);
  });
}

// ---------- 클립보드 (실패 시 선택 가능한 텍스트 모달 폴백) ----------
export async function copyText(text, successMsg = "복사되었습니다. 카톡에 붙여넣으세요!") {
  try {
    await navigator.clipboard.writeText(text);
    toast(successMsg, "ok");
    return true;
  } catch {
    const overlay = el("div", { class: "modal-overlay" }, [
      el("div", { class: "modal" }, [
        el("h3", { text: "아래 내용을 길게 눌러 복사하세요" }),
        el("textarea", { class: "copy-fallback", readonly: "" }, [text]),
        el("div", { class: "modal-actions" }, [
          el("button", { class: "btn btn-primary", text: "닫기", onclick: () => overlay.remove() }),
        ]),
      ]),
    ]);
    document.body.appendChild(overlay);
    const ta = overlay.querySelector("textarea");
    ta.value = text;
    ta.focus();
    ta.select();
    return false;
  }
}

// ---------- 탭 ----------
// tabs: [{id, label}], onSelect(id). 반환: {select(id), setBadge(id, on)}
// 모바일에서 탭이 잘릴 때 좌우 페이드+화살표로 "옆으로 더 있음"을 표시한다.
export function tabBar(container, tabs, onSelect) {
  const bar = el("div", { class: "tabbar", role: "tablist" });
  const buttons = new Map();
  const select = (id) => {
    for (const [tid, btn] of buttons) {
      btn.classList.toggle("active", tid === id);
      btn.setAttribute("aria-selected", tid === id ? "true" : "false");
      if (tid === id) btn.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    onSelect(id);
  };
  for (const t of tabs) {
    const btn = el("button", {
      class: "tab",
      role: "tab",
      text: t.label,
      onclick: () => select(t.id),
    });
    buttons.set(t.id, btn);
    bar.appendChild(btn);
  }
  const wrap = el("div", { class: "tabbar-wrap" }, [
    bar,
    el("div", { class: "tab-fade left", "aria-hidden": "true", text: "‹" }),
    el("div", { class: "tab-fade right", "aria-hidden": "true", text: "›" }),
  ]);
  const updateFades = () => {
    wrap.classList.toggle("more-left", bar.scrollLeft > 2);
    wrap.classList.toggle("more-right", bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 2);
  };
  bar.addEventListener("scroll", updateFades, { passive: true });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(updateFades).observe(bar);
  requestAnimationFrame(updateFades);
  container.appendChild(wrap);
  // 새 소식 배지(●) — on이면 탭 라벨 뒤에 빨간 점 표시
  const setBadge = (id, on) => {
    const btn = buttons.get(id);
    if (!btn) return;
    const cur = btn.querySelector(".tab-dot");
    if (on && !cur) btn.appendChild(el("span", { class: "tab-dot", "aria-label": "새 소식" }));
    else if (!on && cur) cur.remove();
  };
  return { select, setBadge };
}

// ---------- 로딩 스피너 ----------
export function spinner(text = "처리 중…") {
  return el("div", { class: "spinner-wrap" }, [
    el("div", { class: "spinner" }),
    el("div", { class: "spinner-text", text }),
  ]);
}

export function setBusy(node, text) {
  clear(node).appendChild(spinner(text));
}
