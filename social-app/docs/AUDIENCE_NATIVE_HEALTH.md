# Fraîcheur des données Audience natives

Les totaux publics de followers, les courbes Analytics propriétaires et les
démographies sont trois sources distinctes. Le workflow de relevé public ne
transforme jamais un compteur de profil en vues, portée, variation de followers
ou démographie.

## Contrat de fraîcheur

`scripts/check-audience-native-health.mjs` valide d’abord les contrats JSON de
`data/audience-analytics.json` et `data/audience-demographics.json`, puis contrôle
chaque source native avec un seuil strict de 26 heures. Une observation vieille
de exactement 26 heures est acceptée ; elle échoue dès que son âge dépasse 26
heures.

Pour Analytics, le contrôle couvre :

- le `generatedAt` du snapshot ;
- le `lastSuccessfulImportAt` de chaque plateforme ;
- chaque métrique native promise par le dashboard pour la plateforme.

Pour YouTube, vues, temps de visionnage, impressions et engagements sont exigés
en plus des abonnés nets, même si l’ancien importeur CSV ne sait encore lire que
ces derniers. Un simple réimport de la courbe d’abonnés ne peut donc plus
masquer les autres courbes vides.

La fraîcheur d’une métrique vient de la dernière journée `dataThrough` qui porte
réellement une valeur, dans les lignes quotidiennes ou les agrégats de période.
Le `provenance.collectedAt` reste exposé séparément et l’import de chaque
plateforme est lui aussi contrôlé : retélécharger aujourd’hui un vieil export ne
peut donc pas le faire passer pour frais. Une valeur absente est un échec
`missing` ; elle n’est jamais remplacée par zéro.

Une journée native `AAAA-MM-JJ` est considérée couverte jusqu’à sa fin en UTC.
Ainsi, un export normal arrêté à J-1 reste sain pendant J, mais devient rouge au
passage suivant s’il n’a toujours pas avancé.

Pour les démographies, pays, âge et genre sont obligatoires pour YouTube,
Instagram et TikTok. X les déclare actuellement indisponibles : ces trois
dimensions sont auditées et affichées `not-required`, sans prétendre qu’elles ont
été collectées.

## Exécution

```bash
pnpm audience:native:health
pnpm audience:native:health -- --json
pnpm audience:native:health -- --now 2026-09-03T12:00:00.000Z
```

Le workflow `social-update-audience-history.yml` lance ce contrôle pendant ses
deux passages quotidiens. Son étape est indépendante du commit des compteurs
publics : un export natif périmé rend le run rouge, mais n’empêche pas de
conserver un nouveau relevé de followers valide. Le workflow dédié
`social-check-audience-native-health.yml` relance le même contrôle après les deux
fenêtres quotidiennes pour rendre l’incident visible même lorsqu’aucun compteur
public ne change.

## Rafraîchir sans fabriquer de données

Le contrôle est en lecture seule et ne collecte rien. Les données propriétaires
restent importées depuis un manifeste et les exports natifs obtenus avec les
accès du compte :

```bash
pnpm audience:native:import -- --manifest work/owner-analytics/AAAA-MM-JJ/manifest.json
pnpm audience:native:health
```

Le manifeste peut référencer les exports YouTube Studio, Meta Business Suite,
TikTok Studio et X Analytics pris en charge par
`scripts/import-owner-audience-analytics.mjs`. Aucun workflow ne peut produire
ces exports sans session, API ou artefact propriétaire autorisé ; le health check
signale donc leur absence ou leur péremption au lieu d’avancer artificiellement
les timestamps.

L’import reste volontairement local tant qu’aucun producteur authentifié ne sait
générer toutes les sources requises, démographies comprises. Un workflow qui ne
ferait que retélécharger un artefact manuel ne constituerait pas une collecte
quotidienne et ne doit pas être présenté comme tel.
