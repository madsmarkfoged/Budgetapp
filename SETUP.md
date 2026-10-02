# Opsætning af automatisk hentning (Sparekassen Kronjylland + Saxo)

Du skal oprette tre ting. Det tager ca. en time, plus ventetid på Saxos godkendelse.
Menunavnene på de tre sider kan være lidt anderledes, end de er beskrevet her.

```
App (GitHub Pages)  ──►  din Worker (Cloudflare)  ──►  Enable Banking  ──►  Sparekassen Kronjylland
                                                   └►  Saxo OpenAPI
```

Worker'en holder dine hemmelige nøgler og gemmer intet. Dine tal ligger stadig kun på din enhed.

## Før du går i gang (på Mac'en)

- [ ] Mappen `budget-app` er hentet fra den nyeste **Budget-app pakke** på claude.ai og pakket ud.
- [ ] MitID-appen er ved hånden (til Sparekassen og evt. Saxo).
- [ ] Dit Saxo-login.
- [ ] En konto på github.com (gratis).
- [ ] Ca. en time. Saxos godkendelse af live-appen kan tage nogle dage, men du kan lave alt det andet imens.

**Rækkefølge:** Trin 0 → 1 → 2 → 4 (banken virker nu) → 3 → 4 igen (Saxo virker).
Når du har udfyldt worker-oplysningerne i appen, tester **Gem og test** hver nøgle for sig og viser ✓ eller ✕ ud for hver. Så kan du se præcis, hvad der mangler.

---

## 0. Læg appen på GitHub Pages først

Følg README.md. Du skal bruge app-adressen i de næste trin, fx

`https://<dit-brugernavn>.github.io/budget-app/`

Det kaldes **redirect-URL** nedenfor. Den skal skrives præcis ens alle steder, også med `/` til sidst.
Appen viser den selv under *Mere → Bankforbindelser*.

## 1. Cloudflare Worker (gratis)

1. Opret en konto på <https://dash.cloudflare.com>.
2. **Workers & Pages → Create → Worker**. Giv den navnet `budget-bridge`, og tryk **Deploy**.
3. **Edit code**. Slet det, der står, og indsæt hele indholdet af `worker/worker.js`. Tryk **Deploy**.
4. **Settings → Variables and Secrets**. Tilføj:

| Navn | Type | Værdi |
|---|---|---|
| `APP_SECRET` | Secret | En lang adgangskode, du selv finder på |
| `ALLOWED_ORIGINS` | Text | `https://<dit-brugernavn>.github.io` (kun domænet, ingen sti). Tilføj `,http://localhost:8080`, hvis du vil teste lokalt |
| `EB_APP_ID` | Secret | Fra trin 2 |
| `EB_PRIVATE_KEY` | Secret | Fra trin 2 (hele teksten i .pem-filen) |
| `SAXO_APP_KEY` | Secret | Fra trin 3 |
| `SAXO_APP_SECRET` | Secret | Fra trin 3 |
| `SAXO_ENV` | Text | `live`, eller `sim` mens du venter på Saxo |

5. Notér worker-adressen, fx `https://budget-bridge.<noget>.workers.dev`.

## 2. Enable Banking (Sparekassen Kronjylland)

1. Opret en konto på <https://enablebanking.com> og åbn kontrolpanelet.
2. Registrér en ny **application** i **Production**:
   - Redirect URL: din redirect-URL fra trin 0.
   - Privat nøgle: vælg at generere den i browseren, og **eksportér/gem .pem-filen**. Den vises kun én gang.
3. Kopiér **Application ID** → `EB_APP_ID`. Indholdet af .pem-filen → `EB_PRIVATE_KEY`.
   - På Mac'en: højreklik på .pem-filen i Overførsler → *Åbn med → Tekstbehandling* (TextEdit). Vises teksten med formatering, så vælg *Formater → Konverter til ren tekst*. Markér alt med ⌘A, kopiér med ⌘C, og indsæt det hele i Cloudflare, inkl. linjerne `-----BEGIN …-----` og `-----END …-----`.
