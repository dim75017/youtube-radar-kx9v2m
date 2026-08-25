# Sources V1 et limites

État vérifié le 4 août 2026. Les quatre comptes sont `@lofigirl`; la chaîne YouTube stable est `UCSJ4gkVC6NrvII8umztf0Ow`.

| Source | Collecte V1 | Couverture publique | Étape propriétaire |
|---|---|---|---|
| YouTube | Flux Atom officiel de la chaîne | Publications récentes, dates, miniatures et vues ; l’ancien compteur de notation n’est pas présenté comme un compteur de likes | Data API puis Analytics OAuth pour likes, commentaires, watch time, rétention et trafic |
| Instagram | Intégration publique du profil | Jusqu’à six posts, légendes, dates, likes, commentaires et miniatures lorsque Meta livre son bloc riche ; zéro métrique inventée sinon | Instagram API du compte professionnel pour une collecte stable, la portée, les vues, partages et sauvegardes |
| TikTok | Intégration publique du profil | Sélection publique de vidéos et vues ; ce n’est pas une chronologie complète | Display API OAuth pour liste récente, likes, commentaires et partages |
| X | Page publique rendue côté serveur | Cinq posts récents, vues et interactions visibles | API v2 pour pagination, stabilité et profondeur historique |

Ces sources publiques sont volontairement présentées comme des couvertures limitées et susceptibles d’évoluer. Une erreur sur un réseau ne supprime pas les résultats déjà collectés sur les autres.

## Accès officiels à brancher ensuite

- YouTube Data API : <https://developers.google.com/youtube/v3/getting-started>
- YouTube Analytics API : <https://developers.google.com/youtube/analytics/reference/>
- Instagram API : <https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api>
- TikTok Display API : <https://developers.tiktok.com/doc/display-api-overview/>
- X API : <https://docs.x.com/x-api/getting-started/pricing>
