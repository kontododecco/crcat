// ============================================================
//  Stremio Addon – Anime Catalog (via AniList API)
//  Vercel Serverless Function
// ============================================================

// ── Manifest ────────────────────────────────────────────────
const MANIFEST = {
  id: "community.crunchyroll-anime-catalog",
  version: "1.1.0",
  name: "Crunchyroll Anime",
  description: "Katalog anime – tytuły, okładki i odcinki. Dane z AniList.",
  logo: "https://www.crunchyroll.com/build/assets/img/favicons/favicon-96x96.png",
  resources: [
    "catalog",
    {
      name: "meta",
      types: ["series"],
      idPrefixes: ["anilist:"],
    },
  ],
  types: ["series"],
  idPrefixes: ["anilist:"],
  catalogs: [
    {
      type: "series",
      id: "crunchyroll-popular",
      name: "🔥 Popularne Anime",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "series",
      id: "crunchyroll-seasonal",
      name: "📅 Sezonowe Anime",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      type: "series",
      id: "crunchyroll-toprated",
      name: "⭐ Najwyżej Oceniane",
      extra: [{ name: "skip", isRequired: false }],
    },
  ],
  behaviorHints: { adult: false },
};

// ── AniList GraphQL helper ───────────────────────────────────
const ANILIST_URL = "https://graphql.anilist.co";

async function anilistQuery(query, variables) {
  const res = await fetch(ANILIST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data;
}

// ── Convert AniList → Stremio meta preview ──────────────────
function toMeta(media) {
  const title =
    media.title.english ||
    media.title.romaji ||
    media.title.native ||
    "Unknown";
  return {
    id: `anilist:${media.id}`,
    type: "series",
    name: title,
    poster: media.coverImage?.extraLarge || media.coverImage?.large || null,
    posterShape: "poster",
    background: media.bannerImage || null,
    genres: media.genres || [],
    releaseInfo: media.startDate?.year?.toString() || "",
  };
}

// ── Media fields used in every query ────────────────────────
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
`;

// ── Catalog fetchers ─────────────────────────────────────────
async function fetchPopular(page, search) {
  if (search) {
    const d = await anilistQuery(
      `query($s:String,$p:Int){Page(page:$p,perPage:20){media(search:$s,type:ANIME,isAdult:false,sort:POPULARITY_DESC){${FIELDS}}}}`,
      { s: search, p: page }
    );
    return d.Page.media;
  }
  const d = await anilistQuery(
    `query($p:Int){Page(page:$p,perPage:20){media(type:ANIME,isAdult:false,sort:POPULARITY_DESC){${FIELDS}}}}`,
    { p: page }
  );
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

// ── Meta handler ─────────────────────────────────────────────
async function buildMeta(rawId) {
  const anilistId = parseInt(rawId.replace("anilist:", ""), 10);
  if (isNaN(anilistId)) throw new Error("Invalid ID");

  const d = await anilistQuery(
    `query($id:Int){Media(id:$id,type:ANIME){
      ${FIELDS}
      description(asHtml:false)
      streamingEpisodes { title thumbnail url site }
      airingSchedule(notYetAired:false,perPage:150){nodes{episode airingAt}}
    }}`,
    { id: anilistId }
  );

  const media = d.Media;
  const meta = toMeta(media);

  // Build airing-date map
  const airMap = {};
  (media.airingSchedule?.nodes || []).forEach((n) => {
    airMap[n.episode] = new Date(n.airingAt * 1000).toISOString();
  });

  const baseDate =
    media.startDate?.year
      ? new Date(
          `${media.startDate.year}-${String(media.startDate.month || 1).padStart(2, "0")}-${String(media.startDate.day || 1).padStart(2, "0")}`
        )
      : new Date("2000-01-01");

  function epDate(num) {
    if (airMap[num]) return airMap[num];
    const d2 = new Date(baseDate);
    d2.setDate(d2.getDate() + (num - 1) * 7);
    return d2.toISOString();
  }

  const videos = [];
  const seList = media.streamingEpisodes || [];

  if (seList.length > 0) {
    seList.forEach((ep, idx) => {
      const num = idx + 1;
      videos.push({
        id: `anilist:${media.id}:1:${num}`,
        title: ep.title || `Odcinek ${num}`,
        season: 1,
        number: num,
        released: epDate(num),
        thumbnail: ep.thumbnail || undefined,
        ...(ep.site === "Crunchyroll" ? { externalUrl: ep.url } : {}),
      });
    });
  } else if (media.episodes > 0) {
    for (let i = 1; i <= media.episodes; i++) {
      videos.push({
        id: `anilist:${media.id}:1:${i}`,
        title: `Odcinek ${i}`,
        season: 1,
        number: i,
        released: epDate(i),
      });
    }
  } else {
    videos.push({
      id: `anilist:${media.id}:1:1`,
      title: "Odcinek 1",
      season: 1,
      number: 1,
      released: baseDate.toISOString(),
    });
  }

  meta.videos = videos;

  if (media.description) {
    meta.description = media.description.replace(/<[^>]*>/g, "").slice(0, 400);
  }

  return meta;
}

// ── Parse extra args from URL path segment ───────────────────
function parseExtra(segment) {
  if (!segment) return {};
  const clean = segment.replace(/\.json$/, "");
  const params = new URLSearchParams(clean);
  const out = {};
  for (const [k, v] of params.entries()) out[k] = decodeURIComponent(v);
  return out;
}

// ── CORS ─────────────────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "max-age=300, stale-while-revalidate=600");
}

// ── Main Vercel handler ───────────────────────────────────────
module.exports = async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") return res.status(200).end();

  const fullPath = (req.url || "/").split("?")[0];
  const path = fullPath.replace(/^\/api/, "") || "/";

  console.log("REQUEST:", path);

  // manifest
  if (path === "/" || path === "/manifest.json") {
    return res.status(200).json(MANIFEST);
  }

  // /catalog/:type/:catalogId[/:extra].json
  const catMatch = path.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/(.+))?\.json$/);
  if (catMatch) {
    const [, , catalogId, extraSegment] = catMatch;
    const extra = parseExtra(extraSegment || "");
    const skip = parseInt(extra.skip || "0", 10) || 0;
    const page = Math.floor(skip / 20) + 1;
    const search = extra.search || null;

    try {
      let items = [];
      if (catalogId === "crunchyroll-popular") items = await fetchPopular(page, search);
      else if (catalogId === "crunchyroll-seasonal") items = await fetchSeasonal(page);
      else if (catalogId === "crunchyroll-toprated") items = await fetchTopRated(page);
      return res.status(200).json({ metas: (items || []).filter(Boolean).map(toMeta) });
    } catch (e) {
      console.error("Catalog error:", e.message);
      return res.status(200).json({ metas: [] });
    }
  }

  // /meta/:type/:id.json
  const metaMatch = path.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
  if (metaMatch) {
    const [, , id] = metaMatch;
    if (!id.startsWith("anilist:")) return res.status(200).json({ meta: null });
    try {
      const meta = await buildMeta(id);
      return res.status(200).json({ meta });
    } catch (e) {
      console.error("Meta error:", e.message);
      return res.status(200).json({ meta: null });
    }
  }

  return res.status(404).json({ error: "Not found", path });
};
