// crypto.js — WebCrypto 래퍼 (브라우저/Node 공용, 외부 의존성 없음)
//
// 키 유도 구조:
//   PBKDF2-SHA256(정규화된 비밀값, salt, iterations) → 256bit IKM
//   IKM → HKDF-SHA256 분리:
//     - 파일 ID : info="SHS1|student-id"  (16바이트 hex, 공개돼도 키 정보 없음)
//     - AES 키  : info="SHS1|student-key" (AES-256-GCM)
//   마스터 비밀번호는 별도 salt/반복수 + info="SHS1|roster-key"

const subtle = globalThis.crypto.subtle;

export const FORMAT_VERSION = 1;
export const ITER_STUDENT = 310000;
export const ITER_MASTER = 600000;

// 혼동되기 쉬운 문자(0/O/1/I/L) 제외 31자
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_LENGTH = 10; // XXXXX-XXXXX

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- base64 / hex (대용량 안전: 청크 단위 변환) ----------

export function b64encode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64decode(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function hexEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// ---------- 입력 정규화 ----------

// 접속 코드: 대문자화 + 구분자(하이픈/공백 등) 제거
export function normalizeCode(s) {
  return String(s || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

// 마스터 비밀번호: 한글 IME 조합형 차이(NFC/NFD)로 기기마다 달라지는 것 방지
export function normalizePassword(s) {
  return String(s || "").trim().normalize("NFC");
}

// ---------- 난수 생성 ----------

export function generateCode() {
  // 편향 없는 rejection sampling
  const chars = [];
  const limit = 256 - (256 % CODE_ALPHABET.length);
  while (chars.length < CODE_LENGTH) {
    const buf = new Uint8Array(CODE_LENGTH * 2);
    globalThis.crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit && chars.length < CODE_LENGTH) {
        chars.push(CODE_ALPHABET[b % CODE_ALPHABET.length]);
      }
    }
  }
  const raw = chars.join("");
  return raw.slice(0, 5) + "-" + raw.slice(5);
}

export function randomHexId(nBytes = 16) {
  const buf = new Uint8Array(nBytes);
  globalThis.crypto.getRandomValues(buf);
  return hexEncode(buf);
}

export function randomSaltB64(nBytes = 16) {
  const buf = new Uint8Array(nBytes);
  globalThis.crypto.getRandomValues(buf);
  return b64encode(buf);
}

export function randomKeyB64() {
  return randomSaltB64(32);
}

// ---------- AES 키 가져오기/내보내기 (학원 키, roster의 encKey 캐시용) ----------

export async function importAesKeyB64(b64) {
  return subtle.importKey("raw", b64decode(b64), { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function exportAesKeyB64(key) {
  const raw = await subtle.exportKey("raw", key);
  return b64encode(raw);
}

// ---------- 키 유도 ----------

async function pbkdf2Bits(secretStr, saltB64, iterations) {
  const baseKey = await subtle.importKey(
    "raw",
    enc.encode(secretStr),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  return subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: b64decode(saltB64),
      iterations,
    },
    baseKey,
    256
  );
}

async function hkdfFromBits(ikmBits) {
  return subtle.importKey("raw", ikmBits, "HKDF", false, ["deriveBits", "deriveKey"]);
}

async function hkdfBits(hkdfKey, info, nBytes) {
  return subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) },
    hkdfKey,
    nBytes * 8
  );
}

async function hkdfAesKey(hkdfKey, info) {
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    true, // roster의 encKey 캐시에 내보내기 위해 extractable
    ["encrypt", "decrypt"]
  );
}

// 학생 접속 코드 → { fileId, aesKey }
export async function deriveStudentKeys(code, saltStudentB64, iterations = ITER_STUDENT) {
  const norm = normalizeCode(code);
  const ikm = await pbkdf2Bits(norm, saltStudentB64, iterations);
  const hkdf = await hkdfFromBits(ikm);
  const idBits = await hkdfBits(hkdf, "SHS1|student-id", 16);
  const aesKey = await hkdfAesKey(hkdf, "SHS1|student-key");
  return { fileId: hexEncode(idBits), aesKey };
}

// 마스터 비밀번호 → roster용 AES 키
export async function deriveMasterKey(password, saltMasterB64, iterations = ITER_MASTER) {
  const norm = normalizePassword(password);
  const ikm = await pbkdf2Bits(norm, saltMasterB64, iterations);
  const hkdf = await hkdfFromBits(ikm);
  return hkdfAesKey(hkdf, "SHS1|roster-key");
}

// ---------- 암호화/복호화 ----------

function newIV() {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  return iv;
}

// JSON → {v, iv, ct} 봉투
export async function encryptJSON(key, obj) {
  const iv = newIV();
  const plain = enc.encode(JSON.stringify(obj));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  return { v: FORMAT_VERSION, iv: b64encode(iv), ct: b64encode(ct) };
}

export async function decryptJSON(key, envelope) {
  const iv = b64decode(envelope.iv);
  const ct = b64decode(envelope.ct);
  const plain = await subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(dec.decode(plain));
}

// 바이너리(PDF 등) → IV(12B) || ciphertext
export async function encryptBytes(key, arrayBuffer) {
  const iv = newIV();
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, arrayBuffer);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return out.buffer;
}

export async function decryptBytes(key, arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length < 13) throw new Error("잘못된 암호화 파일입니다.");
  const iv = bytes.subarray(0, 12);
  const ct = bytes.subarray(12);
  return subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
}
