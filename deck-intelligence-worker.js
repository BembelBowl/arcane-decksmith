/**
 * Arcane Decksmith – deck intelligence proxy for Cloudflare Workers.
 *
 * Secrets / variables:
 *   TOPDECK_API_KEY              required for TopDeck.gg data
 *   ALLOWED_ORIGINS              optional comma-separated origins
 *   TOPDECK_LOOKBACK_DAYS        optional, default 120
 *   TOPDECK_MIN_PARTICIPANTS     optional, default 12
 *   ARCHIDEKT_SAMPLE_DECKS       optional, default 6 (max 8)
 *
 * TopDeck.gg requires visible attribution in the consuming application.
 * Commander Spellbook asks clients to identify themselves and make sparse
 * requests. EDHREC's JSON endpoints and Archidekt's read endpoints are not
 * guaranteed stable APIs, so both are aggressively cached and optional.
 */

const TOPDECK_URL =
  "https://topdeck.gg/api/v2/tournaments";
const SPELLBOOK_BASE =
  "https://backend.commanderspellbook.com";
const EDHREC_BASE =
  "https://json.edhrec.com/pages/commanders";
const ARCHIDEKT_BASE =
  "https://archidekt.com/api";
const USER_AGENT =
  "Arcane Decksmith/1.0 (deck intelligence; contact via project owner)";

const SOURCE_TIMEOUT_MS = 9000;
const CACHE_SECONDS = 6 * 60 * 60;
const EDHREC_CACHE_SECONDS = 24 * 60 * 60;
const ARCHIDEKT_CACHE_SECONDS = 12 * 60 * 60;
const MAX_CANDIDATES = 5000;
const MAX_DECK_CARDS = 200;
const MAX_COMBOS = 12;

function jsonResponse(data, status = 200, origin = "*") {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Vary": "Origin",
        "Cache-Control": "no-store"
      }
    }
  );
}

function allowedOrigin(request, env) {
  const origin =
    request.headers.get("Origin") || "";
  const configured =
    String(env.ALLOWED_ORIGINS || "")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean);

  if (configured.length === 0) {
    return origin || "*";
  }

  if (configured.includes(origin)) {
    return origin;
  }

  return null;
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function cleanCardName(value) {
  return String(value || "")
    .replace(/^\s*\d+\s*[x×]?\s+/i, "")
    .replace(/\s+[x×]\s*\d+\s*$/i, "")
    .replace(/\s+\([A-Z0-9]{2,8}\)\s+\d+[A-Za-z★]*\s*$/i, "")
    .replace(/\s+\[[^\]]+\]\s*$/i, "")
    .trim();
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? number
    : undefined;
}

function clamp(value, min, max) {
  return Math.min(
    max,
    Math.max(min, value)
  );
}

function uniqueStrings(values, limit) {
  const seen = new Map();

  for (const value of values || []) {
    const cleaned = cleanCardName(value);
    const key = normalizeName(cleaned);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.set(key, cleaned);

    if (seen.size >= limit) {
      break;
    }
  }

  return [...seen.values()];
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SOURCE_TIMEOUT_MS
  );

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function cacheKeyForTopDeck(format, lookback, minParticipants) {
  return new Request(
    `https://arcane-decksmith-cache.invalid/topdeck/${encodeURIComponent(format)}?last=${lookback}&min=${minParticipants}`,
    { method: "GET" }
  );
}

