import { useCallback, useEffect, useState } from "react";

export type AppPage =
  | "home"
  | "collection"
  | "search"
  | "builder"
  | "decks";

export const APP_PAGE_HASHES: Record<AppPage, string> = {
  home: "#/",
  collection: "#/collection",
  search: "#/search",
  builder: "#/build",
  decks: "#/decks"
};

export const APP_NAV_ITEMS: Array<{
  page: AppPage;
  label: string;
}> = [
  { page: "home", label: "Start" },
  { page: "collection", label: "Sammlung" },
  { page: "search", label: "Kartensuche" },
  { page: "builder", label: "Deck bauen" },
  { page: "decks", label: "Decks" }
];

const PAGE_TITLES: Record<AppPage, string> = {
  home: "Arcane Decksmith",
  collection: "Sammlung · Arcane Decksmith",
  search: "Kartensuche · Arcane Decksmith",
  builder: "Deck bauen · Arcane Decksmith",
  decks: "Decks · Arcane Decksmith"
};

export function appPageHref(page: AppPage): string {
  return APP_PAGE_HASHES[page];
}

export function appPageFromHash(hash: string): AppPage | null {
  const normalized = hash.trim().toLowerCase();

  if (
    normalized === "" ||
    normalized === "#" ||
    normalized === "#/" ||
    normalized === "#/home"
  ) {
    return "home";
  }

  const entry = Object.entries(APP_PAGE_HASHES).find(
    ([, value]) => value.toLowerCase() === normalized
  );

  return entry ? (entry[0] as AppPage) : null;
}

function currentPage(): AppPage {
  if (typeof window === "undefined") {
    return "home";
  }

  return appPageFromHash(window.location.hash) ?? "home";
}

export function useAppNavigation(): {
  page: AppPage;
  navigate: (page: AppPage) => void;
} {
  const [page, setPage] = useState<AppPage>(currentPage);

  useEffect(() => {
    const syncFromLocation = () => {
      const rawHash = window.location.hash.trim().toLowerCase();
      const parsed = appPageFromHash(rawHash);

      if (!parsed) {
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}${APP_PAGE_HASHES.home}`
        );
        setPage("home");
        return;
      }

      if (
        parsed === "home" &&
        rawHash !== APP_PAGE_HASHES.home
      ) {
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}${APP_PAGE_HASHES.home}`
        );
      }

      setPage(parsed);
      window.scrollTo({ top: 0, left: 0 });
    };

    syncFromLocation();
    window.addEventListener("hashchange", syncFromLocation);

    return () => {
      window.removeEventListener("hashchange", syncFromLocation);
    };
  }, []);

  useEffect(() => {
    document.title = PAGE_TITLES[page];
  }, [page]);

  const navigate = useCallback((nextPage: AppPage) => {
    const nextHash = APP_PAGE_HASHES[nextPage];

    if (window.location.hash === nextHash) {
      setPage(nextPage);
      return;
    }

    window.location.hash = nextHash;
  }, []);

  return {
    page,
    navigate
  };
}
