import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as boardRepo from "@kan/db/repository/board.repo";

import { deleteUploadedBoardBackground } from "../utils/boardBackground";

vi.mock("@kan/db/repository/watcher.repo", () => ({
  isWatchingBoard: vi.fn().mockResolvedValue(false),
}));
vi.mock("@kan/db/repository/board.repo", () => ({
  getWorkspaceAndBoardIdByBoardPublicId: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@kan/db/repository/workspace.repo", () => ({}));
vi.mock("@kan/db/repository/card.repo", () => ({}));
vi.mock("@kan/db/repository/cardActivity.repo", () => ({}));
vi.mock("@kan/db/repository/label.repo", () => ({}));
vi.mock("@kan/db/repository/list.repo", () => ({}));
vi.mock("../utils/integrationJobs", () => ({
  enqueueGoogleBoardSync: vi.fn(),
}));
vi.mock("../utils/permissions", () => ({
  assertCanEdit: vi.fn(),
  assertCanDelete: vi.fn(),
  assertPermission: vi.fn(),
}));
vi.mock("../utils/boardBackground", () => ({
  deleteUploadedBoardBackground: vi.fn(),
  withBackgroundImageUrl: vi.fn(),
}));
vi.mock("@kan/shared/utils", () => ({
  convertDueDateFiltersToRanges: vi.fn(),
  generateAttachmentUrl: vi.fn(),
  generateSlug: vi.fn(),
  generateUID: vi.fn(),
}));

const mockGetBoard = vi.mocked(boardRepo.getWorkspaceAndBoardIdByBoardPublicId);
const mockUpdate = vi.mocked(boardRepo.update);
const mockDeleteUpload = vi.mocked(deleteUploadedBoardBackground);

const boardPublicId = "board1234567";
const ctx = {
  db: {} as never,
  user: { id: "user-1", name: "Test", email: "test@example.com" },
} as never;

const getCaller = async () => {
  const { boardRouter } = await import("./board");
  return boardRouter.createCaller(ctx);
};

describe("board.update background", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBoard.mockResolvedValue({
      id: 1,
      workspaceId: 2,
      createdBy: "user-1",
      backgroundImage: "board-backgrounds/board1234567/old.png",
    });
    mockUpdate.mockResolvedValue({ publicId: boardPublicId, name: "Board" });
  });

  it("clears the image and removes the old upload when a colour is picked", async () => {
    const caller = await getCaller();
    await caller.update({ boardPublicId, backgroundColour: "gradient-ocean" });

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        backgroundColour: "gradient-ocean",
        backgroundImage: null,
      }),
    );
    expect(mockDeleteUpload).toHaveBeenCalledWith(
      "board-backgrounds/board1234567/old.png",
    );
  });

  it("clears the colour when a bundled photo is picked", async () => {
    const caller = await getCaller();
    await caller.update({
      boardPublicId,
      backgroundImage: "/backgrounds/mountains.svg",
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        backgroundColour: null,
        backgroundImage: "/backgrounds/mountains.svg",
      }),
    );
  });

  it("removes both when the background is reset", async () => {
    const caller = await getCaller();
    await caller.update({ boardPublicId, backgroundColour: null });

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ backgroundColour: null, backgroundImage: null }),
    );
  });

  it("leaves the background alone for unrelated updates", async () => {
    const caller = await getCaller();
    await caller.update({ boardPublicId, name: "Renamed" });

    const [, args] = mockUpdate.mock.calls[0] ?? [];
    expect(args).not.toHaveProperty("backgroundColour");
    expect(args).not.toHaveProperty("backgroundImage");
    expect(mockDeleteUpload).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown colour", { backgroundColour: "red" }],
    ["an http image", { backgroundImage: "http://example.com/a.png" }],
    ["a storage key", { backgroundImage: "board-backgrounds/other/x.png" }],
    ["arbitrary CSS", { backgroundColour: "url(javascript:alert(1))" }],
  ])("rejects %s", async (_label, input) => {
    const caller = await getCaller();
    await expect(
      caller.update({ boardPublicId, ...(input as object) }),
    ).rejects.toThrow(TRPCError);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