async function loadTopDeckTournaments(format, env) {
  if (!env.TOPDECK_API_KEY) {
    return null;
  }

  const topDeckFormat =
    format === "standard"
      ? "Standard"
      : "EDH";

  const lookback =
    clamp(
      Number(env.TOPDECK_LOOKBACK_DAYS) || 120,
      14,
      365
    );

  const minParticipants =
    clamp(
      Number(env.TOPDECK_MIN_PARTICIPANTS) || 12,
      4,
      128
    );

  const key = cacheKeyForTopDeck(
    topDeckFormat,
    lookback,
    minParticipants
  );

  const cache = caches.default;
  const cached = await cache.match(key);

  if (cached) {
    return cached.json();
  }

  const response = await fetchWithTimeout(
    TOPDECK_URL,
    {
      method: "POST",
      headers: {
        Authorization:
          String(env.TOPDECK_API_KEY),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        game: "Magic: The Gathering",
        format: topDeckFormat,
        last: lookback,
        participantMin: minParticipants,
        columns: [
          "name",
          "decklist",
          "wins",
          "draws",
          "losses",
          "winRate"
        ],
        rounds: false
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      `TopDeck.gg ${response.status}`
    );
  }

  const data = await response.json();

  const cacheResponse = new Response(
    JSON.stringify(data),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${CACHE_SECONDS}`
      }
    }
  );

  await cache.put(
    key,
    cacheResponse
  );

  return data;
}

function cardMapFromSection(section) {
  const result = new Map();

  if (!section) {
    return result;
  }

  if (Array.isArray(section)) {
    for (const item of section) {
      if (typeof item === "string") {
        const name = cleanCardName(item);
        if (name) result.set(normalizeName(name), name);
        continue;
      }

      if (item && typeof item === "object") {
        const name = cleanCardName(
          item.name || item.card || item.cardName || ""
        );
        if (name) result.set(normalizeName(name), name);
      }
    }

    return result;
  }

  if (typeof section !== "object") {
    return result;
  }

  for (const [key, value] of Object.entries(section)) {
    const keyName = cleanCardName(key);

    if (
      keyName &&
      (
        typeof value === "number" ||
        typeof value === "string" ||
        value === null ||
        (value && typeof value === "object" && (
          "quantity" in value ||
          "count" in value ||
          "qty" in value
        ))
      )
    ) {
      result.set(
        normalizeName(keyName),
        keyName
      );
      continue;
    }

    if (value && typeof value === "object") {
      for (const [nestedKey, nestedName] of cardMapFromSection(value)) {
        result.set(nestedKey, nestedName);
      }
    }
  }

  return result;
}

function parseDeckObject(deckObj) {
  const cards = new Map();
  const commanders = new Map();

  if (!deckObj || typeof deckObj !== "object") {
    return { cards, commanders };
  }

  for (const [sectionName, section] of Object.entries(deckObj)) {
    const lower = sectionName.toLowerCase();
    const sectionCards = cardMapFromSection(section);

    if (/commander|leader/.test(lower)) {
      for (const [key, name] of sectionCards) {
        commanders.set(key, name);
        cards.set(key, name);
      }
      continue;
    }

    if (
      /main|deck|card|sideboard|companion/.test(lower)
    ) {
      for (const [key, name] of sectionCards) {
        cards.set(key, name);
      }
    }
  }

  // Some TopDeck payloads are already a card map without sections.
  if (cards.size === 0) {
    for (const [key, name] of cardMapFromSection(deckObj)) {
      cards.set(key, name);
    }
  }

  return { cards, commanders };
}

function parseDeckText(text) {
  const cards = new Map();
  const commanders = new Map();

  if (
    typeof text !== "string" ||
    /^https?:\/\//i.test(text.trim())
  ) {
    return { cards, commanders };
  }

  let section = "main";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line) continue;

    const heading = line
      .replace(/^[~#/*\-\s]+|[~#/*\-\s]+$/g, "")
      .toLowerCase();

    if (/commanders?|leaders?/.test(heading) && !/^\d/.test(line)) {
      section = "commander";
      continue;
    }

    if (/main(board)?|deck/.test(heading) && !/^\d/.test(line)) {
      section = "main";
      continue;
    }

    if (/sideboard|maybeboard/.test(heading) && !/^\d/.test(line)) {
      section = "side";
      continue;
    }

    if (section === "side") {
      continue;
    }

    const name = cleanCardName(line);

    if (!name || name.length < 2) {
      continue;
    }

    const key = normalizeName(name);
    cards.set(key, name);

    if (section === "commander") {
      commanders.set(key, name);
    }
  }

  return { cards, commanders };
}

function parseStandingDeck(standing) {
  const fromObject = parseDeckObject(
    standing?.deckObj
  );

  if (fromObject.cards.size > 0) {
    return fromObject;
  }

  return parseDeckText(
    standing?.decklist
  );
}

function standingResult(standing) {
  const wins =
    Math.max(0, finiteNumber(standing?.wins) || 0);
  const draws =
    Math.max(0, finiteNumber(standing?.draws) || 0);
  const losses =
    Math.max(0, finiteNumber(standing?.losses) || 0);
  const games = wins + draws + losses;

  if (games > 0) {
    return {
      games,
      points: wins + draws * 0.5,
      rate: (wins + draws * 0.5) / games
    };
  }

  const winRate =
    finiteNumber(standing?.winRate);

  if (winRate !== undefined) {
    return {
      games: 4,
      points: clamp(winRate, 0, 1) * 4,
      rate: clamp(winRate, 0, 1)
    };
  }

  return null;
}

function performanceSignal(stats, baseline, format, priorGames = 10) {
  if (!stats || stats.games <= 0 || stats.decks <= 0) {
    return 0;
  }

  const smoothed =
    (stats.points + baseline * priorGames) /
    (stats.games + priorGames);

  const scale =
    format === "standard"
      ? 0.09
      : 0.075;

  const confidence = Math.min(
    1,
    Math.sqrt(stats.decks / 8) *
      Math.sqrt(stats.games / 32)
  );

  return clamp(
    Math.tanh((smoothed - baseline) / scale) * confidence,
    -1,
    1
  );
}

function analyzeTopDeck(data, format, targetNames, commanderNames) {
  const tournaments = Array.isArray(data)
    ? data
    : Array.isArray(data?.data)
      ? data.data
      : [];

  const targetMap = new Map(
    targetNames.map(name => [normalizeName(name), name])
  );
  const commanderSet = new Set(
    commanderNames.map(normalizeName)
  );

  const decks = [];
  let totalPoints = 0;
  let totalGames = 0;

  for (const tournament of tournaments) {
    const standings = Array.isArray(tournament?.standings)
      ? tournament.standings
      : [];

    for (const standing of standings) {
      const result = standingResult(standing);
      if (!result) continue;

      const parsed = parseStandingDeck(standing);
      if (parsed.cards.size === 0) continue;

      const commanderMatch =
        commanderSet.size > 0 &&
        [...commanderSet].every(key => parsed.commanders.has(key));

      decks.push({
        result,
        cards: parsed.cards,
        commanderMatch
      });

      totalPoints += result.points;
      totalGames += result.games;
    }
  }

  if (decks.length === 0 || totalGames === 0) {
    return {
      available: false,
      cards: [],
      cardSignals: {},
      sampleDecks: 0,
      sampleGames: 0
    };
  }

  const baseline = totalPoints / totalGames;
  const generic = new Map();
  const commanderSpecific = new Map();

  const addStats = (map, key, result) => {
    const current = map.get(key) || {
      decks: 0,
      games: 0,
      points: 0
    };
    current.decks += 1;
    current.games += result.games;
    current.points += result.points;
    map.set(key, current);
  };

  for (const deck of decks) {
    for (const key of deck.cards.keys()) {
      if (!targetMap.has(key)) continue;
      addStats(generic, key, deck.result);

      if (deck.commanderMatch) {
        addStats(commanderSpecific, key, deck.result);
      }
    }
  }

  const cards = [];
  const cardSignals = {};

  for (const [key, displayName] of targetMap) {
    const stats = generic.get(key);
    if (!stats) continue;

    const performance =
      performanceSignal(
        stats,
        baseline,
        format,
        10
      );

    const commanderStats =
      commanderSpecific.get(key);

    const commanderPerformance =
      commanderStats &&
      commanderStats.decks >= 2 &&
      commanderStats.games >= 6
        ? performanceSignal(
            commanderStats,
            baseline,
            format,
            7
          )
        : undefined;

    const smoothedWinRate =
      (stats.points + baseline * 10) /
      (stats.games + 10);

    cards.push({
      name: displayName,
      winRate: smoothedWinRate,
      baselineWinRate: baseline,
      sampleDecks: stats.decks,
      sampleGames: stats.games,
      performance,
      commanderPerformance
    });

    cardSignals[key] = {
      performance,
      commanderPerformance,
      sampleDecks: stats.decks,
      sampleGames: stats.games
    };
  }

  cards.sort((a, b) =>
    Math.max(
      b.commanderPerformance ?? -2,
      b.performance ?? -2
    ) -
    Math.max(
      a.commanderPerformance ?? -2,
      a.performance ?? -2
    )
  );

  return {
    available: true,
    format: format === "standard" ? "Standard" : "EDH",
    baselineWinRate: baseline,
    sampleDecks: decks.length,
    sampleGames: totalGames,
    cards,
    cardSignals
  };
}

function spellbookBody(commanders, deckCards) {
  const counts = new Map();

  for (const card of deckCards) {
    const key = normalizeName(card);
    const current = counts.get(key) || {
      card,
      quantity: 0
    };
    current.quantity += 1;
    counts.set(key, current);
  }

  return {
    commanders: commanders.map(card => ({
      card,
      quantity: 1
    })),
    main: [...counts.values()]
  };
}

async function spellbookPost(path, body) {
  const response = await fetchWithTimeout(
    `${SPELLBOOK_BASE}${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT
      },
      body: JSON.stringify(body)
    }
  );

  if (!response.ok) {
    throw new Error(
      `Commander Spellbook ${response.status}`
    );
  }

  return response.json();
}

