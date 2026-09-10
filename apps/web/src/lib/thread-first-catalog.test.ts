import { resolve } from "node:path";
import { createCompiledCatalog, getCatalogs } from "@lingui/cli/api";
import { getConfig } from "@lingui/conf";
import { setupI18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";

const webRoot = resolve(import.meta.dirname, "../..");
const config = getConfig({ cwd: webRoot });
// Lingui resolves relative include paths against process.cwd(), while Vitest
// runs from the monorepo root. Keep extraction independent of runner cwd.
config.catalogs = config.catalogs.map((entry) => ({
  ...entry,
  include: entry.include.map((file) => resolve(webRoot, file)),
  exclude: entry.exclude ?? [],
}));
const featureFiles = ["src/pages/Shell.tsx", "src/pages/shell/SlackWorkspace.tsx"];
// Includes failure paths, status chrome, accessible names and narrow/mobile navigation.
const featureMessages = [
  "Start a conversation",
  "Reply in thread",
  "Start the conversation.",
  "No agents yet",
  "Back to original message",
  "Message sent. History refresh failed; retry to reconcile.",
  "This failed root has no text to retry",
  "Retry details are unavailable for this failed root",
  "Failed to stop",
  "Run failed",
  "Working",
  "Waiting for your input",
  "Waiting for takeover",
  "Queued",
  "Failed",
  "Completed",
  "Stopped",
  "Mixed activity",
  "No run yet",
  "Agents",
  "No agent run",
  "Stop this root",
  "Retry in thread",
  "Back to channel",
  "Back to direct message",
  "Stop root {0}",
  "Retry root {0}",
  "Failure: {failure}",
  "{replyCount, plural, one {# reply} other {# replies}}",
];
let catalog: Awaited<ReturnType<typeof getCatalogs>>[number];
let extracted: import("@lingui/cli/api").ExtractedCatalogType;

beforeAll(async () => {
  const [firstCatalog] = await getCatalogs(config);
  if (!firstCatalog) throw new Error("Web catalog missing");
  catalog = firstCatalog;
  const messages = await catalog.collect({
    files: featureFiles.map((file) => resolve(webRoot, file)),
  });
  if (!messages) throw new Error("Thread-first extraction failed");
  extracted = messages;
});

describe("thread-first production catalogs", () => {
  it("extracts the whole new UI surface, not just the composer placeholder", () => {
    const messages = Object.values(extracted).map((entry) => entry.message);
    for (const message of featureMessages) expect(messages, message).toContain(message);
  });

  for (const locale of config.locales) {
    it(`resolves every Shell/Slack macro by ID in compiled ${locale}`, async () => {
      const { messages } = await catalog.getTranslations(locale, {
        sourceLocale: config.sourceLocale,
        fallbackLocales: config.fallbackLocales,
      });
      const compiled = createCompiledCatalog(locale, messages, { namespace: "json" });
      expect(compiled.errors).toEqual([]);
      const runtime = setupI18n({
        locale,
        messages: { [locale]: JSON.parse(compiled.source).messages },
      });
      // Production macros omit message/context. Never pass source text here: that
      // would hide a stale catalog, as the former source-fallback tests did.
      const missing: string[] = [];
      runtime.on("missing", ({ id }) => missing.push(id));
      for (const [id, entry] of Object.entries(extracted)) {
        const values = Object.fromEntries(
          Object.keys(entry.placeholders ?? {}).map((key) => [key, 2]),
        );
        const result = runtime._({
          id,
          values: { ...values, 0: 2, replyCount: 2, failure: "fixture failure" },
        });
        expect(result, `${locale}: ${entry.message} (${id})`).not.toBe(id);
        expect(result, `${locale}: ${entry.message}`).not.toBe("");
      }
      expect(missing).toEqual([]);
    });
  }
});
