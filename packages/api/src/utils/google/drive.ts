import { googleFetch } from "./oauth";

const DRIVE_API = "https://www.googleapis.com/drive/v3";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  url: string;
  iconUrl: string | null;
}

/** Drive file ids are URL-safe base64-like strings. */
export const isValidDriveFileId = (id: string) => /^[\w-]{10,200}$/.test(id);

/** Only links that open on Google's own sites are kept. */
export const isGoogleUrl = (value: string | undefined) => {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "google.com" ||
        url.hostname.endsWith(".google.com") ||
        url.hostname.endsWith(".googleusercontent.com"))
    );
  } catch {
    return false;
  }
};

/**
 * Reads a file's name, type and link from Drive. With the drive.file scope
 * this only works for files the person picked in the Google Picker, so it
 * also proves they can open the file.
 */
export const getDriveFile = async (
  accessToken: string,
  fileId: string,
): Promise<DriveFile> => {
  const params = new URLSearchParams({
    fields: "id,name,mimeType,webViewLink,iconLink",
    supportsAllDrives: "true",
  });
  const file = await googleFetch<{
    id: string;
    name?: string;
    mimeType?: string;
    webViewLink?: string;
    iconLink?: string;
  }>(
    accessToken,
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params.toString()}`,
  );

  if (!file || !isGoogleUrl(file.webViewLink)) {
    throw new Error("Google Drive returned no link for this file");
  }

  return {
    id: file.id,
    name: (file.name ?? "Untitled").slice(0, 1024),
    mimeType: (file.mimeType ?? "application/octet-stream").slice(0, 255),
    url: file.webViewLink ?? "",
    iconUrl: isGoogleUrl(file.iconLink) ? (file.iconLink ?? null) : null,
  };
};
