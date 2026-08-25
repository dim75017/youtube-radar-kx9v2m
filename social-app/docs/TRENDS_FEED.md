# Feed Trends v6

Le feed public est un snapshot quotidien conservé dans `data/trends/feed.json`. Il est conçu pour afficher au moins 50 tendances distinctes et exploitables, avec Lofi Girl comme univers prioritaire. Lofi Boy reste un complément minoritaire.

## Règles de publication

Un nouveau snapshot n’est publié que si tous les contrôles passent :

- au moins 50 cartes actionnables ;
- au moins 80 % de Lofi Girl dans les 50 premières cartes ;
- une URL native et un fingerprint distincts pour chaque carte ;
- au moins trois créateurs distincts et trois posts natifs indépendants reprenant réellement la même mécanique ;
- le post de référence doit faire partie de cette preuve multi-créateurs ;
- les republications du même clip, compilations et contenus seulement homonymes ne comptent pas ;
- aucune vidéo sous 50 000 likes publics ;
- durée vidéo vérifiée, strictement inférieure à 30 secondes ;
- aucun média `unknown`, aucune trend au stade `watch` dans le feed visible ;
- snapshot quotidien âgé de moins de 26 heures ;
- métriques absentes laissées à `null` et jamais remplacées par zéro ou par une estimation éditoriale.

En cas d’échec, le dernier bon `feed.json` reste intact. Le fichier `data/trends/refresh-status.json` décrit l’essai échoué, et l’Action GitHub échoue visiblement.

## Rafraîchissement quotidien

Le workflow `.github/workflows/refresh-social-trends.yml` lance un scan principal puis un créneau de secours douze heures plus tard. Le second créneau ne contacte aucune source si un succès existe déjà pour la journée en heure de Paris.

Le script `scripts/refresh-social-trends.mjs` :

1. charge le feed validé et les sources de `data/trends/watchlists.json` ;
2. vérifie que chaque page ou API conserve sa structure attendue ;
3. relève les signaux correspondant aux trends qualifiées sans mélanger les métriques entre plateformes ;
4. construit la preuve du run (`sourceChecks`, compteurs, heure et lien GitHub éventuel) ;
5. refuse l’écriture si moins de trois sources ont été réellement parsées ou si le feed tombe sous ses quotas ;
6. écrit le JSON de façon atomique, puis laisse les tests décider si le commit est autorisé.

La preview GitHub Pages embarque le dernier snapshot de secours, puis recharge `data/trends/feed.json` depuis le dépôt public de la maquette au montage, toutes les heures et au retour sur l’onglet. Une mise à jour quotidienne copie uniquement le feed validé dans ce dépôt ; elle ne nécessite pas de reconstruire le bundle du site.

## Niveaux de preuve

- `exact` : valeur renvoyée par une API officielle ou compteur public non abrégé ;
- `platform-estimate` : valeur arrondie affichée par la plateforme ;
- `editorial-observation` : format ou mécanisme observé sur une page publique, sans métrique numérique.

Une vérification quotidienne d’une page éditoriale ne rafraîchit jamais artificiellement les likes ou les vues du post de référence. Chaque métrique conserve sa propre date de capture.

La preuve `reuseEvidence` est elle aussi datée. Un simple post viral reste hors du feed visible tant que deux autres créateurs n’ont pas publié leurs propres adaptations. Pour une trend active, cette preuve doit être revérifiée dans les 72 heures ; une trend stable dispose d’une fenêtre de quatorze jours.

## Limites des plateformes

- **X** : l’API Trends France est utilisée lorsque `X_BEARER_TOKEN` est disponible. Elle peut fournir un signal officiel, mais reste soumise au coût et aux limites du plan X.
- **TikTok** : Creative Center et des trackers publics servent à la découverte. Leur HTML n’est pas une API garantie ; le parseur échoue de façon fermée si la structure change.
- **Instagram** : les listes publiques et la watchlist servent de signaux. Sans jeton Meta professionnel, le radar ne prétend pas disposer d’un feed global natif des audios Reels.
- **YouTube Shorts** : les archives et métadonnées publiques servent de proxy short-form. Une durée courte seule ne prouve pas qu’un contenu est officiellement classé Short ; les cartes conservent l’URL native et la durée observée.

Le produit distingue donc un signal officiel, un tracker public et une observation éditoriale. Un simple HTTP 200 ne devient jamais une preuve de volume ou de viralité.

Sources techniques : [X Trends](https://docs.x.com/x-api/trends/get-trends-by-woeid), [TikTok Creative Center](https://ads.tiktok.com/help/article/how-to-use-trends), [Instagram API](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api), [YouTube Data API](https://developers.google.com/youtube/v3/docs/videos/list).
