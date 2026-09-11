// Powers the free-text chat page. Two steps happen for every question:
// 1. Ask Gemini which of our loaded law documents are relevant (cheap, fast).
// 2. Load only those documents' full text and ask for a structured answer.
// This keeps things fast and within free-tier limits, even as you add more
// acts to acts.json later — we never send ALL documents on every question.

const MODEL = "gemini-3.8-flash";

const MAIN_INSTRUCTIONS = `
You are a plain-language legal assistant helping Indian citizens with basic
English literacy understand what they can do about a legal problem. You will
be given the text of relevant Indian law(s) and a citizen's question.

Answer ONLY using the law text provided. Be accurate and specific: name the
exact statute and section, the punishment where relevant, and what evidence
or procedure the person should prepare (referencing the Evidence Act /
BNSS / CrPC where the provided text covers this).

Respond ONLY with valid JSON in exactly this shape, no other text:
{
  "relevant_act": "name of the act/section this concerns",
  "statute_section": "exact section number(s)",
  "plain_explanation": "clear explanation in simple everyday words",
  "punishment": "punishment or consequence, or 'Not applicable' if none",
  "evidence_and_procedure": "what evidence to gather and what process to expect",
  "example": "one short concrete real-life example",
  "landmark_judgments": [
    {
      "case_name": "real case name",
      "what_court_said": "simple explanation of the ruling",
      "still_valid": true,
      "note_if_overturned": ""
    }
  ],
  "not_covered": false
}

Only include a case in landmark_judgments if you are genuinely confident it
is real and accurately described — an empty array is far better than an
invented case. If a judgment was later overturned by a higher court, set
still_valid to false and explain in note_if_overturned.
`;

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { question } = await request.json();
    if (!question || typeof question !== "string") {
      return jsonError("Please send a question.", 400);
    }

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) return jsonError("Server is missing GEMINI_API_KEY.", 500);

    const acts = await loadActsList(env, request);
    if (!acts.length) return jsonError("No law documents are configured yet.", 500);

    // STEP 1: which act(s) are relevant?
    const routingPrompt = `Available Indian law documents:\n${acts
      .map((a) => `- id: "${a.id}" | ${a.name} | ${a.description}`)
      .join("\n")}\n\nCitizen's question: "${question}"\n\nReturn JSON only: {"relevant_ids": ["id1","id2"]} — pick at most 4 relevant documents: the substantive law(s) that actually apply, PLUS "landmark-judgments" if a real case citation would strengthen the answer. Return {"relevant_ids": []} if truly none apply.`;

    const routing = await callGemini(apiKey, routingPrompt);
    const relevantIds = Array.isArray(routing?.relevant_ids) ? routing.relevant_ids : [];
    const chosenActs = acts.filter((a) => relevantIds.includes(a.id));

    if (chosenActs.length === 0) {
      return okJson({
        not_covered: true,
        message: "None of the currently loaded laws seem to directly cover this. Try rephrasing, or this may need a document we haven't added yet.",
      });
    }

    // STEP 2: load only the relevant PORTION of each act's text (not the
    // whole document — that's what was blowing through the free quota),
    // then answer properly.
    let combinedText = "";
    for (const act of chosenActs) {
      const fullText = await loadDocumentText(env, request, act.file);
      const excerpt = selectRelevantExcerpt(fullText, question, PER_ACT_CHAR_BUDGET);
      combinedText += `\n\n=== ${act.name} ===\n${excerpt}`;
    }

    const answerPrompt = `${MAIN_INSTRUCTIONS}\n\nRELEVANT LAW TEXT:\n${combinedText}\n\nCITIZEN'S QUESTION: ${question}`;
    const answer = await callGemini(apiKey, answerPrompt);

    return okJson(answer);
  } catch (err) {
    return jsonError("Something went wrong: " + String(err), 500);
  }
}

async function loadActsList(env, request) {
  const res = await env.ASSETS.fetch(new URL("/acts.json", request.url));
  if (!res.ok) return [];
  return await res.json();
}

async function loadDocumentText(env, request, filePath) {
  const res = await env.ASSETS.fetch(new URL("/" + filePath, request.url));
  if (!res.ok) return "(document could not be loaded)";
  return await res.text();
}

// Large acts (Constitution, BNSS, Companies Act, etc.) are far bigger than
// any single question needs. Sending the whole thing every time is what
// blew through the free-tier per-minute token quota. Instead, we keep only
// the paragraphs that actually relate to the question's own words, up to
// this many characters per act (roughly 7,500 tokens) — small acts that are
// already under this size are left completely untouched.
const PER_ACT_CHAR_BUDGET = 30000;

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
  if (fullText.length <= maxChars) return fullText; // already small — send as-is

  const keywords = extractKeywords(queryText);
  const paragraphs = fullText.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  const scored = paragraphs.map((para, idx) => {
    const lower = para.toLowerCase();
    let score = 0;
    for (const kw of keywords) if (lower.includes(kw)) score += 1;
    if (/^\(?\d+/.test(para)) score += 0.5; // slight boost for numbered sections
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

  chosen.sort((a, b) => a.idx - b.idx); // restore original document order
  const excerpt = chosen.map((c) => c.para).join("\n\n");
  return excerpt || fullText.slice(0, maxChars);
}

// If the main model is overloaded (503) or rate-limited (429), retry a
// couple of times with a short pause, then fall back to a second model
// before giving up entirely. This is the difference between a real Google
// outage looking like "the app is broken" vs "it took one extra second."
const FALLBACK_MODEL = "gemini-3.6-flash";

async function callGemini(apiKey, prompt) {
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
    // Only retry/fallback on overload or rate-limit; anything else (bad key,
    // bad request) fails fast since retrying won't help.
    if (res.status !== 503 && res.status !== 429) break;
  }
  throw new Error(`Gemini error after retries: ${lastErrorText}`);
}

function okJson(obj) {
  return new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } });
}

function jsonError(msg, status) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
