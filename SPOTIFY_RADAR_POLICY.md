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
