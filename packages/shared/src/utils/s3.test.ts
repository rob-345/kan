import { afterEach, describe, expect, it } from "vitest";

import { createS3Client, generateBoardBackgroundUrl } from "./s3";

const originalS3Region = process.env.S3_REGION;

afterEach(() => {
  if (originalS3Region === undefined) {
    delete process.env.S3_REGION;
  } else {
    process.env.S3_REGION = originalS3Region;
  }
});

describe("createS3Client", () => {
  it("defaults to us-east-1 when S3_REGION is unset", async () => {
    delete process.env.S3_REGION;

    const client = createS3Client();

    await expect(client.config.region()).resolves.toBe("us-east-1");
    client.destroy();
  });

  it("defaults to us-east-1 when S3_REGION is empty", async () => {
    process.env.S3_REGION = "";

    const client = createS3Client();

    await expect(client.config.region()).resolves.toBe("us-east-1");
    client.destroy();
  });

  it("uses S3_REGION when it is configured", async () => {
    process.env.S3_REGION = "eu-west-1";

    const client = createS3Client();

    await expect(client.config.region()).resolves.toBe("eu-west-1");
    client.destroy();
  });
});

describe("generateBoardBackgroundUrl", () => {
  it("returns bundled presets and https links unchanged", async () => {
    await expect(
      generateBoardBackgroundUrl("/backgrounds/waves.svg"),
    ).resolves.toBe("/backgrounds/waves.svg");
    await expect(
      generateBoardBackgroundUrl("https://example.com/a.jpg"),
    ).resolves.toBe("https://example.com/a.jpg");
  });

  it("returns null without a background or storage bucket", async () => {
    await expect(generateBoardBackgroundUrl(null)).resolves.toBeNull();
    const originalBucket = process.env.NEXT_PUBLIC_ATTACHMENTS_BUCKET_NAME;
    delete process.env.NEXT_PUBLIC_ATTACHMENTS_BUCKET_NAME;
    await expect(
      generateBoardBackgroundUrl("board-backgrounds/abc/x.png"),
    ).resolves.toBeNull();
    if (originalBucket !== undefined)
      process.env.NEXT_PUBLIC_ATTACHMENTS_BUCKET_NAME = originalBucket;
  });
});
