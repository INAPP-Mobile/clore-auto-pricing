// Clore.ai auto-pricing, multi-server.
// Each cycle: fetch live marketplace once -> for every configured server
// profile compute the median on-demand price over comparable single-GPU
// listings (profile CLORE_GPU substring) -> set price at 95% of median
// (clamped per profile). The rented-median naturally prices stronger GPUs
// higher (live: 5070 Ti rented-median $6.50 vs 5060 Ti $3.00).
//
// Comparator set matters: rented listings are the only prices that actually
// cleared the market. Unrented (available) ones skew HIGH — they sit there
// because nobody accepts their price (measured: rented-median $2.77 vs
// available-median $4.03).
//
// Realized-price rule (2026-10-23 fix): the target is the median of the
// REALIZED (rented) comparable prices whenever AT LEAST ONE exists. The old
// rule required >=5 realized comps and otherwise fell back to the ALL-LISTING
// median — that fallback is toxic in a thin segment. Measured on the 2x 5070 Ti
// segment: only 3 of 27 comps had ever rented, so the bot priced off the
// all-listing median ($16.50, inflated by stale $24-$80 listings nobody
// accepts) and never got rented. The same rule prices the 1x 5060 Ti segment
// identically to before ($3.14 realized median -> $2.98), so it is a
// no-regression change for the healthy server.
//
// Two more correctness fixes in the same change:
// - Our own listing is excluded from the comparator set. Including it makes
//   the bot price to match its own previous price (self-referential feedback)
//   and lets one server distort another's median.
// - When the realized sample is thin (<5), the target is additionally capped
//   at the cheapest AVAILABLE comparable, so a thin market cannot price us
//   above the cheapest listing a renter can actually pick.
// - If NO comparable has ever rented, the target is the cheapest available
//   comparable (undercut) so the first rental can land; the next cycle the
//   realized basis takes over and converges the price back up.
//
// Write deadband (2026-10-24): tenants harvest dips instantly via re-booking,
// so sub-threshold listing flicker is pure downside. The bot skips the write
// when the new price is within CLORE_DEADBAND_PCT (default 3%) of the current
// listing price (pricing["USD-Blockchain"] from server_config — NOT the
// locked rented rate). Unknown current price fails open to writing.
//
// GPU count: multi-GPU rigs rent as a WHOLE (rig $/day). A 2x 5070 Ti server
// must be priced against other 2x RTX 5070 Ti listings, not 1x ones — so the
// comparator matches on both GPU substring AND gpu count (profile "count").
// API notes (from docs.clore.ai/for-hosts/api.md):
// - Auth header is `auth: <key>` — NOT `Authorization: Bearer` (that returns code 3).
// - Market data: GET /v1/marketplace (requires auth; /v1/market does not exist).
// - Price is set via POST /v1/set_server_settings (whole-server $/day via
//   usd_pricing + autoprice; USD cap 0.1–1000).
// - `name`, `availability`, `mrl` are MANDATORY on every set_server_settings
//   call — omitting them = HTTP 500 code 1. Price-only calls are not possible;
//   the API rewrites the whole settings object each call, which is why
//   availability/mrl are always re-sent even when "only changing price".
// - The enabled-* flags rebuild the accepted-currency list on EVERY call —
//   omitting one drops that currency from the server. Always send all three.
// - `mrl` (max rental length, hours, 6–3000) defaults to preserving the
//   value currently set on the server (read live each cycle) so a value set
//   in the web UI is never stomped; CLORE_MRL env overrides it explicitly.
// - server_config is GET-with-JSON-body (bun fetch can't send GET bodies ->
//   raw node:https request is used below).
// - Rate limit: 1 request/sec per key.
//
// Configuration is env-driven (see ENV defaults below):
//   CLORE_API_KEY        API token
//   CLORE_SERVERS        JSON array of server profiles:
//                        [{"server":"LINUX_..","gpu":"5060 ti","min":2.4,"max":4.5,
//                          "undercut":0.95}, ...]   (undercut optional, default 0.95)
//                        When unset, falls back to the single-server vars below.
//   CLORE_SERVER         single-server mode: server name (LINUX_...)
//   CLORE_GPU            single-server mode: case-insensitive GPU match substring
//   CLORE_MIN_USD        single-server mode: price floor ($/day)
//   CLORE_MAX_USD        single-server mode: price ceiling ($/day)
//   CLORE_UNDERCUT       fraction of market median to charge (0.95 = -5%)
//                        (also the default for profiles without an override)
//   CLORE_DEADBAND_PCT   write deadband percent (default 3): skip the price
//                        write when the new price is within this % of the
//                        current listing price (0 = disabled).
//   CLORE_MRL            max rental length hours (6-3000). UNSET = preserve
//                        whatever is currently set on the server (UI value).
//   CLORE_AVAILABILITY   fallback availability (used when a profile has no
//                        explicit "available"). Each cycle the bot READS the
//                        server's live visibility from /v1/my_servers and
//                        mirrors it — availability is owned by the UI, the
//                        bot only decides the price.
//   CLORE_INTERVAL_MIN   loop interval minutes
//   CLORE_ONCE           if set, run one cycle and exit (testing)
import { sleep } from "bun";
import { request } from "node:https";

