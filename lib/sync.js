import { fromB64, toB64 } from "./util.js";

const te = new TextEncoder(), td = new TextDecoder();

async function syncCryptoKey(secret) {
  const base = await crypto.subtle.importKey("raw", te.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: te.encode("budget-app-sync-v1"), iterations: 150000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

const gz = async (bytes, mode) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(mode === "z" ? new CompressionStream("gzip") : new DecompressionStream("gzip"))).arrayBuffer());

async function sealData(obj, secret) {
  let bytes = te.encode(JSON.stringify(obj)), z = false;
  if (typeof CompressionStream !== "undefined") { bytes = await gz(bytes, "z"); z = true; }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await syncCryptoKey(secret), bytes);
  return { data: (z ? "z:" : "") + toB64(ct), iv: toB64(iv) };
}

async function openData(blob, secret) {
  const z = blob.data.startsWith("z:");
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(blob.iv) }, await syncCryptoKey(secret), fromB64(z ? blob.data.slice(2) : blob.data)));
  return JSON.parse(td.decode(z ? await gz(pt, "u") : pt));
}

const deviceName = () => /iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad" : /Android/.test(navigator.userAgent) ? "Android" : /Mac/.test(navigator.userAgent) ? "Mac" : /Windows/.test(navigator.userAgent) ? "Windows-pc" : "computer";

export { te, td, syncCryptoKey, gz, sealData, openData, deviceName };
