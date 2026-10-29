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

Cada pas de l'espectacle és una **cue**: `video`, `diapositives`, `votacio`, `espera`, `entrada`,
`questionari`, `repte`, `mencions` o `mur`.
Les votacions defineixen a quina cue va cada opció (`va_a`). Els detalls i un exemple
complet són al mateix `show.yaml`. Després d'editar-lo, clica **Recarregar guió**: si té
errors, es manté la versió anterior i el panell mostra què falla.

Format de vídeo recomanat: MP4 H.264 + AAC, 1920x1080 o 1280x720,
amb `-movflags +faststart`.

### Entrada triomfal

La cue `entrada` es fa per passos: pantalla d'inici (`text`), un pas per cada nen (la seva
`foto` i el nom en gran, amb confeti i l'`efecte` de so) i un mosaic final amb tots
(`text_final`). GO passa al següent nen, ENRERE torna a l'anterior, i el panell mostra un
botó per a cada nen per saltar-hi directament. L'ordre és el de `participants`, o el de
`ordre` si es vol un altre. Les fotos han de ser verticals (3:4), amb la cara al terç superior;
si un nen no en té, surt el seu avatar o les inicials (i el panell ho avisa).

Cada nen pot tenir un **vídeo d'entrada** (`video_entrada`: el resum del seu pas per l'escola,
amb la seva música integrada). Llavors, al seu pas, GO reprodueix el vídeo a pantalla completa
amb el nom a sota (`nom_sobre_video: false` per treure'l) i, quan acaba, surt la seva targeta
fins al GO següent. El vídeo del nen següent ja està precarregat (sense talls), la música de
fons de la cue calla mentre sonen, i si el projector es reinicia, el vídeo es reprèn on era.
El panell marca amb 🎬 els nens que tenen vídeo.

Durada: amb 23 nens i la franja de 20 minuts del planning (17:05–17:25) hi ha uns 50 s per nen,
comptant el temps de dir el nom i caminar. Recomanació: vídeos d'entrada de 25–35 s.

### Qüestionari

Preguntes tipus Kahoot sobre records de l'escola (`questionari`). Cada pregunta té 2–4 opcions,
la `correcta` (lletra A–D), un `temps` i opcionalment una `imatge`. Amb GO, cada pregunta passa
per tres passos: **es llegeix** (a la pantalla, sense poder respondre) → **resposta oberta**
(compte enrere; al mòbil, botons de colors amb forma ▲◆●■) → **solució** (la correcta destacada,
quants han triat cada opció i la classificació provisional). Al final, **podi**.
Una resposta correcta val de 500 a 1000 punts segons la rapidesa; cada nen només pot respondre
un cop. Si responen tots abans del temps, la solució surt sola (`tancar_quan_tots`).
`classificacio: 0` amaga els punts de la pantalla (cada nen només veu al mòbil si l'ha encertada).
Plans B al panell: **+15 s** i **Repetir pregunta** (esborra les respostes d'aquella pregunta).

### Repte col·lectiu

Un repte de tota la sala que desbloqueja una escena (`repte`). Modalitat `tocs`: tots toquen
el botó gran del mòbil i el comptador comú ha d'arribar a l'`objectiu` abans del `temps`.
Modalitat `tots`: cal que premin «Sóc a punt!» tots els nens que tenen mòbil. Si el superen,
GO va a `si_exit`; si no, a `si_no` (o a la cue de sota). Al panell: començar, aturar, +10 s,
reiniciar, i **Superat / No superat** a mà (pla B sense mòbils: aplaudiments).
Els tocs s'agrupen al mòbil i al servidor, i es desen al diari cada segon (en una caiguda es
perd com a molt l'últim segon). Referència: 23 nens a ~6 tocs/s fan uns 140 tocs/s.

### Mencions (diplomes)

`mencions` funciona com l'entrada triomfal (GO nen a nen i mosaic final) però en daurat, amb
la menció de cada nen a sota del nom. La menció es posa a `mencio` de cada participant o al
mapa `mencions: {id: text}` de la cue (té preferència). El panell avisa dels nens sense menció.

### Mur de missatges

`mur`: els nens envien des del mòbil un missatge curt (fins a 100 caràcters, amb emojis) o un
dibuix fet amb el dit. Amb `moderacio: true` (per defecte) cada missatge espera al panell fins
que el tècnic l'**aprova**; només els aprovats surten a la pantalla (els 8 més recents) i es
poden tornar a treure. Límit per nen: `maxim_per_nen` (3) i un cada 3 s. Els dibuixos no
aprovats només es poden veure des del portàtil del tècnic.

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
npx electron scripts/check-transitions.js --scenario=parade   # entrada amb vídeos de nens
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

## Comandament del presentador

El presentador porta el seu mòbil amb `http://<ip>:8080/remote` (QR a la targeta «PRESENTADOR»
del panell) i entra el PIN de `xarxa.pin_presentador`. Hi veu on som (i el nen actual a l'entrada),
el text que ha de dir (camp `guio` de cada cue), què farà GO, i l'estat de la votació. Pot fer
**GO** i **ENRERE** (doble toc) i **avisar el tècnic** (franja vermella al panell, sense so).
No pot saltar, forçar votacions ni res més. El tècnic el pot **bloquejar** des del panell.
Si tots dos premen GO alhora, només s'avança una vegada.

## Plans B inclosos

- **Vot a mà alçada**: el botó «Mà alçada» de cada opció decideix el resultat sense mòbils.
- **Repte sense mòbils**: «Superat» / «No superat» al panell decideixen la branca.
- **Qüestionari**: +15 s i repetir una pregunta; GO tanca la pregunta en qualsevol moment.
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
