// Cloudflare Worker: private bridge between the budget app and Enable Banking (Sparekassen) + Saxo OpenAPI.
// Holds the secrets, stores nothing. Deploy by pasting this file into a Worker in the Cloudflare dashboard.
//
// Variables/secrets to set on the Worker (Settings -> Variables and Secrets):
//   APP_SECRET        your own password; the app must send it (header X-App-Secret)
//   ALLOWED_ORIGINS   e.g. "https://<user>.github.io,http://localhost:8080"
//   EB_APP_ID         Enable Banking application id
//   EB_PRIVATE_KEY    Enable Banking private key (PEM, the whole text)
//   EB_ASPSP_NAME     optional, default "Sparekassen Kronjylland"
//   EB_COUNTRY        optional, default "DK"
//   SAXO_APP_KEY      Saxo app key
//   SAXO_APP_SECRET   Saxo app secret
//   SAXO_ENV          optional, "live" (default) or "sim"

const EB_BASE = "https://api.enablebanking.com";
const SAXO = {
  live: { auth: "https://live.logonvalidation.net", api: "https://gateway.saxobank.com/openapi" },
  sim: { auth: "https://sim.logonvalidation.net", api: "https://gateway.saxobank.com/sim/openapi" },
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = allowedOrigins(env);
    // Echo the caller's origin so the app can read our error messages even when it's not allowed yet;
    // everything past the origin and secret checks below is still refused to other sites.
    const cors = {
      "Access-Control-Allow-Origin": origin || "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-App-Secret",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return reply({ error: "Workeren kører. Den bruges af budget-appen og svarer kun på POST." }, 405);
    if (!allowed.includes(origin)) {
      return reply({
        error: allowed.length
          ? `Appens adresse ${origin || "(ukendt)"} står ikke i ALLOWED_ORIGINS på workeren. Tilføj præcis "${origin}" (uden sti).`
          : `ALLOWED_ORIGINS mangler på workeren. Sæt den til "${origin}".`,
        code: "origin",
      }, 403);
    }
    if (!env.APP_SECRET) return reply({ error: "APP_SECRET mangler på workeren.", code: "secret" }, 500);
    if (!timingSafeEqual(request.headers.get("X-App-Secret") || "", env.APP_SECRET)) {
      return reply({ error: "Forkert adgangskode. Den skal være præcis det samme som APP_SECRET på workeren.", code: "secret" }, 401);
    }

    let body = {};
    try { body = await request.json(); } catch {}
    // PSD2: fetches the user starts themselves carry their IP/user agent, which exempts them from
    // the bank's limit on unattended fetches (typically 4 per day).
    const psu = body.interactive ? {
      ip: request.headers.get("CF-Connecting-IP") || "",
      ua: request.headers.get("User-Agent") || "",
    } : null;
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    const routes = {
      "/ping": ping,
      "/eb/start": ebStart,
      "/eb/session": ebSession,
      "/eb/sync": ebSync,
      "/saxo/start": saxoStart,
      "/saxo/token": saxoToken,
      "/saxo/refresh": saxoRefresh,
      "/saxo/portfolio": saxoPortfolio,
    };
    const handler = routes[path];
    if (!handler) return reply({ error: "Ukendt sti " + path }, 404);
    try {
      return reply(await handler(body, env, psu));
    } catch (e) {
      return reply({ error: e.message || String(e), code: e.code, upstreamStatus: e.status }, e.status && e.status < 500 ? e.status : 502);
    }
  },
};

const allowedOrigins = (env) => (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch with one retry on network errors and 5xx answers.
async function fetchRetry(url, init) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500 && attempt < 1) { await sleep(800); continue; }
      return res;
    } catch (e) {
      if (attempt >= 1) throw new UpstreamError("Kunne ikke få forbindelse – prøv igen om lidt.", 503);
      await sleep(800);
    }
  }
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

class UpstreamError extends Error {
  constructor(msg, status, code) { super(msg); this.status = status; this.code = code; }
}

async function upstream(res, label) {
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) {
    if (res.status === 429) {
      throw new UpstreamError(`${label}: grænsen for antal hentninger er nået. Prøv igen senere – banker tillader typisk kun 4 automatiske hentninger i døgnet.`, 429, "rate_limited");
    }
    const msg = data?.message || data?.detail || data?.error_description || data?.error || data?.Message || text.slice(0, 300);
    throw new UpstreamError(`${label}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`, res.status);
  }
  return data ?? {};
}

