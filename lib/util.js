
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

const toB64 = (buf) => { const u = new Uint8Array(buf); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

const fromB64 = (b) => Uint8Array.from(atob(b), c => c.charCodeAt(0));

export { uid, randomBytes, toB64, fromB64 };
