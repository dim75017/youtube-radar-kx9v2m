# Spotify Radar — politique de données unifiée

Ce dépôt sépare volontairement deux usages qui ne doivent plus être confondus.

## 1. Inventaire de navigation

`Toutes les pistes` et `Tous les artistes` servent à explorer le marché. Ces vues combinent :

- le catalogue historique issu du tableur `Rachat_catalogue_Spotify_artistes_LOFI`, c'est-à-dire les discographies des artistes ayant déjà sorti avec le label ;
- le catalogue de découverte Soundcharts publié dans `Spotify_Browse_Catalogue_data.js` ;
- les mesures et métadonnées disponibles dans le snapshot Soundcharts actif.

Le catalogue historique possède une voie de confiance bornée à ses identifiants
Spotify exacts : ses pistes restent visibles dès 100 000 streams lifetime, sans
exiger rétroactivement les preuves Soundcharts de genre, d'instrumentalité, d'IA
ou de droits. Cette exception répond au cas d'usage commercial des artistes déjà
connus du label. Une simple valeur `source_tier=trusted_internal_catalogue` ne
suffit jamais : l'identifiant doit exister dans le tableur source versionné.

Toutes les découvertes externes — playlists, Fans Also Like et catalogues
d'artistes découverts — restent soumises aux garde-fous instrumentaux stricts.
Dans les seules vues d'inventaire, `ai_risk=unknown` est affiché « à vérifier »
et peut rester visible lorsque le genre, l'instrumentalité/no-lyrics, les droits,
les identités structurées et le seuil de streams sont tous prouvés. Un risque IA
`high` reste bloquant. Les Opportunités A&R exigent toujours un risque IA faible.
La voie historique n'accorde jamais automatiquement un statut Opportunité, un
moyen de contact ou une éligibilité d'expansion.

Les cohortes de récupération versionnées, notamment le scan Dark Ambient du
24 juillet 2026, sont conservées hors de la projection active tant que la preuve
d'instrumentalité manque. Leur appartenance ne constitue aucune preuve : elle
sert uniquement à les prioriser dans la classification Soundcharts exacte.
Les exclusions manuelles sont appliquées par identifiants Spotify avant toute
voie de confiance interne, afin qu'un refresh quotidien ne les réintroduise pas.

Une ligne peut être vérifiée, mesurée, à écouter, découverte dans une playlist, découverte dans un catalogue artiste ou encore à enrichir. Son affichage ne vaut jamais validation commerciale.

## 2. A&R et contacts

`Opportunités A&R`, les coordonnées, les offres, les seeds d’expansion et toute action commerciale utilisent uniquement le snapshot Soundcharts strict et ses garde-fous :

- identités Spotify + Soundcharts structurées ;
- genre instrumental cible ;
- confiance suffisante ;
- risque IA faible ;
- droits compatibles ;
- seuils de taille artiste et piste ;
- contact public uniquement lorsque tous les contrôles passent.

Les pistes incomplètes restent non contactables.

Pour une track éligible, le collecteur conserve tous les profils publics
explicitement retournés par les identifiants Soundcharts (site officiel,
Instagram, Bandcamp, SoundCloud, etc.) et les présente sous forme d’icônes.
L’e-mail professionnel est prioritaire lorsqu’il est publié ; sinon la fiche
garde l’état « E-mail public à enrichir ». Aucun handle, e-mail ou lien n’est
deviné : l’enrichissement ne peut utiliser que des pages et profils officiels
accessibles publiquement et reste bloqué tant que les garde-fous A&R ne passent
pas.

### Exception contrôlée pour `Sélection`

Un artiste ajouté manuellement à `Sélection` peut faire l’objet d’une recherche
de contact sans attendre qu’il passe tous les garde-fous de promotion A&R. Cette
exception sert uniquement à instruire un dossier déjà choisi par l’équipe : elle
ne rend pas la piste éligible aux `Opportunités`, ne change aucune classification
instrumentale, de droits ou de risque IA et ne crée aucun seed d’expansion.

Le répertoire `Spotify_Selection_Contacts_data.js`, utilisé uniquement par cette
vue, peut contenir :

- les profils publics explicitement retournés par Soundcharts ;
- un e-mail professionnel explicitement publié sur une source vérifiée ;
- des corrections manuelles sourcées qui excluent un profil homonyme ou un canal
  sans moyen de contact.

Spotify, Apple Music et les chaînes YouTube Topic peuvent prouver une identité,
mais ne sont pas présentés comme des moyens de contact. Aucun profil ni e-mail
n’est deviné, aucun message n’est envoyé automatiquement et l’absence de source
fiable est affichée comme telle.

Le pipeline quotidien priorise les artistes inscrits dans
`spotify-selection-artist-seeds.json`, recontrôle leurs profils publics connus
et reconstruit le répertoire. Une sélection qui existe seulement dans le stockage
local du navigateur reste `en attente` tant qu’elle n’a pas rejoint cette file
serveur ; le site statique ne doit jamais prétendre qu’un scan serveur a eu lieu.

Cette exception ne modifie pas la règle fail-closed appliquée partout hors de
`Sélection`.

## 3. Expansion Fans Also Like — phase 1

Le crawl Soundcharts « Fans Also Like » est une source de découverte brute et
non une preuve de compatibilité éditoriale. Sa première phase reste dans un
état SQLite séparé et ne modifie aucun fichier chargé par le dashboard.

- La cohorte source est figée et dédupliquée par identifiants Spotify et
  Soundcharts avant le premier appel. Seuls les artistes actuels avec au moins
  50 000 auditeurs mensuels servent de sources à cette phase ; aucun plafond
  d'audience n'est appliqué.
