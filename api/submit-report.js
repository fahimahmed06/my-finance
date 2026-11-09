// Vercel Serverless Function: POST /api/submit-report
// Keep DISCORD_REPORT_WEBHOOK in Vercel Environment Variables only.
const crypto = require("node:crypto");

const MAX_DESCRIPTION = 5000;
const MAX_FILES = 4;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = Math.floor(2.5 * 1024 * 1024);
const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "text/plain",
]);

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function cleanFilename(value, index) {
  const base = String(value || `attachment-${index + 1}`)
    .replace(/[\r\n"]/g, "")
    .replace(/[\\/]/g, "_")
    .trim()
    .slice(0, 90);
  return base || `attachment-${index + 1}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Method not allowed." });
  }

  const webhook = process.env.DISCORD_REPORT_WEBHOOK;
  if (!webhook) {
    return sendJson(res, 500, { error: "Support reporting is not configured yet. Please try again later." });
  }

  let webhookUrl;
  try {
    webhookUrl = new URL(webhook);
  } catch {
    return sendJson(res, 500, { error: "Support reporting is not configured correctly." });
  }
  if (
    webhookUrl.protocol !== "https:" ||
    !["discord.com", "discordapp.com"].includes(webhookUrl.hostname) ||
    !webhookUrl.pathname.startsWith("/api/webhooks/")
  ) {
    return sendJson(res, 500, { error: "Support reporting is not configured correctly." });
  }
  webhookUrl.searchParams.set("wait", "true");

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { error: "Invalid report data." });
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return sendJson(res, 400, { error: "Invalid report data." });
  }

  // Honeypot field: bots that fill this field are silently accepted without forwarding.
  if (String(body.website || "").trim()) {
    return sendJson(res, 200, { ok: true });
  }

  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim();
  const description = String(body.description || "").trim();
  if (name.length < 2 || name.length > 80) {
    return sendJson(res, 400, { error: "Please enter a name between 2 and 80 characters." });
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return sendJson(res, 400, { error: "Please enter a valid email address." });
  }
  if (description.length < 20 || description.length > MAX_DESCRIPTION) {
    return sendJson(res, 400, { error: `Your report must be between 20 and ${MAX_DESCRIPTION} characters.` });
  }

  const incomingFiles = Array.isArray(body.files) ? body.files : [];
  if (incomingFiles.length > MAX_FILES) {
    return sendJson(res, 400, { error: `Please attach no more than ${MAX_FILES} files.` });
  }

  const files = [];
  let totalBytes = 0;
  for (let i = 0; i < incomingFiles.length; i += 1) {
    const item = incomingFiles[i] || {};
    const type = String(item.type || "").toLowerCase();
    const encoded = String(item.data || "");
    if (!ALLOWED_TYPES.has(type)) {
      return sendJson(res, 400, { error: "One of the attachments has an unsupported file type." });
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
      return sendJson(res, 400, { error: "One of the attachments could not be read. Please select it again." });
    }
    const buffer = Buffer.from(encoded, "base64");
    if (!buffer.length || buffer.length > MAX_FILE_BYTES) {
      return sendJson(res, 400, { error: "Each attachment must be 1 MB or smaller." });
    }
    totalBytes += buffer.length;
    if (totalBytes > MAX_TOTAL_FILE_BYTES) {
      return sendJson(res, 400, { error: "Combined attachments must be 2.5 MB or less." });
    }
    files.push({
      buffer,
      type,
      filename: cleanFilename(item.name, i),
    });
  }

  const reportId = crypto.randomUUID();
  const firstPart = description.slice(0, 2500);
  const secondPart = description.slice(2500);
  const embeds = [
    {
      title: "New My Finance Support Report",
      color: 14205043,
      fields: [
        { name: "Report ID", value: reportId, inline: false },
        { name: "Name", value: name, inline: true },
        { name: "Email", value: email, inline: true },
      ],
      description: firstPart,
      timestamp: new Date().toISOString(),
    },
  ];
  if (secondPart) {
    embeds.push({
      title: "Report Details (continued)",
      color: 14205043,
      description: secondPart,
    });
  }

  const form = new FormData();
  const attachments = files.map((file, index) => ({
    id: index,
    filename: file.filename,
  }));
  form.append("payload_json", JSON.stringify({
    username: "My Finance Support",
    content: "A new support report has been submitted.",
    embeds,
    attachments,
  }));
  files.forEach((file, index) => {
    form.append(
      `files[${index}]`,
      new Blob([file.buffer], { type: file.type }),
      file.filename
    );
  });

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      // Do not expose webhook URL or Discord's raw response to the browser.
      return sendJson(res, 502, { error: "Discord could not receive the report right now. Please try again later." });
    }
    return sendJson(res, 200, { ok: true, reportId });
  } catch (error) {
    console.error("Discord report delivery failed:", error && error.message ? error.message : "Unknown error");
    return sendJson(res, 502, { error: "Could not reach Discord. Please try again later." });
  }
};
