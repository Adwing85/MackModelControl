# Streckenrekonstruktion aus dem Testvideo

Quelle: Video `IMG_0518.MOV` (25 s, 1280 × 720). Ein Boot fährt in einem Testbecken in der Werkstatt.
Ausgewertet wurden zwei Einzelbilder pro Sekunde.

![Rekonstruierte Teststrecke, schematisch](strecke-aus-video.svg)

## Im Video gesehen

| Element | Beobachtung |
| --- | --- |
| Schiene | Unterwasserschiene aus zwei blauen Rohren mit weißen Haltern auf dem Beckenboden. Das Boot schwimmt und folgt ihr. |
| S-Kurve | Schlangenlinie mit zwei Gegenbögen. Das Boot braucht dafür rund **13 s** (0–13 s im Video). |
| Bogen an der Beckenwand | Langer Bogen entlang der Seitenwand bis zur Rückwand, rund **11 s** (13–24,5 s). |
| Kreisbogen auf Stützen | Großer Kreis auf weißen Stützen, hinten hoch aufgeständert, vorne auf Wasserhöhe. Im Video ohne Boot. |
| Drehplattform | Runde Gitterscheibe mit geradem Gleisstück, innerhalb des Kreisbogens. Dreht sich im Video nicht. |
| Boot | 1 Boot mit 12 Plätzen (6 Reihen à 2), fährt durchgehend mit dem Bug voraus und hält unterwegs nicht. |

## Nicht im Video

Bahnhof, Catch-Car-Lift, Drehlift, Blockgrenzen bzw. Haltesensoren und weitere Boote kommen nicht vor.
Offen bleibt auch, wie S-Kurve, Kreisbogen und Drehplattform miteinander verbunden sind und in welche
Richtung der Kreisbogen befahren wird.

## Übernahme in `config/rocking-boat.json`

| Abschnitt | Herkunft | Fahrzeit |
| --- | --- | --- |
| Bahnhof | Annahme | 4 s |
| Drehplattform (180°) | gesehen, Drehwinkel angenommen | 3 s |
| Block 1 · S-Kurve | gesehen | 13 s (gemessen) |
| Block 2 · Beckenrand | gesehen | 11 s (gemessen) |
| Block 3 · Kreisbogen | gesehen, Fahrtrichtung angenommen | 12 s (geschätzt) |
| Catch-Car-Lift | Annahme | 3 s |
| Drehlift | Annahme | 3 s |
| Block 4 · Bremsstrecke | Annahme | 5 s |

Mit 3 Booten ergibt das in der Simulation rund 126 Abfahrten pro Stunde, etwa alle 27 s eine.

## Zu klären

1. Liegt der Bahnhof vor der Drehplattform, und wie weit dreht sie (90° oder 180°)?
2. Wird der Kreisbogen im oder gegen den Uhrzeigersinn befahren, und wo schließt er an S-Kurve und Drehplattform an?
3. Wo sitzen Catch-Car-Lift und Drehlift, und ist der ansteigende Teil des Kreisbogens schon die Liftstrecke?
4. Wo liegen die Haltepositionen bzw. Sensoren? Davon hängt ab, in wie viele Blöcke die lange Unterwasserstrecke zerfällt.
5. Mit wie vielen Booten wird das Modell betrieben?
