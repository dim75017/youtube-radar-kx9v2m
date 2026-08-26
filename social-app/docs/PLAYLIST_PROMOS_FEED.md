# Feed « Pubs playlists »

## But

Construire un benchmark durable des vidéos qui promeuvent une playlist musicale, puis transformer les mécaniques créatives observées en briefs originaux pour Lofi Girl.

Le feed public ne contient que des cartes dont la métrique affichée est attribuable à l’URL native et dont le dernier compteur de likes vérifié est supérieur ou égal à 10 000. Les candidats non vérifiables restent hors feed ; une panne temporaire ne supprime jamais le dernier snapshot valide.

## Deux voies qui ne doivent pas être confondues

1. **Post natif** : likes, vues et commentaires publics de la publication. Le seuil de 10 000 likes s’applique ici.
2. **Diffusion payante** : présence dans une bibliothèque publicitaire, portée agrégée, pays, dates de diffusion et variantes lorsque la plateforme les expose.

Les likes indiquent une résonance publique. Sans impressions, dépenses, clics et conversions, ils ne prouvent ni un bon coût d’acquisition ni un bon taux de conversion.

## Snapshot initial

Le lancement suit les neuf créations Instagram fournies le 26 août 2026. Toutes sont des vidéos verticales de moins de 20 secondes et leur intégration publique expose `product_type: ad`. Les vidéos concurrentes ne sont ni téléchargées ni republiées : le site conserve une frame de référence et charge l’intégration officielle uniquement après un clic humain.

Les métriques sont historisées comme observations immuables. Un relevé identique n’ajoute pas de doublon ; un nouveau compteur ajoute une observation. Le refresh échoue fermé en cas de `429`, challenge, réponse incomplète ou métrique non attribuable.

## Couverture réaliste

| Surface | Automatisation | Signal de qualification | Limite principale |
|---|---|---|---|
| Instagram natif | URLs connues, watchlists de comptes professionnels et hashtags via accès Meta | Likes natifs ≥ 10 000 | Il n’existe pas d’API officielle exhaustive de recherche globale des Reels concurrents |
| Meta Ads | Ads Library / Ads Archive | Portée, longévité, variantes ; likes natifs seulement si une URL de post est appariée avec certitude | Pas de likes, CTR ou conversions dans la bibliothèque |
| TikTok natif | Compte autorisé via Display API ou fournisseur de social listening licencié | Likes natifs ≥ 10 000 | L’API publique n’est pas un moteur global de recherche concurrentielle |
| TikTok Ads | Commercial Content API / Creative Center | Bande de portée, dates, ciblage et variantes | Données surtout européennes, pas de likes dans les champs paid |
| YouTube Shorts | Search API puis `videos.list` | `likeCount` ≥ 10 000, vues et commentaires officiels | Un classifieur doit confirmer qu’il s’agit bien d’une promo de playlist |
| Google Ads | Ads Transparency Center | Créatif, annonceur, région et dates | Pas de likes ni d’indicateurs de conversion |
| Pinterest | Ads Repository et API Analytics pour les comptes autorisés | Saves, clics et impressions selon accès | Le signal comparable n’est pas le like |

Sources officielles :

- [Instagram API](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api), [Business Discovery](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/business-discovery/), [Hashtag Search](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag-search/)
- [Meta Ads Library API](https://www.facebook.com/ads/library/api/) et [Ads Archive](https://developers.facebook.com/docs/marketing-api/reference/ads_archive/)
- [TikTok Display API](https://developers.tiktok.com/docs/en/display-api-overview), [Commercial Content API](https://developers.tiktok.com/products/commercial-content-api) et [Creative Center](https://ads.tiktok.com/help/article/creative-center?lang=en)
- [YouTube Search](https://developers.google.com/youtube/v3/docs/search/list) et [Videos](https://developers.google.com/youtube/v3/docs/videos)
- [Google Ads Transparency Center](https://adstransparency.google.com/) et [Pinterest Ads Repository](https://ads.pinterest.com/ads-repository/)

## Fichiers et propriété

- `data/playlist-promos/seeds.json` : URLs à suivre et provenance.
- `data/playlist-promos/feed.json` : dernier inventaire qualifié et curation.
- `data/playlist-promos/refresh-status.json` : état de la dernière tentative.
- `scripts/refresh-playlist-promos.mjs` : revalidation quotidienne des URLs connues.
- `public/media/playlist-promos/` : frames fixes du snapshot initial, jamais de vidéo concurrente.

Le workflow « Social · Refresh playlist promos » ne modifie que le feed et son statut. Les briefs créatifs sont conservés lors du refresh et restent sous contrôle humain.

## Garde-fous créatifs

- Production humaine uniquement : storyboard, illustration, animation, tournage, montage et sound design originaux.
- Aucun extrait de film, mème vidéo tiers, personnage concurrent ou métrique Spotify inventée.
- Aucune promesse médicale ou garantie de sommeil rapide.
- Une accroche observée peut inspirer une structure, jamais une copie plan pour plan.
- Le clic sur une référence constitue le seul déclencheur de lecture ; aucun autoplay audio ou vidéo.