// Setup check: reports each piece of configuration separately so the app can show what's missing.
async function ping(_body, env) {
  const checks = [];
  const add = (id, ok, msg) => checks.push({ id, ok, msg });
  add("origins", allowedOrigins(env).length > 0, `ALLOWED_ORIGINS: ${allowedOrigins(env).join(", ") || "mangler"}`);
  if (!env.EB_APP_ID) add("eb_app", false, "EB_APP_ID mangler");
  else add("eb_app", true, "EB_APP_ID er sat");
  if (!env.EB_PRIVATE_KEY) add("eb_key", false, "EB_PRIVATE_KEY mangler");
  else {
    try { cachedKey = null; await ebKey(env); add("eb_key", true, "EB_PRIVATE_KEY kan læses"); }
    catch (e) { add("eb_key", false, "EB_PRIVATE_KEY kan ikke læses – indsæt hele .pem-filens tekst, inkl. BEGIN/END-linjerne"); }
  }
  add("saxo_key", Boolean(env.SAXO_APP_KEY), env.SAXO_APP_KEY ? "SAXO_APP_KEY er sat" : "SAXO_APP_KEY mangler");
  add("saxo_secret", Boolean(env.SAXO_APP_SECRET), env.SAXO_APP_SECRET ? "SAXO_APP_SECRET er sat" : "SAXO_APP_SECRET mangler");
  const saxoEnvOk = !env.SAXO_ENV || ["live", "sim"].includes(env.SAXO_ENV);
  add("saxo_env", saxoEnvOk, saxoEnvOk ? `Saxo-miljø: ${env.SAXO_ENV === "sim" ? "sim (demo)" : "live"}` : `SAXO_ENV skal være "live" eller "sim", ikke "${env.SAXO_ENV}"`);
  const byId = Object.fromEntries(checks.map((c) => [c.id, c.ok]));
  return {
    ok: true,
    bank: Boolean(byId.eb_app && byId.eb_key),
    saxo: Boolean(byId.saxo_key && byId.saxo_secret && byId.saxo_env),
    saxoEnv: env.SAXO_ENV === "sim" ? "sim" : "live",
    checks,
  };
}

// ---------------- Enable Banking ----------------

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

function derLength(n) {
  if (n < 0x80) return [n];
  const out = [];
  while (n > 0) { out.unshift(n & 0xff); n >>= 8; }
  return [0x80 | out.length, ...out];
}

// Wrap a PKCS#1 RSA key ("BEGIN RSA PRIVATE KEY") in a PKCS#8 envelope, which is what WebCrypto imports.
function pkcs1ToPkcs8(pkcs1) {
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLength(pkcs1.length), ...pkcs1];
  const inner = [0x02, 0x01, 0x00, ...algId, ...octet];
  return new Uint8Array([0x30, ...derLength(inner.length), ...inner]);
}

let cachedKey = null;
async function ebKey(env) {
  if (cachedKey) return cachedKey;
  const pem = (env.EB_PRIVATE_KEY || "").trim();
  if (!pem) throw new UpstreamError("EB_PRIVATE_KEY mangler på workeren", 500);
  const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  try {
    let der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    if (isPkcs1) der = pkcs1ToPkcs8(der);
    cachedKey = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    throw new UpstreamError("EB_PRIVATE_KEY på workeren kan ikke læses. Indsæt hele .pem-filens tekst, inkl. BEGIN/END-linjerne.", 500, "config");
  }
  return cachedKey;
}

