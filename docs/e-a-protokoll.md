# E/A-Protokoll zur Modell-Hardware

Die Steuerung trennt Ablauflogik und Hardware über ein **E/A-Abbild** aus benannten Signalen.
Die Simulation (`IO_DRIVER=simulation`) und die reale Hardware (`IO_DRIVER=tcp`) liefern dieselben Signale.
Die Firmware des Modells, etwa ein ESP32/Arduino mit Ethernet/WLAN oder ein SPS-Gateway, muss deshalb
nur dieses Protokoll umsetzen. An der Ablauflogik ändert sich dabei nichts.

## Verbindung

- TCP, die Steuerung ist **Client** und verbindet sich mit `IO_HOST:IO_PORT` (Standard `127.0.0.1:7000`).
- Nachrichten sind JSON-Objekte, **eine Nachricht pro Zeile** (`\n`-terminiert, UTF-8).
- Nach einem Verbindungsabbruch baut die Steuerung die Verbindung jede Sekunde neu auf.
- Für USB/Seriell genügt eine Brücke, z. B. `socat TCP-LISTEN:7000,reuseaddr,fork FILE:/dev/ttyUSB0,b115200,raw,echo=0`.

### Steuerung → Hardware

```json
{"type":"hello","protocol":1,"sections":[{"id":"station","type":"station"}, …]}
{"type":"outputs","seq":42,"data":{"station.drive":false,"station.brakeOpen":false,"drehplattform.drehung.cmd":"ausfahrt", …}}
```

`outputs` enthält immer das **vollständige** Ausgangsabbild und wird bei jeder Änderung gesendet,
sonst spätestens alle 200 ms (Heartbeat).

### Hardware → Steuerung

```json
{"type":"inputs","data":{"safety.estopOk":true,"station.present":true,"drehplattform.drehung.pos":180,"drehplattform.drehung.at":"ausfahrt", …}}
```

`inputs` bei jeder Änderung senden, mindestens aber alle 500 ms. Die **erste** Nachricht nach dem Verbindungsaufbau muss
das vollständige Eingangsabbild enthalten, denn daraus baut die Steuerung die Fahrzeugverfolgung auf. Danach sind
Teilabbilder erlaubt, fehlende Signale behalten ihren letzten Wert. Treffen länger als 1 s keine Eingänge ein, meldet die Steuerung *„Keine Verbindung zur Anlagen-E/A“*
und hält die Anlage an.

## Pflichten der Firmware

1. **Watchdog:** Kommt länger als 500 ms keine `outputs`-Nachricht, schaltet die Firmware alle Ausgänge in den
   sicheren Zustand: Antriebe aus, Bremsen zu, Achsen stehen. Bei Verbindungsabbruch gilt dasselbe.
2. **Halt am Haltesensor:** Meldet `<abschnitt>.present` eine Ankunft (steigende Flanke), stoppt die Firmware den
   Förderantrieb dieses Abschnitts sofort selbst. Eine neue Abfahrt beginnt erst, wenn die Steuerung `drive` weggenommen
   und wieder gesetzt hat. Die Steuerung hält dafür nach jeder Ankunft mindestens `timing.settleTime` (0,3 s) den Antrieb aus.
3. **Achsen:** `…cmd` ist eine benannte Zielposition (z. B. `"ausfahrt"`) oder `null`. Die Firmware fährt die Position an und bleibt
   dort stehen. Bei `null` stoppt die Achse sofort. `…at` meldet den Namen der erreichten Position innerhalb der Toleranz,
   sonst `null`. `…jog` (−1/0/1) ist Tippbetrieb mit reduzierter Geschwindigkeit.
4. **Verriegelung:** Achsen eines Elements mit Verriegelung dürfen sich nur bewegen, solange `…lock.engaged = false` ist.
   Der Bolzen rastet nur in einer definierten Position ein.
5. **Not-Halt:** `safety.estopOk` ist der Zustand des **fest verdrahteten** Not-Halt-Kreises. Der Not-Halt selbst muss die
   Antriebe hardwareseitig abschalten. Die Software meldet und verriegelt den Zustand nur.

## Signalbedeutung

| Signal | Richtung | Bedeutung |
| --- | --- | --- |
| `<id>.present` | Eingang | Boot steht in der Halteposition des Abschnitts |
| `<id>.drive` | Ausgang | Förderantrieb (Reifen/LSM/Band) des Abschnitts ein |
| `<id>.brakeOpen` | Ausgang | Bremse des Abschnitts lüften |
| `<id>.<achse>.pos` | Eingang | Istwert der Achse (Einheit lt. Konfiguration) |
| `<id>.<achse>.at` | Eingang | erreichte benannte Position oder `null` |
| `<id>.<achse>.cmd` | Ausgang | Zielposition oder `null` (Halt) |
| `<id>.<achse>.jog` | Ausgang | Tippbetrieb −1/0/1 |
| `<id>.lock` / `<id>.lock.engaged` | Aus/Ein | Verriegelung einlegen / eingerastet |
| `<id>.restraints.unlock` / `<id>.restraints.locked` | Aus/Ein | Bügel öffnen / alle Bügel verriegelt |
| `<id>.gates.open` / `<id>.gates.closed` | Aus/Ein | Gates öffnen / Gates geschlossen |

Bei einer Fahrt von Abschnitt A nach B setzt die Steuerung `drive` und `brakeOpen` **beider** Abschnitte, bis
`B.present` meldet.

## Testen ohne Hardware

