import { and, eq, isNull } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import { cardDriveFiles } from "@kan/db/schema";
import { generateUID } from "@kan/shared/utils";

export const create = async (
  db: dbClient,
  input: {
    cardId: number;
    driveFileId: string;
    name: string;
    mimeType: string;
    url: string;
    iconUrl: string | null;
    createdBy: string;
  },
) => {
  const [result] = await db
    .insert(cardDriveFiles)
    .values({ publicId: generateUID(), ...input })
    .returning();

  return result;
};

export const getByPublicId = (db: dbClient, publicId: string) =>
  db.query.cardDriveFiles.findFirst({
    where: and(
      eq(cardDriveFiles.publicId, publicId),
      isNull(cardDriveFiles.deletedAt),
    ),
    with: {
      card: {
        columns: { id: true },
        with: {
          list: {
            columns: { id: true },
            with: { board: { columns: { workspaceId: true } } },
          },
        },
      },
    },
  });

/** The live link to a Drive file on a card, if the file is already linked. */
export const getByCardAndDriveFileId = (
  db: dbClient,
  cardId: number,
  driveFileId: string,
) =>
  db.query.cardDriveFiles.findFirst({
    where: and(
      eq(cardDriveFiles.cardId, cardId),
      eq(cardDriveFiles.driveFileId, driveFileId),
      isNull(cardDriveFiles.deletedAt),
    ),
  });

export const getAllByCardId = (db: dbClient, cardId: number) =>
  db.query.cardDriveFiles.findMany({
    columns: {
      publicId: true,
      driveFileId: true,
      name: true,
      mimeType: true,
      url: true,
      iconUrl: true,
      createdAt: true,
    },
    where: and(
      eq(cardDriveFiles.cardId, cardId),
      isNull(cardDriveFiles.deletedAt),
    ),
    orderBy: (files, { asc }) => [asc(files.createdAt)],
    with: {
      createdBy: { columns: { name: true } },
    },
  });

export const softDelete = async (
  db: dbClient,
  args: { id: number; deletedAt: Date },
) => {
  const [result] = await db
    .update(cardDriveFiles)
    .set({ deletedAt: args.deletedAt })
    .where(eq(cardDriveFiles.id, args.id))
    .returning({ id: cardDriveFiles.id });

  return result;
};