function variantCards(variant) {
  const names = [];

  for (const use of variant?.uses || []) {
    const name = cleanCardName(
      use?.card?.name || ""
    );
    if (name) names.push(name);
  }

  return uniqueStrings(names, 12);
}

function variantResults(variant) {
  const results = [];

  for (const produced of variant?.produces || []) {
    const name = String(
      produced?.feature?.name || ""
    ).trim();
    if (name) results.push(name);
  }

  return uniqueStrings(results, 12);
}

function comboScore(variant, missingCount) {
  // Spellbook bracketTag values are intentionally not mapped to power here.
  // Their public API exposes the tag, but consumers should not guess semantic
  // ordering. Score only facts we can interpret reliably: a curated combo,
  // its produced result, popularity, and whether a piece is missing.
  const results = variantResults(variant)
    .join(" ")
    .toLowerCase();

  const winning =
    /win the game|infinite damage|infinite lifeloss|infinite life loss|infinite mill|infinite combat|infinite turns/.test(results);
  const usefulInfinite =
    /infinite|near-infinite/.test(results);
  const popularity =
    Math.max(0, finiteNumber(variant?.popularity) || 0);
  const popularityBoost =
    Math.min(0.1, Math.log10(popularity + 1) / 45);

  const resultBoost =
    winning
      ? 0.28
      : usefulInfinite
        ? 0.16
        : 0.06;

  const missingPenalty =
    missingCount === 0
      ? 1
      : missingCount === 1
        ? 0.9
        : 0.5;

  return clamp(
    (0.56 + resultBoost + popularityBoost) * missingPenalty,
    0,
    1
  );
}

