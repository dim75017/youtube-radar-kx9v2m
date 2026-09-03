# Architecture fonctionnelle

## Tranche V1 livrée

```text
4 comptes officiels Lofi Girl
  → collecte publique par plateforme
  → normalisation des posts et métriques
  → upsert du contenu + nouveau snapshot horodaté
  → score relatif dans la plateforme
  → top posts + rapprochement cross-platform
  → enseignements éditoriaux descriptifs
```

Le premier écran ne part plus de tendances fictives. Il interroge Instagram, X, TikTok et YouTube, puis affiche les publications réellement exposées par chaque source publique et les limites de couverture éventuelles.

## Données persistées

- `social_accounts` : compte officiel, URL, couverture, statut, abonnés visibles et fraîcheur.
- `social_posts` : contenu normalisé, format, date, miniature, dernières métriques, score et explication.
- `post_metric_snapshots` : relevés successifs immuables des vues et interactions.
- `scan_runs` : tentative par source, durée, résultat, compteurs et erreur éventuelle.
- `data/comment-opportunities/feed.json` : file publique de vidéos à commenter, URLs natives, relevés métriques sourcés, palier de moment, vitesse mesurée, score éditorial et trois réactions courtes par vidéo. Une valeur absente reste `null` et le statut « Accélère » exige au moins deux observations comparables.
- `data/comment-opportunities/watchlist.json` : comptes dont une simple publication est déjà un événement, avec leur identifiant de chaîne YouTube résolu et leur thème. `pnpm comments:watchlist` résout les identifiants manquants depuis les pages publiques.
- `data/comment-opportunities/candidates.json` : relevés de base de la voie rapide. Jamais commité, restauré depuis le cache Actions entre deux passages.
- `data/audience-history.json` : relevés horodatés des followers des quatre comptes, précision de chaque compteur et taux d’engagement dérivé. Les jalons historiques et relevés quotidiens sont conservés sans interpolation.
- `data/audience-analytics.json` : courbes et agrégats propriétaires importés depuis les exports natifs, avec une provenance indépendante pour chaque ligne et métrique réellement observée.
- `data/audience-demographics.json` : répartitions natives par pays, âge et genre, avec leur période et leur date de collecte ; une dimension indisponible reste explicitement absente.
- `data/audio-trends/feed.json` : watchlist d’au moins 50 sons distincts, actuellement structurée pour 41 TikTok, 6 Instagram et 3 YouTube. Chaque entrée conserve sa page audio native, une vidéo de référence distincte et son angle Lofi Girl. Le refresh tourne deux fois par jour et publie uniquement si les 50 identités, les 50 URLs audio, les 50 vidéos de référence, toutes les miniatures TikTok et toutes les lectures Instagram sont vérifiées. Un compteur public indisponible — notamment le volume global des reprises YouTube — reste vide : la croissance est toujours dérivée de deux relevés comparables et n’est jamais inventée.
- `data/playlist-promos/feed.json` : benchmark autonome des créations qui promeuvent une playlist. Les observations natives, le statut paid, la destination DSP, la lecture créative et les briefs humains sont séparés. Le seuil de 10 000 likes porte sur le post natif ; les bibliothèques publicitaires sans likes sont classées par portée et longévité dans une voie distincte.

Les anciennes tables `trends`, `ideas`, `briefs` et `decision_events` restent disponibles pour la phase d’idéation, mais aucune donnée de démonstration n’est plus injectée ou affichée.

## Score de performance

Le score ne compare jamais les volumes bruts de deux plateformes différentes. Il classe un post dans sa cohorte de plateforme à partir des dimensions réellement présentes :

- niveau de vues ajusté à l’âge du post quand sa date est publique ;
- interactions rapportées aux vues lorsqu’elles coexistent ;
- interactions ajustées à l’âge quand les vues manquent mais que la date existe ;
- conversation et partages lorsque disponibles.

