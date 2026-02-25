// Lokalny serwer do testowania przed wrzuceniem na Vercel
// Uruchom: node server.js
// Następnie w Stremio dodaj: http://localhost:3000/manifest.json

const http = require("http");
const handler = require("./api/index");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  handler(req, res);
});

server.listen(PORT, () => {
  console.log(`\n✅ Stremio Crunchyroll Addon działa na http://localhost:${PORT}`);
  console.log(`\nDodaj do Stremio: http://localhost:${PORT}/manifest.json`);
  console.log(`Lub otwórz w przeglądarce: stremio://localhost:${PORT}/manifest.json\n`);
});