async function ebJwt(env) {
  if (!env.EB_APP_ID) throw new UpstreamError("EB_APP_ID mangler på workeren", 500);
  const iat = Math.floor(Date.now() / 1000);
  const head = b64urlJson({ typ: "JWT", alg: "RS256", kid: env.EB_APP_ID });
  const claims = b64urlJson({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat, exp: iat + 3600 });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await ebKey(env), new TextEncoder().encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64url(sig)}`;
}

async function eb(env, method, path, payload, psu) {
  const headers = { Authorization: `Bearer ${await ebJwt(env)}`, "Content-Type": "application/json" };
  if (psu?.ip) headers["Psu-Ip-Address"] = psu.ip;
  if (psu?.ua) headers["Psu-User-Agent"] = psu.ua;
  const res = await fetchRetry(EB_BASE + path, { method, headers, body: payload ? JSON.stringify(payload) : undefined });
  return upstream(res, "Enable Banking");
}

async function ebStart(body, env) {
  if (!body.redirect_url || !body.state) throw new UpstreamError("redirect_url og state mangler", 400);
  const country = env.EB_COUNTRY || "DK";
  const wanted = (env.EB_ASPSP_NAME || "Sparekassen Kronjylland").toLowerCase();
  const list = await eb(env, "GET", `/aspsps?country=${encodeURIComponent(country)}&psu_type=personal`);
  const aspsp = (list.aspsps || []).find((a) => a.name.toLowerCase() === wanted)
    || (list.aspsps || []).find((a) => a.name.toLowerCase().includes(wanted));
  if (!aspsp) throw new UpstreamError(`Banken "${env.EB_ASPSP_NAME || "Sparekassen Kronjylland"}" findes ikke hos Enable Banking (${country})`, 404);
  const maxSeconds = aspsp.maximum_consent_validity || 90 * 86400;
  const validUntil = new Date(Date.now() + Math.min(maxSeconds, 180 * 86400) * 1000 - 60000).toISOString();
  const auth = await eb(env, "POST", "/auth", {
    access: { valid_until: validUntil },
    aspsp: { name: aspsp.name, country },
    state: body.state,
    redirect_url: body.redirect_url,
    psu_type: "personal",
    language: "da",
  });
  return { url: auth.url, bank: aspsp.name };
}

async function ebSession(body, env) {
  if (!body.code) throw new UpstreamError("code mangler", 400);
  const s = await eb(env, "POST", "/sessions", { code: body.code });
  return {
    session_id: s.session_id,
    valid_until: s.access?.valid_until || null,
    bank: s.aspsp?.name || null,
    accounts: (s.accounts || []).map((a) => ({
      uid: a.uid,
      name: a.name || a.product || a.details || "Konto",
      iban: a.account_id?.iban || null,
      currency: a.currency || "DKK",
    })),
  };
}

const BALANCE_PREFERENCE = ["ITAV", "CLAV", "ITBD", "CLBD", "XPCD", "OPAV", "OPBD"];

function pickBalance(balances) {
  for (const t of BALANCE_PREFERENCE) {
    const b = balances.find((x) => x.balance_type === t);
    if (b) return +b.balance_amount.amount;
  }
  return balances.length ? +balances[0].balance_amount.amount : null;
}

function normalizeTx(t) {
  const raw = Math.abs(parseFloat(t.transaction_amount?.amount ?? "0"));
  const amount = t.credit_debit_indicator === "DBIT" ? -raw : raw;
  const date = t.booking_date || t.value_date || t.transaction_date || null;
  const counterparty = t.credit_debit_indicator === "DBIT" ? t.creditor?.name : t.debtor?.name;
  const remit = Array.isArray(t.remittance_information) ? t.remittance_information.join(" ") : (t.remittance_information || "");
  const description = (remit || counterparty || t.bank_transaction_code?.description || "Ukendt").replace(/\s+/g, " ").trim();
  return { ref: t.entry_reference || null, date, description, amount: Math.round(amount * 100) / 100 };
}

async function ebSync(body, env, psu) {
  if (!body.session_id) throw new UpstreamError("session_id mangler", 400);
  const session = await eb(env, "GET", `/sessions/${encodeURIComponent(body.session_id)}`);
  if (session.status && session.status !== "AUTHORIZED") {
    return { status: session.status, valid_until: session.access?.valid_until || null, accounts: [] };
  }
  const uids = Array.isArray(body.accounts) && body.accounts.length ? body.accounts : session.accounts || [];
  const dateFrom = /^\d{4}-\d{2}-\d{2}$/.test(body.date_from || "") ? body.date_from : null;
  const accounts = [];
  for (const uid of uids) {
    const id = encodeURIComponent(uid);
    const bal = await eb(env, "GET", `/accounts/${id}/balances`, null, psu);
    const transactions = [];
    let key = null;
    for (let page = 0; page < 50; page++) {
      const q = new URLSearchParams();
      if (dateFrom) q.set("date_from", dateFrom);
      if (key) q.set("continuation_key", key);
      const r = await eb(env, "GET", `/accounts/${id}/transactions?${q}`, null, psu);
      for (const t of r.transactions || []) {
        const status = (t.status || "BOOK").toUpperCase();
        if (status === "PDNG" || status === "PEND") continue;
        transactions.push(normalizeTx(t));
      }
      key = r.continuation_key || null;
      if (!key) break;
    }
    accounts.push({ uid, balance: pickBalance(bal.balances || []), transactions });
  }
  return { status: session.status || "AUTHORIZED", valid_until: session.access?.valid_until || null, accounts };
}

// ---------------- Saxo ----------------

function saxoEnv(env) {
  if (!env.SAXO_APP_KEY || !env.SAXO_APP_SECRET) throw new UpstreamError("SAXO_APP_KEY/SAXO_APP_SECRET mangler på workeren", 500);
  return SAXO[env.SAXO_ENV === "sim" ? "sim" : "live"];
}

function saxoStart(body, env) {
  const s = saxoEnv(env);
  if (!body.redirect_uri || !body.state) throw new UpstreamError("redirect_uri og state mangler", 400);
  const q = new URLSearchParams({ response_type: "code", client_id: env.SAXO_APP_KEY, state: body.state, redirect_uri: body.redirect_uri });
  return { url: `${s.auth}/authorize?${q}` };
}

async function saxoTokenRequest(env, params) {
  const s = saxoEnv(env);
  const res = await fetchRetry(`${s.auth}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${env.SAXO_APP_KEY}:${env.SAXO_APP_SECRET}`),
    },
    body: new URLSearchParams(params),
  });
  const t = await upstream(res, "Saxo login");
  return {
    access_token: t.access_token,
    expires_in: t.expires_in,
    refresh_token: t.refresh_token,
    refresh_token_expires_in: t.refresh_token_expires_in,
  };
}

function saxoToken(body, env) {
  if (!body.code || !body.redirect_uri) throw new UpstreamError("code og redirect_uri mangler", 400);
  return saxoTokenRequest(env, { grant_type: "authorization_code", code: body.code, redirect_uri: body.redirect_uri });
}

function saxoRefresh(body, env) {
  if (!body.refresh_token || !body.redirect_uri) throw new UpstreamError("refresh_token og redirect_uri mangler", 400);
  return saxoTokenRequest(env, { grant_type: "refresh_token", refresh_token: body.refresh_token, redirect_uri: body.redirect_uri });
}

async function saxoGet(env, token, path) {
  const res = await fetchRetry(saxoEnv(env).api + path, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new UpstreamError("Saxo-login er udløbet. Log ind igen.", 401, "saxo_login");
  return upstream(res, "Saxo");
}

async function saxoPortfolio(body, env) {
  if (!body.access_token) throw new UpstreamError("access_token mangler", 400);
  const bal = await saxoGet(env, body.access_token, "/port/v1/balances/me");
  const positions = [];
  let next = "/port/v1/netpositions/me?FieldGroups=NetPositionBase,NetPositionView,DisplayAndFormat&$top=500";
  for (let i = 0; next && i < 20; i++) {
    const r = await saxoGet(env, body.access_token, next);
    for (const p of r.Data || []) {
      const b = p.NetPositionBase || {}, v = p.NetPositionView || {}, d = p.DisplayAndFormat || {};
      positions.push({
        id: p.NetPositionId,
        name: d.Description || d.Symbol || p.NetPositionId,
        symbol: d.Symbol || "",
        currency: d.Currency || "DKK",
        assetType: b.AssetType || null,
        amount: b.Amount ?? 0,
        avgPrice: v.AverageOpenPrice ?? 0,
        price: v.CurrentPrice ?? 0,
        marketValue: v.MarketValue ?? null,
        marketValueBase: v.MarketValueInBaseCurrency ?? null,
      });
    }
    // __next is an absolute URL; keep only the part after the gateway base.
    next = r.__next ? r.__next.replace(/^https?:\/\/[^/]+\/(sim\/)?openapi/, "") : null;
  }
  return {
    currency: bal.Currency || "DKK",
    cash: bal.CashBalance ?? 0,
    total: bal.TotalValue ?? null,
    positions,
  };
}
