import OpenAI from "openai";

/* ------------ ENV ------------ */
const WEBHOOK_URL   = process.env.WEBHOOK_URL;
const SHARED_SECRET = process.env.SHARED_SECRET || "";
const OPENAI_KEY    = process.env.OPENAI_API_KEY || "";
const AI_MODEL      = process.env.AI_MODEL || "gpt-4o-mini";

const GNEWS_KEY     = process.env.GNEWS_API_KEY || "";
const MAX_ARTICLES  = Math.max(5, Number(process.env.MAX_ARTICLES || "20")); // modest on free tier
const COUNTRY       = process.env.COUNTRY || "in";
const LANG          = process.env.LANG || "en";

if (!WEBHOOK_URL || !SHARED_SECRET) {
  console.error("Missing WEBHOOK_URL or SHARED_SECRET"); process.exit(2);
}
if (!OPENAI_KEY) {
  console.error("Missing OPENAI_API_KEY"); process.exit(2);
}
if (!GNEWS_KEY) {
  console.error("Missing GNEWS_API_KEY"); process.exit(2);
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

/* ------------ Helpers ------------ */
function todayIST() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}
function uniq(arr) { return [...new Set(arr)]; }
function normCo(s="") {
  return s.toLowerCase()
    .replace(/limited|ltd\.?|private|pvt\.?|ipo|drhp|rhp|public issue/gi,"")
    .replace(/\s+/g," ").trim();
}
function pickStatus(a,b){const r={approved:4,RHP:3,DRHP:2,rumor:1};return (r[a]||0)>=(r[b]||0)?a:b;}
const IPO_RGX = /\b(ipo|drhp|rhp|public\s+issue|initial\s+public\s+offering)\b/i;

