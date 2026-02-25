// ============================================================
//  Stremio Addon – Crunchyroll Anime Catalog (via AniList API)
//  Vercel Serverless Function
// ============================================================

const MANIFEST = {
  id: "community.crunchyroll-anime-catalog",
  version: "1.0.0",
  name: "Crunchyroll Anime",
  description: "Katalog anime z Crunchyroll – tytuły, okładki i odcinki. Powered by AniList.",
  logo: "https://www.crunchyroll.com/build/assets/img/favicons/favicon-96x96.png",
  background: "https://images5.alphacoders.com/131/1315877.jpg",
  resources: ["catalog", "meta"],
  types: ["series"],
  idPrefixes: ["anilist:"],
  catalogs: [
    {
      type: "series",
      id: "crunchyroll-popular",
      name: "🔥 Popularne Anime",
      extra: [{ name: "skip" }, { name: "search" }],
    },
    {
      type: "series",
      id: "crunchyroll-seasonal",
      name: "📅 Sezonowe Anime (teraz)",
      extra: [{ name: "skip" }],
    },
    {
      type: "series",
      id: "crunchyroll-toprated",
      name: "⭐ Najwyżej Oceniane",
      extra: [{ name: "skip" }],
    },
  ],
  behaviorHints: {
    adult: false,
    configurable: false,
  },
};

// ──────────────────────────────────────────────
//  AniList GraphQL helper
// ──────────────────────────────────────────────
const ANILIST_URL = "https://graphql.anilist.co";

async function anilistQuery(query, variables) {
  const res = await fetch(ANILIST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data;
}

// ──────────────────────────────────────────────
//  Convert AniList media → Stremio meta object
// ──────────────────────────────────────────────
function toStremioMeta(media) {
  return {
    id: `anilist:${media.id}`,
    type: "series",
    name: media.title.romaji || media.title.english || media.title.native || "Unknown",
    poster: media.coverImage?.extraLarge || media.coverImage?.large || null,
    background: media.bannerImage || null,
    genres: media.genres || [],
    releaseInfo: media.startDate?.year?.toString() || "",
    imdbRating: media.averageScore ? (media.averageScore / 10).toFixed(1) : undefined,
    description: media.description
      ? media.description.replace(/<[^>]*>/g, "").slice(0, 300)
      : undefined,
  };
}

// ──────────────────────────────────────────────
//  Catalog queries
// ──────────────────────────────────────────────
const MEDIA_FIELDS = `
  id
  title { romaji english native }
  coverImage { large extraLarge }
  bannerImage
  genres
  startDate { year month day }
  averageScore
  description(asHtml: false)
  episodes
  status
`;

async function getPopular(page, search) {
  if (search) {
    const data = await anilistQuery(
      `query($search:String,$page:Int){Page(page:$page,perPage:20){media(search:$search,type:ANIME,isAdult:false,sort:POPULARITY_DESC){${MEDIA_FIELDS}}}}`,
      { search, page }
    );
    return data.Page.media;
  }
  const data = await anilistQuery(
    `query($page:Int){Page(page:$page,perPage:20){media(type:ANIME,isAdult:false,sort:POPULARITY_DESC){${MEDIA_FIELDS}}}}`,
    { page }
  );
  return data.Page.media;
}

async function getSeasonal(page) {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const season =
    month <= 3 ? "WINTER" : month <= 6 ? "SPRING" : month <= 9 ? "SUMMER" : "FALL";
  const data = await anilistQuery(
    `query($page:Int,$season:MediaSeason,$year:Int){Page(page:$page,perPage:20){media(type:ANIME,isAdult:false,season:$season,seasonYear:$year,sort:POPULARITY_DESC){${MEDIA_FIELDS}}}}`,
    { page, season, year }
  );
  return data.Page.media;
}

async function getTopRated(page) {
  const data = await anilistQuery(
    `query($page:Int){Page(page:$page,perPage:20){media(type:ANIME,isAdult:false,sort:SCORE_DESC){${MEDIA_FIELDS}}}}`,
    { page }
  );
  return data.Page.media;
}

// ──────────────────────────────────────────────
//  Meta handler – returns series details + episodes
// ──────────────────────────────────────────────
async function getMeta(id) {
  const anilistId = parseInt(id.replace("anilist:", ""), 10);

  const data = await anilistQuery(
    `query($id:Int){Media(id:$id,type:ANIME){
      ${MEDIA_FIELDS}
      streamingEpisodes { title thumbnail url site }
      airingSchedule(notYetAired:false,perPage:50) {
        nodes { episode airingAt }
      }
    }}`,
    { id: anilistId }
  );

  const media = data.Media;
  const meta = toStremioMeta(media);

  // Build a map: episodeNumber → airingAt timestamp
  const airDates = {};
  if (media.airingSchedule?.nodes) {
    media.airingSchedule.nodes.forEach((node) => {
      airDates[node.episode] = node.airingAt; // Unix timestamp
    });
  }

  // Fallback release date when no airing data
  const fallbackDate = media.startDate?.year
    ? new Date(`${media.startDate.year}-01-01`).toISOString()
    : new Date("2000-01-01").toISOString();

  function getEpisodeDate(epNum) {
    if (airDates[epNum]) {
      return new Date(airDates[epNum] * 1000).toISOString();
    }
    // Estimate: fallback + epNum weeks offset
    const base = media.startDate?.year
      ? new Date(`${media.startDate.year}-${String(media.startDate.month || 1).padStart(2,"0")}-${String(media.startDate.day || 1).padStart(2,"0")}`)
      : new Date("2000-01-01");
    base.setDate(base.getDate() + (epNum - 1) * 7);
    return base.toISOString();
  }

  const videos = [];

  if (media.streamingEpisodes && media.streamingEpisodes.length > 0) {
    // streamingEpisodes from AniList – real CR episode titles & thumbnails
    media.streamingEpisodes.forEach((ep, idx) => {
      const epNum = idx + 1;
      videos.push({
        id: `anilist:${media.id}:1:${epNum}`,   // format: prefix:metaId:season:ep
        title: ep.title || `Odcinek ${epNum}`,
        season: 1,
        number: epNum,                            // NOTE: must be `number`, not `episode`
        thumbnail: ep.thumbnail || null,
        released: getEpisodeDate(epNum),          // required by Stremio
        ...(ep.site === "Crunchyroll" ? { externalUrl: ep.url } : {}),
      });
    });
  } else if (media.episodes && media.episodes > 0) {
    // Fallback: generate list from total episode count
    for (let i = 1; i <= media.episodes; i++) {
      videos.push({
        id: `anilist:${media.id}:1:${i}`,
        title: `Odcinek ${i}`,
        season: 1,
        number: i,                               // must be `number`
        released: getEpisodeDate(i),             // required
      });
    }
  } else {
    // Still airing / unknown count – show placeholder episode 1
    videos.push({
      id: `anilist:${media.id}:1:1`,
      title: "Odcinek 1",
      season: 1,
      number: 1,
      released: fallbackDate,
    });
  }

  meta.videos = videos;
  return meta;
}

// ──────────────────────────────────────────────
//  CORS headers
// ──────────────────────────────────────────────
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "max-age=300, stale-while-revalidate=3600");
}

