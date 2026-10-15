// Vercel serverless function. Processes ONE company per call.

// Env var (if set in Vercel) wins; otherwise falls back to the key below.
const GEMINI_KEY = process.env.GEMINI_API_KEY || "AQ.Ab8RN6LhyrFfN5xuLb-hMpWY7MVfOJsl0WEY-k9TEcxEsa8YXg";

function extractJson(text) {
  const clean = (text || "").replace(/```json|```/g, "").trim();
  const m = clean.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try { return JSON.parse(m[0]); } catch { return {}; }
}

function cleanDomain(v) {
  return (v || "").toLowerCase().trim()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
}

async function findPeople({ company, website, roles, maxPeople }) {
  const prompt = `Find the key decision makers at this company using Google Search
(company website, public LinkedIn results, news, Crunchbase, etc.).

Company: ${company}
Website: ${website || "unknown"}
Target roles: ${roles}
Max people: ${maxPeople}

Rules:
- Only include people you actually found in search results. Never invent names.
- If unsure, leave the field as an empty string.
- Return ONLY valid JSON in this exact shape:
{"domain":"company email domain e.g. acme.com",
 "people":[{"name":"Full Name","title":"Job title","linkedin_url":"public linkedin URL or empty","source_url":"page where found"}]}`;

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  // "AQ." keys = Vertex AI express keys; "AIza" keys = AI Studio keys
  const isVertex = GEMINI_KEY.startsWith("AQ.");
  const url = isVertex
    ? `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const headers = { "Content-Type": "application/json" };
  if (!isVertex) headers["x-goog-api-key"] = GEMINI_KEY;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ googleSearch: {} }],
      generationConfig: { temperature: 0.1 },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Gemini error");
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
  return extractJson(text);
}

async function hunterEmail(domain, fullName) {
  const key = process.env.HUNTER_API_KEY;
  const parts = fullName.trim().split(/\s+/);
  if (!key || parts.length < 2 || !domain) return null;
  try {
    const url = new URL("https://api.hunter.io/v2/email-finder");
    url.search = new URLSearchParams({
      domain, first_name: parts[0], last_name: parts[parts.length - 1], api_key: key,
    });
    const d = ((await (await fetch(url)).json()).data) || {};
    if (d.email) return { email: d.email, source: `hunter (score ${d.score ?? "?"})` };
  } catch {}
  return null;
}

function guessEmail(domain, fullName) {
  const parts = fullName.replace(/[^a-zA-Z ]/g, "").toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length < 2 || !domain) return "";
  return `${parts[0]}.${parts[parts.length - 1]}@${domain}`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

  // Optional password so strangers can't burn your API quota
  if (process.env.APP_PASSWORD && body.password !== process.env.APP_PASSWORD)
    return res.status(401).json({ error: "Wrong password" });

  try {
    const found = await findPeople(body);
    const domain = cleanDomain(found.domain || body.website);
    const people = [];

    for (const p of (found.people || []).slice(0, body.maxPeople || 3)) {
      const name = p.name || "";
      let email = "", email_source = "";
      const h = await hunterEmail(domain, name);
      if (h) ({ email, source: email_source } = h);
      else if (body.guess !== false) {
        email = guessEmail(domain, name);
        if (email) email_source = "guessed (verify!)";
      }
      people.push({
        person_name: name, title: p.title || "", linkedin_url: p.linkedin_url || "",
        email, email_source, source_url: p.source_url || "",
      });
    }
    return res.status(200).json({ domain, people });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
};