Une métrique absente est retirée du calcul et les poids restants sont renormalisés. Elle ne vaut jamais zéro. L’explication conserve la taille de l’échantillon, les métriques disponibles et leurs percentiles.

## Audience et engagement

Analytics applique un filtre commun à l’évolution des followers et au taux d’engagement sur YouTube, Instagram, TikTok et X. Les périodes proposées sont 30 jours (vue par défaut), 3 mois, 6 mois, 1 an et All time.

Pour chaque période, le taux d’engagement correspond à la moyenne des likes et commentaires de tous les posts mesurables publiés dans la fenêtre, divisée par le dernier nombre de followers réellement observé. Les commentaires YouTube publiés par Lofi Girl sont exclus de l’échantillon. Les partages et sauvegardes ne sont pas mélangés au calcul, car ils ne sont pas disponibles de façon comparable sur les quatre plateformes. L’évolution des followers s’appuie exclusivement sur les observations réelles disponibles dans la période sélectionnée, sans interpolation ni repli artificiel vers une autre période.

Un relevé quotidien ajoute uniquement les compteurs réellement récupérés. Si une source échoue, son dernier point valide est conservé ; aucune valeur n’est inventée. Les compteurs arrondis par une plateforme restent explicitement marqués comme tels. Le snapshot validé reste dans `main`, puis le workflow GitHub Pages publie un artefact immuable de la révision demandée. La preview recharge les feeds dynamiques depuis `main` au démarrage, chaque heure et au retour sur l’onglet.

La fraîcheur des exports Analytics et démographiques est contrôlée séparément avec un seuil strict de 26 heures. Le contrôle échoue par plateforme et par métrique à partir de sa provenance réelle ; il expose aussi la dernière journée couverte et ne modifie aucun JSON. Le workflow des totaux publics continue de conserver les relevés réussis même si ce garde-fou natif est rouge. Le contrat complet et les commandes d’exploitation sont décrits dans [AUDIENCE_NATIVE_HEALTH.md](AUDIENCE_NATIVE_HEALTH.md).

## Dépôt et publication

Le dashboard utilise un seul dépôt GitHub. `main` est la source de vérité pour
le code, les tests, les workflows et les JSON validés. Chaque changement de
code valide et reconstruit la preview, puis GitHub Pages publie l’artefact
généré. Les seuls changements de feeds bot-owned sont relus depuis `main` et
n’imposent pas un rebuild. Aucun second dépôt miroir n’est nécessaire.

## Analyse éditoriale

Le moteur rapproche les accroches normalisées afin de repérer le même créatif sur plusieurs plateformes. Les enseignements restent descriptifs : type de contenu dominant dans le top, réseau porteur, écart entre déclinaisons et taille de l’échantillon. Aucune causalité n’est inventée.

## Veille de commentaires

La file « Commentaires » est séparée du feed Trends : elle classe des posts individuels sur lesquels une intervention rapide peut créer de la notoriété. Le classement combine fraîcheur, adéquation à l’univers Lofi, poids du moment et potentiel de réaction ; il ne compare jamais directement les volumes bruts de plateformes différentes. Les commentaires proposés doivent viser un détail précis de la vidéo, tenir en une seule idée, éviter liens, hashtags, appels à l’action et autopromotion, et rester hors des sujets sensibles.

### Deux voies, deux magasins

La détection tourne en deux voies. La **voie rapide** lit toutes les quinze minutes le flux Atom public des comptes de `data/comment-opportunities/watchlist.json`. Ce flux est gratuit, ne demande aucune clé, porte le compteur de vues public et se met à jour quelques minutes après une mise en ligne : c’est ce qui permet à une bande-annonce d’arriver sur le tableau pendant que sa section de commentaires est encore vide. La **voie profonde** repasse toutes les six heures avec un horizon de sept jours, pour rattraper une chaîne injoignable, une vidéo qui ne décolle que le lendemain, et pour élaguer.

