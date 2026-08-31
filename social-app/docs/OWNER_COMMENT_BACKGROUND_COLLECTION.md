# Collecte des commentaires publiés en arrière-plan

Les collecteurs Instagram n'utilisent jamais le profil Chrome personnel. Ils démarrent uniquement un Chromium Playwright headless avec un profil dédié stocké sous `social-app/work/`, donc privé et ignoré par Git.

- `scripts/collect_instagram_authored_comment_inventory.mjs` effectue le bootstrap All time et le delta d'inventaire. Il inspecte uniquement des réponses JSON Instagram dans le navigateur isolé, n'en conserve qu'un schéma fermé sans en-têtes, cookies, jetons ni corps brut, puis utilise le DOM virtualisé comme fallback.
- `scripts/collect_instagram_authored_comment_metrics.mjs` réobserve les dates, likes et réponses des cibles déjà attribuées.

## Garanties

- aucune souris, aucun clavier et aucun changement de focus ;
- aucune publication, réaction, réponse ou suppression ;
- arrêt immédiat si la session n'est pas authentifiée, si Instagram affiche un challenge ou limite les requêtes ;
- sauvegarde atomique après chaque cible ;
- une métrique absente reste `null`, jamais zéro ;
- les liens profonds portant l'ID natif sont prioritaires ; un permalink de contenu déjà vérifié peut aussi être contrôlé uniquement si le texte exact de Lofi Girl n'apparaît qu'une fois dans un conteneur de commentaire attribuable ;
- les commentaires sans cible Instagram vérifiée sont comptés comme non résolus et jamais devinés ;
- le checkpoint produit est directement compatible avec `scripts/import_owner_comment_history.mjs`.
- un inventaire n'est `complete` qu'après preuve du filtre All time, de la borne, de deux passes stables, de la fin de pagination et de l'absence de fil ou collision non résolus.

## Exécution

Depuis `social-app`, lancer d'abord l'inventaire, puis l'enrichissement métrique :

```text
npm run owner-comments:instagram:inventory
npm run owner-comments:instagram:collect
```

Le profil dédié doit avoir été authentifié manuellement une seule fois au préalable. Les collecteurs eux-mêmes restent toujours headless et refusent d'automatiser l'authentification. Les checkpoints privés sont écrits sous `work/owner-comments/YYYY-MM-DD/instagram/`. Après contrôle du rapport, l'import se fait avec `scripts/import_owner_comment_history.mjs --input <checkpoint>`.
