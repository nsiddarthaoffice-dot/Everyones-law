// Powers the Bare Act Explainer page. Given one act (and optionally a
// section/topic the person typed), returns the original text alongside a
// plain-English explanation, a real-life example, and a relevant court case.

const MODEL = "gemini-3.8-flash";

const EXPLAIN_INSTRUCTIONS = `
You are creating a "bare act explainer" card for Indian citizens with basic
English literacy. You will be given the full text of one Indian law and,
optionally, a specific section or topic the person wants explained.

Respond ONLY with valid JSON in exactly this shape, no other text:
{
  "section_reference": "which section(s) this covers",
  "original_text_excerpt": "the relevant original text, verbatim, kept short",
  "plain_english": "about 25-30 words, plain everyday language — do NOT start with 'This law states' or 'This law applies'",
  "example": "one short concrete real-life or hypothetical example",
  "court_case": {
    "case_name": "real case name",
    "court": "Supreme Court or which High Court",
    "year": "year of judgment",
    "what_court_said": "simple explanation of what the court decided",
    "still_valid": true,
    "note_if_overturned": ""
  }
}

If you are not genuinely confident of a real, accurately-described case, set
"court_case" to null rather than inventing one. If a judgment was later
overturned by a higher court, set still_valid to false and explain briefly
in note_if_overturned.
`;

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { act_id, section } = await request.json();
    if (!act_id) return jsonError("Please choose a law.", 400);

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) return jsonError("Server is missing GEMINI_API_KEY.", 500);

    const actsRes = await env.ASSETS.fetch(new URL("/acts.json", request.url));
    const acts = await actsRes.json();
    const act = acts.find((a) => a.id === act_id);
    if (!act) return jsonError("Unknown law selected.", 400);

    const fileRes = await env.ASSETS.fetch(new URL("/" + act.file, request.url));
    const fullText = await fileRes.text();
    // Only one act loads on this page, so it gets a bigger budget than the
    // multi-act chat page — but still trimmed for genuinely huge acts.
    const excerpt = selectRelevantExcerpt(fullText, section || "", 60000);

    const prompt = `${EXPLAIN_INSTRUCTIONS}\n\nACT TEXT:\n${excerpt}\n\nSECTION OR TOPIC REQUESTED: ${
      section && section.trim() ? section : "(none given — pick the single most useful, illustrative provision in this document)"
    }`;

    const result = await callGeminiWithRetry(apiKey, prompt);
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return jsonError("Something went wrong: " + String(err), 500);
  }
}

// Same resilience as chat.js: retry the main model a couple of times on
// overload/rate-limit, then fall back to a second model before giving up.
const FALLBACK_MODEL = "gemini-3.6-flash";

async function callGeminiWithRetry(apiKey, prompt) {
  const attempts = [
    { model: MODEL, delay: 0 },
    { model: MODEL, delay: 1500 },
    { model: FALLBACK_MODEL, delay: 0 },
    { model: FALLBACK_MODEL, delay: 1500 },
  ];

  let lastErrorText = "";
  for (const attempt of attempts) {
    if (attempt.delay) await new Promise((r) => setTimeout(r, attempt.delay));
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${attempt.model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" },
        }),
      }
    );
    if (res.ok) {
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
      return JSON.parse(text);
    }
    lastErrorText = await res.text();
    if (res.status !== 503 && res.status !== 429) break;
  }
  throw new Error(`Gemini error after retries: ${lastErrorText}`);
}

function jsonError(msg, status) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const STOPWORDS = new Set([
  "the","and","is","in","to","of","a","for","on","that","with","as","by",
  "an","be","this","my","what","can","do","i","are","will","from","or",
  "at","it","if","was","has","have","had","not","but","so","we","you",
  "your","he","she","they","them","his","her","their","me","us","our",
]);

function extractKeywords(text) {
  return [...new Set(
    (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
      (w) => w.length > 2 && !STOPWORDS.has(w)
    )
  )];
}

function selectRelevantExcerpt(fullText, queryText, maxChars) {
  if (fullText.length <= maxChars) return fullText;

  const keywords = extractKeywords(queryText);
  const paragraphs = fullText.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  // No section/topic given and doc is huge — just take the opening portion
  // (definitions + early substantive sections) rather than guessing.
  if (keywords.length === 0) return fullText.slice(0, maxChars);

  const scored = paragraphs.map((para, idx) => {
    const lower = para.toLowerCase();
    let score = 0;
    for (const kw of keywords) if (lower.includes(kw)) score += 1;
    if (/^\(?\d+/.test(para)) score += 0.5;
    return { idx, para, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const chosen = [];
  let total = 0;
  for (const item of scored) {
    if (total + item.para.length > maxChars) continue;
    chosen.push(item);
    total += item.para.length;
    if (total >= maxChars * 0.95) break;
  }

  chosen.sort((a, b) => a.idx - b.idx);
  const excerpt = chosen.map((c) => c.para).join("\n\n");
  return excerpt || fullText.slice(0, maxChars);
}