function summarizeVariant(variant, deckSet) {
  const cards = variantCards(variant);
  const missingCards = cards.filter(
    card => !deckSet.has(normalizeName(card))
  );

  return {
    id: String(variant?.id || "unknown"),
    cards,
    missingCards,
    results: variantResults(variant),
    popularity: finiteNumber(variant?.popularity),
    bracketTag: variant?.bracketTag
      ? String(variant.bracketTag)
      : undefined,
    score: comboScore(variant, missingCards.length)
  };
}

function spellbookVariantArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (Array.isArray(value?.results)) {
    return value.results;
  }

  if (Array.isArray(value?.variants)) {
    return value.variants;
  }

  return [];
}

function extractSpellbookLists(data) {
  const root =
    data?.results &&
    !Array.isArray(data.results) &&
    (
      data.results.included ||
      data.results.almostIncluded ||
      data.results.almost_included
    )
      ? data.results
      : data;

  return {
    included: spellbookVariantArray(
      root?.included
    ),
    almost: spellbookVariantArray(
      root?.almostIncluded ??
      root?.almost_included
    )
  };
}

function bracketTagFromEstimate(data) {
  const tag =
    data?.bracketTag ??
    data?.bracket_tag ??
    data?.bracket?.tag;

  return typeof tag === "string"
    ? tag
    : undefined;
}

async function analyzeSpellbook(commanders, deckCards, candidateNames) {
  const body = spellbookBody(
    commanders,
    deckCards
  );

  const [comboData, bracketData] = await Promise.all([
    spellbookPost(
      "/find-my-combos",
      body
    ),
    spellbookPost(
      "/estimate-bracket",
      body
    ).catch(() => null)
  ]);

  const deckSet = new Set(
    deckCards.map(normalizeName)
  );
  const candidateSet = new Set(
    candidateNames.map(normalizeName)
  );

  const lists = extractSpellbookLists(comboData);
  const includedCombos = lists.included
    .map(variant => summarizeVariant(variant, deckSet))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, MAX_COMBOS);

  const almostCombos = lists.almost
    .map(variant => summarizeVariant(variant, deckSet))
    .filter(combo => combo.missingCards.length > 0)
    .sort((a, b) => {
      const aOwned = a.missingCards.every(card => candidateSet.has(normalizeName(card))) ? 1 : 0;
      const bOwned = b.missingCards.every(card => candidateSet.has(normalizeName(card))) ? 1 : 0;
      return bOwned - aOwned || (b.score || 0) - (a.score || 0);
    })
    .slice(0, MAX_COMBOS);

  const comboSignals = {};
  const setCombo = (name, score) => {
    const key = normalizeName(name);
    if (!key) return;
    comboSignals[key] = Math.max(
      comboSignals[key] || 0,
      clamp(score, 0, 1)
    );
  };

  for (const combo of includedCombos) {
    for (const card of combo.cards) {
      setCombo(card, 0.55 + (combo.score || 0) * 0.35);
    }
  }

  for (const combo of almostCombos) {
    const exactMissing = combo.missingCards.filter(
      card => candidateSet.has(normalizeName(card))
    );

    if (exactMissing.length === 1 && combo.missingCards.length === 1) {
      setCombo(
        exactMissing[0],
        0.58 + (combo.score || 0) * 0.42
      );

      for (const existing of combo.cards.filter(card => !combo.missingCards.includes(card))) {
        setCombo(
          existing,
          0.35 + (combo.score || 0) * 0.25
        );
      }
    }
  }

  return {
    available: true,
    bracketTag: bracketTagFromEstimate(bracketData),
    includedCombos,
    almostCombos,
    comboSignals
  };
}


