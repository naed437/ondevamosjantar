# Onde vamos jantar?

Pick a mood, say when you're ready, and get a restaurant plus a meeting plan to send to the group chat.

No accounts, no API keys, no cost. Places and opening hours come from OpenStreetMap
(Overpass servers, with Nominatim as a backup when they're busy).

## Run it

```sh
cd ~/ondevamosjantar
python3 -m http.server 8000      # or: npm start
```

Open http://localhost:8000. It has to be served like this rather than double-clicked,
because browsers block modules and location access on `file://` pages.

## What it does

- **Where**: your location, or type an area ("Chiado", "Baixa, Porto").
- **Mood**: eight tiles (surprise us, cosy, date night, cheap, something new, veggie, big table, seafood).
  Each one weights restaurants by cuisine. "Something new" favours cuisines that are rare nearby.
- **When**: the time you're ready, how you're travelling, and how far you'll go.
  Places closed at that time, or closing within the hour, are skipped.
- **Where to meet**:
  - *At the restaurant* (default). If it isn't open yet when you'd arrive, it plans a drink
    at a bar within 500 m until it opens.
  - *Drink first* means you meet at a nearby bar and dinner is about 45 minutes later.
  - *Straight to dinner*.
- **Then**: *Send to the group* (share sheet / WhatsApp), *Pick another* (veto),
  *Let them vote* (3 options; the group replies 1, 2 or 3), *Check reviews*.

OpenStreetMap has no star ratings. Picks are weighted toward good matches with complete
listings (hours, website, cuisine), not reviews.

## Deploying

The `Dockerfile` serves the site with nginx on **port 3000**. There's no build step and no backend.
Point your server or deploy tool at this repo and let it build the Dockerfile.

Serve it over **https**: phones only allow "Use my location" on secure pages, and shared
messages only include a link back to the plan when the app runs on https.

The message the app sends already contains Google Maps links, so friends don't need the app open to follow the plan.

## Tests

```sh
node --test tests/*.test.mjs
```
