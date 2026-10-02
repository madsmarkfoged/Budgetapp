# Budget-app (Personlig økonomi)

PWA uden build-trin: `index.html`, `app.js` (React 18 + htm fra esm.sh), `styles.css`, `sw.js`, `manifest.webmanifest`, `icons/`.
`worker/worker.js` er en Cloudflare Worker (Enable Banking til Sparekassen Kronjylland + Saxo OpenAPI), og den deployes separat.
Hostes på GitHub Pages, og brugeren uploader filerne manuelt via github.com (ingen git/node på arbejds-PC'en).
Opsætning for brugeren står i `README.md` og `SETUP.md`. Svar brugeren på dansk.

Løn udbetales den **sidste bankdag i måneden** (`paydayIn` i `app.js`, med danske banklukkedage). Den løbende budgetmåned skifter på lønningsdagen. Poster fra og med den 25. (`PAYDAY_CUTOFF`) med positivt beløb eller kategorien Husleje tælles med i næste budgetmåned. Den tidligste mulige lønningsdag er den 26.

## Status (29. september 2026)

Appen og workeren er færdige og testet mod simulerede Enable Banking- og Saxo-API'er, men **ikke mod de rigtige endnu**.
Næste skridt: brugeren sætter GitHub Pages, Cloudflare, Enable Banking og Saxo op på sin Mac efter `SETUP.md`. Hjælp dem trin for trin, og brug "Gem og test"-tjeklisten i appen (`/ping` i workeren) til fejlfinding. Første rigtige synkronisering er der, hvor uventede feltnavne eller formater kan dukke op – tjek dem mod virkeligheden.

## Arbejdsgang mellem to computere (arbejds-PC med Windows og Mac derhjemme)

Den seneste version af projektet ligger som zip på brugerens private claude.ai-artefakt:
**https://claude.ai/artifact/DgmELqiSt5h9GxEDZpM744** ("Budget-app pakke", med `downloads`-capability).

- **Ved start:** Spørg brugeren, om mappen er hentet fra den seneste pakke. Hvis ikke, bed brugeren om at hente den derfra først, så vi ikke overskriver arbejde fra den anden computer.
- **Når en ændring er færdig:**
  1. Tæl `CACHE` i `sw.js` én op, hvis app-filerne er ændret.
  2. Lav `budget-app.zip` af hele mappen med `.nojekyll`, men uden `.claude/` og uden selve zip-filen.
  3. Genudgiv artefakt-siden **med `url` sat til linket ovenfor** (Artifact-værktøjet, `action: "read"` først), så linket forbliver det samme. Siden er en enkelt HTML-fil med zip'en indlejret som base64 og en "Hent budget-app.zip"-knap, der bruger `downloads.save`. Opdatér dato, størrelse og fillisten på siden.
  4. Mind brugeren om at uploade de ændrede filer til GitHub (og worker-koden til Cloudflare, hvis den er ændret).