const API_KEY = process.env.CLORE_API_KEY ?? "";
if (!API_KEY) throw new Error("CLORE_API_KEY env var is required");
// PoH market manager (pass 2) — session token from clore_token cookie value.
const POH_TOKEN = process.env.CLORE_POH_TOKEN ?? "";
// Single-server fallback vars (used when CLORE_SERVERS is unset) and the
// shared pricing default.
const SERVER = process.env.CLORE_SERVER || "LINUX_7729002a97884640be5e8377a809aba1";
const GPU_SUBSTR = (process.env.CLORE_GPU || "5060 ti").toLowerCase();
const MIN_USD = Number(process.env.CLORE_MIN_USD || 2.4); // floor below the ~$2.8 rented-market clearing median
const MAX_USD = Number(process.env.CLORE_MAX_USD || 4.5);
const UNDERCUT = Number(process.env.CLORE_UNDERCUT || 0.95); // price at 95% of market median
const AVAILABILITY = (process.env.CLORE_AVAILABILITY ?? "true") !== "false";

// Server profiles. CLORE_SERVERS = JSON array of profiles:
//   {server, gpu, min, max, undercut?, count?, available?}
//   gpu      case-insensitive GPU match substring (e.g. "5070 ti")
//   count    GPU count of our rig; comparator matches listings with the same
//            count (1 = single-GPU listings, 2 = 2x rigs) — multi-GPU rigs
//            rent as a whole, so comps must be same-size rigs. Default 1.
//   available  per-server availability; omit to use CLORE_AVAILABILITY.
// unset -> single profile from the single-server vars above (back-compat).
function parseServers(json) {
  const arr = JSON.parse(json);
  if (!Array.isArray(arr) || arr.length === 0) throw new Error("CLORE_SERVERS must be a non-empty JSON array");
  return arr.map((p) => {
    if (!p?.server || !p?.gpu) throw new Error("CLORE_SERVERS entries need {server, gpu, min, max}");
    const prof = {
      server: String(p.server),
      gpu: String(p.gpu).toLowerCase(),
      min: Number(p.min),
      max: Number(p.max),
      undercut: p.undercut != null ? Number(p.undercut) : UNDERCUT,
      count: p.count != null ? Number(p.count) : 1,
      available: p.available != null ? !!p.available : AVAILABILITY,
      availableSet: p.available != null,
    };
    if (!prof.server.startsWith("LINUX_")) throw new Error(`bad server name: ${prof.server}`);
    if (!(Math.min(prof.min, prof.max) > 0)) throw new Error(`bad min/max for ${prof.server}: ${prof.min}/${prof.max}`);
    if (prof.min > prof.max) throw new Error(`bad min/max for ${prof.server}: min ${prof.min} > max ${prof.max}`);
    if (!(prof.undercut > 0 && prof.undercut <= 1.5)) throw new Error(`bad undercut for ${prof.server}: ${prof.undercut}`);
    if (!Number.isInteger(prof.count) || prof.count < 1) throw new Error(`bad count for ${prof.server}: ${prof.count}`);
    return prof;
  });
}
const PROFILES = process.env.CLORE_SERVERS
  ? parseServers(process.env.CLORE_SERVERS)
  : [{ server: SERVER, gpu: GPU_SUBSTR, min: MIN_USD, max: MAX_USD, undercut: UNDERCUT, count: 1, available: AVAILABILITY, availableSet: false }];
