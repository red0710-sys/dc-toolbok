import { createHash } from "node:crypto";
import { get, put } from "@vercel/blob";

const BOOK_RE = /^[a-f0-9]{32}$/;
const MAX_BYTES = 2_000_000;

function pathFor(book) {
  const hash = createHash("sha256").update(book).digest("hex");
  return `ledgers/v1/${hash}.json`;
}

function defaultData() {
  return {
    version: 1,
    settings: { memberA: "David", memberB: "太太", monthlyBudget: 0 },
    entries: []
  };
}

function send(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

async function readLedger(pathname) {
  const result = await get(pathname, { access: "private" });
  if (!result || result.statusCode === 404) return null;
  if (result.statusCode !== 200) throw new Error("Unable to read ledger");
  const text = await new Response(result.stream).text();
  return { data: JSON.parse(text), etag: result.blob.etag };
}

function sanitizeData(input) {
  if (!input || typeof input !== "object") throw new Error("Invalid ledger payload");
  const settings = input.settings || {};
  const entries = Array.isArray(input.entries) ? input.entries : [];

  if (entries.length > 20000) throw new Error("Ledger is too large");

  const cleaned = {
    version: 1,
    settings: {
      memberA: String(settings.memberA || "David").slice(0, 30),
      memberB: String(settings.memberB || "太太").slice(0, 30),
      monthlyBudget: Math.max(0, Number(settings.monthlyBudget) || 0)
    },
    entries: entries.map((e) => ({
      id: String(e.id || "").slice(0, 80),
      type: e.type === "income" ? "income" : "expense",
      amount: Math.max(0, Number(e.amount) || 0),
      category: String(e.category || "其他").slice(0, 30),
      member: e.member === "B" ? "B" : "A",
      note: String(e.note || "").slice(0, 200),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(e.date || "")) ? String(e.date) : new Date().toISOString().slice(0, 10),
      createdAt: String(e.createdAt || new Date().toISOString()).slice(0, 40),
      updatedAt: String(e.updatedAt || e.createdAt || new Date().toISOString()).slice(0, 40)
    })).filter((e) => e.id && e.amount > 0)
  };

  if (Buffer.byteLength(JSON.stringify(cleaned)) > MAX_BYTES) {
    throw new Error("Ledger exceeds storage limit");
  }
  return cleaned;
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const book = String(req.query?.book || "");
      if (!BOOK_RE.test(book)) return send(res, 400, { error: "Invalid book key" });

      const stored = await readLedger(pathFor(book));
      return send(res, 200, stored || { data: defaultData(), etag: null });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const book = String(body.book || "");
      if (!BOOK_RE.test(book)) return send(res, 400, { error: "Invalid book key" });

      const pathname = pathFor(book);
      const current = await readLedger(pathname);
      const expected = body.etag == null ? null : String(body.etag);

      if ((current?.etag || null) !== expected) {
        return send(res, 409, {
          error: "Ledger changed on another device",
          data: current?.data || defaultData(),
          etag: current?.etag || null
        });
      }

      const data = sanitizeData(body.data);
      const saved = await put(pathname, JSON.stringify(data), {
        access: "private",
        allowOverwrite: true,
        contentType: "application/json",
        cacheControlMaxAge: 0,
        ...(current?.etag ? { ifMatch: current.etag } : {})
      });

      return send(res, 200, { ok: true, data, etag: saved.etag });
    }

    return send(res, 405, { error: "Method not allowed" }, { Allow: "GET, POST" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (/precondition|if.?match|412/i.test(message)) {
      return send(res, 409, { error: "Ledger changed on another device. Reload and try again." });
    }
    console.error(error);
    return send(res, 500, { error: "Ledger service error" });
  }
}
