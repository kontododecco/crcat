# 🎌 Crunchyroll Anime – Stremio Addon

Addon do Stremio pokazujący katalog anime z danymi z AniList (tytuły, okładki, lista odcinków).

## 📋 Katalogi

| Katalog | Opis |
|---------|------|
| 🔥 Popularne Anime | Najczęściej oglądane anime wszechczasów |
| 📅 Sezonowe Anime | Aktualnie emitowane anime (bieżący sezon) |
| ⭐ Najwyżej Oceniane | Anime z najwyższymi ocenami |

## 🚀 Deployment na Vercel (krok po kroku)

### Krok 1 – Wgraj projekt na GitHub

1. Idź na [github.com](https://github.com) i zaloguj się
2. Kliknij **"+"** → **"New repository"**
3. Nazwa: `crunchyroll-stremio-addon`
4. Kliknij **"Create repository"**
5. Wgraj wszystkie pliki z tego folderu do repozytorium

### Krok 2 – Deploy na Vercel

1. Idź na [vercel.com](https://vercel.com) i zaloguj się przez GitHub
2. Kliknij **"Add New..."** → **"Project"**
3. Wybierz swoje repozytorium `crunchyroll-stremio-addon`
4. Kliknij **"Import"**
5. Zostaw wszystkie ustawienia domyślne
6. Kliknij **"Deploy"**
7. Po deploymencie skopiuj swój URL (np. `https://crunchyroll-stremio-addon.vercel.app`)

### Krok 3 – Dodaj addon do Stremio

1. Otwórz Stremio
2. Kliknij ikonę puzzla (Addons) w prawym górnym rogu
3. Na górze wpisz URL:
   ```
   https://TWOJ-URL.vercel.app/manifest.json
   ```
4. Kliknij **"Install"**

## 🖥️ Lokalne testowanie

```bash
node server.js
```

Następnie w Stremio dodaj: `http://127.0.0.1:3000/manifest.json`

## 📁 Struktura plików

```
.
├── api/
│   └── index.js      # Główna logika addonu (Vercel Serverless Function)
├── server.js          # Lokalny serwer do testów
├── vercel.json        # Konfiguracja Vercel (routing)
├── package.json       # Metadata projektu
└── README.md          # Ta dokumentacja
```

## ⚙️ Jak to działa

- Addon używa **AniList GraphQL API** (100% darmowe, bez klucza API)
- AniList ma dokładnie te same anime co Crunchyroll + więcej
- Każde anime ma okładkę, tytuł, gatunki i pełną listę odcinków
- Odcinki, które mają linki do Crunchyroll, otwierają się bezpośrednio na CR

## 🔗 Endpointy

| Endpoint | Opis |
|----------|------|
| `/manifest.json` | Manifest addonu |
| `/catalog/series/crunchyroll-popular.json` | Popularne anime |
| `/catalog/series/crunchyroll-seasonal.json` | Sezonowe anime |
| `/catalog/series/crunchyroll-toprated.json` | Najwyżej oceniane |
| `/meta/series/anilist:XXXXX.json` | Szczegóły anime |

## ⚠️ Uwagi

- Addon **nie streamuje** żadnych filmów – tylko pokazuje katalog
- Kliknięcie odcinka może otworzyć link do Crunchyroll (jeśli dostępny)
- Do oglądania nadal potrzebujesz konta Crunchyroll
- AniList API ma limit 90 zapytań/minutę (zupełnie wystarczający)
