import crypto from "crypto";
import { env } from "next-runtime-env";

import type { dbClient } from "@kan/db/client";
import * as googleConnectionRepo from "@kan/db/repository/googleConnection.repo";

import { decryptToken, encryptToken } from "../encryption";

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";
// Only the Drive files a person picks in Kan, never the rest of their Drive
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/**
 * What a connect flow asks Google for. "sync" is Calendar and Tasks from the
 * account settings; "drive" is file linking from a card. Google keeps earlier
 * grants (include_granted_scopes), so one connection ends up with both.
 */
export const GOOGLE_SCOPES = {
  sync: [
    "openid",
    "email",
    // Create and manage only the calendars Kan creates
    CALENDAR_SCOPE,
    TASKS_SCOPE,
  ],
  drive: ["openid", "email", DRIVE_FILE_SCOPE],
} as const;

export type GoogleConnectPurpose = keyof typeof GOOGLE_SCOPES;

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

/** Raised for any non-2xx response from a Google API. */
export class GoogleApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly reason?: string,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }

  /** The user revoked access or the refresh token is no longer valid. */
  get isAuthError() {
    return this.status === 401 || this.reason === "invalid_grant";
  }

  get isRetryable() {
    return this.status === 429 || this.status >= 500;
  }
}

export const getGoogleOAuthConfig = () => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: `${env("NEXT_PUBLIC_BASE_URL")}/api/integrations/google/callback`,
  };
};

export const isGoogleIntegrationConfigured = () => !!getGoogleOAuthConfig();

/** Whether Google granted every scope Kan asked for, by feature. */
export const getGrantedFeatures = (scope: string | undefined) => {
  const scopes = new Set((scope ?? "").split(" "));
  return {
    calendar: scopes.has(CALENDAR_SCOPE),
    tasks: scopes.has(TASKS_SCOPE),
    drive: scopes.has(DRIVE_FILE_SCOPE),
  };
};

/**
 * The Picker's app id is the Cloud project number, which is the part of the
 * OAuth client id before the first dash.
 */
export const getGoogleProjectNumber = () => {
  const projectNumber = process.env.GOOGLE_CLIENT_ID?.split("-")[0];
  return projectNumber && /^\d+$/.test(projectNumber) ? projectNumber : null;
};

/** A path on this site to come back to after connecting, or null. */
export const normalizeReturnTo = (returnTo: string | undefined) => {
  if (!returnTo?.startsWith("/") || returnTo.length > 512) return null;
  // "//host" and "/\\host" are read by browsers as another site
  if (returnTo.startsWith("//") || returnTo.startsWith("/\\")) return null;
  return returnTo;
};

/**
 * The OAuth state ties the callback to the user who started the flow and
 * expires after ten minutes. It is encrypted, so it can't be forged. It also
 * carries the browser's time zone, used for the calendar and task due dates,
 * what the flow was for and where to send the person afterwards.
 */
export const createOAuthState = (
  userId: string,
  timeZone: string,
  now = Date.now(),
  options: { purpose?: GoogleConnectPurpose; returnTo?: string | null } = {},
) =>
  encryptToken(
    JSON.stringify({
      userId,
      timeZone,
      purpose: options.purpose ?? "sync",
      returnTo: options.returnTo ?? null,
      issuedAt: now,
      nonce: crypto.randomBytes(8).toString("hex"),
    }),
  );

/** Returns the state's time zone if it is valid for this user, else null. */
export const verifyOAuthState = (
  state: string,
  userId: string,
  now = Date.now(),
): {
  timeZone: string;
  purpose: GoogleConnectPurpose;
  returnTo: string | null;
} | null => {
  try {
    const parsed = JSON.parse(decryptToken(state)) as {
      userId?: string;
      timeZone?: string;
      purpose?: string;
      returnTo?: string | null;
      issuedAt?: number;
    };
    if (
      parsed.userId !== userId ||
      typeof parsed.issuedAt !== "number" ||
      now - parsed.issuedAt >= STATE_MAX_AGE_MS
    ) {
      return null;
    }
    return {
      timeZone: normalizeTimeZone(parsed.timeZone),
      purpose: parsed.purpose === "drive" ? "drive" : "sync",
      returnTo: normalizeReturnTo(parsed.returnTo ?? undefined),
    };
  } catch {
    return null;
  }
};

/** A valid IANA time zone, or UTC. */
export const normalizeTimeZone = (timeZone: string | undefined) => {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
};

export const buildAuthorizationUrl = (
  userId: string,
  timeZone: string,
  options: { purpose?: GoogleConnectPurpose; returnTo?: string | null } = {},
) => {
  const config = getGoogleOAuthConfig();
  if (!config) return null;

  const purpose = options.purpose ?? "sync";
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES[purpose].join(" "),
    access_type: "offline",
    // Always ask, so Google returns a refresh token on every connect
    prompt: "consent",
    include_granted_scopes: "true",
    state: createOAuthState(userId, timeZone, Date.now(), {
      purpose,
      returnTo: normalizeReturnTo(options.returnTo ?? undefined),
    }),
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
};

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

const postTokenRequest = async (body: Record<string, string>) => {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await response.json().catch(() => ({}))) as
    | TokenResponse
    | { error?: string; error_description?: string };

  if (!response.ok || !("access_token" in json)) {
    const error = "error" in json ? json.error : undefined;
    const description =
      "error_description" in json ? json.error_description : undefined;
    throw new GoogleApiError(
      `Google token request failed: ${description ?? error ?? response.status}`,
      response.status,
      error,
    );
  }
  return json;
};

export const exchangeCodeForTokens = async (code: string) => {
  const config = getGoogleOAuthConfig();
  if (!config) throw new Error("Google integration is not configured");
  return postTokenRequest({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
  });
};

export const getGoogleEmail = async (accessToken: string) => {
  const response = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  const json = (await response.json()) as { email?: string };
  return json.email ?? null;
};

export const revokeToken = async (token: string) => {
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
};

type GoogleConnection = NonNullable<
  Awaited<ReturnType<typeof googleConnectionRepo.getById>>
>;

/**
 * Returns a usable access token for a connection, refreshing and saving a new
 * one when the stored token is missing or about to expire.
 */
export const getAccessToken = async (
  db: dbClient,
  connection: GoogleConnection,
  now = new Date(),
) => {
  if (
    connection.accessToken &&
    connection.accessTokenExpiresAt &&
    connection.accessTokenExpiresAt.getTime() - now.getTime() > 60_000
  ) {
    return decryptToken(connection.accessToken);
  }

  const config = getGoogleOAuthConfig();
  if (!config) throw new Error("Google integration is not configured");

  const tokens = await postTokenRequest({
    refresh_token: decryptToken(connection.refreshToken),
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
  });

  await googleConnectionRepo.update(db, connection.id, {
    accessToken: encryptToken(tokens.access_token),
    accessTokenExpiresAt: new Date(now.getTime() + tokens.expires_in * 1000),
  });

  return tokens.access_token;
};

/**
 * Calls a Google REST API with a bearer token and returns the parsed JSON body
 * (or null for empty responses).
 */
export const googleFetch = async <T>(
  accessToken: string,
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T | null> => {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body !== undefined && { "Content-Type": "application/json" }),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const json = (await response.json().catch(() => null)) as {
      error?: { message?: string; errors?: { reason?: string }[] };
    } | null;
    throw new GoogleApiError(
      `Google API ${init.method ?? "GET"} ${new URL(url).pathname} failed: ${
        json?.error?.message ?? response.status
      }`,
      response.status,
      json?.error?.errors?.[0]?.reason,
    );
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : null;
};
