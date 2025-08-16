// server.js
import express from "express";
import dotenv from "dotenv";
import { z } from "zod";
import sgMail from "@sendgrid/mail";
import morgan from "morgan";           // remove this import + middleware line below if you don't want request logs
import OpenAI from "openai";

dotenv.config();

/* ---------- Providers ---------- */
sgMail.setApiKey(process.env.SENDGRID_API_KEY || "");

const openai =
  process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const AI_ENABLED = process.env.AI_SUMMARY === "1" && !!openai;
const AI_MODEL   = process.env.AI_MODEL || "gpt-4o-mini";

/* ---------- App ---------- */
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));

/* ---------- Validation (forgiving) ---------- */
const Item = z.object({
  company: z.string(),
  sector: z.string().optional(),
  issue_size_cr: z.coerce.number().optional(), // accepts "1,200" -> 1200
  status: z.string(),                           // rumor | DRHP | RHP | approved
  expected_window: z.string().optional(),
  // allow "a,b" or ["a","b"]
  lead_banks: z.preprocess(
    v => Array.isArray(v) ? v :
      (typeof v === "string" ? v.split(/[,;|]/).map(s => s.trim()).filter(Boolean) : []),
    z.array(z.string()).optional()
  ),
  // allow url | "" | "NA"
  links: z.object({
    drhp: z.union([z.string().url(), z.literal(""), z.literal("NA")]).optional(),
    rhp: z.union([z.string().url(), z.literal(""), z.literal("NA")]).optional(),
    exchange_notice: z.union([z.string().url(), z.literal(""), z.literal("NA")]).optional(),
    news: z.union([z.string().url(), z.literal(""), z.literal("NA")]).optional()
  }).partial().optional(),
  notes: z.string().optional()
});

const Payload = z.object({
  as_of_date: z.string(),
  timezone: z.string().default("Asia/Kolkata"),
  source_notes: z.array(z.string()).default([]),
  changes_since_last_run: z.string().optional(),
  items: z.array(Item)
});

