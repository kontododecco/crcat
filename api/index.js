// ============================================================
//  Stremio Addon – Anime Catalog (via AniList API)
//  Vercel Serverless Function — v1.3 multi-season
// ============================================================

const MANIFEST = {
  id: "community.animecrunchyroll.catalog",
  version: "1.3.0",
  name: "Crunchyroll Anime",
  description: "Katalog anime – tytuły, okładki, wszystkie sezony i odcinki.",
  logo: "https://www.crunchyroll.com/build/assets/img/favicons/favicon-96x96.png",
  resources: [
    "catalog",
    { name: "meta", types: ["series"], idPrefixes: ["al:"] },
  ],
  types: ["series"],
  idPrefixes: ["al:"],
  catalogs: [
    {
      type: "series", id: "anime-popular", name: "🔥 Popularne Anime",
      extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }],
    },
    {
      type: "series", id: "anime-seasonal", name: "📅 Sezonowe Anime",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      type: "series", id: "anime-toprated", name: "⭐ Najwyżej Oceniane",
      extra: [{ name: "skip", isRequired: false }],
    },
  ],
  behaviorHints: { adult: false },
};

// ── AniList helper ───────────────────────────────────────────
const ANILIST_URL = "https://graphql.anilist.co";

async function anilistQuery(query, variables) {
  const res = await fetch(ANILIST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

// ── Fields ───────────────────────────────────────────────────
const FIELDS = `
  id
  title { romaji english native }
  coverImage { large extraLarge }
  bannerImage
  genres
  startDate { year month day }
  averageScore
  episodes
  status
  format
`;

const RELATION_FIELDS = `
  id
  title { romaji english native }
  type
  format
  episodes
  startDate { year month day }
  status
  streamingEpisodes { title thumbnail url site }
  airingSchedule(notYetAired:false, perPage:150) { nodes { episode airingAt } }
`;

// ── toMeta ───────────────────────────────────────────────────
function toMeta(media) {
  return {
    id: `al:${media.id}`,
    type: "series",
    name: media.title.english || media.title.romaji || media.title.native || "Unknown",
    poster: media.coverImage?.extraLarge || media.coverImage?.large || null,
    posterShape: "poster",
    background: media.bannerImage || null,
    genres: media.genres || [],
    releaseInfo: media.startDate?.year?.toString() || "",
  };
}

// ── Catalog fetchers ─────────────────────────────────────────
async function fetchPopular(page, search) {
  const q = search
    ? `query($s:String,$p:Int){Page(page:$p,perPage:20){media(search:$s,type:ANIME,isAdult:false,sort:POPULARITY_DESC){${FIELDS}}}}`
    : `query($p:Int){Page(page:$p,perPage:20){media(type:ANIME,isAdult:false,sort:POPULARITY_DESC){${FIELDS}}}}`;
  const d = await anilistQuery(q, search ? { s: search, p: page } : { p: page });
  return d.Page.media;
}

async function fetchSeasonal(page) {
  const m = new Date().getMonth() + 1;
  const year = new Date().getFullYear();
  const season = m <= 3 ? "WINTER" : m <= 6 ? "SPRING" : m <= 9 ? "SUMMER" : "FALL";
  const d = await anilistQuery(
    `query($p:Int,$s:MediaSeason,$y:Int){Page(page:$p,perPage:20){media(type:ANIME,isAdult:false,season:$s,seasonYear:$y,sort:POPULARITY_DESC){${FIELDS}}}}`,
    { p: page, s: season, y: year }
  );
  return d.Page.media;
}

async function fetchTopRated(page) {
  const d = await anilistQuery(
    `query($p:Int){Page(page:$p,perPage:20){media(type:ANIME,isAdult:false,sort:SCORE_DESC,averageScore_greater:70){${FIELDS}}}}`,
    { p: page }
  );
  return d.Page.media;
}

// ── Zbierz cały łańcuch serii (S1→S2→S3→filmy) ──────────────
// Przechodzi przez SEQUEL/PREQUEL rekurencyjnie, zwraca posortowaną listę
async function collectAllParts(rootId) {
  // Najpierw znajdź najstarszą część (idź przez PREQUEL do początku)
  const visited = new Set();
  const allMedia = new Map(); // id → media

  async function fetchWithRelations(id) {
    if (visited.has(id)) return;
    visited.add(id);

    const d = await anilistQuery(
      `query($id:Int){Media(id:$id,type:ANIME){
        ${RELATION_FIELDS}
        relations {
          edges {
            relationType
            node { id type format title { romaji english } }
          }
        }
      }}`,
      { id }
    );

    const media = d.Media;
    allMedia.set(id, media);

    // Zbierz SEQUEL i PREQUEL (tylko ANIME)
    const related = (media.relations?.edges || []).filter(e =>
      (e.relationType === "SEQUEL" || e.relationType === "PREQUEL") &&
      e.node.type === "ANIME"
    );

    // Limit: max 15 części żeby nie zapętlić się w długich franczyzach
    if (allMedia.size < 15) {
      await Promise.all(
        related.map(e => fetchWithRelations(e.node.id))
      );
    }
  }

  await fetchWithRelations(rootId);

  // Posortuj chronologicznie po dacie startu
  const sorted = Array.from(allMedia.values()).sort((a, b) => {
    const da = a.startDate?.year ? new Date(`${a.startDate.year}-${String(a.startDate.month||1).padStart(2,'0')}-01`) : new Date(0);
    const db = b.startDate?.year ? new Date(`${b.startDate.year}-${String(b.startDate.month||1).padStart(2,'0')}-01`) : new Date(0);
    return da - db;
  });

  return sorted;
}

// ── Zbuduj listę odcinków dla jednej części ──────────────────
function buildEpisodesForPart(media, seasonNum) {
  const airMap = {};
  (media.airingSchedule?.nodes || []).forEach(n => {
    airMap[n.episode] = new Date(n.airingAt * 1000).toISOString();
  });

  const baseDate = media.startDate?.year
    ? new Date(`${media.startDate.year}-${String(media.startDate.month||1).padStart(2,'0')}-${String(media.startDate.day||1).padStart(2,'0')}`)
    : new Date("2000-01-01");

  function epDate(num) {
    if (airMap[num]) return airMap[num];
    const d = new Date(baseDate);
    d.setDate(d.getDate() + (num - 1) * 7);
    return d.toISOString();
  }

  const seList = media.streamingEpisodes || [];
  const videos = [];

  // Nazwa sezonu (np. "Sezon 2", "Film: Mugen Train")
  const isMovie = media.format === "MOVIE";
  const partTitle = media.title.english || media.title.romaji || media.title.native;

  if (seList.length > 0) {
    seList.forEach((ep, idx) => {
      const num = idx + 1;
      videos.push({
        id:        `al:${media.id}:${seasonNum}:${num}`,
        title:     ep.title || (isMovie ? partTitle : `Odcinek ${num}`),
        season:    seasonNum,
        episode:   num,
        released:  epDate(num),
        thumbnail: ep.thumbnail || undefined,
        ...(ep.site === "Crunchyroll" ? { externalUrl: ep.url } : {}),
      });
    });
  } else if (media.episodes > 0) {
    for (let i = 1; i <= media.episodes; i++) {
      videos.push({
        id:       `al:${media.id}:${seasonNum}:${i}`,
        title:    isMovie && i === 1 ? partTitle : `Odcinek ${i}`,
        season:   seasonNum,
        episode:  i,
        released: epDate(i),
      });
    }
  } else {
    // Nieznana liczba odcinków (np. trwa emisja)
    videos.push({
      id:       `al:${media.id}:${seasonNum}:1`,
      title:    isMovie ? partTitle : "Odcinek 1",
      season:   seasonNum,
      episode:  1,
      released: baseDate.toISOString(),
    });
  }

  return videos;
}

// ── buildMeta — główny handler ───────────────────────────────
async function buildMeta(rawId) {
  const anilistId = parseInt(rawId.replace("al:", ""), 10);
  if (isNaN(anilistId)) throw new Error("Invalid ID: " + rawId);

  // Pobierz wszystkie powiązane części (sezony + filmy)
  const parts = await collectAllParts(anilistId);

  // Użyj pierwszej części jako bazy dla metadanych
  const root = parts[0];
  const meta = toMeta(root);

  // Jeśli jest tylko jedna część — prosta lista odcinków
  if (parts.length === 1) {
    meta.videos = buildEpisodesForPart(root, 1);
    return meta;
  }

  // Wiele części — filmy → sezon 0 ("Specials"), odcinki TV → sezon 1, 2, 3...
  const allVideos = [];
  let tvSeasonCounter = 1;
  parts.forEach((part) => {
    const isMovie = part.format === "MOVIE";
    const seasonNum = isMovie ? 0 : tvSeasonCounter++;
    const eps = buildEpisodesForPart(part, seasonNum);
    allVideos.push(...eps);
  });

  meta.videos = allVideos;

  // Dodaj opis z głównej części
  if (root.description) {
    meta.description = root.description.replace(/<[^>]*>/g, "").slice(0, 400);
  }

  return meta;
}

// ── Helpers ──────────────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "max-age=300, stale-while-revalidate=600");
}

function parseExtra(seg) {
  if (!seg) return {};
  const out = {};
  new URLSearchParams(seg.replace(/\.json$/, "")).forEach((v, k) => { out[k] = decodeURIComponent(v); });
  return out;
}

// ── Main Vercel handler ───────────────────────────────────────
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const path = ((req.url || "/").split("?")[0]).replace(/^\/api/, "") || "/";
  console.log("[addon]", req.method, path);

  // manifest
  if (path === "/" || path === "/manifest.json") {
    return res.status(200).json(MANIFEST);
  }

  // /catalog/:type/:id[/:extra].json
  const catM = path.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/(.+))?\.json$/);
  if (catM) {
    const [, , catalogId, extraSeg] = catM;
    const extra  = parseExtra(extraSeg || "");
    const page   = Math.floor((parseInt(extra.skip || "0", 10) || 0) / 20) + 1;
    const search = extra.search || null;
    try {
      let items = [];
      if      (catalogId === "anime-popular")  items = await fetchPopular(page, search);
      else if (catalogId === "anime-seasonal") items = await fetchSeasonal(page);
      else if (catalogId === "anime-toprated") items = await fetchTopRated(page);
      return res.status(200).json({ metas: (items || []).filter(Boolean).map(toMeta) });
    } catch (e) {
      console.error("[catalog error]", e.message);
      return res.status(200).json({ metas: [] });
    }
  }

  // /meta/:type/:id.json
  const metaM = path.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
  if (metaM) {
    const id = decodeURIComponent(metaM[2]);
    console.log("[meta]", id);
    if (!id.startsWith("al:")) return res.status(200).json({ meta: null });
    try {
      const meta = await buildMeta(id);
      console.log("[meta ok]", meta.name, "| seasons:", new Set(meta.videos.map(v=>v.season)).size, "| episodes:", meta.videos.length);
      return res.status(200).json({ meta });
    } catch (e) {
      console.error("[meta error]", e.message);
      return res.status(200).json({ meta: null });
    }
  }

  return res.status(404).json({ error: "Not found", path });
};
