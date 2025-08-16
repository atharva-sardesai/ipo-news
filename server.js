import express from "express";
import bodyParser from "body-parser";
import nodemailer from "nodemailer";
import { z } from "zod";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

// -------- Validation schema --------
const Item = z.object({
  company: z.string(),
  sector: z.string().optional(),
  issue_size_cr: z.number().optional(),
  status: z.string(), // "rumor" | "DRHP" | "RHP" | "approved"
  expected_window: z.string().optional(),
  lead_banks: z.array(z.string()).optional(),
  links: z
    .object({
      drhp: z.string().url().optional(),
      rhp: z.string().url().optional(),
      exchange_notice: z.string().url().optional(),
      news: z.string().url().optional()
    })
    .partial()
    .optional(),
  notes: z.string().optional()
});

const Payload = z.object({
  as_of_date: z.string(),
  timezone: z.string().default("Asia/Kolkata"),
  source_notes: z.array(z.string()).default([]),
  changes_since_last_run: z.string().optional(),
  items: z.array(Item)
});

// -------- HTML email renderer --------
function buildHtml(p) {
  const rows = p.items
    .map(
      (it, idx) => `
    <tr>
      <td style="padding:8px;border:1px solid #eee">${idx + 1}</td>
      <td style="padding:8px;border:1px solid #eee"><b>${it.company}</b><br><small>${it.sector || ""}</small></td>
      <td style="padding:8px;border:1px solid #eee">${it.issue_size_cr ?? ""}</td>
      <td style="padding:8px;border:1px solid #eee"><b>${it.status}</b><br><small>${
        it.expected_window || ""
      }</small></td>
      <td style="padding:8px;border:1px solid #eee">${(it.lead_banks || []).join(", ")}</td>
      <td style="padding:8px;border:1px solid #eee">
        ${it.links?.drhp ? `<a href="${it.links.drhp}">DRHP</a> ` : ""}
        ${it.links?.rhp ? `<a href="${it.links.rhp}">RHP</a> ` : ""}
        ${it.links?.exchange_notice ? `<a href="${it.links.exchange_notice}">Notice</a> ` : ""}
        ${it.links?.news ? `<a href="${it.links.news}">News</a>` : ""}
      </td>
      <td style="padding:8px;border:1px solid #eee">${it.notes || ""}</td>
    </tr>`
    )
    .join("");

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

// -------- SMTP (optional) --------
import sgMail from "@sendgrid/mail";

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

function parseRecipients(csv) {
  return csv.split(",").map(s => s.trim()).filter(Boolean);
}



// -------- Shared-secret middleware (highly recommended) --------
app.use((req, res, next) => {
  const required = process.env.SHARED_SECRET;
  if (!required) return next(); // disabled
  const got = req.header("X-Auth-Token");
  if (got !== required) return res.status(401).json({ error: "Unauthorized" });
  next();
});

// -------- Endpoint --------
app.post("/monthly", async (req, res) => {
  // 1) Validate
  const parsed = Payload.safeParse(req.body);
  if (!parsed.success) {
    console.error("Zod error:", JSON.stringify(parsed.error.flatten(), null, 2));
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  // 2) Make 'payload' available to the whole handler (not inside a narrower block)
  const payload = parsed.data;
  const html = buildHtml(payload);

  try {
    // 3) SendGrid (preferred)
    if (process.env.SENDGRID_API_KEY && process.env.FROM_EMAIL && process.env.TO_EMAIL) {
      await sgMail.send({
        to: process.env.TO_EMAIL.split(",").map(s => s.trim()).filter(Boolean),
        from: process.env.FROM_EMAIL, // must be verified in SendGrid
        subject: `Upcoming India IPOs — ${payload.as_of_date}`,
        html
      });
    }

    // 4) (Optional) forward JSON to Zapier
    if (process.env.ZAPIER_HOOK_URL) {
      await fetch(process.env.ZAPIER_HOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    }

    // 5) Done
    return res.json({ ok: true });
  } catch (err) {
    console.error("Delivery error:", err?.response?.body || err.message || err);
    // You can still return 200 if you don't want callers to retry:
    return res.status(500).json({ error: "delivery_failed" });
  }
});

// -------- Health check --------
app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = Number(process.env.PORT || "8080");
app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