function slugifyEdhrec(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/\/\/.+$/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function commanderSlugCandidates(commanders) {
  const slugs = commanders
    .map(slugifyEdhrec)
    .filter(Boolean);

  if (slugs.length <= 1) {
    return slugs;
  }

  const direct = slugs.join("-");
  const reverse = [...slugs].reverse().join("-");
  return direct === reverse
    ? [direct]
    : [direct, reverse];
}

function cacheRequest(namespace, key) {
  return new Request(
    `https://arcane-decksmith-cache.invalid/${namespace}/${encodeURIComponent(key)}`,
    { method: "GET" }
  );
}

async function fetchCachedJson(url, cacheKey, ttlSeconds, headers = {}) {
  const cache = caches.default;
  const key = cacheRequest("source", cacheKey);
  const cached = await cache.match(key);

  if (cached) {
    return cached.json();
  }

  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...headers
    }
  });

  if (!response.ok) {
    throw new Error(`${url} ${response.status}`);
  }

  const data = await response.json();
  await cache.put(
    key,
    new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${ttlSeconds}`
      }
    })
  );

  return data;
}

function edhrecJsonDict(data) {
  return data?.container?.json_dict || data?.json_dict || data || {};
}

function edhrecManaValue(data) {
  const candidates = [
    data?.panels?.mana_curve,
    edhrecJsonDict(data)?.panels?.mana_curve,
    data?.container?.json_dict?.panels?.mana_curve
  ];

  for (const curve of candidates) {
    if (!curve || typeof curve !== "object" || Array.isArray(curve)) {
      continue;
    }

    let total = 0;
    let weighted = 0;

    for (const [rawMv, rawCount] of Object.entries(curve)) {
      const mv = Number(rawMv.replace(/\+$/, ""));
      const count = Number(rawCount);
      if (!Number.isFinite(mv) || !Number.isFinite(count) || count <= 0) continue;
      total += count;
      weighted += mv * count;
    }

    if (total > 0) {
      return weighted / total;
    }
  }

  return undefined;
}

function normalizedPercent(value) {
  const number = finiteNumber(value);
  if (number === undefined) {
    return undefined;
  }

  if (number > 1.0001) {
    return clamp(number / 100, 0, 1);
  }

  return clamp(number, 0, 1);
}

function analyzeEdhrec(data, commander, targetNames) {
  const json = edhrecJsonDict(data);
  const targetMap = new Map(
    targetNames.map(name => [normalizeName(name), name])
  );
  const cardLists = Array.isArray(json?.cardlists)
    ? json.cardlists
    : [];
  const best = new Map();
  let largestPotentialDecks = 0;

  for (const list of cardLists) {
    const category = String(list?.tag || list?.header || "").trim();
    const views = Array.isArray(list?.cardviews) ? list.cardviews : [];

    for (const view of views) {
      const name = cleanCardName(view?.name || "");
      const key = normalizeName(name);
      if (!targetMap.has(key)) continue;

      let synergy = finiteNumber(view?.synergy);
      if (synergy !== undefined && Math.abs(synergy) > 1.5) {
        synergy /= 100;
      }
      if (synergy !== undefined) {
        synergy = clamp(synergy, -1, 1);
      }

      const rawPotentialDecks = Math.max(
        0,
        finiteNumber(view?.potential_decks) ??
          finiteNumber(view?.potentialDecks) ??
          0
      );
      largestPotentialDecks = Math.max(
        largestPotentialDecks,
        rawPotentialDecks
      );

      const explicitNumDecks = finiteNumber(
        view?.num_decks ?? view?.numDecks
      );
      const explicitInclusion = normalizedPercent(
        view?.inclusion ?? view?.inclusion_rate
      );

      const inclusionRate =
        rawPotentialDecks > 0 && explicitNumDecks !== undefined
          ? clamp(explicitNumDecks / rawPotentialDecks, 0, 1)
          : explicitInclusion;

      const numDecks = Math.max(
        0,
        explicitNumDecks ??
          (
            rawPotentialDecks > 0 && inclusionRate !== undefined
              ? Math.round(rawPotentialDecks * inclusionRate)
              : 0
          )
      );

      const confidenceBasis =
        rawPotentialDecks > 0
          ? rawPotentialDecks
          : numDecks;
      const confidence = Math.min(
        1,
        Math.sqrt(Math.max(0, confidenceBasis) / 500)
      );

      // Synergy is commander-specific and therefore the primary EDHREC signal.
      // Inclusion adds a smaller popularity / established-practice component.
      // Negative synergy can mildly penalize a card instead of being discarded.
      const signedSynergy = synergy ?? 0;
      const inclusionComponent =
        inclusionRate === undefined
          ? 0
          : Math.max(0, inclusionRate - 0.08) / 0.92;
      const score = clamp(
        (
          signedSynergy * 0.78 +
          inclusionComponent * 0.22
        ) * Math.max(0.25, confidence),
        -1,
        1
      );

      const entry = {
        name: targetMap.get(key),
        synergy,
        inclusionRate,
        numDecks,
        potentialDecks: rawPotentialDecks || undefined,
        score,
        category
      };

      const existing = best.get(key);
      if (
        !existing ||
        Math.abs(score) > Math.abs(existing.score || 0)
      ) {
        best.set(key, entry);
      }
    }
  }

  const commanderCard = json?.card || data?.card || {};
  const sampleDecks = Math.max(
    0,
    finiteNumber(data?.num_decks_avg) ??
      finiteNumber(json?.num_decks_avg) ??
      finiteNumber(commanderCard?.num_decks) ??
      finiteNumber(commanderCard?.potential_decks) ??
      largestPotentialDecks ??
      0
  );
  const cards = [...best.values()]
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  const cardSignals = {};

  for (const card of cards) {
    cardSignals[normalizeName(card.name)] = card.score || 0;
  }

  return {
    available: cards.length > 0 || sampleDecks > 0,
    commander,
    sampleDecks,
    averageManaValue: edhrecManaValue(data),
    cards,
    cardSignals
  };
}

async function analyzeEdhrecForCommander(commanders, targetNames) {
  if (commanders.length === 0) {
    return {
      available: false,
      cards: [],
      cardSignals: {}
    };
  }

  let lastError;
  for (const slug of commanderSlugCandidates(commanders)) {
    try {
      const data = await fetchCachedJson(
        `${EDHREC_BASE}/${encodeURIComponent(slug)}.json`,
        `edhrec:${slug}`,
        EDHREC_CACHE_SECONDS
      );
      return analyzeEdhrec(
        data,
        commanders.join(" + "),
        targetNames
      );
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return {
    available: false,
    cards: [],
    cardSignals: {}
  };
}

function archidektListResults(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.decks)) return data.decks;
  return [];
}

function archidektDeckId(item) {
  const value = item?.id ?? item?.deckId ?? item?.pk;
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? String(Math.trunc(id)) : null;
}

function archidektIncludedCategories(detail) {
  const categories = new Map();
  for (const category of detail?.categories || []) {
    const name = String(category?.name || "").trim();
    if (!name) continue;
    categories.set(name, {
      included: category?.includedInDeck !== false,
      commander: Boolean(category?.isPremier) || /commander/i.test(name)
    });
  }
  return categories;
}

function archidektCardInfo(entry) {
  const oracle =
    entry?.card?.oracleCard ||
    entry?.card?.oracle_card ||
    entry?.oracleCard ||
    entry?.oracle_card ||
    {};
  const card = entry?.card || {};
  const name = cleanCardName(
    oracle?.name ||
    card?.displayName ||
    card?.name ||
    entry?.name ||
    ""
  );
  const typeLine = String(
    oracle?.typeLine ||
    oracle?.type_line ||
    oracle?.type ||
    card?.typeLine ||
    card?.type_line ||
    ""
  );
  const manaValue = finiteNumber(
    oracle?.cmc ??
    oracle?.manaValue ??
    oracle?.mana_value ??
    card?.cmc ??
    card?.manaValue ??
    card?.mana_value
  );
  const quantity = Math.max(
    1,
    Math.trunc(finiteNumber(entry?.quantity ?? entry?.qty) || 1)
  );
  const categories = Array.isArray(entry?.categories)
    ? entry.categories
        .map(value =>
          typeof value === "string"
            ? value
            : value?.name
        )
        .filter(Boolean)
    : entry?.category
      ? [String(entry.category)]
      : [];

  return { name, typeLine, manaValue, quantity, categories };
}

function summarizeArchidektDeck(detail) {
  const categories = archidektIncludedCategories(detail);
  const cards = new Map();
  const commanders = new Map();
  let lands = 0;
  let nonlandCount = 0;
  let nonlandMana = 0;
  let totalCards = 0;

  for (const entry of detail?.cards || []) {
    const info = archidektCardInfo(entry);
    if (!info.name) continue;

    if (info.categories.length > 0 && categories.size > 0) {
      const included = info.categories.some(name =>
        categories.get(name)?.included !== false
      );
      if (!included) continue;
    }

    const isCommander =
      info.categories.some(name =>
        /commander/i.test(String(name)) ||
        categories.get(String(name))?.commander
      ) ||
      /commander/i.test(String(entry?.category || ""));

    totalCards += info.quantity;
    const key = normalizeName(info.name);
    cards.set(key, info.name);

    if (isCommander) {
      commanders.set(key, info.name);
    }

    if (/\bLand\b/i.test(info.typeLine)) {
      lands += info.quantity;
    } else if (info.manaValue !== undefined) {
      nonlandCount += info.quantity;
      nonlandMana += info.manaValue * info.quantity;
    }
  }

  return {
    cards: [...cards.keys()],
    commanders: [...commanders.keys()],
    lands,
    averageManaValue:
      nonlandCount > 0
        ? nonlandMana / nonlandCount
        : undefined,
    totalCards
  };
}

function sameCommanderName(actual, wanted) {
  const normalizeFront = value =>
    normalizeName(value)
      .split(" // ")[0]
      .trim();

  return normalizeFront(actual) === normalizeFront(wanted);
}

async function loadArchidektList(commander) {
  const buildUrl = (parameter, orderBy) => {
    const url = new URL(`${ARCHIDEKT_BASE}/decks/v3/`);
    url.searchParams.set(parameter, commander);
    url.searchParams.set("deckFormat", "3");
    url.searchParams.set("pageSize", "20");
    url.searchParams.set("page", "1");
    url.searchParams.set("orderBy", orderBy);
    return url;
  };

  // commanderName is the precise current web-search filter. If that shape
  // changes, fall back to name-search and verify the actual commander on the
  // downloaded deck before using it.
  for (const [parameter, orderBy] of [
    ["commanderName", "-viewCount"],
    ["name", "-viewCount"]
  ]) {
    try {
      const url = buildUrl(parameter, orderBy);
      const data = await fetchCachedJson(
        url.toString(),
        `archidekt-list:${parameter}:${normalizeName(commander)}`,
        ARCHIDEKT_CACHE_SECONDS
      );
      if (archidektListResults(data).length > 0) {
        return data;
      }
    } catch (error) {
      console.error("Archidekt list lookup failed", error);
    }
  }

  return { results: [] };
}

async function loadArchidektCommanderSample(commanders, env) {
  if (commanders.length !== 1) {
    return null;
  }

  const commander = commanders[0];
  const cache = caches.default;
  const key = cacheRequest("archidekt-analysis", normalizeName(commander));
  const cached = await cache.match(key);
  if (cached) return cached.json();

  const sampleLimit = clamp(
    Number(env.ARCHIDEKT_SAMPLE_DECKS) || 6,
    3,
    8
  );
  const list = await loadArchidektList(commander);
  const ids = archidektListResults(list)
    .map(archidektDeckId)
    .filter(Boolean)
    .slice(0, Math.max(sampleLimit * 2, sampleLimit));

  const detailResults = await Promise.allSettled(
    ids.map(async id => {
      const detail = await fetchCachedJson(
        `${ARCHIDEKT_BASE}/decks/${id}/`,
        `archidekt-deck:${id}`,
        ARCHIDEKT_CACHE_SECONDS
      );
      return {
        id,
        summary: summarizeArchidektDeck(detail)
      };
    })
  );
  const summaries = [];

  for (const result of detailResults) {
    if (result.status !== "fulfilled") {
      console.error("Archidekt deck sample failed", result.reason);
      continue;
    }

    const summary = result.value.summary;
    const commanderVerified =
      summary.commanders.length === 0
        ? false
        : summary.commanders.some(name =>
            sameCommanderName(name, commander)
          );

    if (
      commanderVerified &&
      summary.totalCards >= 90 &&
      summary.totalCards <= 110
    ) {
      summaries.push(summary);
    }

    if (summaries.length >= sampleLimit) {
      break;
    }
  }

  const payload = { commander, summaries };
  await cache.put(
    key,
    new Response(JSON.stringify(payload), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${ARCHIDEKT_CACHE_SECONDS}`
      }
    })
  );
  return payload;
}