/* ---------- Helpers ---------- */
function requireSecret(req, res, next) {
  const required = process.env.SHARED_SECRET;
  if (!required) return next();
  const token = req.get("X-Auth-Token") || req.get("x-auth-token");
  if (token !== required) return res.status(401).json({ error: "Unauthorized" });
  next();
}
function getRecipients() {
  return (process.env.TO_EMAIL || "").split(",").map(s => s.trim()).filter(Boolean);
}
function escapeHtml(s = "") {
  return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function itemToFacts(it) {
  return [
    `Company: ${it.company}`,
    it.sector ? `Sector: ${it.sector}` : null,
    Number.isFinite(it.issue_size_cr) ? `Issue size (₹ Cr): ${it.issue_size_cr}` : null,
    `Status: ${it.status}`,
    it.expected_window ? `Expected window: ${it.expected_window}` : null,
    (it.lead_banks && it.lead_banks.length) ? `Lead banks: ${it.lead_banks.join(", ")}` : null,
    it.links?.drhp ? `DRHP: ${it.links.drhp}` : null,
    it.links?.rhp ? `RHP: ${it.links.rhp}` : null,
    it.links?.exchange_notice ? `Exchange notice: ${it.links.exchange_notice}` : null,
    it.links?.news ? `News: ${it.links.news}` : null
  ].filter(Boolean).join("\n");
}

/* ---------- AI: advisor-style summary (THIS is where AI comes in) ---------- */
async function generateAdvisorSummary(it) {
  if (!AI_ENABLED) return null;

  const facts = itemToFacts(it);
  const messages = [
    {
      role: "system",
      content:
`You are a measured sell-side financial research analyst.
Write 3–5 crisp bullets (≤90 words total) for an upcoming India IPO using ONLY the provided facts.
No guessing or fabricated data. No buy/sell advice. Keep it neutral and specific.`
    },
    {
      role: "user",
      content:
`Facts:
${facts}

Bullets should cover: business model, size/timing/status, lead bankers, key risks/dependencies, and next procedural steps if relevant.`
    }
  ];

  const resp = await openai.chat.completions.create({
    model: AI_MODEL,
    temperature: 0.3,
    messages
  });

  return resp.choices?.[0]?.message?.content?.trim() || "";
}

/* ---------- HTML email renderer ---------- */
function buildHtml(p) {
  const rows = (p.items || []).map((it, idx) => `
    <tr>
      <td style="padding:8px;border:1px solid #eee">${idx + 1}</td>
      <td style="padding:8px;border:1px solid #eee"><b>${it.company}</b><br><small>${it.sector || ""}</small></td>
      <td style="padding:8px;border:1px solid #eee">${it.issue_size_cr ?? ""}</td>
      <td style="padding:8px;border:1px solid #eee"><b>${it.status}</b><br><small>${it.expected_window || ""}</small></td>
      <td style="padding:8px;border:1px solid #eee">${(it.lead_banks || []).join(", ")}</td>
      <td style="padding:8px;border:1px solid #eee">
        ${it.links?.drhp ? `<a href="${it.links.drhp}">DRHP</a> ` : ""}
        ${it.links?.rhp ? `<a href="${it.links.rhp}">RHP</a> ` : ""}
        ${it.links?.exchange_notice ? `<a href="${it.links.exchange_notice}">Notice</a> ` : ""}
        ${it.links?.news ? `<a href="${it.links.news}">News</a>` : ""}
      </td>
      <td style="padding:8px;border:1px solid #eee">
        ${it.notes || ""}
        ${it.ai_summary ? `<div style="margin-top:6px;color:#444"><em>${escapeHtml(it.ai_summary)}</em></div>` : ""}
      </td>
    </tr>
  `).join("");

  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif">
    <h2>Upcoming India IPOs — ${p.as_of_date} (IST)</h2>
    ${p.changes_since_last_run ? `<p><b>What changed:</b> ${p.changes_since_last_run}</p>` : ""}
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <thead>
        <tr style="background:#f7f7f7">
          <th style="padding:8px;border:1px solid #eee">#</th>
          <th style="padding:8px;border:1px solid #eee">Company</th>
          <th style="padding:8px;border:1px solid #eee">Issue (₹ Cr)</th>
          <th style="padding:8px;border:1px solid #eee">Status / Window</th>
          <th style="padding:8px;border:1px solid #eee">Lead Banks</th>
          <th style="padding:8px;border:1px solid #eee">Links</th>
          <th style="padding:8px;border:1px solid #eee">Notes / Advisor Summary</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${p.source_notes?.length ? `<p style="margin-top:12px"><small>Sources: ${p.source_notes.join(" • ")}</small></p>` : ""}
  </div>`;
}

/* ---------- Routes ---------- */
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/status", requireSecret, (_req, res) => {
  res.json({
    dry_run: process.env.DRY_RUN === "1",
    has_sendgrid_key: !!process.env.SENDGRID_API_KEY,
    has_from: !!process.env.FROM_EMAIL,
    to_count: getRecipients().length,
    ai_enabled: AI_ENABLED,
    ai_model: AI_MODEL,
    zapier_enabled: !!process.env.ZAPIER_HOOK_URL,
    time: new Date().toISOString()
  });
});

app.post("/monthly", requireSecret, async (req, res) => {
  const parsed = Payload.safeParse(req.body);
  if (!parsed.success) {
    console.error("Zod error:", JSON.stringify(parsed.error.flatten(), null, 2));
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const payload = parsed.data;
  let items = payload.items || [];

  console.log("[monthly] payload received", {
    as_of_date: payload.as_of_date,
    items: items.length,
    dry_run: process.env.DRY_RUN === "1",
    ai_enabled: AI_ENABLED
  });

  // -------- AI STEP: generate advisor-style bullets per item (if enabled)
  if (AI_ENABLED) {
    for (const it of items) {
      try {
        if (!it.ai_summary) {
          it.ai_summary = await generateAdvisorSummary(it);
        }
      } catch (e) {
        console.error("AI summary failed for", it.company, e?.message || e);
      }
    }
  }

  // Build HTML AFTER summaries are attached
  const html = buildHtml(payload);

  try {
    if (process.env.DRY_RUN === "1") {
      console.log("[dry-run] would send to:", getRecipients().join(", "));
    } else {
      const to = getRecipients();
      if (!process.env.SENDGRID_API_KEY) throw new Error("SENDGRID_KEY_MISSING");
      if (!process.env.FROM_EMAIL) throw new Error("FROM_EMAIL_MISSING");
      if (!to.length) throw new Error("NO_RECIPIENTS");

      await sgMail.send({
        to,
        from: process.env.FROM_EMAIL, // must be a verified sender in SendGrid
        subject: `Upcoming India IPOs — ${payload.as_of_date}`,
        html
      });
      console.log("[sendgrid] queued to:", to.join(", "));
    }

    if (process.env.ZAPIER_HOOK_URL) {
      const r = await fetch(process.env.ZAPIER_HOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      console.log("[zapier] forward status:", r.status);
    }

    return res.json({ ok: true });
  } catch (err) {
    const sgBody = err?.response?.body ? JSON.stringify(err.response.body) : null;
    console.error("Delivery error:", { name: err?.name, message: err?.message, sgBody });
    return res.status(500).json({ error: err?.message || "delivery_failed" });
  }
});

/* ---------- Start ---------- */
const PORT = Number(process.env.PORT || "8080");
app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