```bash
npm run emulator              # Hardware-Emulator (Simulation hinter TCP) auf 127.0.0.1:7000
IO_DRIVER=tcp npm start       # Steuerung über den TCP-Treiber
```

`tools/hardware-emulator.js` dient zugleich als Referenzimplementierung für die Firmware (Watchdog, Nachrichtenformat).

## Signalliste des Standardlayouts

Erzeugt mit `npm run io-list`. Nach Änderungen am Layout neu erzeugen.

### Eingänge (Hardware → Steuerung)

| Signal | Typ | Bedeutung |
| --- | --- | --- |
| `safety.estopOk` | bool | Not-Halt-Kreis geschlossen (true = in Ordnung) |
| `station.present` | bool | Bahnhof: Boot in Halteposition |
| `station.restraints.locked` | bool | Bahnhof: alle Bügel verriegelt |
| `station.gates.closed` | bool | Bahnhof: Gates geschlossen |
| `drehplattform.present` | bool | Drehplattform: Boot in Halteposition |
| `drehplattform.drehung.pos` | number | Drehplattform: Drehung Istwert [°] |
| `drehplattform.drehung.at` | string\|null | Drehplattform: Drehung erreichte Position (einfahrt \| ausfahrt) |
| `drehplattform.lock.engaged` | bool | Drehplattform: Verriegelung eingerastet |
| `block1.present` | bool | Block 1 · S-Kurve: Boot in Halteposition |
| `block2.present` | bool | Block 2 · Beckenrand: Boot in Halteposition |
| `block3.present` | bool | Block 3 · Kreisbogen: Boot in Halteposition |
| `catchcar.present` | bool | Catch-Car-Lift: Boot in Halteposition |
| `catchcar.wagen.pos` | number | Catch-Car-Lift: Catch Car Istwert [%] |
| `catchcar.wagen.at` | string\|null | Catch-Car-Lift: Catch Car erreichte Position (unten \| oben) |
| `drehlift.present` | bool | Drehlift: Boot in Halteposition |
| `drehlift.hub.pos` | number | Drehlift: Hub Istwert [mm] |
| `drehlift.hub.at` | string\|null | Drehlift: Hub erreichte Position (unten \| oben) |
| `drehlift.drehung.pos` | number | Drehlift: Drehung Istwert [°] |
| `drehlift.drehung.at` | string\|null | Drehlift: Drehung erreichte Position (einfahrt \| ausfahrt) |
| `drehlift.lock.engaged` | bool | Drehlift: Verriegelung eingerastet |
| `block4.present` | bool | Block 4 · Bremsstrecke: Boot in Halteposition |

### Ausgänge (Steuerung → Hardware)

| Signal | Typ | Bedeutung |
| --- | --- | --- |
| `station.drive` | bool | Bahnhof: Förderantrieb ein |
| `station.brakeOpen` | bool | Bahnhof: Bremse lüften |
| `station.restraints.unlock` | bool | Bahnhof: Bügel öffnen |
| `station.gates.open` | bool | Bahnhof: Gates öffnen |
| `drehplattform.drive` | bool | Drehplattform: Förderantrieb ein |
| `drehplattform.brakeOpen` | bool | Drehplattform: Bremse lüften |
| `drehplattform.drehung.cmd` | string\|null | Drehplattform: Drehung Zielposition (einfahrt \| ausfahrt), null = Halt |
| `drehplattform.drehung.jog` | -1\|0\|1 | Drehplattform: Drehung Tippbetrieb |
| `drehplattform.lock` | bool | Drehplattform: Verriegelung einlegen |
| `block1.drive` | bool | Block 1 · S-Kurve: Förderantrieb ein |
| `block1.brakeOpen` | bool | Block 1 · S-Kurve: Bremse lüften |
| `block2.drive` | bool | Block 2 · Beckenrand: Förderantrieb ein |
| `block2.brakeOpen` | bool | Block 2 · Beckenrand: Bremse lüften |
| `block3.drive` | bool | Block 3 · Kreisbogen: Förderantrieb ein |
| `block3.brakeOpen` | bool | Block 3 · Kreisbogen: Bremse lüften |
| `catchcar.drive` | bool | Catch-Car-Lift: Förderantrieb ein |
| `catchcar.brakeOpen` | bool | Catch-Car-Lift: Bremse lüften |
| `catchcar.wagen.cmd` | string\|null | Catch-Car-Lift: Catch Car Zielposition (unten \| oben), null = Halt |
| `catchcar.wagen.jog` | -1\|0\|1 | Catch-Car-Lift: Catch Car Tippbetrieb |
| `drehlift.drive` | bool | Drehlift: Förderantrieb ein |
| `drehlift.brakeOpen` | bool | Drehlift: Bremse lüften |
| `drehlift.hub.cmd` | string\|null | Drehlift: Hub Zielposition (unten \| oben), null = Halt |
| `drehlift.hub.jog` | -1\|0\|1 | Drehlift: Hub Tippbetrieb |
| `drehlift.drehung.cmd` | string\|null | Drehlift: Drehung Zielposition (einfahrt \| ausfahrt), null = Halt |
| `drehlift.drehung.jog` | -1\|0\|1 | Drehlift: Drehung Tippbetrieb |
| `drehlift.lock` | bool | Drehlift: Verriegelung einlegen |
| `block4.drive` | bool | Block 4 · Bremsstrecke: Förderantrieb ein |
| `block4.brakeOpen` | bool | Block 4 · Bremsstrecke: Bremse lüften |
