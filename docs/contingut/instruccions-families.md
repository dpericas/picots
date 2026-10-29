# Gala sorpresa de final de curs – què us demanem

*(Per enviar al grup de famílies i professors. **Secret absolut davant dels nens!** 🤫)*

Hola, famílies!

Al juny farem una gala sorpresa per als nostres fills i filles. Cada nen entrarà a la sala
mentre a la pantalla gran es projecta un **vídeo curt amb fotos dels seus anys a l'escola i
la seva cançó**. També hi haurà un espectacle interactiu amb records de tots els cursos.
Per fer-ho, us demanem aquest material. **Data límit: 31 de gener de 2027.**

## 1. Fotos del vostre fill o filla (per al seu vídeo d'entrada)

- **Entre 10 i 20 fotos**, idealment **una o dues de cada curs** (de P3 a 6è) i alguna de més petit.
- **Numerades per ordre cronològic**: `01.jpg`, `02.jpg`, `03.jpg`… (la més antiga primer).
- Fotos originals del mòbil o escanejades; **no** captures de WhatsApp (perden qualitat).
- Que el nen o nena es vegi bé. Verticals o horitzontals, és igual.
- Formats: JPG o PNG.

## 2. Una foto actual

- **Vertical**, de cintura o pit cap amunt, amb la **cara al terç superior**, ben il·luminada,
  fons senzill. Surt en gran quan entra i al diploma.
- Anomeneu-la `actual.jpg`.

## 3. La seva cançó

- La cançó que vulgueu que soni mentre entra (la que més li agrada, la de la família…).
- **Fitxer d'àudio** (MP3 o M4A) — no un enllaç de YouTube o Spotify.
- Si voleu que comenci per un moment concret (p. ex. la tornada), digueu-nos el **minut i
  segon** (p. ex. *1:05*).
- Que la lletra sigui adequada per a tots els públics.

## 4. Per a l'homenatge als professors (opcional)

- Un **vídeo curt (màx. 20 s)** amb un missatge als professors, gravat **en horitzontal**,
  amb bona llum i sense soroll de fons. Pot ser de tota la família.

## 5. Com enviar-ho

Una carpeta amb **el nom del vostre fill/a** i tot a dins, a: **[enllaç a la carpeta compartida]**

```
Marti_Garcia/
  01.jpg  02.jpg  03.jpg … 15.jpg
  actual.jpg
  canco.mp3         (i, si cal: "comença al 1:05")
  homenatge.mp4     (opcional)
```

## 6. Autorització

Les imatges **només es faran servir el dia de la gala**, a l'ordinador de la gala (sense
internet ni xarxes socials) i **s'esborraran després**. Si us plau, signeu l'autorització
adjunta: **[enllaç o full d'autorització]**. Si no voleu que surtin fotos del vostre fill/a,
digueu-nos-ho i li preparem una entrada sense fotos.

## 7. Secret!

Els nens **no en poden saber res**: ni les fotos, ni la cançó, ni la data. Si us pregunten,
la versió oficial és la de l'escola. 😉

Moltes gràcies!
**[Nom de qui ho coordina] · [contacte]**

---

### Per a qui prepara els vídeos (no cal enviar a les famílies)

1. Per cada nen, crear `fonts-entrada/<id>/` (l'id del guió, sense espais) i copiar-hi
   les fotos numerades i la cançó (`canco.mp3`). `actual.jpg` va a `show/media/fotos/<id>.jpg`.
2. Si la cançó ha de començar més tard, crear `fonts-entrada/<id>/config.yaml` amb
   `inici: 65` (segons).
3. `npm run entry-videos -- --actualitza-guio` munta tots els vídeos i els posa al guió.
4. Els vídeos de l'homenatge s'han de muntar en un sol vídeo (`show/media/video/homenatge.mp4`).