// mrl: env override wins; otherwise read live per cycle (UI-controlled).
const MRL_ENV = process.env.CLORE_MRL ? Number(process.env.CLORE_MRL) : null;
if (MRL_ENV !== null && (!Number.isInteger(MRL_ENV) || MRL_ENV < 6 || MRL_ENV > 3000)) {
  console.error(`Invalid CLORE_MRL=${process.env.CLORE_MRL} (integer 6-3000 required)`);
  process.exit(1);
}
// interval is owned by the Railway cron schedule (see serviceInstanceUpdate), not the source
const REQ_GAP_MS = 1500; // stay above the 1 req/sec limit
// A realized (rented) sample smaller than this is "thin" — the target is then
// additionally capped at the cheapest available comparable. Above it, the
// realized median is trusted on its own.
const THIN_SAMPLE = 5;
// Dry run: compute and log the target price but never call set_server_settings.
// Used to validate a pricing-rule change against the live market before it
// writes real prices.
const DRY_RUN = (process.env.CLORE_DRY_RUN ?? "").toLowerCase() === "true";
// Write deadband: skip the price write when the new price is within this
// percent of the current listing price (0 = disabled, every cycle writes).
// Tenants harvest dips instantly via re-booking, so sub-threshold listing
// flicker is pure downside; the write only happens when the market moved
// enough to matter.
const DEADBAND_PCT = Number(process.env.CLORE_DEADBAND_PCT ?? 3);
if (!(DEADBAND_PCT >= 0 && DEADBAND_PCT < 100)) throw new Error(`bad CLORE_DEADBAND_PCT=${process.env.CLORE_DEADBAND_PCT} (number 0-99 required)`);
const DEADBAND = DEADBAND_PCT / 100;