async function analyzeArchidekt(commanders, targetNames, env) {
  const sample = await loadArchidektCommanderSample(commanders, env);
  const summaries = Array.isArray(sample?.summaries) ? sample.summaries : [];

  if (summaries.length < 3) {
    return {
      available: false,
      cards: [],
      cardSignals: {}
    };
  }

  const targetMap = new Map(
    targetNames.map(name => [normalizeName(name), name])
  );
  const counts = new Map();
  let totalLands = 0;
  let totalMv = 0;
  let mvDecks = 0;

  for (const summary of summaries) {
    totalLands += finiteNumber(summary?.lands) || 0;
    if (finiteNumber(summary?.averageManaValue) !== undefined) {
      totalMv += finiteNumber(summary.averageManaValue) || 0;
      mvDecks += 1;
    }

    const keys = Array.isArray(summary?.cards)
      ? summary.cards
      : [];
    for (const key of keys) {
      if (!targetMap.has(key)) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  const confidence = Math.min(1, Math.sqrt(summaries.length / 8));
  const cards = [];
  const cardSignals = {};

  for (const [key, count] of counts) {
    const inclusionRate = count / summaries.length;
    const score = clamp(
      Math.max(0, (inclusionRate - 0.08) / 0.72) * confidence,
      0,
      1
    );
    const entry = {
      name: targetMap.get(key),
      inclusionRate,
      sampleDecks: summaries.length,
      score
    };
    cards.push(entry);
    cardSignals[key] = score;
  }

  cards.sort((a, b) => (b.score || 0) - (a.score || 0));

  return {
    available: true,
    format: "Commander",
    sampleDecks: summaries.length,
    averageLands: totalLands / summaries.length,
    averageManaValue: mvDecks > 0 ? totalMv / mvDecks : undefined,
    cards,
    cardSignals
  };
}

function mergeSignals(
  topDeckSignals,
  comboSignals,
  edhrecSignals,
  archidektSignals
) {
  const keys = new Set([
    ...Object.keys(topDeckSignals || {}),
    ...Object.keys(comboSignals || {}),
    ...Object.keys(edhrecSignals || {}),
    ...Object.keys(archidektSignals || {})
  ]);
  const result = {};

  for (const key of keys) {
    const top = topDeckSignals?.[key] || {};
    result[key] = {
      ...top,
      combo: comboSignals?.[key],
      edhrec: edhrecSignals?.[key],
      archidekt: archidektSignals?.[key]
    };
  }

  return result;
}

function mergedStructure(edhrec, archidekt) {
  const samples = Math.max(
    0,
    finiteNumber(archidekt?.sampleDecks) ||
      (edhrec?.available ? 10 : 0)
  );
  const archMv = finiteNumber(archidekt?.averageManaValue);
  const edhMv = finiteNumber(edhrec?.averageManaValue);

  return {
    lands: finiteNumber(archidekt?.averageLands),
    targetManaValue:
      archMv !== undefined && edhMv !== undefined
        ? archMv * 0.65 + edhMv * 0.35
        : archMv ?? edhMv,
    sampleDecks: samples
  };
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);

    if (!origin) {
      return jsonResponse(
        { error: "Origin not allowed" },
        403,
        "null"
      );
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin"
        }
      });
    }

    if (request.method !== "POST") {
      return jsonResponse(
        { error: "Method not allowed" },
        405,
        origin
      );
    }

    let payload;

    try {
      payload = await request.json();
    } catch {
      return jsonResponse(
        { error: "Invalid JSON" },
        400,
        origin
      );
    }

    const action =
      payload?.action === "analyze"
        ? "analyze"
        : "build";
    const format =
      payload?.format === "standard"
        ? "standard"
        : "commander";
    const commanders = uniqueStrings(
      payload?.commanders,
      2
    );
    const deckCards = uniqueStrings(
      payload?.deckCards,
      MAX_DECK_CARDS
    );
    const candidateCards = uniqueStrings(
      payload?.candidateCards,
      MAX_CANDIDATES
    );
    const targetCards =
      action === "build"
        ? candidateCards
        : uniqueStrings(
            [...deckCards, ...commanders],
            MAX_DECK_CARDS
          );

    const topDeckTask = (async () => {
      try {
        const tournaments =
          await loadTopDeckTournaments(
            format,
            env
          );

        if (!tournaments) {
          return {
            data: {
              available: false,
              cards: [],
              sampleDecks: 0,
              sampleGames: 0
            },
            signals: {}
          };
        }

        const result = analyzeTopDeck(
          tournaments,
          format,
          targetCards,
          commanders
        );
        const signals = result.cardSignals || {};
        delete result.cardSignals;
        return { data: result, signals };
      } catch (error) {
        console.error("TopDeck intelligence failed", error);
        return {
          data: {
            available: false,
            cards: [],
            sampleDecks: 0,
            sampleGames: 0
          },
          signals: {}
        };
      }
    })();

    const spellbookTask = (async () => {
      if (
        format !== "commander" ||
        deckCards.length === 0
      ) {
        return {
          data: {
            available: false,
            includedCombos: [],
            almostCombos: []
          },
          signals: {}
        };
      }

      try {
        const result =
          await analyzeSpellbook(
            commanders,
            deckCards,
            candidateCards
          );
        const signals = result.comboSignals || {};
        delete result.comboSignals;
        return { data: result, signals };
      } catch (error) {
        console.error("Commander Spellbook intelligence failed", error);
        return {
          data: {
            available: false,
            includedCombos: [],
            almostCombos: []
          },
          signals: {}
        };
      }
    })();

    const edhrecTask = (async () => {
      if (
        format !== "commander" ||
        commanders.length === 0
      ) {
        return {
          data: {
            available: false,
            cards: []
          },
          signals: {}
        };
      }

      try {
        const result =
          await analyzeEdhrecForCommander(
            commanders,
            targetCards
          );
        const signals = result.cardSignals || {};
        delete result.cardSignals;
        return { data: result, signals };
      } catch (error) {
        console.error("EDHREC intelligence failed", error);
        return {
          data: {
            available: false,
            cards: []
          },
          signals: {}
        };
      }
    })();

    const archidektTask = (async () => {
      if (
        format !== "commander" ||
        commanders.length !== 1
      ) {
        return {
          data: {
            available: false,
            cards: []
          },
          signals: {}
        };
      }

      try {
        const result =
          await analyzeArchidekt(
            commanders,
            targetCards,
            env
          );
        const signals = result.cardSignals || {};
        delete result.cardSignals;
        return { data: result, signals };
      } catch (error) {
        console.error("Archidekt intelligence failed", error);
        return {
          data: {
            available: false,
            cards: []
          },
          signals: {}
        };
      }
    })();

    const [
      topDeckResult,
      spellbookResult,
      edhrecResult,
      archidektResult
    ] = await Promise.all([
      topDeckTask,
      spellbookTask,
      edhrecTask,
      archidektTask
    ]);

    const topDeck = topDeckResult.data;
    const topDeckSignals = topDeckResult.signals;
    const spellbook = spellbookResult.data;
    const comboSignals = spellbookResult.signals;
    const edhrec = edhrecResult.data;
    const edhrecSignals = edhrecResult.signals;
    const archidekt = archidektResult.data;
    const archidektSignals = archidektResult.signals;

    return jsonResponse(
      {
        topDeck,
        spellbook,
        edhrec,
        archidekt,
        structure:
          mergedStructure(
            edhrec,
            archidekt
          ),
        cardSignals:
          mergeSignals(
            topDeckSignals,
            comboSignals,
            edhrecSignals,
            archidektSignals
          )
      },
      200,
      origin
    );
  }
};
