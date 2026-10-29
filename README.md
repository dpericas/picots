# Gala Manager

Aplicació de Windows per dirigir la gala interactiva de final de curs: un sol portàtil
fa de servidor local, projector i panell de control. Els mòbils dels nens s'hi connecten
per WiFi (router propi, sense internet) llegint un QR. El pla complet és a
[`docs/Pla-Gala-Manager.pdf`](docs/Pla-Gala-Manager.pdf).

```
show/            guió (show.yaml) + fitxers multimèdia (media/…)
dades/           es crea sol: diari d'events, secret dels QR, posició del vídeo, registres
src/main/        procés principal d'Electron (finestres, segona pantalla, vigilant)
src/server/      servidor HTTP + WebSocket (port 8080 per defecte)
src/engine/      motor: guió, reductor d'events, diari, vistes per rol
src/web/         pàgines: screen (projector), control (panell), play (mòbil)
scripts/         servidor sense Electron, vídeos de prova, simulador de mòbils
test/            tests (node --test)
```

## Posar-ho en marxa

```bash
npm install
npm run sample-media     # vídeos i fotos de prova (cal ffmpeg)
npm start                # Electron: panell + projector a la 2a pantalla
npm test                 # tests
```

Sense Electron (per desenvolupar des del navegador):

```bash
npm run dev-server                       # http://localhost:8080/control i /screen
npm run simulate -- --n=25 --delay=8     # 25 mòbils falsos que voten sols
```

Paquet per a Windows (ZIP portable, es pot generar des de Linux):

```bash
npm run dist:win    # dist/Gala Manager-<versió>-win.zip
```

Descomprimeix el ZIP al portàtil i copia-hi la carpeta `show/` completa (amb `media/`)
al costat de `Gala Manager.exe`. Les dades es creen a `dades/`, al mateix lloc.
Opcions: `--show=<carpeta>` i `--data=<carpeta>`.

## El guió (`show/show.yaml`)

Cada pas de l'espectacle és una **cue**: `video`, `diapositives`, `votacio` o `espera`.
Les votacions defineixen a quina cue va cada opció (`va_a`). Els detalls i un exemple
complet són al mateix `show.yaml`. Després d'editar-lo, clica **Recarregar guió**: si té
errors, es manté la versió anterior i el panell mostra què falla.

Format de vídeo recomanat: MP4 H.264 + AAC, 1920x1080 o 1280x720,
amb `-movflags +faststart`.

### Pas sense talls entre vídeos

El projector té sempre carregats els vídeos que poden venir després (la cue següent,
o totes les branques d'una votació mentre no està decidida). En canviar de cue, el vídeo
nou entra a sobre de l'anterior i l'anterior no es retira fins que el nou ja pinta, de
manera que mai es veu negre: com a molt, l'últim fotograma uns mil·lisegons.
Amb `fos: 0.8` en una cue de vídeo, hi entra amb un fos encadenat (imatge i so).
Els salts a una cue no prevista també són sense negre, però poden congelar la imatge
un moment mentre el vídeo carrega.

Comprovació automàtica (captura el projector ~60 cops per segon, sense so):

```bash
npx electron scripts/check-transitions.js --scenario=auto     # vídeo → vídeo amb fos
npx electron scripts/check-transitions.js --scenario=jump     # salts i ENRERE
npx electron scripts/check-transitions.js --scenario=layers   # espera/fotos ↔ vídeo
```

## Panell de control

| Tecla | Acció |
|---|---|
| Espai | **GO**: avança. En una votació: obrir → tancar → anar a la branca guanyadora |
| Shift+← | **ENRERE**: torna a la cue anterior del camí seguit |
| P | Pausa / continuar |
| N | Pantalla negra sí/no (només imatge; el so el controla la pausa) |
| E | Pantalla d'espera sí/no |
| Esc | Treure pantalla negra / espera |
| Doble clic a l'escaleta | Saltar a qualsevol cue |

Menú **Projector**: moure'l a una altra pantalla (Ctrl+Shift+M), pantalla completa
(Ctrl+Shift+F) i recarregar-lo (Ctrl+Shift+R).

## Plans B inclosos

- **Vot a mà alçada**: el botó «Mà alçada» de cada opció decideix el resultat sense mòbils.
- **Forçar, reiniciar o allargar** una votació, i regla d'empat configurable.
- **Sense vots**: s'aplica `per_defecte`.
- **Recuperació**: cada acció es desa (amb fsync) a `dades/journal.jsonl`. Si l'app es tanca,
  en reobrir-la continua a la mateixa cue i reprèn el vídeo al segon on era.
- **Projector penjat**: es recarrega sol i torna a l'estat actual.
- **Mòbils**: es reconnecten sols. Cada nen té un QR personal (botó «QR» del panell) que
  recupera la seva identitat des de qualsevol mòbil. «Alliberar» deslliga un mòbil.
- **Nova sessió**: arxiva el diari (`journal-<data>.jsonl`) i comença de zero (per als assajos).

## Seguretat

El panell i el projector només accepten connexions des del mateix portàtil, tret que
es defineixi `xarxa.pin_control` (llavors `/control?pin=…` des d'una tauleta). Els mòbils
només poden triar nom i votar en nom propi.