// ──────────────────────────────────────────────
//  Main Vercel handler
// ──────────────────────────────────────────────
module.exports = async function handler(req, res) {
  setCORS(res);

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  const url = req.url || "/";
  const path = url.split("?")[0].replace(/^\/api/, "");

  // ── /manifest.json ─────────────────────────
  if (path === "/manifest.json" || path === "/") {
    res.status(200).json(MANIFEST);
    return;
  }

  // ── /catalog/:type/:id.json ─────────────────
  const catalogMatch = path.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/skip=(\d+))?(?:\/search=([^/]+))?\.json$/);
  if (catalogMatch) {
    const [, , catalogId, skipStr, searchRaw] = catalogMatch;
    const page = skipStr ? Math.floor(parseInt(skipStr, 10) / 20) + 1 : 1;
    const search = searchRaw ? decodeURIComponent(searchRaw) : null;

    try {
      let items = [];
      if (catalogId === "crunchyroll-popular") {
        items = await getPopular(page, search);
      } else if (catalogId === "crunchyroll-seasonal") {
        items = await getSeasonal(page);
      } else if (catalogId === "crunchyroll-toprated") {
        items = await getTopRated(page);
      } else {
        res.status(200).json({ metas: [] });
        return;
      }

      const metas = (items || []).filter(Boolean).map(toStremioMeta);
      res.status(200).json({ metas });
    } catch (err) {
      console.error("Catalog error:", err.message);
      res.status(200).json({ metas: [] });
    }
    return;
  }

  // ── /meta/:type/:id.json ────────────────────
  const metaMatch = path.match(/^\/meta\/([^/]+)\/([^/]+)\.json$/);
  if (metaMatch) {
    const [, , id] = metaMatch;
    if (!id.startsWith("anilist:")) {
      res.status(200).json({ meta: {} });
      return;
    }
    try {
      const meta = await getMeta(id);
      res.status(200).json({ meta });
    } catch (err) {
      console.error("Meta error:", err.message);
      res.status(200).json({ meta: {} });
    }
    return;
  }

  // ── Not found ───────────────────────────────
  res.status(404).json({ error: "Not found", path });
};
