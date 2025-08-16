import OpenAI from "openai";

// ---------- ENV ----------
const WEBHOOK_URL   = process.env.WEBHOOK_URL;           // e.g., https://.../monthly
const SHARED_SECRET = process.env.SHARED_SECRET || "";
const BING_KEY      = process.env.BING_NEWS_KEY || "";
const GNEWS_KEY     = process.env.GNEWS_API_KEY || "";
const OPENAI_KEY    = process.env.OPENAI_API_KEY || "";
const AI_MODEL      = process.env.AI_MODEL || "gpt-4o-mini";
const MAX_ARTICLES  = Number(process.env.MAX_ARTICLES || "30");
const COUNTRY       = process.env.COUNTRY || "in";
const LANG          = process.env.LANG || "en";

if (!WEBHOOK_URL || !SHARED_SECRET) {
  console.error("Missing WEBHOOK_URL or SHARED_SECRET");
  process.exit(2);
}
if (!OPENAI_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(2);
}

// ---------- Helpers ----------
function todayIST() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  });
  return fmt.format(new Date()); // YYYY-MM-DD
}
function uniq(arr) { return [...new Set(arr)]; }
function normCompany(s) {
  return (s || "").toLowerCase().replace(/limited|ltd\.?|private|pvt\.?|ipo|drhp|rhp|public issue/gi, "").replace(/\s+/g, " ").trim();
}
function pickBetterStatus(a, b) {
  const rank = { approved: 4, RHP: 3, DRHP: 2, rumor: 1 };
  return (rank[a] || 0) >= (rank[b] || 0) ? a : b;
}

// ---------- Fetch news from either provider ----------
async function fetchBingNews(query) {
  const url = new URL("https://api.bing.microsoft.com/v7.0/news/search");
  url.searchParams.set("q", query);
  url.searchParams.set("mkt", "en-IN");
  url.searchParams.set("count", String(Math.min(MAX_ARTICLES, 50)));
  url.searchParams.set("freshness", "Month");
  url.searchParams.set("sortBy", "Date");
  const r = await fetch(url, { headers: { "Ocp-Apim-Subscription-Key": BING_KEY } });
  if (!r.ok) throw new Error(`Bing news error ${r.status}`);
  const j = await r.json();
  return (j.value || []).map(v => ({
    title: v.name, description: v.description, url: v.url,
    source: v.provider?.[0]?.name, publishedAt: v.datePublished
  }));
}