/* ------------ Rate-limit & Retry (for GNews) ------------ */
const BASE_DELAY_MS = 2500; // ~1 req / 2.5s
async function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function gnewsFetch(url, { tries = 5 } = {}) {
  for (let i=0;i<tries;i++){
    const r = await fetch(url);
    const text = await r.text();
    if (r.ok) return JSON.parse(text);
    if (r.status === 429) {
      const wait = BASE_DELAY_MS * Math.pow(1.8, i) + Math.floor(Math.random()*400);
      console.log(`[gnews] 429; backing off ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (r.status >= 500) {
      const wait = 1000 * (i+1);
      console.log(`[gnews] ${r.status}; retrying in ${wait}ms`);
      await sleep(wait);
      continue;
    }
    throw new Error(`GNews ${r.status}: ${text}`);
  }
  throw new Error("GNews retries exhausted");
}

/* ------------ Low-request strategies ------------ */
// A) Top headlines (few calls) then filter by IPO terms
async function fetchTopHeadlines(p=1, per=10){
  const u = new URL("https://gnews.io/api/v4/top-headlines");
  u.searchParams.set("topic","business");
  u.searchParams.set("lang",LANG);
  u.searchParams.set("country",COUNTRY);
  u.searchParams.set("max", String(Math.min(per,10)));
  u.searchParams.set("page", String(p));
  u.searchParams.set("token", GNEWS_KEY);
  const j = await gnewsFetch(u);
  return (j.articles||[]).map(a=>({
    title:a.title, description:a.description, url:a.url,
    source:a.source?.name, publishedAt:a.publishedAt
  }));
}

// B) One or two simple searches (no site:/OR) to top up results
async function fetchSearch(q, p=1, per=10){
  const u = new URL("https://gnews.io/api/v4/search");
  u.searchParams.set("q", q);
  u.searchParams.set("lang", LANG);
  u.searchParams.set("country", COUNTRY);
  u.searchParams.set("max", String(Math.min(per,10)));
  u.searchParams.set("page", String(p));
  u.searchParams.set("token", GNEWS_KEY);
  const j = await gnewsFetch(u);
  return (j.articles||[]).map(a=>({
    title:a.title, description:a.description, url:a.url,
    source:a.source?.name, publishedAt:a.publishedAt
  }));
}

async function getArticles() {
  let all = [];

  // 1) Top headlines 2–3 pages
  const per = Math.min(10, MAX_ARTICLES);
  const pages = Math.min(3, Math.ceil(MAX_ARTICLES / per));
  for (let p=1; p<=pages; p++){
    const chunk = await fetchTopHeadlines(p, per);
    all = all.concat(chunk);
    await sleep(BASE_DELAY_MS);
  }

  // Filter for IPO keywords
  all = all.filter(a => IPO_RGX.test(`${a.title} ${a.description||""}`));

  // 2) If not enough, top-up with 1–2 searches
  if (all.length < MAX_ARTICLES) {
    const needed = MAX_ARTICLES - all.length;
    const pagesNeeded = Math.min(2, Math.ceil(needed / per));
    const queries = ["India IPO", "DRHP India"];
    for (const q of queries) {
      for (let p=1; p<=pagesNeeded; p++){
        const chunk = await fetchSearch(q, p, per);
        all = all.concat(chunk);
        await sleep(BASE_DELAY_MS);
      }
    }
  }

  // Dedupe by URL
  const seen = new Set();
  all = all.filter(a => !seen.has(a.url) && seen.add(a.url));

  return all.slice(0, MAX_ARTICLES);
}

/* ------------ AI extraction & summary ------------ */
async function extractItemFromArticle(a) {
  const sys = `You convert one article into ONE India IPO record.
Return JSON object with keys:
- company (string, required)
- sector (string, optional)
- issue_size_cr (number, optional)
- status ("rumor"|"DRHP"|"RHP"|"approved", required)
- expected_window (string, optional)
- lead_banks (array<string>, optional)
- links (object: drhp?, rhp?, exchange_notice?, news?)
- notes (string, optional)
If unknown, omit the field. Use only the article's information.`;

  const usr = `Article:
TITLE: ${a.title}
DESC: ${a.description || ""}
URL: ${a.url}
SOURCE: ${a.source || ""}
DATE: ${a.publishedAt || ""}

Return strictly one JSON object. Include "news" inside links.`;

  const r = await openai.chat.completions.create({
    model: AI_MODEL, temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [{ role:"system", content:sys }, { role:"user", content:usr }]
  });

  let obj;
  try { obj = JSON.parse(r.choices?.[0]?.message?.content || "{}"); }
  catch { obj = {}; }
  if (!obj.company || !obj.status) return null;

  obj.links = { ...(obj.links||{}), news: obj.links?.news || a.url };
  if (typeof obj.issue_size_cr === "string") {
    const n = Number(obj.issue_size_cr.replace(/[^\d.]/g,""));
    if (Number.isFinite(n)) obj.issue_size_cr = n; else delete obj.issue_size_cr;
  }
  return obj;
}

async function addAdvisorSummary(it) {
  const facts = [
    `Company: ${it.company}`,
    it.sector ? `Sector: ${it.sector}` : null,
    Number.isFinite(it.issue_size_cr) ? `Issue size (₹ Cr): ${it.issue_size_cr}` : null,
    `Status: ${it.status}`,
    it.expected_window ? `Expected window: ${it.expected_window}` : null,
    it.lead_banks?.length ? `Lead banks: ${it.lead_banks.join(", ")}` : null
  ].filter(Boolean).join("\n");

  const r = await openai.chat.completions.create({
    model: AI_MODEL, temperature: 0.3,
    messages: [
      { role:"system", content:"You are a measured sell-side analyst. 3–5 crisp bullets (≤90 words). Only use provided facts. No advice or invented numbers." },
      { role:"user", content:`Facts:\n${facts}\n\nWrite the bullets:` }
    ]
  });
  it.ai_summary = r.choices?.[0]?.message?.content?.trim();
}

/* ------------ Main ------------ */
(async () => {
  try {
    console.log("Fetching news…");
    const articles = await getArticles();
    console.log("Articles after filter/dedupe:", articles.length);

    const items = [];
    for (const a of articles) {
      try {
        const it = await extractItemFromArticle(a);
        if (it) items.push(it);
        await sleep(200); // gentle on OpenAI
      } catch (e) {
        console.error("extract failed:", e.message);
      }
    }

    // Merge by company; prefer stronger status; merge arrays/links
    const byCo = new Map();
    for (const it of items) {
      const key = normCo(it.company);
      const prev = byCo.get(key);
      if (!prev) { byCo.set(key, it); continue; }
      const merged = {
        ...prev, ...it,
        status: pickStatus(it.status, prev.status),
        lead_banks: uniq([...(prev.lead_banks||[]), ...(it.lead_banks||[])]),
        links: { ...(prev.links||{}), ...(it.links||{}) }
      };
      byCo.set(key, merged);
    }

    const finalItems = Array.from(byCo.values());
    for (const it of finalItems) {
      try { await addAdvisorSummary(it); } catch (e) { console.error("summary failed:", e.message); }
    }

    const payload = {
      as_of_date: todayIST(),
      timezone: "Asia/Kolkata",
      source_notes: ["GNews (business/top-headlines + search)", "AI extraction/summary"],
      changes_since_last_run: "Automated weekly run",
      items: finalItems
    };

    const resp = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type":"application/json", "X-Auth-Token": SHARED_SECRET },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      const t = await resp.text();
      console.error("Webhook POST failed:", resp.status, t);
      process.exit(1);
    }
    console.log("Sent", finalItems.length, "items to webhook OK");
  } catch (e) {
    console.error("Agent error:", e.message);
    process.exit(1);
  }
})();
