# Elpriskollen

En gratis MCP-koppling som låter Claude och ChatGPT svara på frågor om svenska elpriser: kvartspriser för SE1–SE4, idag och imorgon. Den kräver ingen inloggning och sparar ingen data om användarna.

**Lägg till i Claude:** Gå till Customize → Connectors, klicka på + och välj Add custom connector. Använd adressen

```
https://elpriskollen.carlindgren.workers.dev/mcp
```

## Fråga till exempel

- *När ska jag köra diskmaskinen i natt? Den går i 2 timmar.*
- *Vilka timmar är billigast att ladda bilen innan 07:00? Den behöver 4 timmar.*
- *Är elen dyr just nu i Stockholm?*
- *Hur skiljer sig priset mellan SE1 och SE4 idag?*
- *Hur dyr var elen i oktober?*
- *Vad kostar elen egentligen per kWh just nu, med skatt och moms? Jag har 25 öre i överföringsavgift och 6 öre i påslag.*

## Verktyg

| Verktyg | Vad det gör |
| --- | --- |
| `get_prices` | Priser timme för timme eller per kvart för en dag, med snitt, lägsta, högsta, billigaste och dyraste timme |
| `get_current_price` | Priset just nu, hur det står sig mot resten av dagen och de närmaste timmarna |
| `find_cheapest_time` | Den billigaste tiden att köra något, till exempel disk, tvätt eller bilen, inom ett tidsfönster. Svaret visar också hur mycket billigare det är än att starta nu och ungefärlig kostnad om man anger kWh. Den kan även välja flera separata perioder. |
| `get_total_price` | Vad elen faktiskt kostar per kWh: spotpris plus energiskatt och moms, och elbolagets påslag och nätbolagets överföringsavgift om man anger dem. Gäller nu, en viss tid eller dagens snitt. |
| `compare_areas` | Snitt, lägsta och högsta pris i SE1–SE4 för en dag |
| `get_daily_averages` | Dagssnitt för upp till 31 dagar, med periodens billigaste och dyraste dag |
| `send_feedback` | Skickar ett förslag eller en felrapport till utvecklaren. Claude använder det bara när användaren ber om det. |

Priserna är Nord Pools spotpris, utan elbolagets påslag, energiskatt och nätavgift. Moms läggs till om man ber om det. Morgondagens priser publiceras runt kl 13.

`get_total_price` och `find_cheapest_time` räknar också fram totalpriset. Energiskatten följer Skatteverkets nivå för året (36,0 öre/kWh exkl. moms 2026, 9,6 öre lägre i de norra kommunerna med reducerad skatt). Påslag och överföringsavgift anger man själv, antingen i öre/kWh eller som procent av spotpriset för nätbolag med spotindexerad avgift. Fasta månadsavgifter och effektavgifter räknas inte in eftersom de inte beror på hur många kWh man använder.

## Förslag och feedback

Förslag kommer in från formuläret på startsidan och via verktyget `send_feedback`. De sparas i Cloudflare KV (bindningen `FEEDBACK`, som skapas automatiskt) och kan läsas på `/admin`. För att logga in där lägger du till hemligheten `ADMIN_PASSWORD` (minst 12 tecken) under Settings → Variables and Secrets. Användarnamnet kan vara vad som helst. Ett spamskydd begränsar antalet förslag till 5 per IP-adress och timme och 200 per dygn totalt.

Om du vill få en push-notis i mobilen för varje nytt förslag lägger du till hemligheten `NTFY_TOPIC` med ett långt, slumpmässigt ämnesnamn och prenumererar på samma ämne i appen [ntfy](https://ntfy.sh). Notisen innehåller typen av förslag och en kort förhandsvisning, aldrig avsändarens e-post. Om du trycker på notisen öppnas `/admin`.

Lägg också in `NTFY_TOKEN`, en access token som börjar med `tk_` från ett gratis konto på ntfy.sh. Utan den räknar ntfy.sh gratisgränsen per IP-adress, och Cloudflare delar sina utgående IP-adresser med väldigt många andra sajter, så gränsen tar ofta slut. På `/admin/ntfy-test` kan du kontrollera att allt fungerar.

## Data

Elpriser tillhandahålls av [Elpriset just nu.se](https://www.elprisetjustnu.se). Varje dag hämtas en gång och sparas i minnet en stund, så att vi inte belastar deras API i onödan.

## Köra själv

```sh
npm install
npm run dev        # lokalt på http://localhost:8787
npm run check      # typkontroll
npm test           # enhetstester (sommartid/vintertid, negativa priser, billigaste fönster mot brute force)
npm run test:e2e   # kör Workern lokalt mot ett låtsas-API och anropar alla verktyg via MCP-klienten
```

Den körs på Cloudflare Workers, och gratisplanen räcker gott. Sätt `DONATE_URL` i `wrangler.jsonc` till en betallänk för att visa knappen "Bjud på en öl" på startsidan.

## Stöd projektet

Elpriskollen är gratis och byggs på fritiden. Har den sparat dig en slant får du gärna [bjuda på en öl på Ko-fi](https://ko-fi.com/carlindgren) 🍺

## Licens

MIT