- Un artiste déjà connu est enregistré comme doublon, jamais réintroduit comme
  nouvelle découverte.
- Les relations FAL sont conservées avant qualification afin de pouvoir
  recalibrer les seuils sans refaire le crawl.
- Une nouvelle discographie n'est approfondie que si l'audience est connue et
  atteint au moins 50 000 auditeurs mensuels, sans plafond, et si l'artiste a
  publié au moins un titre durant les 1 095 derniers jours.
- Les artistes explicitement vocaux, hors taxonomie ou blacklistés sont
  rejetés. Une information absente n'est jamais transformée en preuve.
- `ai_risk=unknown` et `instrumental_status=unknown` restent en revue. Une
  proximité FAL, un nom de playlist ou un genre large ne suffit jamais à les
  convertir en `low` ou `instrumental`.
- Les titres sont dédupliqués par UUID Soundcharts, identifiant Spotify et ISRC
  lorsqu'ils sont disponibles. Les identités encore incomplètes restent en
  staging.
- La phase 1 ne récursive pas sur les nouveaux artistes, ne crée aucune
  Opportunité et n'effectue aucune promotion canonique. Un état des lieux et
  une validation explicite de Dim sont requis avant toute exposition publique.

## 4. Expansion Fans Also Like — audit de promotion

Le backfill d'identifiants Spotify exacts et l'audit de promotion restent deux
étapes distinctes. L'audit compare chaque identifiant de piste FAL au catalogue
canonique courant avec une égalité stricte ; aucun rapprochement flou par nom
d'artiste ou titre n'est autorisé.

Une piste ne peut entrer dans la cohorte privée de validation que si les preuves
suivantes sont explicites : instrumental, absence de lyrics, genre cible,
identité artiste complète, droits non-major compatibles, source approuvée et
revue humaine tracée. Les doublons Spotify/ISRC et les valeurs inconnues sur ces
champs restent exclus. Le nombre d'auditeurs mensuels, la speechiness ou le
career stage ne doivent jamais servir à inventer un statut non-superstar.

Le risque IA suit deux voies bornées :

- un risque élevé bloque toutes les voies ;
- un risque faible et prouvé peut rendre la piste éligible aux Opportunités ;
- un risque inconnu reste « à vérifier » et ne peut entrer que dans la voie
  catalogue, à condition que l'instrumentalité et l'absence de voix soient déjà
  prouvées. Il reste exclu des Opportunités.

La cohorte ligne à ligne est stockée uniquement sous forme chiffrée. Seuls des
comptages agrégés peuvent être publiés comme artefact de workflow. L'audit ne
modifie ni `Spotify_Browse_Catalogue_data.js` ni un autre fichier chargé par le
dashboard. Toute promotion canonique exige encore une validation explicite de
Dim et un changement séparé, revu et testé.

Une piste FAL ne peut rejoindre le catalogue public qu'après cette validation
explicite, avec la provenance dédiée `soundcharts_fal_promoted`, et en passant
encore tous les garde-fous externes (genre, instrumentalité, IA, droits,
identités et 100 000 streams). Le simple fait d'exister dans le staging privé
ne lui accorde jamais cette provenance.

## Intégrité des compteurs Spotify

Un compteur lifetime Soundcharts n'est fusionné que lorsque le plot porte
l'identifiant Spotify exact de la piste (ID, URI ou URL délimitée). Un plot
unique générique ou attribué à une autre piste est inutilisable.

Chaque historique est comparé à sa propre cadence récente. Une rupture extrême,
positive ou négative, est conservée comme événement d'audit mais reste hors des
totaux, deltas, courbes, agrégats et simulations de rachat. Un point aberrant
isolé entre deux compteurs cohérents est retiré. Une rebase calme et persistante
n'est jamais assimilée automatiquement à un changement d'identité : seule une
correction explicite du mapping Soundcharts peut repartir sur la nouvelle base.
Les valeurs Browse (total, date et delta D-1 exact) sont publiées atomiquement,
et la publication échoue si elles divergent de l'historique Performance sûr.

## Règle de maintenance

Ne jamais sécuriser A&R en vidant le catalogue de navigation. Les formes suivantes constituent une régression :

```js
const A = [];
const LEGACY_R = [];
const DISCOVERY_CATALOGUE = {tracks:[],artists:[],counts:{}};
```

Une correction doit préserver simultanément :

1. un catalogue large et vivant dans les vues de navigation ;
2. un moteur A&R strict et fail-closed.

Le catalogue historique approuvé ne doit jamais être vidé par un durcissement
destiné aux découvertes externes. Le test de régression doit conserver sa voie
séparée et son seuil public de 100 000 streams.

Chaque reconstruction quotidienne publie aussi des compteurs de cohortes
(`trusted_internal`, `dark_ambient` et FAL promues) et compare le candidat au
catalogue déjà approuvé avant d'écrire le fichier. Une disparition n'est
automatique que lorsqu'une nouvelle preuve factuelle l'explique explicitement
(compteur sous 100 000, piste vocale, genre hors périmètre, risque IA élevé,
droits major/mixed ou blacklist manuelle). Une donnée simplement absente ou
inconnue bloque la publication au lieu de faire disparaître silencieusement la
ligne. La clé locale `spotify_catalogue_archives_v1` reste stable : les
exclusions manuelles faites dans le dashboard survivent aux actualisations.

Les modifications de cette architecture passent par une pull request et les tests de couche catalogue. Aucun `Revert` direct sur `main` ne doit être utilisé pour opposer ces deux objectifs.
