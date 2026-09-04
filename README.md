# Arcane Decksmith – MTG Sammlung & Deckbuilder

Produktionsnahes, statisches React/TypeScript-Projekt für GitHub Pages + Firebase Auth/Firestore + Scryfall.

## Wichtige Annahmen

- Die Anwendung speichert Kartendaten als schlankes eigenes Schema, nicht als vollständige Scryfall-Objekte.
- Decks werden aus der Sammlung gebaut. Es werden keine fehlenden Karten automatisch aus Scryfall „herbeigezaubert“.
- Commander wird automatisch nur als einzelner Commander gewählt. Partner-/Friends-Forever-/Doctor's-Companion-Kandidaten werden erkannt, ein Paar wird aber bewusst nicht automatisch kombiniert.
- Standard-Decks werden nach Scryfalls `legalities.standard` gefiltert; die offizielle Mindestgröße ist 60 Karten, Sideboard maximal 15.
- Commander wird als 99 + 1 modelliert.
- Preise sind absichtlich nicht Teil des Deck-Scorings.
- Die lokale generative KI ist optional: Transformers.js lädt beim ersten Aufruf ein kleines Modell in den Browser und cached es. Wenn das Gerät/Netzwerk dies nicht zulässt, bleibt der regelbasierte Erklärtext erhalten.

## Lokal starten

1. Node.js 22 installieren.
2. `npm install`
3. `.env.example` nach `.env.local` kopieren.
4. Firebase-Konfiguration eintragen.
5. `npm run dev`
6. Tests: `npm test`
7. Build: `npm run build`

## Firebase

- Authentication: Email/Password aktivieren.
- Firestore Database anlegen.
- Inhalt von `firestore.rules` als Firestore Security Rules veröffentlichen.
- Keine Cloud Functions, kein Storage erforderlich.

## GitHub Pages

Repository als öffentliches Repository anlegen, Dateien committen, Actions aktivieren und unter Settings → Pages → Build and deployment → Source „GitHub Actions“ wählen. Der Workflow baut `dist` und veröffentlicht es.

Bei einem Repository `BENUTZER.github.io/REPO` ist `base: "./"` bewusst gesetzt, damit die Anwendung auch unter einem Unterpfad funktioniert.

## Firebase-Konfiguration und GitHub

Die Firebase Web-Konfiguration ist kein Secret im klassischen Sinn; die eigentliche Absicherung erfolgt durch Firebase Authentication und Firestore Security Rules. Trotzdem sollten Firestore Rules und Auth-Domain korrekt eingerichtet werden.

## Datenschutz

Kartensuche und Bilder gehen direkt an Scryfall. Die Sammlung und Decks liegen bei angemeldeten Nutzern in Firestore. Der Demo-Modus speichert ausschließlich im Browser-LocalStorage.
