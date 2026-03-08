import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { Config } from "../config.js";

export interface GoogleAccount {
  name: string;
  email: string;
  auth: OAuth2Client;
}

export function createGoogleAccounts(config: Config): GoogleAccount[] {
  const accounts: GoogleAccount[] = [];

  for (const acct of config.googleAccounts) {
    const auth = new google.auth.OAuth2(
      config.googleClientId,
      config.googleClientSecret
    );
    auth.setCredentials({ refresh_token: acct.refreshToken });
    accounts.push({ name: acct.name, email: acct.email, auth });
  }

  return accounts;
}

export function findAccount(accounts: GoogleAccount[], query: string): GoogleAccount | undefined {
  const q = query.toLowerCase();
  return accounts.find(
    (a) => a.email.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)
  );
}
