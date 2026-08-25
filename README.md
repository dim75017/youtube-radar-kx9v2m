# Lofi Radar

Interface unifiée de pilotage Lofi Girl :

- `/` — YouTube
- `/spotify/` — Spotify
- `/social/` — Social (Instagram, TikTok, YouTube et X)

Le moteur Social est isolé sous `social-app/` et construit par le workflow
GitHub Pages principal. Son code source n'est jamais publié dans l'artefact :
seul son export statique est disponible sous `/social/`.

Les trois surfaces conservent leurs moteurs et leurs données propres. Elles
partagent un sélecteur vertical YouTube, Spotify et Social avec des logos SVG
locaux, sans iframe et sans ouverture d'un autre onglet.

Les feeds Social live sont lus depuis `main/social-app/data/`, avec les
snapshots intégrés au build comme repli. Les workflows Social sont préfixés
`social-` dans `.github/workflows/`; aucun ne publie une branche `gh-pages`
séparée.