const jsonHeaders = { auth: API_KEY, "Content-Type": "application/json" };

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// GET with JSON body — bun/undici refuse GET bodies, so use raw node:https.
function getWithBody(path, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj);
    const req = request(
      {
        host: "api.clore.ai",
        path,
        method: "GET",
        headers: {
          auth: API_KEY,
          "Content-type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try { resolve(JSON.parse(buf)); } catch { reject(new Error(`bad json from ${path}: ${buf.slice(0, 200)}`)); }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function fetchMarketServers() {
  const res = await fetch("https://api.clore.ai/v1/marketplace", {
    headers: { auth: API_KEY },
  });
  const data = await res.json();
  if (data.code !== undefined && data.code !== 0) {
    throw new Error(`marketplace code ${data.code}${data.error ? `: ${data.error}` : ""}`);
  }
  return data.servers || [];
}

// Live availability per server, read fresh each cycle so UI flips are
// mirrored, not stomped. Profiles may pin it with an explicit "available".
// Also returns the set of our own listing ids, so our own listings can be
// excluded from the comparator set.
async function fetchMyServers() {
  const res = await fetch("https://api.clore.ai/v1/my_servers", { headers: { auth: API_KEY } });
  const data = await res.json();
  if (data.code !== undefined && data.code !== 0) {
    throw new Error(`my_servers code ${data.code}${data.error ? `: ${data.error}` : ""}`);
  }
  const servers = data.servers || [];
  return {
    visibility: new Map(servers.map((s) => [s.name, s.visibility])),
    ids: new Set(servers.map((s) => s.id)),
  };
}

function computeMedian(servers, prof, ownIds) {
  // listings with the same GPU substring AND same GPU count as our rig
  // (multi-GPU rigs rent as a whole — a 2x rig must be compared to 2x comps)
  const isComp = (s) => {
    // Never compare against our own listing — that is self-referential
    // feedback (we would price to match our own previous price) and lets one
    // of our servers distort another server's median.
    if (ownIds && ownIds.has(s.id)) return false;
    const gpu = (s.specs?.gpu || "").toLowerCase();
    if (!gpu.includes(prof.gpu)) return false;
    const m = gpu.match(/^(\d+)x/);
    const n = m ? Number(m[1]) : (s.gpu_array?.length ?? 0);
    return n === prof.count;
  };
  const priceOf = (s) => s.price?.usd?.on_demand_usd;
  const okPrice = (p) => typeof p === "number" && p > 0;

  const comps = servers.filter(isComp);
  const realized = comps.filter((s) => s.rented).map(priceOf).filter(okPrice);
  const available = comps.filter((s) => !s.rented).map(priceOf).filter(okPrice);
  const allPrices = comps.map(priceOf).filter(okPrice);
  const cheapestAvailable = available.length ? Math.min(...available) : null;

  let target;
  let basis;
  if (realized.length > 0) {
    // Realized (rented) prices are the only ones that actually cleared the
    // market. Use them whenever there is at least one — a thin realized
    // sample is still real market data, and is far better than an
    // all-listing median inflated by stale, never-accepted listings.
    target = median(realized);
    basis = `realized(${realized.length})`;
    // Thin realized sample: cap the target at the cheapest AVAILABLE comp so
    // we never price above the cheapest listing a renter can actually pick.
    if (realized.length < THIN_SAMPLE && cheapestAvailable != null) {
      target = Math.min(target, cheapestAvailable);
      basis += `+cap(cheapest-available $${cheapestAvailable.toFixed(2)})`;
    }
  } else if (cheapestAvailable != null) {
    // Nothing in this segment has ever rented (cold market). Undercut the
    // cheapest available listing so the first rental can land; once it does,
    // the realized basis takes over and converges the price back up.
    target = cheapestAvailable;
    basis = `cheapest-available(no realized sample)`;
  } else {
    throw new Error(`no comparable ${prof.count}x ${prof.gpu} listings found`);
  }
  return { median: target, count: comps.length, basis, realizedCount: realized.length, allMedian: allPrices.length ? median(allPrices) : null };
}

// Live mrl (owner-controlled in the UI) unless CLORE_MRL overrides it, plus
// the current listing price for the write deadband — both from one
// server_config read, so the deadband costs no extra API call. The listing
// price is pricing["USD-Blockchain"] (the host-configured USD price), NOT
// rented_price_by_currency, which is the locked rate of an active order and
// must never be used as the deadband baseline. A missing/invalid listing
// price yields null, and the caller then fails open to writing.
async function resolveLiveSettings(serverName) {
  if (MRL_ENV !== null && DEADBAND === 0) return { mrl: MRL_ENV, currentPrice: null };
  const d = await getWithBody("/v1/server_config", { server_name: serverName });
  if (d.code !== 0) throw new Error(`server_config code ${d.code}`);
  const mrl = MRL_ENV !== null ? MRL_ENV : d.config?.mrl;
  if (!Number.isInteger(mrl) || mrl < 6 || mrl > 3000) {
    throw new Error(`server_config returned unusable mrl: ${mrl}`);
  }
  const p = d.config?.pricing?.["USD-Blockchain"];
  const currentPrice = typeof p === "number" && p > 0 ? p : null;
  return { mrl, currentPrice };
}

async function setServerPrice(prof, availability, usd, mrl) {
  const body = {
    name: prof.server,
    availability, // mandatory field — mirrored from live server state (or pinned in the profile)
    mrl, // mandatory field even for price-only updates
    // mandatory per API spec; ignored while autoprice is "usd"
    bitcoin_on_demand: 0.0000359,
    bitcoin_spot: 0.0000359,
    // keep all accepted currencies enabled (list is rebuilt on every call)
    "enabled-bitcoin": true,
    "enabled-CLORE-Blockchain": true,
    "enabled-USD-Blockchain": true,
    // BTC/CLORE follow the USD target at the live exchange rate
    autoprice: { bitcoin: "usd", "CLORE-Blockchain": "usd" },
    usd_pricing: {
      bitcoin: { on_demand: usd, spot: usd },
      "CLORE-Blockchain": { on_demand: usd, spot: usd },
    },
    // direct USD stablecoin pricing
    "USD-Blockchain_on_demand": usd,
    "USD-Blockchain_spot": usd,
  };
  const res = await fetch("https://api.clore.ai/v1/set_server_settings", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`set_server_settings code ${data.code}${data.error ? `: ${data.error}` : ""}`);
  }
  return data;
}

// Single-shot cycle — Railway cron schedule triggers each run (sleepApplication
// on = zero idle cost); no in-source loop.
// Pass 1: GPU auto-pricing. Pass 2: PoH offer management (CLORE_POH_TOKEN set).

// ==================== Pass 2: PoH offer management ====================
// Ported from poh-market-manager.mjs. Policy rails:
// Breakeven floor (live-verified Oct 2026): rented coins (1) stop staking
// rewards (reward_amount excludes rented), (2) leave the fee-reduction tier
// (counted balance = reward bucket only). On the current stack (~1.05M total,
// 5060Ti host), renting 500k drops the tier 25%->13% = +$0.0161/day fee, and
// rent at rate R% beats staking only iff R >= stake_apy + ~1.69pp. Old margin
// 0.4 listed offers at ~parity (all 100k tranches instantly rented at <=10.5)
// — pointless by construction. 1.8 covers the fee-tier cost with slack.
const POH_FLOOR_MARGIN = Number(process.env.POH_FLOOR_MARGIN ?? 1.8);
const POH_STEP_FAST = 0.2;      // pp/cycle above target (downward convergence)
const POH_STEP_SLOW_UP = 0.1;   // pp/cycle below target (raise cautiously)
const POH_TARGET_TOL = 0.05;    // deadband
const POH_TERM_PREMIUM = 0.6;   // 7d over 30d
const POH_LONG_PREMIUM = 0.4;   // 90d discount vs 30d
const POH_STALE_HOURS = 24;     // reprice only offers older than this
const POH_MAX_EDITS = 5;        // bounded rate edits per cycle
const POH_MAX_OFFERS = 20;      // platform cap
const POH_SWEEP_MIN = 500;      // platform MIN_AMOUNT
const POH_DAY = 86400;
const pohBucket = (rt) => (rt <= 7 * POH_DAY ? "7d" : rt <= 35 * POH_DAY ? "30d" : "90d");
// Run PoH pass only on top-of-hour fires (~4h effective spacing would be
// better, but idempotency makes 1/h safe: sweep is a no-op once free ~ 0 and
// edits are gated by staleness). Fires non-top-of-hour skip pass 2.
const POH_EVERY_HOURS = Number(process.env.POH_EVERY_HOURS ?? 1);

async function pohJfetch(path, { method = "POST", body = null, qs = "" } = {}) {
  const hasBody = method !== "GET" && method !== "HEAD";
  const res = await fetch(`https://clore.ai${path}${qs ? "?" + qs : ""}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: hasBody ? (body === null ? "null" : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { http: res.status, raw: text.slice(0, 200) }; }
}

async function pohPass() {
  if (!POH_TOKEN) { console.log("PoH pass skipped: CLORE_POH_TOKEN not set"); return; }
  const nowH = new Date().getUTCHours();
  if (POH_EVERY_HOURS > 1 && nowH % POH_EVERY_HOURS !== 0) return;
  const t0 = Date.now();
  const cfg = await pohJfetch("/poh-api/config", { method: "GET" });
  const apyMkt = await pohJfetch("/poh-api/internal/apy", { method: "GET" });
  const apyStake = await pohJfetch("/webapi/get_poh_reward_apy", { body: { token: POH_TOKEN } });
  const stake = apyStake?.data?.apy ?? null;
  // Abort loudly if staking APY is unavailable: parity floor is unknowable
  // without it, and a silent null would collapse the floor to ~0 and let
  // offers walk to the book floor — below passive staking.
  if (stake == null) throw new Error(`PoH staking APY unavailable — aborting pass: ${JSON.stringify(apyStake).slice(0, 120)}`);
  const info = await pohJfetch("/poh-api/poh/user/info", { body: { token: POH_TOKEN } });
  const me = info?.items?.[0];
  if (!me || !info?.balance) throw new Error(`PoH auth failed: ${JSON.stringify(info).slice(0, 120)}`);
  const bal = info.balance;

  let mine = [], off = 0;
  for (let i = 0; i < 5; i++) {
    const p = await pohJfetch("/poh-api/poh/user/offers", { body: { token: POH_TOKEN, limit: 50, offset: off } });
    const items = p?.items ?? [];
    mine = mine.concat(items);
    if (items.length < 50) break;
    off += 50;
  }

  let book = []; off = 0; let count = 0;
  for (let i = 0; i < 20; i++) {
    const p = await pohJfetch("/poh-api/poh/offers", { body: { token: POH_TOKEN }, qs: `limit=20&offset=${off}` });
    count = p?.count ?? count;
    const items = p?.items ?? [];
    book = book.concat(items);
    if (items.length < 20 || book.length >= count) break;
    off += 20;
  }
  const seen = new Set(); book = book.filter((o) => !seen.has(o.offer_number) && seen.add(o.offer_number));

  const mineNums = new Set(mine.map((o) => o.offer_number));
  const stats = {};
  for (const b of ["7d", "30d", "90d"]) {
    const rows = book.filter((o) => o.owner_user_id !== me.user && pohBucket(o.rent_time) === b)
      .map((o) => o.annual_rate).sort((a, b2) => a - b2);
    const med = rows.length ? rows[Math.floor(rows.length / 2)] : null;
    stats[b] = { n: rows.length, min: rows[0] ?? null, med };
  }
  const now = Date.now();
  const freshest = (b) => Math.min(...book.filter((o) => o.owner_user_id !== me.user && pohBucket(o.rent_time) === b)
    .map((o) => (now - o.creation_time) / 3600000).concat([Infinity]));

  const target = (b) => {
    const s = stats[b];
    // Beat the bucket MEDIAN when the book is deep (median-level asks do get
    // filled — tranches listed near the floor were all instantly rented, i.e.
    // underpriced); fall back to floor-undercut only when the bucket is thin.
    const deepListings = s.n >= 25;
    let t = deepListings
      ? s.med - 0.1                      // just under the median: first-choice among equals
      : (s.min != null ? s.min - 0.05 : (apyMkt?.apy ?? 11) - 0.5);
    if (b === "7d") t += POH_TERM_PREMIUM;
    else if (b === "90d") t -= POH_LONG_PREMIUM;
    // Parity floor applies AFTER term premiums: the 90d discount must never
    // punch below staking + margin (rented coins stop earning staking rewards,
    // so renting at ~staking APY is pointless). Regression this fixes:
    // stake 9.0895 -> floor 9.4895 -> -0.4 = 9.09 -> listed 9.1 -> rented at
    // parity (offer #8668171267014656, 100k x 90d, Oct 2026).
    return Math.round(Math.max(stake + POH_FLOOR_MARGIN, t) * 10) / 10;
  };

  const actions = [];
  const rented = mine.filter((o) => o.status === "rented");
  const listed = mine.filter((o) => o.status === "on_marketplace");
  const finished = mine.filter((o) => o.status === "finished");

  // Ladder: 5x7d + 4x30d + 1x90d. Two passes so the 100k profit tranches claim
  // the premium 7d slots FIRST, and the small free-probe tranches (20k/27k/856)
  // fill the remaining 30d/90d slots. Without priority the 3-4 probes burn the
  // 7d slots and push the profit 100k offers (e.g. the 4 stuck at 10.5) down to
  // 15.6/12.6 instead of the 16.4 the 7d median supports. (The ladder was sized
  // "5x7d on the 100k tranches"; keep that intent now that probes are managed
  // too, so the probes are never frozen either.)
  let wantShort = 5, wantMid = 4, wantLong = 1;
  const plan = {};
  const pohAssign = (o) => { plan[o.offer_number] = { t7: wantShort-- > 0 ? "7d" : wantMid-- > 0 ? "30d" : "90d" }; };
  for (const o of listed) if (o.amount === 100000) pohAssign(o);
  for (const o of listed) if (o.amount !== 100000) pohAssign(o);
  const edits = [];
  for (const o of listed) {
    if (edits.length >= POH_MAX_EDITS) break;
    const b = plan[o.offer_number]?.t7;
    if (!b) continue;
    const ageH = (now - o.creation_time) / 3600000;
    // Manage ALL listed offers, not just the 100k tranches. Leftover free-probe
    // tranches (20k / 27k / 856) and odd-amount sweeps otherwise sit stuck at their
    // creation rate forever (observed: probes parked at 10.5 for 72 h).
    // Amount-preserving edit: pass through the offer's original amount.
    const isYoung = ageH < POH_STALE_HOURS;
    const tgt = target(b);
    const lower = o.annual_rate - tgt > POH_TARGET_TOL;
    const raise = !lower && (tgt - o.annual_rate > POH_TARGET_TOL) && o.current_earnings === 0;
    let delta = 0;
    if (lower) {
      // Walk DOWN only once an offer has aged past the stale gate — don't churn
      // a just-created offer down the book before it has had a fair age to rent.
      if (isYoung) continue;
      delta = -Math.min(POH_STEP_FAST, o.annual_rate - tgt);
    } else if (raise) {
      // Raise immediately, even for young offers. A freshly minted offer is
      // exactly when it is most likely underpriced vs the book, and moving UP
      // has no overshoot risk (worst case it sits unrented and steps back down
      // next cycle). Gating raises by the stale gate would park a 10.5 % offer
      // ~1.5 days below the 16.4 % median for no benefit.
      delta = tgt - o.annual_rate;
    }
    const newRate = Math.round((o.annual_rate + delta) * 10) / 10;
    const newRentTime = { "7d": 7 * POH_DAY, "30d": 30 * POH_DAY, "90d": 90 * POH_DAY }[b];
    // Term realignment still honours the stale gate so we don't re-roll a fresh
    // offer's duration on its very first cycle.
    if (delta !== 0 || (!isYoung && o.rent_time !== newRentTime)) edits.push({ o, newRate, newRentTime });
  }

  // Sweep ALL free balance into 7d offers (directive: offer all available PoH).
  // Idempotent: skips when an identical-amount 7d offer already exists.
  const sweep = [];
  let freeFloat = Math.floor(bal.free_amount);
  if (freeFloat < POH_SWEEP_MIN) freeFloat = 0;
  const existingSweepKeys = new Set(mine.filter((o) => o.status === "on_marketplace" && pohBucket(o.rent_time) === "7d").map((o) => o.amount));
  let creationSlots = Math.max(0, POH_MAX_OFFERS - mine.length);
  let rate7 = Math.round(target("7d") * 10) / 10;
  let guard = 0;
  while (freeFloat >= POH_SWEEP_MIN && creationSlots > 0 && guard++ < 20) {
    const amt = Math.min(freeFloat, 100000);
    if (!existingSweepKeys.has(amt)) {
      sweep.push({ amount: amt, rent_time: 7 * POH_DAY, annual_rate: rate7 });
      existingSweepKeys.add(amt);
      creationSlots--;
    }
    freeFloat -= amt;
  }

  for (const e of edits.slice(0, POH_MAX_EDITS)) {
    const body = { token: POH_TOKEN, offer: { amount: e.o.amount, rent_time: e.newRentTime, annual_rate: e.newRate } };
    const r = await pohJfetch(`/poh-api/poh/user/offers/edit/${e.o.id}`, { method: "PUT", body });
    actions.push({ action: "edit", offer: e.o.offer_number, to: e.newRate, resp: String(JSON.stringify(r)).slice(0, 80) });
  }
  for (const s of sweep) {
    const r = await pohJfetch("/poh-api/poh/user/offers/create", { body: { token: POH_TOKEN, offer: s } });
    actions.push({ action: "sweep_create", ...s, resp: String(JSON.stringify(r)).slice(0, 80) });
  }

  console.log(JSON.stringify({
    poh_pass: true, ms: Date.now() - t0,
    me: { user: me.user, total: bal.total, free: bal.free_amount },
    rates: { staking_apy: stake, market_benchmark: apyMkt?.apy },
    book: { total: book.length, by_bucket: stats },
    my: { listed: listed.length, rented: rented.length, finished: finished.length },
    plan: edits.map((e) => ({ offer: e.o.offer_number, bucket: plan[e.o.offer_number].t7, rate_to: e.newRate })),
    sweep_creates: sweep,
    actions,
  }, null, 1));
}

try {
  console.log(`[${new Date().toISOString()}] Fetching market...`);
  const market = await fetchMarketServers();
  await sleep(REQ_GAP_MS);
  const { visibility, ids: ownIds } = await fetchMyServers();
  const errors = [];
  for (const prof of PROFILES) {
    try {
      const { median: m, count, basis, realizedCount, allMedian } = computeMedian(market, prof, ownIds);
      const myPrice = Math.round(Math.max(prof.min, Math.min(prof.max, m * prof.undercut)) * 100) / 100;
      console.log(
        `${prof.server}: ${count} comparable ${prof.count}x ${prof.gpu} listings (${realizedCount} realized, all-listing median $${allMedian != null ? allMedian.toFixed(2) : "n/a"}), basis: ${basis} -> $${m.toFixed(2)} -> $${myPrice}/day (${Math.round(prof.undercut * 100)}% of target, clamped ${prof.min}-${prof.max})`
      );
      await sleep(REQ_GAP_MS);
      const { mrl, currentPrice } = await resolveLiveSettings(prof.server);
      await sleep(REQ_GAP_MS);
      // Availability is mandatory on the call but owned by the UI: mirror the
      // live visibility unless the profile pins it with an explicit "available".
      const liveVis = visibility.get(prof.server);
      const availability = prof.availableSet || liveVis == null ? prof.available : liveVis === "public";
      // Deadband: skip the write when the new price is within DEADBAND of the
      // current listing price. Skipping is safe for availability/mrl: those
      // are UI-owned and already live on the server, so not writing cannot
      // clobber them — the write exists to move the price. Unknown current
      // price fails open to writing, so a payload change can never freeze
      // pricing.
      if (currentPrice != null && DEADBAND > 0 && Math.abs(myPrice - currentPrice) <= DEADBAND * currentPrice) {
        console.log(`Deadband: ${prof.server} current $${currentPrice}/day, new $${myPrice}/day within ${DEADBAND_PCT}% — skipping write`);
        continue;
      }
      console.log(
        `Setting ${prof.server} -> $${myPrice}/day, availability=${availability}${prof.availableSet ? " (profile-pinned)" : liveVis == null ? " (fallback: not in my_servers)" : ` (mirrored from UI: ${liveVis})`}, mrl=${mrl}h...`
      );
      if (DRY_RUN) {
        console.log(`DRY RUN: skipping set_server_settings for ${prof.server}`);
        continue;
      }
      await setServerPrice(prof, availability, myPrice, mrl);
      console.log(`Price set OK: ${prof.server} (code 0)`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Pricing failed for ${prof.server}:`, String(e).slice(0, 300));
      errors.push(prof.server);
    }
  }
  // Pass 2 — PoH offer management. Failure here must not fail the pricing pass.
  if (DRY_RUN) {
    console.log("DRY RUN: skipping PoH offer-management pass");
  } else {
    try {
      await sleep(REQ_GAP_MS);
      await pohPass();
    } catch (e) {
      console.error(`[${new Date().toISOString()}] PoH pass failed:`, String(e).slice(0, 300));
    }
  }
  if (errors.length) {
    console.error(`[${new Date().toISOString()}] ${errors.length}/${PROFILES.length} server(s) failed pricing: ${errors.join(", ")}`);
    process.exit(1);
  }
} catch (e) {
  console.error(`[${new Date().toISOString()}] Cycle failed:`, e);
  process.exit(1);
}