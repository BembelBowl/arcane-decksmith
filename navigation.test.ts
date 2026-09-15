import { describe, expect, it } from "vitest";
import {
  appPageFromHash,
  appPageHref
} from "./navigation";

describe("app navigation", () => {
  it("maps every top-level page to a stable GitHub-Pages-safe hash URL", () => {
    expect(appPageHref("home")).toBe("#/");
    expect(appPageHref("collection")).toBe("#/collection");
    expect(appPageHref("search")).toBe("#/search");
    expect(appPageHref("builder")).toBe("#/build");
    expect(appPageHref("decks")).toBe("#/decks");
  });

  it("parses supported routes", () => {
    expect(appPageFromHash("#/collection")).toBe("collection");
    expect(appPageFromHash("#/search")).toBe("search");
    expect(appPageFromHash("#/build")).toBe("builder");
    expect(appPageFromHash("#/decks")).toBe("decks");
  });

  it("keeps old and empty home URLs compatible", () => {
    expect(appPageFromHash("")).toBe("home");
    expect(appPageFromHash("#/home")).toBe("home");
  });

  it("rejects unknown routes so the app can fall back to start", () => {
    expect(appPageFromHash("#/unknown")).toBeNull();
  });
});
