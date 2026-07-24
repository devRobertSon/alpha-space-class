// store.js — 데이터 계층: fetch + 복호화, 주차 헬퍼
import {
  deriveStudentKeys,
  decryptJSON,
  decryptBytes,
  importAesKeyB64,
} from "./crypto.js";

// GitHub Pages CDN 캐시(최대 10분)를 피하기 위해 항상 no-store + 타임스탬프
export async function fetchJSON(path) {
  const res = await fetch(path + "?t=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${path}`);
  return res.json();
}

export async function fetchBytes(path) {
  const res = await fetch(path + "?t=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${path}`);
  return res.arrayBuffer();
}

export async function loadMeta() {
  return fetchJSON("data/meta.json");
}

export async function metaExists() {
  try {
    const res = await fetch("data/meta.json?t=" + Date.now(), { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

// 포털 로그인: 코드 → fileId 대조 → 학생 또는 선생님(열람) 세션
// 반환: {kind:"student", student, academy, ...} 또는 {kind:"teacher", teacher, academy, ...}
// 실패: Error(code: "BAD_CODE" | ...)
export async function loginPortal(code, meta) {
  const { fileId, aesKey } = await deriveStudentKeys(
    code,
    meta.saltStudent,
    meta.kdf.iterStudent
  );
  if (meta.students.includes(fileId)) {
    const envelope = await fetchJSON(`data/s/${fileId}.json`);
    const student = await decryptJSON(aesKey, envelope);
    const academyKey = await importAesKeyB64(student.academy.key);
    const academyEnv = await fetchJSON(`data/a/${student.academy.fileId}.json`);
    const academy = await decryptJSON(academyKey, academyEnv);
    // studentKey: 본인 전용 자료(퀴즈 분석 PDF 등) 복호화용
    return { kind: "student", student, academy, academyKey, studentKey: aesKey, studentFileId: fileId };
  }
  // 선생님 열람 코드: 학원 단위 집계 스냅샷(출석·점수 분포)이 든 blob
  if ((meta.teachers || []).includes(fileId)) {
    const envelope = await fetchJSON(`data/t/${fileId}.json`);
    const teacher = await decryptJSON(aesKey, envelope);
    const academyKey = await importAesKeyB64(teacher.academy.key);
    const academyEnv = await fetchJSON(`data/a/${teacher.academy.fileId}.json`);
    const academy = await decryptJSON(academyKey, academyEnv);
    return { kind: "teacher", teacher, academy, academyKey };
  }
  const err = new Error("코드를 다시 확인해 주세요.");
  err.code = "BAD_CODE";
  throw err;
}

// 자료실 파일 복호화 → Blob
export async function loadMaterial(entry, academyKey) {
  const encBuf = await fetchBytes(entry.path);
  const plainBuf = await decryptBytes(academyKey, encBuf);
  return new Blob([plainBuf], { type: entry.mime || "application/octet-stream" });
}

// ---------- 주차 헬퍼 ----------

// 학원 blob의 weeks 배열을 id 기준 정렬(ISO 주차 문자열은 사전순 = 시간순)
export function sortWeeks(weeks) {
  return [...(weeks || [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// "이번 주" = sessions에 오늘이 포함된 주차, 없으면 마지막 주차
export function currentWeek(weeks, today = new Date()) {
  const sorted = sortWeeks(weeks);
  if (!sorted.length) return null;
  const ymd = toYMD(today);
  for (const w of sorted) {
    const s = w.sessions || [];
    if (s.length && s[0] <= ymd && ymd <= s[s.length - 1]) return w;
  }
  // 오늘 이전에 시작한 마지막 주차
  let last = sorted[0];
  for (const w of sorted) {
    const s = w.sessions || [];
    if (!s.length || s[0] <= ymd) last = w;
  }
  return last;
}

export function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 날짜 → ISO 주차 id ("2026-W27") — 새 주차 기본값 제안용
export function isoWeekId(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

// ---------- 단원별 퀴즈 ----------
// 학원 blob: quizzes[] = {id, unit(단원명), weekId(응시 주차), max(만점), stats:{avg,count}|null}
// 학생 blob: quizzes = {퀴즈ID: 점수}, quizReports = {퀴즈ID: {pdf?:{path,origName,size,mime}, note?:string}}
// 한 주차에 여러 단원 퀴즈가 있을 수 있다. 정렬은 응시 주차 순 → 같은 주차는 등록 순.
export function sortQuizzes(quizzes, weeks) {
  const order = new Map(sortWeeks(weeks).map((w, i) => [w.id, i]));
  return [...(quizzes || [])]
    .map((q, i) => ({ q, i }))
    .sort((a, b) => {
      const wa = order.has(a.q.weekId) ? order.get(a.q.weekId) : 9999;
      const wb = order.has(b.q.weekId) ? order.get(b.q.weekId) : 9999;
      return wa !== wb ? wa - wb : a.i - b.i;
    })
    .map((x) => x.q);
}

export function weekLabelOf(weeks, weekId) {
  return (weeks || []).find((w) => w.id === weekId)?.label || "";
}

// 출석 코드 (ATTENDANCE_ORDER는 선택 버튼 표시 순서 — 뒤에만 추가할 것)
export const ATTENDANCE = {
  P: { label: "출석", cls: "att-p" },
  L: { label: "지각", cls: "att-l" },
  A: { label: "결석", cls: "att-a" },
  M: { label: "보강", cls: "att-m" },
  E: { label: "조퇴", cls: "att-e" },
  X: { label: "공결", cls: "att-x" },
};
export const ATTENDANCE_ORDER = ["P", "L", "A", "M", "E", "X"];

// 결석 관련 상태는 값 null로 저장한다 (키 자체가 없으면 미입력/미완료):
// - 퀴즈: student.quizzes[quizId] === null → 미응시 (평균·응시 인원에서 제외)
// - 숙제: student.weeks[wid].homework[itemId] === null → 확인 전(결석 보류, 완료율에서 제외)
export function isNoShow(map, id) {
  return !!map && id in map && map[id] === null;
}

// 접속 통계 핑 URL — 저장소 릴리스(visit-counter)의 작은 첨부 파일 주소.
// 이 파일을 받아가면 GitHub이 다운로드 횟수를 +1 세고, 관리 페이지가 그 수를 읽는다.
// GitHub Pages(*.github.io)에서만 주소를 만들 수 있고 그 외(localhost 등)는 null.
export function visitPingURL(kind, loc = location) {
  const m = String(loc.hostname || "").match(/^([^.]+)\.github\.io$/i);
  if (!m) return null;
  const seg = String(loc.pathname || "").split("/").filter(Boolean);
  const repo = seg.length && !seg[0].includes(".") ? seg[0] : `${m[1]}.github.io`;
  return `https://github.com/${m[1]}/${repo}/releases/download/visit-counter/visit-${kind}.bin`;
}

// 카톡 공유용 숙제 목록 텍스트 (관리자/학생 공용)
export function homeworkShareText(academyName, week) {
  const lines = [`📌 [${academyName}] ${week.label} 숙제`];
  const items = week.homework || [];
  if (!items.length) {
    lines.push("(등록된 숙제가 없습니다)");
  } else {
    items.forEach((item, i) => lines.push(`${i + 1}. ${item.text}`));
  }
  return lines.join("\n");
}

export function formatBytes(n) {
  if (n == null) return "";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