4. Aktivér appen ved at **linke dine konti** ("Activate by linking accounts"). Vælg Sparekassen Kronjylland, log ind med MitID, og vælg alle de konti, appen skal kunne se.
   - Gratis "restricted" adgang giver kun adgang til de konti, du linker her.

## 3. Saxo OpenAPI

1. Log ind på <https://www.developer.saxo> med dit Saxo-login.
2. Ansøg om en **live-app** til personligt brug. Du er direkte kunde, så du opfylder kravet. Se
   <https://www.developer.saxo/openapi/learn/direct-clients-request-for-openapi-application-credentials-for-the-live-environ>
   - Grant type: **Code** (Authorization Code)
   - Redirect URL: din redirect-URL fra trin 0
3. Når den er godkendt: **App Key** → `SAXO_APP_KEY`, **App Secret** → `SAXO_APP_SECRET`.
4. Imens kan du lave en gratis **SIM**-app (demo-konto) og sætte `SAXO_ENV=sim`. Så kan du prøve flowet med falske data. Skift til live-nøglerne og `SAXO_ENV=live`, når godkendelsen kommer.

## 4. Forbind i appen

1. Åbn appen → **Mere → Bankforbindelser**.
2. Indsæt worker-adressen og `APP_SECRET` → **Gem og test**. Alle punkter skal have ✓. Står der ✕, fortæller teksten ved siden af, hvad der skal rettes i Cloudflare. Tryk **Gem og test** igen bagefter.
3. **Forbind Sparekassen** → log ind med MitID → du kommer tilbage, og posterne hentes.
   - Første gang hentes op til et år tilbage. Har du allerede importeret CSV-filer, starter hentningen dagen efter din nyeste post.
4. **Log ind på Saxo** → dine beholdninger, kurser og kontantbeholdning hentes.

## Til daglig

- Banken synkroniseres automatisk, når du åbner appen (højst hver 8. time), og når du trykker ↻ øverst.
  - Banker må kun give automatiske hentninger ca. 4 gange i døgnet. Når du selv trykker ↻, gælder grænsen ikke, fordi appen oplyser, at du er til stede.
- Saxo: et login holder ca. 40 minutter. Tryk **Log ind** på Hjem eller Investeringer, når du vil opdatere kurserne.
- Bankadgangen skal fornyes med MitID senest efter 180 dage. Appen viser antal dage tilbage og advarer i god tid.

## Hvis noget ikke virker

| Besked i appen | Løsning |
|---|---|
| "Appens adresse … står ikke i ALLOWED_ORIGINS" | Kopiér adressen fra beskeden ind i `ALLOWED_ORIGINS` i Cloudflare, og tryk Deploy |
| "Forkert adgangskode" | Adgangskoden i appen skal være præcis det samme som `APP_SECRET` |
| "EB_PRIVATE_KEY kan ikke læses" | Indsæt hele .pem-teksten igen som ren tekst (se trin 2) |
| "Kunne ikke nå din worker" | Tjek worker-adressen. Den skal starte med `https://` og ende på `.workers.dev` |
| "Banken returnerede ingen konti" | Link kontiene i Enable Banking-kontrolpanelet (trin 2.4), og tryk Forbind igen |
| "grænsen for antal hentninger er nået" | Vent et par timer, eller tryk ↻ selv |

Ændrer du noget i Cloudflare, så husk at trykke **Deploy**, før du tester igen.

## iPhone

Safari og en app, der er lagt på hjemmeskærmen, deler ikke data. Kommer du tilbage fra banken i Safari i stedet for i appen, viser siden en **kode**. Kopiér den, åbn appen, og indsæt den under *Mere → Bankforbindelser → "Har du en kode fra en anden browser?"*. Koden virker kun et par minutter.

## Sikkerhed

- Nøglerne ligger kun som secrets i din Worker, aldrig i appen eller på GitHub.
- Worker'en svarer kun på kald fra din app-adresse med den rigtige `APP_SECRET`.
- Mister du din telefon: skift `APP_SECRET` i Cloudflare, og tilbagekald adgangen i Enable Banking-kontrolpanelet og hos Saxo.
