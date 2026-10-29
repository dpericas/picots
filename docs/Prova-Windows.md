# Primera prova a Windows (≈ 1 hora)

Material: el portàtil de la gala, el projector (o una segona pantalla), 3–4 mòbils o tauletes,
el router o la WiFi que es farà servir, i un USB.

## 1. Preparar l'USB (en aquest PC)

1. `npm run dist:win` → `dist/Gala Manager-0.1.0-win.zip`
2. `npm run sample-media` (o el contingut real) i copiar a l'USB:
   - el ZIP
   - la carpeta `show/` sencera (amb `media/`)
   - opcional: `reserva/gala-reserva.mp4` (`npm run backup-video`) per provar el pla B amb VLC

## 2. Instal·lar al portàtil

1. Descomprimir el ZIP a `C:\Gala\` (no a l'Escriptori sincronitzat amb OneDrive).
2. Copiar `show/` dins de `C:\Gala\`, al costat de `Gala Manager.exe` (substituir la que porta el ZIP).
3. Obrir `Gala Manager.exe`:
   - **SmartScreen** («Windows ha protegit l'ordinador»): *Més informació › Executa igualment*
     (l'app no està signada).
   - **Tallafocs**: marcar **Xarxes privades** i *Permet l'accés*. Si es va cancel·lar, en una
     consola d'administrador:
     `netsh advfirewall firewall add rule name="Gala Manager" dir=in action=allow protocol=TCP localport=8080`
   - La WiFi del portàtil ha d'estar com a **xarxa privada** (Configuració › Xarxa › Propietats).

## 3. Recorregut (marca cada punt)

| ✓ | Què | Prova del pla |
|---|---|---|
| ☐ | Win+P › **Ampliar**. Menú Projector › **Identificar pantalles**; triar la del projector a la llista | T02, T24 |
| ☐ | **✔ Tot a punt?**: tot en verd excepte mòbils/presentador; prova de so i patró de prova | T25 |
| ☐ | Escanejar el QR des de 3 mòbils/tauletes, triar noms; una targeta QR impresa | T04, T10 |
| ☐ | Comandament del presentador amb el PIN des d'un mòbil | T18 |
| ☐ | Entrada triomfal amb els vídeos dels nens (sense talls, nom a sota) | T15, T17 |
| ☐ | Vídeos encadenats `cap1 → vot1 → cap2 → cap3` sense negres | T14 |
| ☐ | Votació, qüestionari, repte i mur amb els mòbils | T04, T19, T20, T22 |
| ☐ | Tancar l'app a mig vídeo i tornar-la a obrir: continua on era | T08 |
| ☐ | 🎭 Començar assaig / Tornar a la gala | T26 |
| ☐ | Menú Gala › Exportar diplomes i targetes QR a PDF | T21, T27 |
| ☐ | VLC amb `gala-reserva.mp4`: capítols (Reproducció › Capítol) | — |

## 4. Si alguna cosa falla

Envia'm `C:\Gala\dades\registres\gala-AAAA-MM-DD.log` (té l'hora exacta de cada acció)
i, si és visual, una foto de la pantalla. Les dades de la prova es poden esborrar amb
**Nova sessió** o, al final, menú Gala › **Esborrar dades després de la gala…**.
