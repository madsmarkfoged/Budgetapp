# Personlig økonomi

Budget, poster, formue og investeringer som installerbar web-app (PWA).
Poster og saldi hentes fra Sparekassen Kronjylland, og beholdninger hentes fra Saxo. Opsætningen står i **SETUP.md**.
Alle dine tal gemmes lokalt i browseren på den enhed, du bruger.

## Læg appen på GitHub Pages (uden git)

1. Log ind på github.com → **New repository** → navn fx `budget-app` → **Public** → Create.
2. På repo-siden: **Add file → Upload files**. Træk disse ind:
   `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, `.nojekyll` og mappen `icons`.
   **Commit changes**. Mappen `worker` hører til Cloudflare (se SETUP.md) og skal ikke med.
   - `.nojekyll` er skjult i Stifinder. Slå *Vis → Skjulte elementer* til, eller opret filen på GitHub via
     *Add file → Create new file* med navnet `.nojekyll` og tomt indhold.
3. **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`, mappe `/ (root)` → Save.
4. Efter 1–2 minutter ligger appen på `https://<dit-brugernavn>.github.io/budget-app/`.

Repoet er offentligt, men det indeholder kun koden. Dine tal og nøgler ligger aldrig i repoet.

## Installér

- **Windows (Edge/Chrome):** åbn adressen → klik på installationsikonet i adresselinjen.
- **iPhone (Safari):** Del-knappen → *Føj til hjemmeskærm*.
- **Android (Chrome):** menu → *Installér app*.

## Claude API-nøgle (til AI-analyse og kurser på manuelle beholdninger)

1. <https://console.anthropic.com> → opret konto → *Billing*: køb lidt kredit.
2. *Settings → API keys → Create key*.
3. I appen: **Mere → Claude API-nøgle** → indsæt → **Gem** → **Test**.

Nøglen gemmes kun på enheden. Et kald koster typisk få øre til et par kroner.

## Flyt data

- Fra claude.ai-versionen: *Eksportér backup* dér → **Mere → Data og backup → Importér** her.
- Mellem pc og telefon: eksportér på den ene, importér på den anden.

## Opdatering af appen

Upload de ændrede filer igen, og tæl `CACHE = "okonomi-v2"` i `sw.js` én op,
så installerede apps henter de nye filer.

## Test lokalt

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```
Åbn derefter <http://localhost:8080> i Edge eller Chrome.