Mesurer et publier sont deux métiers différents, donc deux fichiers. `data/comment-opportunities/candidates.json` garde un relevé de tout ce que la watchlist a publié : sans ce point de départ, aucune accélération n’est mesurable. Il change à chaque passage, n’est donc jamais commité et vit dans le cache GitHub Actions. `data/comment-opportunities/feed.json` est le tableau : il ne reçoit que ce qui a franchi une barre, parce qu’un CM doit ouvrir l’outil et voir dix choses à commenter, pas quatre cents mises en ligne.

### Ce qui est mesuré et ce qui est déduit

- `velocity` est calculée sur la paire de relevés comparables la plus récente d’**un seul** compteur, avec une fenêtre d’au moins dix minutes. Deux relevés à une minute d’intervalle fabriqueraient un débit énorme à partir d’un petit écart : ils sont refusés. Sans deuxième relevé, la vitesse reste inconnue, jamais zéro.
- `momentTier` est déduit, jamais déclaré, et revalidé à la lecture du fichier. La mesure prime. Un gros compteur ne vaut un palier que tant que la publication a moins de 48 h, au-delà il décrit un catalogue et non un moment. Seule concession à la réputation : une vidéo fraîche d’un compte majeur de la watchlist est tenue à « gros buzz » tant que son deuxième relevé n’est pas arrivé.
- La **fenêtre d’or** est la partie actionnable de la carte : six heures pour un moment majeur, douze pour un gros buzz, vingt-quatre pour de la veille. Passé ce délai, un commentaire tombe en page neuf de la section.
- `lofiFitScore` et `commentabilityScore` sont des heuristiques éditoriales assumées, regroupées dans `lib/comment-scoring.ts`. Toutes les cartes sont re-notées par la même fonction à chaque passage : deux cartes ne sont comparables que si elles ont été mesurées sur la même échelle.
- Une carte dont le titre ou la description touche à un sujet sensible ne peut pas être publiée en risque faible. Le validateur refuse le fichier.

### Les trois réactions

`lib/lofi-voice.ts` tient le canon du personnage, les archétypes qui fonctionnent et les commentaires réels qui ont marché. Les propositions sont générées par un appel au modèle, puis filtrées : longueur, une seule idée, ni lien ni hashtag ni appel à l’action, pas d’autopromotion, pas de sujet sensible. Une seule ligne refusée invalide le triplet entier, parce que publier deux bons commentaires et un mauvais est pire que n’en publier aucun : personne ne relit le troisième. Le champ `commentsSource` dit d’où viennent les lignes (`voice-engine`, `curated`, `fallback`) et l’interface affiche un avertissement sur les propositions génériques.

### Alerte et publication

`scripts/notify-comment-drops.mjs` annonce dans le salon CM un moment majeur encore dans sa fenêtre, une seule fois, et seulement après que Discord a accepté le message. Rien n’est jamais commenté automatiquement : le CM copie, relit et décide.

La preview embarque le dernier snapshot validé puis recharge son fichier `data/comment-opportunities/feed.json` au démarrage, chaque heure et au retour sur l’onglet. Comme le tableau est relu à l’exécution, les deux voies poussent uniquement ce JSON sur `gh-pages` au lieu de reconstruire tout le site : reconstruire soixante-seize fois par jour coûterait bien plus que le scan lui-même et ne changerait rien à l’écran.

## Suite

1. Accès propriétaires Instagram et TikTok pour la portée, les partages, les sauvegardes et le watch time.
2. YouTube Analytics pour rétention, durée moyenne, sources de trafic et abonnés gagnés.
3. X API avec plafond de dépense explicite pour une chronologie plus profonde.
4. Relevés rapprochés à 1 h, 6 h, 24 h, 72 h et 7 jours.
5. Transformation manuelle d’un enseignement validé en idée puis en brief.
