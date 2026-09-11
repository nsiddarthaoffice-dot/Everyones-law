// Visit https://everydaylaw.pages.dev/api/debug directly in your browser
// (just type that URL, no need for the chat form). It will show, in plain
// JSON, either the list of models your key can actually use, or the exact
// error Google gives when trying to check.

export async function onRequestGet(context) {
  const { env } = context;
  const apiKey = env.GEMINI_API_KEY;

  if (!apiKey) {
    return new Response(
      JSON.stringify({ problem: "GEMINI_API_KEY is not set on this deployment." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models",
      { headers: { "x-goog-api-key": apiKey } }
    );
    const text = await res.text();

    return new Response(
      JSON.stringify(
        {
          status_code_from_google: res.status,
          key_starts_with: apiKey.slice(0, 6) + "...",
          key_length: apiKey.length,
          google_response: JSON.parse(text),
        },
        null,
        2
      ),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ problem: "Request itself failed", details: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
