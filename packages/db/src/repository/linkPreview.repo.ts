import { eq, inArray } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import type { LinkPreviewStatus } from "@kan/db/schema";
import { linkPreviews } from "@kan/db/schema";

export interface LinkPreviewInput {
  url: string;
  status: LinkPreviewStatus;
  finalUrl: string | null;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  faviconUrl: string | null;
}

export const getByUrl = (db: dbClient, url: string) => {
  return db.query.linkPreviews.findFirst({
    where: eq(linkPreviews.url, url),
  });
};

export const getByUrls = async (db: dbClient, urls: string[]) => {
  if (urls.length === 0) return [];
  return db.query.linkPreviews.findMany({
    where: inArray(linkPreviews.url, urls),
  });
};

export const upsert = async (db: dbClient, input: LinkPreviewInput) => {
  const values = { ...input, fetchedAt: new Date() };
  const [result] = await db
    .insert(linkPreviews)
    .values(values)
    .onConflictDoUpdate({
      target: linkPreviews.url,
      set: {
        status: values.status,
        finalUrl: values.finalUrl,
        title: values.title,
        description: values.description,
        imageUrl: values.imageUrl,
        siteName: values.siteName,
        faviconUrl: values.faviconUrl,
        fetchedAt: values.fetchedAt,
      },
    })
    .returning();

  return result;
};
