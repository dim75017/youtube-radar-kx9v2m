# Spotify Radar — politique de données unifiée

Ce dépôt sépare volontairement deux usages qui ne doivent plus être confondus.

## 1. Inventaire de navigation

`Toutes les pistes` et `Tous les artistes` servent à explorer le marché. Ces vues combinent :

- le catalogue historique `Spotify_Radar_data.js` ;
- le catalogue de découverte Soundcharts publié dans `Spotify_Browse_Catalogue_data.js` ;
- les mesures et métadonnées disponibles dans le snapshot Soundcharts actif.

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

Les modifications de cette architecture passent par une pull request et les tests de couche catalogue. Aucun `Revert` direct sur `main` ne doit être utilisé pour opposer ces deux objectifs.
