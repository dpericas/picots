# Banc de preguntes per al qüestionari

Les millors preguntes són **records reals i compartits** (que la majoria pugui encertar i
que facin riure en sortir la resposta). Aquí hi ha plantilles per curs: omple els
`[claudàtors]` amb els records de la vostra classe i tria'n **5–8** per a la gala
(cada pregunta són ~45 s amb la lectura i la solució).

Consells:
- 3 o 4 opcions curtes (es llegeixen a la pantalla i al mòbil). Les incorrectes, plausibles i divertides.
- Varia la lletra correcta (A, B, C, D) entre preguntes.
- Una **foto** a la pregunta (camp `imatge`) ajuda molt els records d'Infantil.
- Temps: 15 s per a preguntes curtes, 20–25 s si cal mirar una foto.
- Evita preguntes sobre un sol nen (pot incomodar) o que només sàpiga un grup.

## Infantil (P3–P5)

1. Com es deia la nostra classe a P3? — *[nom real]* · [animal] · [color] · [personatge]
2. Quin animal teníem de mascota (o de peluix de la classe)? — [real] · [inventades]
3. On vam anar d'excursió a P4? — [lloc real] · [altres llocs]
4. Quina cançó cantàvem cada matí? — [real] · [altres cançons infantils]
5. Qui era la mestra de P5? — [nom real] · [personatges de conte]
6. *(amb foto)* Què estàvem fent en aquesta foto? — [activitat real] · [altres]

## Cicle inicial (1r–2n)

7. On vam anar de colònies a 2n? — [real] · [altres]
8. Quina obra de teatre / festival vam fer? — [real] · [altres]
9. Quin llibre vam llegir tots junts? — [real] · [altres]
10. Què vam plantar a l'hort? — [real] · [altres]
11. *(amb foto)* De quin any és aquesta foto? — 1r · 2n · 3r · 4t

## Cicle mitjà (3r–4t)

12. Quin projecte vam fer sobre [tema]? — [real] · [altres]
13. Quina sortida ens va agradar més? — [la més votada a classe] · [altres]
14. Quin dia va passar [anècdota coneguda]? — [real] · [altres]
15. Quin esport vam aprendre a educació física? — [real] · [altres]

## Cicle superior (5è–6è)

16. On vam anar de colònies a 6è? — [real] · [altres]
17. Quina va ser la primera paraula/frase en anglès que vam aprendre a cantar? — [real] · [altres]
18. Quants anys fa que anem junts a l'escola? — 6 · **9** · 12 · 15
19. Quants som a la classe? — 21 · **23** · 25 · 27
20. Quin professor ens ha fet riure més? *(pregunta de broma: totes les opcions són professors; es dona per bona la que surti més)*

## Com posar-les a l'app

A l'**Editor del guió** (panell › SESSIÓ › ✏️ Editor del guió) › cue del qüestionari ›
**+ Pregunta**, o directament al `show.yaml`:

```yaml
preguntes:
  - pregunta: "On vam anar de colònies a 2n?"
    opcions: ["A la granja", "A la platja", "A la muntanya", "Al castell"]
    correcta: A
    temps: 20
    imatge: media/preguntes/colonies.jpg   # opcional
```
