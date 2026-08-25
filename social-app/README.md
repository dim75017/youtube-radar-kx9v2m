# Lofi Social Radar

Le **Social & Community Intelligence OS** de Lofi Girl analyse les contenus publics des comptes officiels, classe les posts qui surperforment et transforme leurs signaux en idées éditoriales testables.

**Interface unifiée :** https://dim75017.github.io/youtube-radar-kx9v2m/social/

Le code source, les workflows et le site public vivent dans ce dépôt unique. La
branche `main` contient l’application et les données validées ; la branche
`gh-pages` contient uniquement l’export public servi à l’adresse ci-dessus.

## Fonctionnalités

- Recommandations séparées en **Trends vidéos**, **Trends audio**, **Posts recommandés** et **Commentaires**. Le feed audio contient au minimum 50 sons distincts (41 TikTok, 6 Instagram et 3 YouTube), affiche un exemple vidéo lisible directement, le nombre public de vidéos utilisant le son lorsqu’il est disponible, la croissance réellement mesurée et un angle Lofi Girl concret. Il est contrôlé deux fois par jour ; un lot inférieur à 50 ou privé d’une seule miniature TikTok / lecture Instagram n’est pas publié.
- Navigation interactive : Tableau de bord, « Tous les posts » dépliable par plateforme, « Recommandations » dépliable en Posts recommandés, Commentaires et Trends, puis Roadmap.
- Veille « Commentaires » : le radar surveille en continu 97 comptes dont une simple publication est un événement (gaming, ciné, séries, anime, musique, tech, créateurs, sport) et repère aussi ce qui perce ailleurs sur YouTube, Instagram, TikTok et X. Deux voies : la watchlist est relue toutes les 15 minutes via les flux Atom publics, la veille large repasse toutes les 6 heures avec un horizon de 7 jours. Chaque carte affiche le palier du moment, la vitesse réellement mesurée, le temps qu'il reste dans la fenêtre où un commentaire peut encore être lu, et trois réactions courtes dans la voix de Lofi Girl (drôle, smart, complice), avec lecture du post, copie en un clic et file locale « à commenter / fait / passé ». Un moment majeur encore dans sa fenêtre est annoncé une fois dans le salon CM sur Discord. Le radar ne poste jamais un commentaire : il propose, un humain relit et publie.
- Tableau de bord audience : total de followers, évolution issue de relevés réels et taux d’engagement comparable par plateforme. Un filtre commun pilote les deux indicateurs sur 30 jours (vue par défaut), 3 mois, 6 mois, 1 an ou All time. L’engagement utilise tous les posts mesurables publiés dans la fenêtre sélectionnée ; l’évolution des followers repose uniquement sur les observations réellement collectées, sans interpolation ni remplacement des valeurs absentes par zéro.
- Catalogue public de **910 contenus visibles** au 4 août 2026 : 519 YouTube (319 Shorts + 200 posts Communauté), 386 TikTok et 5 X.
- « Tous les posts » ouvre par défaut le classement global YouTube, Instagram, TikTok et X. Son dépliant permet ensuite d’ouvrir une plateforme et ses catégories propres. Les contenus sont triés par likes publics décroissants ; les vues servent uniquement quand les likes ne sont pas disponibles.
- Le filtre de durée (30 jours, 3 mois, 6 mois, 1 an ou All time) et le tri populaire/récent restent disponibles. Le score analytique composite demeure réservé aux analyses et aux idées ; il n’ordonne plus la liste visible.
- Moteur d’idées explicable : chaque proposition cite les posts sources, le signal observé, le hook, le format et les déclinaisons YouTube, Instagram, TikTok et X.
- Décisions éditoriales locales : « À produire », « À retravailler » ou « Écarter ».
- Catégories et sous-catégories de plateformes entièrement interactives. Les aperçus média sont carrés : un clic sur un TikTok ou un Short lance directement le lecteur, un clic sur une image ouvre une grande preview, et les posts texte n’affichent aucune fausse vignette. La vue globale charge progressivement tout l’historique pour rester rapide.
- Interface responsive alignée sur les Radars YouTube et Spotify, avec assets officiels Lofi Girl uniquement.

## Couverture des données publiques

- **YouTube** : uniquement les Shorts et les posts Communauté publics. Les nombres visibles sont des contenus **collectés**, pas des totaux historiques : la fenêtre publique livre actuellement 200 posts Communauté (94 images, 17 sondages et 89 textes), puis arrête sa pagination. Le scanner conserve désormais les relevés de façon cumulative et dédupliquée pour ne plus perdre les posts qui sortent de cette fenêtre. Les vidéos longues et les lives sont entièrement exclus.
- **Dates YouTube** : les 319 Shorts dont la date publique n’est pas récupérable restent inclus dans All time et sont exclus des durées bornées, sans leur inventer une date à partir de l’import.
- **TikTok** : catalogue public visible du profil officiel, avec dates et métriques publiques disponibles.
- **X** : cinq publications actuellement accessibles par le scanner public. Un historique plus profond nécessite l’API X appropriée.
- **Instagram** : le profil officiel déclare 1 673 publications, mais l’historique complet et ses insights nécessitent l’autorisation Meta du compte propriétaire. Aucun chiffre n’est inventé en attendant.

La couverture porte sur les contenus encore publics et visibles : les contenus supprimés, privés ou non répertoriés ne peuvent pas être certifiés par un scan public.

Les filtres « Commentaires » désignent les commentaires écrits par le compte Lofi Girl. Leur collecte complète nécessite les exports ou accès propriétaires des plateformes ; le radar affiche cette limite au lieu de fabriquer des résultats.

## Commandes

```bash
pnpm install
pnpm dev
pnpm build
pnpm build:preview
pnpm test
pnpm audience:refresh
pnpm audio-trends:refresh
pnpm comments:watchlist        # résout les identifiants de chaîne manquants
pnpm comments:refresh          # voie rapide : watchlist, horizon 48 h
pnpm comments:refresh:deep     # voie profonde : horizon 7 jours, élagage
pnpm comments:alert            # annonce les moments majeurs dans le salon CM
pnpm comments:validate
python scripts/collect_public_history.py
```

### Secrets attendus

| Secret | Rôle | Sans lui |
|---|---|---|
| `ANTHROPIC_API_KEY` | Rédaction des trois réactions par le moteur de voix | Les cartes sortent avec des propositions génériques, signalées comme telles dans l'interface |
| `DISCORD_CM_WEBHOOK_URL` | Alerte des moments majeurs dans le salon CM | Rien n'est envoyé, le tableau reste la seule porte d'entrée |

Aucun des deux n'est nécessaire pour que le scan, le classement et la publication fonctionnent.

## Étape suivante

Importer l’historique propriétaire YouTube Posts pour récupérer les publications Communauté antérieures à la fenêtre publique, puis connecter YouTube Data API afin d’ajouter les likes et dates exactes des Shorts. Connecter ensuite les accès propriétaires Meta, TikTok et X et automatiser les relevés à 1 h, 6 h, 24 h, 72 h et 7 jours.
