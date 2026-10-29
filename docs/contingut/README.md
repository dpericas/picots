# Contingut de la gala

Material de partida per preparar el contingut (no és codi):

| Fitxer | Què és | Per a qui |
|---|---|---|
| [guio-conte.md](guio-conte.md) | Proposta de conte: «La missió secreta dels Picots», decisions, repte i què cal produir | Equip organitzador |
| [show-proposta.yaml](show-proposta.yaml) | El guió complet de l'app per a aquesta proposta (23 nens de mostra, textos del presentador, durades) | Tècnic |
| [preguntes-questionari.md](preguntes-questionari.md) | Plantilles de preguntes per curs per al qüestionari | Mestres |
| [mencions-idees.md](mencions-idees.md) | Criteris i ~50 idees de mencions per als diplomes | Mestres |
| [instruccions-families.md](instruccions-families.md) | Missatge per a les famílies: fotos, foto actual, cançó, autorització | Famílies |
| [instruccions-professors.md](instruccions-professors.md) | Vídeo de comiat amb anècdotes per als tutors, especialistes i exprofessors (són els «guardians» de les pàgines del conte) | Professors |

## Calendari (segons el planning)

| Quan | Què |
|---|---|
| Nov.–des. 2026 | Triar el conte i les decisions. Enviar les instruccions a les famílies i als professors. Escriure les preguntes. |
| 31 gen. 2027 | Data límit del material de les famílies. |
| Gen.–feb. 2027 | Avatars. Muntar els vídeos d'entrada (`npm run entry-videos`). Seleccionar les fotos de records per bloc. |
| 15 març 2027 | Data límit dels vídeos dels professors. |
| Mar.–abr. 2027 | Vídeos del conte. Muntar els vídeos dels guardians. Passar la proposta a `show/show.yaml` amb els noms reals, els rètols i les mencions. |
| Maig 2027 | Assajos (mode assaig) amb els temps reals; ajustar les `durada_estimada`. Imprimir targetes QR i diplomes. Generar el vídeo de reserva. |
| Juny 2027 | La gala! «Tot a punt?» a les 16:15. Després: desar el resum i esborrar les dades. |

## Fer servir la proposta

```bash
cp docs/contingut/show-proposta.yaml show/show.yaml
```

Després, al panell › **✏️ Editor del guió**, canvia els noms i ids dels nens, les mencions i
les preguntes. El panell mostra a l'escaleta la **durada estimada** de cada cue i el total.
Amb vídeos d'entrada de 30 s, vídeos dels guardians de 90 s i 15 fotos per curs, la proposta surt
d'uns **95 min** de gala (entrada ~18 min, conte ~40 min, diplomes ~14 min), sense comptar la foto
de grup ni el berenar. Els primers assajos donaran els temps reals.
