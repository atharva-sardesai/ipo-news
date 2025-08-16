import express from "express";
import dotenv from "dotenv";
import morgan from "morgan";
import { z } from "zod";
import { Resend } from "resend"; // OR use @sendgrid/mail if you prefer
// If you want SendGrid instead, comment Resend lines and use sgMail (shown below in comments)

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));

/* ---------- Validation (more forgiving) ---------- */
const Item = z.object({
  company: z.string(),
  sector: z.string().optional(),
  issue_size_cr: z.coerce.number().optional(), // "1,200" -> 1200
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

/* ---------- HTML email renderer ---------- */
function buildHtml(p) {
  const rows = p.items.map((it, idx) => `
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
      <td style="padding:8px;border:1px solid #eee">${it.notes || ""}</td>
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
          <th style="padding:8px;border:1px solid #eee">Notes</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${p.source_notes?.length ? `<p style="margin-top:12px"><small>Sources: ${p.source_notes.join(" • ")}</small></p>` : ""}
  </div>`;
}

/* ---------- Auth helper ---------- */
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

/* ---------- Health (open) & Status (protected) ---------- */
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/status", requireSecret, (_req, res) => {
  res.json({
    dry_run: process.env.DRY_RUN === "1",
    has_resend_key: !!process.env.RESEND_API_KEY,
    has_from: !!process.env.FROM_EMAIL,
    to_count: getRecipients().length,
    zapier_enabled: !!process.env.ZAPIER_HOOK_URL,
    time: new Date().toISOString()
  });
});

/* ---------- Email providers ---------- */
// Choose ONE provider path; here I show Resend (simple). If using SendGrid instead, see commented block below.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

async function sendEmail(subject, html) {
  const to = getRecipients();
  if (!to.length) throw new Error("NO_RECIPIENTS");
  if (process.env.DRY_RUN === "1") {
    console.log("[dry-run] would send to:", to.join(", "));
    return;
  }

  if (resend && process.env.FROM_EMAIL) {
    const resp = await resend.emails.send({
      from: process.env.FROM_EMAIL, // must be verified sender/domain in Resend
      to,
      subject,
      html
    });
    console.log("[resend] queued:", JSON.stringify(resp));
    return;
  }

  // --- SendGrid alternative ---
  // import sgMail from "@sendgrid/mail" at top and set key:
  // if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  // if (process.env.SENDGRID_API_KEY && process.env.FROM_EMAIL) {
  //   await sgMail.send({ to, from: process.env.FROM_EMAIL, subject, html });
  //   console.log("[sendgrid] queued to:", to.join(", "));
  //   return;
  // }

  throw new Error("NO_DELIVERY_PATH_CONFIGURED");
}

/* ---------- Main endpoint (protected) ---------- */
app.post("/monthly", requireSecret, async (req, res) => {
  const parsed = Payload.safeParse(req.body);
  if (!parsed.success) {
    console.error("Zod error:", JSON.stringify(parsed.error.flatten(), null, 2));
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const payload = parsed.data;
  const html = buildHtml(payload);
  console.log("[monthly] payload received", {
    as_of_date: payload.as_of_date,
    items: payload.items?.length ?? 0,
    dry_run: process.env.DRY_RUN === "1"
  });

  try {
    await sendEmail(`Upcoming India IPOs — ${payload.as_of_date}`, html);

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
    console.error("Delivery error:", {
      name: err?.name,
      message: err?.message,
      stack: err?.stack
    });
    // Return a clear error so you know config is missing
    const code = err?.message === "NO_DELIVERY_PATH_CONFIGURED" ? 500 : 500;
    return res.status(code).json({ error: err?.message || "delivery_failed" });
  }
});

/* ---------- Start ---------- */
const PORT = Number(process.env.PORT || "8080");
app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
