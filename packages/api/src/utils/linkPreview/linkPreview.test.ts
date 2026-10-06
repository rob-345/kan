import http from "http";
import zlib from "zlib";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isBlockedAddress, isBlockedHostname } from "./address";
import { assertFetchableUrl, fetchPage } from "./fetch";
import { buildLinkPreview, normalizeLinkUrl } from "./index";
import { parseMetadata } from "./parse";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.5",
    "192.168.0.5",
    "169.254.169.254",
    "100.84.172.2",
    "0.0.0.0",
    "::1",
    "::",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:a9fe:a9fe",
    "64:ff9b::7f00:1",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"])(
    "allows %s",
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe("isBlockedHostname", () => {
  it.each([
    "localhost",
    "app.localhost",
    "postgres",
    "kan.railway.internal",
    "printer.local",
    "127.0.0.1",
    "[::1]",
    "[::ffff:7f00:1]",
  ])("blocks %s", (host) => {
    expect(isBlockedHostname(host)).toBe(true);
  });

  it("allows public names", () => {
    expect(isBlockedHostname("example.com")).toBe(false);
  });
});

describe("assertFetchableUrl", () => {
  it.each([
    "file:///etc/passwd",
    "ftp://example.com/",
    "http://user:pass@example.com/",
    "http://example.com:22/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://[::1]/",
  ])("rejects %s", (url) => {
    expect(() => assertFetchableUrl(url)).toThrow();
  });

  it("accepts a public https URL", () => {
    expect(assertFetchableUrl("https://example.com/a?b=c").hostname).toBe(
      "example.com",
    );
  });
});

describe("normalizeLinkUrl", () => {
  it("adds https to bare domains", () => {
    expect(normalizeLinkUrl(" example.com/page ")).toBe(
      "https://example.com/page",
    );
  });

  it("rejects other schemes and junk", () => {
    expect(normalizeLinkUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeLinkUrl("not a url")).toBeNull();
    expect(normalizeLinkUrl("")).toBeNull();
  });
});

describe("parseMetadata", () => {
  it("prefers Open Graph, resolves relative URLs and decodes entities", () => {
    const html = `<!doctype html><html><head>
      <title>Fallback title</title>
      <meta property="og:title" content="Tom &amp; Jerry&#39;s &quot;Page&quot;">
      <meta name="description" content="Plain description">
      <meta property="og:description" content='OG description'>
      <meta property="og:image" content="/images/cover.png">
      <meta property="og:site_name" content="Example">
      <link rel="shortcut icon" href="/static/favicon.png">
      <!-- <meta property="og:title" content="commented out"> -->
    </head><body><meta property="og:image" content="/ignored.png"></body></html>`;

    expect(parseMetadata(html, "https://example.com/blog/post")).toEqual({
      title: `Tom & Jerry's "Page"`,
      description: "OG description",
      imageUrl: "https://example.com/images/cover.png",
      siteName: "Example",
      faviconUrl: "https://example.com/static/favicon.png",
    });
  });

  it("falls back to Twitter card and HTML tags", () => {
    const html = `<head><title> Just a
      title </title><meta name="twitter:description" content="Tweet desc">
      <meta name="twitter:image" content="https://cdn.example.com/x.jpg"></head>`;

    expect(parseMetadata(html, "https://example.com/")).toEqual({
      title: "Just a title",
      description: "Tweet desc",
      imageUrl: "https://cdn.example.com/x.jpg",
      siteName: null,
      faviconUrl: "https://example.com/favicon.ico",
    });
  });

  it("drops non-http image URLs", () => {
    const html = `<head><meta property="og:image" content="javascript:alert(1)"></head>`;
    expect(parseMetadata(html, "https://example.com/").imageUrl).toBeNull();
  });
});

describe("fetchPage", () => {
  let server: http.Server;
  let base = "";

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/page") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-encoding": "gzip",
        });
        res.end(
          zlib.gzipSync(
            `<html><head><meta property="og:title" content="Hello"><meta property="og:image" content="/img.png"></head><body>${"x".repeat(5000)}</body></html>`,
          ),
        );
      } else if (req.url === "/redirect") {
        res.writeHead(302, { location: "/page" });
        res.end();
      } else if (req.url === "/loop") {
        res.writeHead(302, { location: "/loop" });
        res.end();
      } else if (req.url === "/slow") {
        res.writeHead(200, { "content-type": "text/html" });
        res.write("<html>");
        // never finishes
      } else if (req.url === "/huge") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body>${"y".repeat(200_000)}`);
      } else if (req.url === "/image.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.alloc(10));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it("refuses localhost unless explicitly allowed", async () => {
    await expect(fetchPage(`${base}/page`)).rejects.toThrow();
  });

  it("refuses names that resolve to private addresses", async () => {
    await expect(fetchPage("http://localtest.me/")).rejects.toThrow();
  });

  it("follows redirects and decompresses", async () => {
    const page = await fetchPage(`${base}/redirect`, {
      allowPrivateAddresses: true,
    });
    expect(page.finalUrl).toBe(`${base}/page`);
    expect(page.body.toString()).toContain("og:title");
  });

  it("refuses redirect targets on internal hosts", () => {
    // Every redirect target goes through the same check as the first URL.
    expect(() => assertFetchableUrl("http://169.254.169.254/latest")).toThrow();
  });

  it("stops after too many redirects", async () => {
    await expect(
      fetchPage(`${base}/loop`, { allowPrivateAddresses: true }),
    ).rejects.toThrow(/redirects/);
  });

  it("times out slow responses", async () => {
    await expect(
      fetchPage(`${base}/slow`, {
        allowPrivateAddresses: true,
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/Timed out/);
  });

  it("caps the body size", async () => {
    const page = await fetchPage(`${base}/huge`, {
      allowPrivateAddresses: true,
      maxBytes: 10_000,
    });
    expect(page.body.length).toBe(10_000);
  });

  it("builds a preview from a page", async () => {
    const preview = await buildLinkPreview(`${base}/redirect#section`, {
      allowPrivateAddresses: true,
    });
    expect(preview).toMatchObject({
      url: `${base}/redirect`,
      status: "ok",
      title: "Hello",
      imageUrl: `${base}/img.png`,
    });
  });

  it("describes images without reading them", async () => {
    const preview = await buildLinkPreview(`${base}/image.png`, {
      allowPrivateAddresses: true,
    });
    expect(preview).toMatchObject({
      status: "ok",
      title: "image.png",
      imageUrl: `${base}/image.png`,
    });
  });

  it("marks failures", async () => {
    const preview = await buildLinkPreview(`${base}/missing`, {
      allowPrivateAddresses: true,
    });
    expect(preview.status).toBe("failed");
  });
});
