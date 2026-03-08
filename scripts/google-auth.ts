import { google } from "googleapis";
import { createServer } from "node:http";
import { URL } from "node:url";

const CLIENT_ID = process.env["GOOGLE_CLIENT_ID"] ?? process.argv[2];
const CLIENT_SECRET = process.env["GOOGLE_CLIENT_SECRET"] ?? process.argv[3];
const ACCOUNT_LABEL = process.argv[4] ?? "account";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Usage: npx tsx scripts/google-auth.ts <client_id> <client_secret> [label]");
  console.error("  Or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars");
  process.exit(1);
}

const REDIRECT_URI = "http://localhost:3456/callback";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
];

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: SCOPES,
});

console.log(`\nAuthorizing: ${ACCOUNT_LABEL}`);
console.log(`\nOpen this URL in your browser:\n\n${authUrl}\n`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:3456`);
  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400);
    res.end("No code received");
    return;
  }

  try {
    const { tokens } = await oauth2.getToken(code);
    console.log(`\n=== Refresh token for ${ACCOUNT_LABEL} ===`);
    console.log(tokens.refresh_token);
    console.log(`\nAdd this to your .env file as:`);
    console.log(`GOOGLE_ACCOUNT_X_REFRESH_TOKEN=${tokens.refresh_token}\n`);

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h1>Done!</h1><p>Refresh token for ${ACCOUNT_LABEL} received. You can close this tab.</p>`);
  } catch (e) {
    const err = e as Error;
    console.error("Error exchanging code:", err.message);
    res.writeHead(500);
    res.end("Error: " + err.message);
  }

  server.close();
});

server.listen(3456, () => {
  console.log("Waiting for OAuth callback on http://localhost:3456/callback ...");
});