async function fetchGNews(query) {
  const url = new URL("https://gnews.io/api/v4/search");
  url.searchParams.set("q", query);
  url.searchParams.set("lang", LANG);
  url.searchParams.set("country", COUNTRY);
  url.searchParams.set("max", String(Math.min(MAX_ARTICLES, 50)));
  url.searchParams.set("token", GNEWS_KEY);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GNews error ${r.status}`);
  const j = await r.json();
  return (j.articles || []).map(a => ({
    title: a.title, description: a.description, url: a.url,
    source: a.source?.name, publishedAt: a.publishedAt
  }));
}

async function getArticles() {
  // IPO-focused queries
  const queries = [
    'IPO India DRHP OR RHP',
    'site:sebi.gov.in DRHP',
    'site:nseindia.com RHP OR "Public Issue"',
    'site:bseindia.com "Public Issue" OR "RHP"'
  ];
  let all = [];
  for (const q of queries) {
    let chunk = [];
    if (BING_KEY) chunk = await fetchBingNews(q);
    else if (GNEWS_KEY) chunk = await fetchGNews(q);
    else throw new Error("Set BING_NEWS_KEY or GNEWS_API_KEY");
    all = all.concat(chunk);
    await new Promise(r => setTimeout(r, 200)); // be polite
  }
  // Dedupe by URL
  const seen = new Set();
  return all.filter(a => !seen.has(a.url) && seen.add(a.url));
}

// ---------- AI extraction per article ----------
const openai = new OpenAI({ apiKey: OPENAI_KEY });

async function extractItemFromArticle(a) {
  // Constrain to JSON object output
  const sys = `You convert a single article into one IPO record for India.
Return a JSON object with keys: company (string), sector (string|optional),
issue_size_cr (number|optional), status (one of: rumor, DRHP, RHP, approved),
expected_window (string|optional), lead_banks (array of strings|optional),
links (object with optional keys: drhp, rhp, exchange_notice, news), notes (string|optional).
If a field is unknown, omit it. Use only info implied by the article text/title.`;
  const usr = `Article:
TITLE: ${a.title}
DESC: ${a.description || ""}
URL: ${a.url}
SOURCE: ${a.source || ""}
DATE: ${a.publishedAt || ""}

Produce strictly one JSON object, no extra text. Include "news" link inside links. If the article only hints at early talks, status=rumor. If mentions DRHP filed, status=DRHP. If RHP filed, status=RHP. If regulator approval granted, status=approved.`;

  const resp = await openai.chat.completions.create({
    model: AI_MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: usr }
    ]
  });

  const text = resp.choices?.[0]?.message?.content || "{}";
  let obj;
  try { obj = JSON.parse(text); } catch { obj = {}; }
  if (!obj || !obj.company || !obj.status) return null;

  // Normalize/cleanup
  if (obj.links) obj.links.news = obj.links.news || a.url;
  else obj.links = { news: a.url };
  if (typeof obj.issue_size_cr === "string") {
    const n = Number(obj.issue_size_cr.replace(/[^\d.]/g, ""));
    if (Number.isFinite(n)) obj.issue_size_cr = n;
    else delete obj.issue_size_cr;
  }
  return obj;
}

// Optional: add a short advisor-style bullet summary using the same AI
async function addAdvisorSummary(it) {
  const facts = [
    `Company: ${it.company}`,
    it.sector ? `Sector: ${it.sector}` : null,
    Number.isFinite(it.issue_size_cr) ? `Issue size (₹ Cr): ${it.issue_size_cr}` : null,
    `Status: ${it.status}`,
    it.expected_window ? `Expected window: ${it.expected_window}` : null,
    it.lead_banks?.length ? `Lead banks: ${it.lead_banks.join(", ")}` : null,
    it.links?.drhp ? `DRHP: ${it.links.drhp}` : null,
    it.links?.rhp ? `RHP: ${it.links.rhp}` : null,
  ].filter(Boolean).join("\n");

  const resp = await openai.chat.completions.create({
    model: AI_MODEL,
    temperature: 0.3,
    messages: [
      { role: "system", content:
        "You are a measured sell-side analyst. Write 3–5 crisp bullets (≤90 words total) using ONLY the provided facts. No advice, no invented numbers." },
      { role: "user", content: `Facts:\n${facts}\n\nWrite the bullets:` }
    ]
  });
  it.ai_summary = resp.choices?.[0]?.message?.content?.trim();
}

// ---------- Main run ----------
(async () => {
  console.log("Fetching news…");
  const articles = await getArticles();
  console.log("Articles:", articles.length);

  // Extract candidate items
  const items = [];
  for (const a of articles.slice(0, MAX_ARTICLES)) {
    try {
      const it = await extractItemFromArticle(a);
      if (it) items.push(it);
      await new Promise(r => setTimeout(r, 150)); // rate-friendly
    } catch (e) {
      console.error("extract failed:", e.message);
    }
  }

  // Dedupe by company, choose best status, merge fields
  const byCo = new Map();
  for (const it of items) {
    const key = normCompany(it.company);
    const prev = byCo.get(key);
    if (!prev) { byCo.set(key, it); continue; }
    // Pick stronger status
    const betterStatus = pickBetterStatus(it.status, prev.status);
    const merged = {
      ...prev,
      ...it,
      status: betterStatus,
      lead_banks: uniq([...(prev.lead_banks || []), ...(it.lead_banks || [])]),
      links: { ...(prev.links || {}), ...(it.links || {}) }
    };
    byCo.set(key, merged);
  }

  // Add advisor summary per company
  const finalItems = Array.from(byCo.values());
  for (const it of finalItems) {
    try { await addAdvisorSummary(it); } catch (e) { console.error("summary failed:", e.message); }
  }

  // Build payload and POST to your webhook
  const payload = {
    as_of_date: todayIST(),
    timezone: "Asia/Kolkata",
    source_notes: ["Bing/GNews + AI extraction"],  // edit as you like
    changes_since_last_run: "Automated weekly run",
    items: finalItems
  };

  const r = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Auth-Token": SHARED_SECRET },
    body: JSON.stringify(payload)
  });

  if (!r.ok) {
    const txt = await r.text();
    console.error("Webhook POST failed:", r.status, txt);
    process.exit(1);
  }
  console.log("Sent", finalItems.length, "items to webhook OK");
})();
