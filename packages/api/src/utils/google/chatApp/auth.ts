import type { JWTVerifyGetKey } from "jose";
import {
  createRemoteJWKSet,
  decodeJwt,
  importPKCS8,
  jwtVerify,
  SignJWT,
} from "jose";
import { env } from "next-runtime-env";

import { GoogleChatError } from "../chat";

/** Google signs the requests it sends to a Chat app's HTTP endpoint as this. */
export const CHAT_ISSUER = "chat@system.gserviceaccount.com";
const CHAT_JWKS_URL = `https://www.googleapis.com/service_accounts/v1/jwk/${CHAT_ISSUER}`;
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHAT_API = "https://chat.googleapis.com/v1";
const CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";

export const CHAT_APP_PATH = "/api/integrations/google/chat-app";

/**
 * The Chat app is on when the Google Cloud project number is set. It is what
 * Google puts in the audience of the requests it sends.
 */
export const getChatAppConfig = () => {
  const projectNumber = process.env.GOOGLE_CHAT_PROJECT_NUMBER?.trim();
  if (!projectNumber) return null;
  return {
    projectNumber,
    endpointUrl: `${env("NEXT_PUBLIC_BASE_URL")}${CHAT_APP_PATH}`,
  };
};

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

/**
 * The service account key the app uses to post on its own (reminders). Takes
 * the downloaded JSON key as is, or base64 encoded.
 */
export const getServiceAccountKey = (): ServiceAccountKey | null => {
  const raw = process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_KEY?.trim();
  if (!raw) return null;
  try {
    const json = raw.startsWith("{")
      ? raw
      : Buffer.from(raw, "base64").toString("utf8");
    const key = JSON.parse(json) as Partial<ServiceAccountKey>;
    if (!key.client_email || !key.private_key) return null;
    return {
      client_email: key.client_email,
      // Some hosts store the newlines in the key escaped
      private_key: key.private_key.replace(/\\n/g, "\n"),
      private_key_id: key.private_key_id,
    };
  } catch {
    return null;
  }
};

/** Whether the app can post messages on its own, e.g. reminders. */
export const canChatAppSendMessages = () =>
  !!getChatAppConfig() && !!getServiceAccountKey();

let chatKeys: JWTVerifyGetKey | undefined;
let googleKeys: JWTVerifyGetKey | undefined;

export interface VerifyKeys {
  chatKeys?: JWTVerifyGetKey;
  googleKeys?: JWTVerifyGetKey;
}

/**
 * Checks that a request to the Chat app endpoint really comes from Google
 * Chat for this project. Google sends one of two bearer tokens, depending on
 * the "Authentication audience" picked in the Chat API configuration:
 * - Project number: a JWT from chat@system.gserviceaccount.com whose audience
 *   is the project number.
 * - HTTP endpoint URL: a Google ID token whose audience is the endpoint URL,
 *   for the Chat service account (or, for apps built as Workspace add-ons,
 *   the project's add-ons service account).
 */
export const verifyChatRequest = async (
  authorization: string | undefined,
  keys: VerifyKeys = {},
) => {
  const config = getChatAppConfig();
  if (!config) return false;

  const token = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]?.trim();
  if (!token) return false;

  let issuer: string | undefined;
  try {
    issuer = decodeJwt(token).iss;
  } catch {
    return false;
  }

  try {
    if (issuer === CHAT_ISSUER) {
      chatKeys ??= createRemoteJWKSet(new URL(CHAT_JWKS_URL));
      await jwtVerify(token, keys.chatKeys ?? chatKeys, {
        issuer: CHAT_ISSUER,
        audience: config.projectNumber,
        clockTolerance: 30,
      });
      return true;
    }

    googleKeys ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
    const { payload } = await jwtVerify(token, keys.googleKeys ?? googleKeys, {
      issuer: GOOGLE_ISSUERS,
      audience: config.endpointUrl,
      clockTolerance: 30,
    });
    const allowed = [
      CHAT_ISSUER,
      `service-${config.projectNumber}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`,
    ];
    return (
      typeof payload.email === "string" &&
      allowed.includes(payload.email) &&
      payload.email_verified !== false
    );
  } catch {
    return false;
  }
};

let cachedToken: { value: string; expiresAt: number } | undefined;

/** An access token for the Chat API, acting as the app itself. */
export const getChatAppAccessToken = async () => {
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) {
    return cachedToken.value;
  }

  const key = getServiceAccountKey();
  if (!key) {
    throw new GoogleChatError(
      "GOOGLE_CHAT_SERVICE_ACCOUNT_KEY is missing or not a service account key",
      400,
    );
  }

  const privateKey = await importPKCS8(key.private_key, "RS256");
  const assertion = await new SignJWT({ scope: CHAT_BOT_SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: key.private_key_id })
    .setIssuer(key.client_email)
    .setSubject(key.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new GoogleChatError(
      `Could not reach Google: ${error instanceof Error ? error.message : String(error)}`,
      0,
    );
  }

  const json = (await response.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  } | null;

  if (!response.ok || !json?.access_token) {
    throw new GoogleChatError(
      `Google refused the Chat app's service account: ${json?.error_description ?? json?.error ?? response.status}`,
      response.status >= 500 ? response.status : 400,
    );
  }

  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
};

/**
 * Posts a message as the app to a space or direct message it belongs to.
 * Messages with the same thread key are grouped into one thread.
 */
export const sendChatAppMessage = async (
  spaceName: string,
  text: string,
  threadKey?: string,
) => {
  if (!/^spaces\/[\w-]+$/.test(spaceName)) {
    throw new GoogleChatError(`Not a Chat space: ${spaceName}`, 400);
  }

  const accessToken = await getChatAppAccessToken();
  const url = new URL(`${CHAT_API}/${spaceName}/messages`);
  if (threadKey) {
    url.searchParams.set(
      "messageReplyOption",
      "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
    );
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        text,
        ...(threadKey ? { thread: { threadKey } } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new GoogleChatError(
      `Could not reach Google Chat: ${error instanceof Error ? error.message : String(error)}`,
      0,
    );
  }

  if (!response.ok) {
    if (response.status === 401) cachedToken = undefined;
    const json = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new GoogleChatError(
      `Google Chat rejected the message: ${json?.error?.message ?? response.status}`,
      response.status,
    );
  }
};
