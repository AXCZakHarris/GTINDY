// Optional shared-password gate (carried over from the Streamlit version).
//
// If the Pages project has an APP_PASSWORD secret set, the browser asks for a
// password before showing anything (leave the user name box empty or type
// anything; only the password is checked). If APP_PASSWORD is not set, the
// site is open, exactly as the original app behaved.
//
// This only guards the page itself. Uploaded CSVs never reach this code: all
// processing happens in the visitor's browser.

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// Compare without leaking how many leading characters matched.
async function samePassword(given, expected) {
  const a = await sha256(given);
  const b = await sha256(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function passwordFrom(request) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return null;
  try {
    const bytes = Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const colon = decoded.indexOf(":");
    return colon === -1 ? null : decoded.slice(colon + 1);
  } catch {
    return null;
  }
}

export async function onRequest(context) {
  const expected = context.env.APP_PASSWORD;
  if (!expected) return context.next();

  const given = passwordFrom(context.request);
  if (given !== null && (await samePassword(given, expected))) return context.next();

  return new Response("Password required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="IRIS Provider Invoice", charset="UTF-8"',
      "Cache-Control": "no-store",
    },
  });
}
