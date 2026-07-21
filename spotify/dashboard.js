'use strict';
const D = window.SPOTIFY_RADAR || {t:'?', seed:'?', artists:[], rows:[]};

/* ---------- i18n FR / EN ---------- */
let LANG = 'fr';
try{ LANG = localStorage.getItem('sr_lang') || 'fr'; }catch(e){}
const EN_MAP = {
  "Analyse":"Analysis","Vue d'ensemble":"Overview","Artistes":"Artists","Sorties récentes":"Recent releases","Découverte":"Discovery",
  "Opportunités A&R":"A&R opportunities","Radar A&R":"A&R radar","Pépites à écouter":"Gems to review","Filons confirmés":"Confirmed trends","À enrichir":"Needs enrichment","Pré-sélection":"Pre-selection","Signal de découverte":"Discovery signal","Auditeurs mensuels":"Monthly listeners","Réseau Fans Also Like":"Fans Also Like network","Étape suivante":"Next step","Écoute + genre / IA / droits":"Listen + genre / AI / rights","Aucun filon confirmé":"No confirmed trend","Historique en cours : un filon nécessite des genres fiables, plusieurs artistes et des mesures successives.":"History building: a trend requires reliable genres, multiple artists and successive measurements.","Données Soundcharts non encore exportées.":"Soundcharts data has not been exported yet.","Prêt à contacter":"Ready to contact","À revoir":"Review","Données insuffisantes":"Insufficient data","Genre":"Genre","Instrumental":"Instrumental","Droits":"Rights","Contact":"Contact",
  "Catalogue hors Lofi Records des artistes du label : tout ce qu'ils ont sorti en indépendant ou chez d'autres labels, candidats à distribution, rachat ou avance. Données rafraîchies par le crawl automatique (veille hebdomadaire).":"Everything the label's artists have released outside Lofi Records, independently or on other labels: candidates for distribution, catalog acquisition or advances. Data refreshed automatically by the crawler (weekly watch).",
  "Artistes scannés":"Artists scanned","réguliers":"regulars","occasionnels":"occasional","hors label":"unsigned",
  "Tracks hors Lofi":"Tracks outside Lofi","catalogue analysé":"catalog analyzed",
  "Streams cumulés":"Total streams","hors catalogue Lofi":"outside the Lofi catalog",
  "priorités rachat":"buyout priorities","tracks en indé":"self-released tracks",
  "Sorties 90 j":"Releases (90d)","veille nouveautés":"new-release watch","artistes découverte":"discovery artists",
  "Top artistes par streams hors Lofi":"Top artists by non-Lofi streams","clic = détail des tracks":"click = track details",
  "Top playlists":"Top playlists","clic = ouvrir sur Spotify":"click = open on Spotify",
  "tracks hors Lofi":"tracks outside Lofi","indé":"indie","label":"label","dernière sortie":"last release","streams":"streams",
  "Voir tous les artistes":"View all artists","Indé vs autres labels":"Indie vs other labels","Autre label":"Other label","Sorties par année":"Releases per year",
  "régulier":"regular","occasionnel":"occasional",
  "Toutes les tracks hors Lofi Records. Les lignes vertes dépassent 500 000 streams (priorités). Streams / mois = vélocité depuis la sortie.":"Every track outside Lofi Records. Green rows are above 500,000 streams (priorities). Streams / month = velocity since release.",
  "Rechercher track, artiste, label…":"Search track, artist, label…","Tous":"All","Streams : tous":"Streams: all","Type : tous":"Type: all",
  "Type de sortie : tous":"Release type: all","Type d'artiste : tous":"Artist type: all",
  "tracks indé":"self-released tracks","sur":"of","hors Lofi":"outside Lofi",
  "Aucune track indé. Les tracks de cet artiste sont toutes sous label : passe par la fiche du label (onglet All labels).":"No self-released track. All this artist's tracks are on labels: use the label's page (All labels tab).",
  "Offre suggérée pour cette track":"Suggested offer for this track","Avance à proposer":"Advance to offer",
  "Aucune track retrouvée pour ce label dans la base actuelle.":"No track found for this label in the current database.",
  "Tout voir":"View all","priorités":"priorities","revenu mensuel est.":"est. monthly revenue","sorties 90 j":"releases (90d)",
  "découvertes":"discovered","followers cumulés":"total followers","identifiés":"identified","couvertes":"covered",
  "revenu est. cumulé":"est. lifetime revenue","revenu est.":"est. revenue","revenu":"revenue",
  "Aucune donnée playlists chargée.":"No playlist data loaded.","Aucune donnée labels chargée.":"No label data loaded.",
  "Toutes périodes":"All periods","90 derniers jours":"Last 90 days","12 derniers mois":"Last 12 months","3 dernières années":"Last 3 years",
  "< 1 mois":"< 1 month","< 3 mois":"< 3 months","< 6 mois":"< 6 months","< 12 mois":"< 12 months","< 3 ans":"< 3 years",
  "1 dernier mois":"Last month","3 derniers mois":"Last 3 months","6 derniers mois":"Last 6 months","12 derniers mois":"Last 12 months","Tout l'historique":"All time",
  "Relation label : tous":"Label relation: all","Réguliers chez Lofi (≥10)":"Lofi regulars (≥10)","Occasionnels (1-9)":"Occasional (1-9)","Jamais":"No releases",
  "← Retour":"← Back","tracks":"tracks","Artiste":"Artist","Streams/mois":"Streams/mo","Sortie":"Release","Statut":"Status",
  "Indé":"Indie","détectée":"found","Aucune track ne correspond à ces filtres.":"No track matches these filters.",
  "Chargement…":"Loading…","restantes":"left",
  "Un profil par artiste : volume hors Lofi, part d'indé, priorités ≥ 500k. Clic sur une carte pour ouvrir ses tracks.":"One profile per artist: non-Lofi volume, indie share, ≥500k priorities. Click a card to open its tracks.",
  "Rechercher un artiste…":"Search an artist…","Réguliers chez Lofi":"Lofi regulars","Occasionnels":"Occasional",
  "Tri : streams hors Lofi":"Sort: non-Lofi streams","Tri : tracks ≥ 500k":"Sort: tracks ≥ 500k","Tri : nb de tracks":"Sort: track count","Tri : sortie la plus récente":"Sort: latest release",
  "artistes":"artists","tracks chez Lofi":"tracks on Lofi","découverte":"discovery",
  "Nouvelles sorties hors Lofi des artistes suivis. Le badge « détectée » signale les tracks apparues lors d'un rafraîchissement de veille (après le":"New non-Lofi releases from tracked artists. The “found” badge flags tracks that appeared during a watch refresh (after",
  "j":"d","sorties":"releases","détectées par la veille":"found by the watch",
  "Aucune sortie sur la période. La veille hebdomadaire alimentera cette vue automatiquement.":"No release in this period. The weekly watch will feed this view automatically.",
  "Découverte — expansion hors catalogue":"Discovery — beyond the catalog",
  "Élargissement progressif au-delà des artistes Lofi : artistes similaires (« fans also like ») d'abord, playlists éditoriales par genre ensuite. Chaque artiste découvert entre dans la même file de crawl que le catalogue, puis dans la veille hebdomadaire.":"Progressive expansion beyond Lofi artists: similar artists (“fans also like”) first, editorial playlists by genre next. Each discovered artist joins the same crawl queue as the catalog, then the weekly watch.",
  "Artistes découverts":"Artists discovered","plafond initial : 200":"initial cap: 200","Déjà scannés":"Already scanned","en attente du 1er lot":"waiting for the first batch","% du lot":"% of the batch","Source active":"Active source","playlists éditoriales ensuite":"editorial playlists next",
  "Comment ça va se remplir":"How this will fill up",
  "Récolte":"Harvest","Sur les runs creux de la veille, le crawler récupère les « fans also like » de nos 500+ artistes et les ajoute à la file (plafonné, dédupliqué, hors artistes déjà suivis).":"On idle watch runs, the crawler collects the “fans also like” of our 500+ artists and adds them to the queue (capped, deduplicated, excluding artists already tracked).",
  "Scan":"Scan","Chaque artiste découvert passe dans le pipeline existant : discographie complète, streams, labels. Coût élevé une seule fois.":"Each discovered artist goes through the existing pipeline: full discography, streams, labels. Expensive only once.",
  "Veille":"Watch","Il rejoint ensuite le rafraîchissement hebdomadaire, quasi gratuit. Ses tracks apparaissent dans l'onglet Tracks avec le badge « découverte ».":"It then joins the weekly refresh, nearly free. Its tracks appear in the Tracks tab with the “discovery” badge.",
  "Élargissement":"Expansion","Quand le lot de 200 est digéré, on monte le plafond et on ajoute les playlists éditoriales par genre (lofi, ambient, piano, jazz…) comme seconde source.":"Once the batch of 200 is digested, we raise the cap and add editorial playlists by genre (lofi, ambient, piano, jazz…) as a second source.",
  "Origine":"Origin","scanné":"scanned","en file":"queued",
  "Scan incomplet, pause sécurité Spotify":"Scan incomplete, Spotify safety pause",
  "Recensement des playlists éditoriales Spotify et indépendantes sur nos genres, alimenté par le scanner de mots-clés. Suivi des followers et du fit pour repérer ce qui marche.":"Census of Spotify editorial and independent playlists in our genres, powered by the keyword scanner. Follower and fit tracking to spot what works.",
  "Mots-clés scannés":"Keywords scanned","Compteur déclaré, pas encore exporté automatiquement par le scanner":"Declared count, not yet automatically exported by the scanner","déclaré":"declared",
  "Playlists découvertes":"Playlists discovered","Fiches détaillées":"Detailed profiles",
  "Followers visibles":"Visible followers","Non affichés par Spotify":"Not shown by Spotify","Non affiché par Spotify":"Not shown by Spotify",
  "Spotify ne montre pas le compteur de followers pour cette playlist":"Spotify does not show the follower count for this playlist",
  "toutes tailles confondues":"all sizes combined","du total":"of total","playlists à fort potentiel":"high-potential playlists",
  "Followers cumulés":"Total followers","playlists avec followers visibles":"playlists with visible followers",
  "Qualifiées (≥10k)":"Qualified (≥10k)","Toutes les playlists":"All playlists","Vue liste":"List view","Vue grille":"Grid view","Voir les playlists qualifiées":"View qualified playlists",
  "Aucun artiste ne correspond à ces filtres.":"No artist matches these filters.",
  "Évolution 30j":"30-day change","Tri : évolution 30j":"Sort: 30-day change","Historique en cours":"History building up",
  "Pas encore assez d'historique pour calculer une évolution, repasser dans quelques jours":"Not enough history yet to compute a trend, check back in a few days",
  "Évolution des followers":"Follower growth","Première observation":"First seen","Curateur non renseigné":"Curator not provided",
  "Courbe en cours de constitution : le scan quotidien enregistrera un point par jour. Reviens après le prochain snapshot pour voir la tendance.":"Chart building up: the daily scan will record one point per day. Check back after the next snapshot to see the trend.",
  "L'historique des followers est alimenté par les snapshots quotidiens du scanner.":"Follower history is fed by the scanner's daily snapshots.",
  "Éditoriales":"Editorial","Indépendantes":"Independent","Éditoriale":"Editorial","Indépendante":"Independent","Non déterminé":"Undetermined",
  "Fiche détaillée uniquement":"Detailed profile only",
  "Tri : followers":"Sort: followers","Tri : nb tracks":"Sort: track count","Tri : fit score":"Sort: fit score","Tri : vue récemment":"Sort: recently viewed",
  "Connu depuis":"Known since","Non estimé":"Not estimated","Non exhaustif":"Not exhaustive","Rechercher un label…":"Search a label…",
  "Tri : revenu estimé":"Sort: est. revenue","Tri : streams":"Sort: streams","Tri : connu depuis":"Sort: known since","Tri : streams 30j":"Sort: streams (30d)",
  "Aucun label ne correspond à cette recherche.":"No label matches this search.",
  "Rechercher playlist, curateur, genre…":"Search playlist, curator, genre…","Curateur":"Curator","Mots-clés":"Keywords",
  "Création estimée":"Estimated creation","Dernière observation":"Last observation","Lien":"Link","Ouvrir":"Open",
  "Non estimée":"Not estimated","Estimation":"Estimate","Estimation, pas une date certaine":"Estimate, not a firm date","confiance":"confidence",
  "Détail pas encore récupéré":"Detail not yet retrieved","en attente":"pending",
  "Aucune playlist ne correspond à ces filtres.":"No playlist matches these filters.","Aucune donnée playlists chargée pour le moment.":"No playlist data loaded yet.",
  "Dernier scan le":"Last scan:","artistes scannés":"artists scanned","staging Soundcharts strict":"strict Soundcharts staging","Catalogue + staging Soundcharts strict":"Catalog + strict Soundcharts staging","artistes éligibles":"eligible artists","artistes visibles":"visible artists","tracks Soundcharts strictes intégrées":"strict Soundcharts tracks included","Export Soundcharts le":"Soundcharts export:",
  "Revenu mensuel est.":"Est. monthly revenue","catalogue hors Lofi":"catalog outside Lofi","cumulé":"lifetime",
  "Revenus estimés à":"Revenue estimated at","all-in Spotify, fourchette":"all-in Spotify, range","source Duetti / Loud & Clear 2025-26":"source Duetti / Loud & Clear 2025-26",
  "Revenu est.":"Est. revenue","mois":"mo","mo":"mo","lifetime":"lifetime",
  "Streams total":"Total streams","Streams 30j":"Streams 30d","Revenu total":"Total revenue","Revenu 30j":"Revenue 30d",
  "Revenus":"Revenue","Vue streams":"Streams view","Vue revenus":"Revenue view","Revenus total":"Total revenue","Revenus 30 jours":"Revenue 30 days","Revenus 7 jours":"Revenue 7 days","Revenus 24 heures":"Revenue 24 hours","Revenu lifetime estimé":"Estimated lifetime revenue","streams mensuels est.":"est. monthly streams","Revenu estimé / jour":"Estimated revenue / day","Courbe quotidienne des revenus estimés":"Daily estimated revenue chart","Revenu quotidien estimé d’après les streams":"Daily revenue estimated from streams",
  "Streams 24 h":"Streams 24h","Streams 7 j":"Streams 7d","Streams 24 heures":"Streams 24 hours","Streams 7 jours":"Streams 7 days","Streams 30 jours":"Streams 30 days","Flux de streams":"Stream flow","Flux réel sur la période":"Actual flow over the period",
  "24 h précédentes":"previous 24h","7 j précédents":"previous 7d","30 j précédents":"previous 30d","vs période précédente":"vs previous period",
  "Données partielles":"Partial data","Historique insuffisant":"Not enough history","Aucune extrapolation":"No extrapolation","tracks couvertes":"tracks covered",
  "Fiche Analytics":"Analytics profile","Performance comparée":"Compared performance","Courbe quotidienne":"Daily chart","Streams quotidiens":"Daily streams",
  "Monthly listeners":"Monthly listeners","Évolution des monthly listeners":"Monthly listener trend","Principales contributions":"Top contributors",
  "Signal":"Signal","Rising":"Rising","Hot":"Hot","Non disponible":"Unavailable","Vélocité 7 j":"7-day velocity","Cadence de collecte":"Collection cadence",
  "Followers total":"Total followers","Compteur lifetime":"Lifetime counter","Compteur actuel":"Current counter","Followers 24 h":"Followers 24h","Followers 7 j":"Followers 7d","Followers 30 j":"Followers 30d","Followers 24 heures":"Followers 24 hours","Followers 7 jours":"Followers 7 days","Followers 30 jours":"Followers 30 days","Évolution followers":"Follower change",
  "Placements / rangs connus":"Known placements / ranks","Dernières variations":"Latest changes","Classification":"Classification","Label":"Label",
  "Historique quotidien requis pour cette fenêtre.":"Daily history is required for this window.","Comparaison indisponible tant que la période précédente n'est pas complète.":"Comparison is unavailable until the previous equal period is complete.",
  "est.":"est.","mesuré sur historique réel":"measured from real history","estimation, moyenne depuis la sortie":"estimate, average since release",
  "ans":"yr","Rachat":"Buyout",
  "Simulation d'offre de rachat":"Buyout offer simulator",
  "Choisir le split artiste / label. Avance = prix d'achat de la part cédée. Payback = temps pour rembourser l'avance avec les revenus captés (objectif 2-3 ans).":"Pick the artist / label split. Advance = purchase price of the ceded share. Payback = time to recoup the advance from captured revenue (target 2-3 years).",
  "rachat total":"full buyout","Avance à verser":"Advance to pay","Revenu capté /mois":"Captured revenue /mo","Payback":"Payback","Part cédée au label":"Share ceded to label","Contact":"Contact","contact à trouver":"contact to find",
  "top artiste":"top artist","fidèle":"loyal","Tracks sélectionnées":"Selected tracks","Tout sélectionner":"Select all",
  "Coche les tracks à racheter ci-dessous, choisis le split artiste / label : l'avance et le payback se recalculent. Objectif payback 2-3 ans.":"Tick the tracks to buy below, pick the artist / label split: advance and payback recompute. Target payback 2-3 years.",
  "Aucune track sélectionnée — coche des lignes pour simuler une offre.":"No track selected — tick rows to simulate an offer.",
  "Watchlist":"Watchlist","Date de sortie":"Release date","Ajouter / retirer de la watchlist":"Add / remove from watchlist",
  "Tes tracks et artistes épinglés, à suivre pour un rachat. Stocké dans ce navigateur.":"Your pinned tracks and artists to track for a buyout. Stored in this browser.",
  "Aucune track épinglée. Clique sur l'étoile ☆ d'une track pour la suivre ici.":"No pinned tracks yet. Hit the ☆ on any track to track it here.",
  "Toutes les pistes":"All tracks","Tous les artistes":"All artists","Tous les labels":"All labels","Tout sélectionner":"Select all","email dispo":"email available","Opportunités":"Opportunities","Score":"Score",
  "Veille artistes":"Artist watch","Aucune track.":"No track.",
  "Le top des tracks récentes qui sortent du lot (fort volume de streams par mois, pondéré par la fraîcheur). Les meilleures cibles de rachat. Clique une track pour sa fiche.":"The top recent standout tracks (high monthly streams, weighted by freshness). The best buyout targets. Click a track for its detail sheet.",
  "opportunités":"opportunities","Opportunité":"Opportunity","Très chaud":"Very hot","Chaud":"Hot","Prometteur":"Rising","À suivre":"Watch","Aucune opportunité sur la période.":"No opportunity in this range.",
  "Revenu /mois":"Revenue /mo","Évolution des streams":"Streams trend","en hausse":"rising","en baisse":"declining",
  "Courbe en cours de constitution : la veille hebdomadaire enregistre un point par semaine. Reviens dans quelques semaines pour voir la tendance.":"Curve being built: the weekly watch records one point per week. Come back in a few weeks to see the trend.",
  "Ouvrir sur Spotify":"Open on Spotify","Épinglé":"Pinned","Épingler":"Pin",
  "Revenus & rachat estimés (0,0035$/stream, +20% multi-plateformes, modèle LOFI RECORDS). L'historique des streams est capté par la veille pour tracer la tendance dans le temps.":"Revenue & buyout estimated (0.0035$/stream, +20% multi-platform, LOFI RECORDS model). Stream history is captured by the watch to plot the trend over time.",
  "Aucun artiste épinglé. Clique sur l'étoile ☆ d'une carte artiste.":"No pinned artists yet. Hit the ☆ on any artist card.",
  "Base : revenu 24 mois projeté (vélocité × 0,0035$/stream) → EUR ×0,875, −8% Orchard, −12% coûts, −15% décote. Grille et paramètres repris du modèle LOFI RECORDS. Estimation indicative, hors CIPP (rachat catalogue non éligible).":"Base: projected 24-month revenue (velocity × $0.0035/stream) → EUR ×0.875, −8% Orchard, −12% costs, −15% haircut. Grid and parameters from the LOFI RECORDS model. Indicative estimate, excl. CIPP (catalog buyouts not eligible).",
  "Base : revenu 24 mois projeté (vélocité × 0,0035$/stream, +20% Apple Music & autres plateformes) → EUR ×0,875, −8% Orchard, −12% coûts, −15% décote. Grille du modèle LOFI RECORDS. Publishing = +10% sur l'avance. Coche des tracks pour simuler. Estimation indicative, hors CIPP.":"Base: projected 24-month revenue (velocity × $0.0035/stream, +20% Apple Music & other platforms) → EUR ×0.875, −8% Orchard, −12% costs, −15% haircut. LOFI RECORDS grid. Publishing = +10% on the advance. Tick tracks to simulate. Indicative estimate, excl. CIPP."
};
const T = s => LANG === 'fr' ? s : (EN_MAP[s] !== undefined ? EN_MAP[s] : s);
const HOT = 500000;                       // seuil de mise en évidence
const RATE = 0.0035;                      // $/stream Spotify all-in (Duetti/Loud&Clear 2025-26, fourchette 0.003-0.005)
const TODAY = new Date(D.t + 'T00:00:00');
function money(n){
  if (n==null||n<0) return '?';
  if (n>=1e6) return '$'+(n/1e6).toFixed(n>=1e7?0:1)+'M';
  if (n>=1e3) return '$'+Math.round(n/1e3)+'k';
  return '$'+Math.round(n);
}
function eur(n){
  if (n==null||n<0) return '?';
  if (n>=1e6) return (n/1e6).toFixed(n>=1e7?0:1)+'M€';
  if (n>=1e3) return Math.round(n/1e3)+'k€';
  return Math.round(n)+'€';
}

/* ---------- Modèle de rachat (repris de l'Excel LOFI RECORDS, vDEF 24/06/2026) ---------- */
const BUY = {
  fx: 0.875,          // USD -> EUR
  orchard: 0.08,      // commission Orchard
  costs: 0.12,        // coûts directs
  decote: 0.15,       // décote prudentielle (projection de revenus futurs)
  multiPlat: 0.20,    // uplift Apple Music + autres plateformes (~+20% vs data Spotify seule)
  publishing: 0.10,   // surcoût si on rachète aussi le publishing (option)
  // paliers : clé = "part artiste / part label", adv = avance en % de la base
  paliers: [
    {k:'60/40',  artist:0.60, adv:0.40},
    {k:'70/30',  artist:0.30, adv:0.50},
    {k:'80/20',  artist:0.20, adv:0.60},
    {k:'90/10',  artist:0.10, adv:0.75},
    {k:'100/0',  artist:0.00, adv:1.10},
  ],
};
function palier(){ return BUY.paliers.find(p=>p.k===S.palier) || BUY.paliers[4]; }
// revenu 24 mois projeté (USD) depuis la vélocité de streams Spotify, majoré multi-plateformes
function rev24(monthlyStreams){ return monthlyStreams * 24 * RATE * (1+BUY.multiPlat); }
// base de référence (EUR) nettoyée, comme le calculateur de l'Excel
function baseRef(monthlyStreams){
  const e = rev24(monthlyStreams) * BUY.fx;
  return e * (1-BUY.orchard) * (1-BUY.costs) * (1-BUY.decote);
}
// revenu mensuel net capté par le label (EUR) au palier courant (multi-plateformes inclus)
function labelMonthly(monthlyStreams){
  const p = palier();
  return monthlyStreams * RATE * (1+BUY.multiPlat) * BUY.fx * (1-BUY.orchard) * (1-BUY.costs) * (1-p.artist);
}
// avance (coût de l'offre) EUR au palier courant, +publishing si activé
function advance(monthlyStreams){ return baseRef(monthlyStreams) * palier().adv * (S.publishing?1+BUY.publishing:1); }
// payback en mois
function payback(monthlyStreams){
  const m = labelMonthly(monthlyStreams);
  return m>0 ? advance(monthlyStreams)/m : null;
}
function paybackTxt(months){
  if (months==null) return '—';
  if (months >= 120) return '>10 '+T('ans');
  const y = months/12;
  return y<1 ? Math.round(months)+' '+T('mois') : y.toFixed(1)+' '+T('ans');
}
function paybackClass(months){
  if (months==null) return '';
  if (months<=24) return 'pb-good';
  if (months<=36) return 'pb-mid';
  return 'pb-bad';
}

/* ---------- préparation ---------- */
// artists: [nom, nbLofi, flag, done, disco, origine, seedSrc]
// rows:    [ai, track, date, streams, statut(0 self/1 autre), label, id, firstSeen]
const A = (D.artists || []).map(artist=>Array.isArray(artist)?artist.slice():artist);
/* Explicit quarantine requested by Dim for mainstream/vocal identities. This
   applies to the general views as well as to future Soundcharts merges. */
const GENERAL_VIEW_QUARANTINED_ARTISTS = new Set([
  'powfu','metallica','michael jackson','justin bieber','bruno mars','shakira','lady gaga',
  'pitbull','david guetta','calvin harris','dua lipa','kendrick lamar','black eyed peas',
  'sean paul','jennifer lopez','ellie goulding','bring me the horizon','a$ap rocky','asap rocky',
  'sarcastic sounds','rxseboy','sody'
]);
function generalArtistKey(value){ return String(value||'').trim().toLowerCase(); }
/* A display credit is not an artist identity. Separators used by providers for
   collaborations must be resolved through the structured artist array first. */
function isCompositeArtistCredit(value){
  const name=String(value||'').trim();
  return /[&,]/.test(name)
    || /(?:^|\s)(?:feat(?:uring)?|ft|x|×)\.?(?:\s|$)/i.test(name);
}
function isGeneralArtistQuarantined(value,structuredComplete=false){
  const key=generalArtistKey(value);
  return !key
    || GENERAL_VIEW_QUARANTINED_ARTISTS.has(key)
    || (isCompositeArtistCredit(value)&&!structuredComplete);
}
/* Preserve the historical catalogue. If its existing discriminator explicitly
   marks a retired discovery row, or the artist is in the reviewed vocal/
   mainstream quarantine above, keep the source data but hide it from the
   instrumental general views. */
const LEGACY_R = (D.rows || []).filter(row=>{
  const artist=A[Number(row&&row[0])];
  return artist && Number(artist[4]||0)!==1
    && !isGeneralArtistQuarantined(artist[0]);
});
/* Keep the reviewed historical catalogue in the general views, then merge only
   the strict Soundcharts additions below. A&R and FAL expansion still use the
   stricter structured Soundcharts gates and never inherit from this array. */
const R = LEGACY_R.map(row=>Array.isArray(row)?row.slice():row);
/* Raccord progressif aux historiques journaliers validés.
   Le dashboard ne lit jamais SQLite et ne promeut aucune table staging. Un export approuvé
   pourra définir window.SPOTIFY_PERFORMANCE avant ce script avec ce contrat :
   {
     source:'soundcharts_staging',
     tracks:{spotifyId:{history:[[date,cumulativeStreams]],cadence_days,label,signal}},
     artists:{spotifyId:{monthly_listeners_history:[[date,value]],signal}},
     playlists:{spotifyId:{history:[[date,followers]],placements:[],last_variations:[]}}
   }
   D.hist et PL.hist restent compatibles. Sans points quotidiens suffisants, l'UI affiche —. */
/* Le même export peut progressivement fournir `classification` sur les entrées tracks
   et artists : genre, subgenres, genre_confidence, genre_source, instrumental,
   instrumental_confidence, ai_risk, ai_risk_confidence et ai_risk_source.
   Le dashboard ne déduit jamais ces champs du catalogue et ne touche pas au staging. */
const PERF = window.SPOTIFY_PERFORMANCE || {};
const PERF_TRACKS = PERF.tracks || {};
const PERF_ARTISTS = PERF.artists || {};
const PERF_PLAYLISTS = PERF.playlists || {};
const SC = window.SPOTIFY_SOUNDCHARTS || null;
/* Le staging Soundcharts est volontairement injecté dans les vues globales sans
   modifier le catalogue historique : chaque ligne garde son marqueur `sc`. */
const SC_STAGING = {artists:0, tracks:0};
function scField(row,schema,name){ const i=(schema||[]).indexOf(name); return i<0?null:row[i]; }
function scKey(v){ return String(v||'').trim().toLowerCase(); }
const SC_ALLOWED_GENRES = new Set([
  'lofi_hip_hop','guitar','acoustic','fingerstyle','nature','soundscape',
  'jazz_jazzhop','classical','ambient','piano',
  'halloween_lofi','christmas_lofi','dark_ambient','phonk_instrumental','dnb_instrumental'
]);
const SC_MIN_LISTENERS = 1000;
const SC_MAX_LISTENERS = 5000000;
const SC_MAX_TRACK_STREAMS = 250000000;
function scVerifiedOpportunityIndex(){
  const out=new Map();
  if(!SC||!Array.isArray(SC.opportunities)) return out;
  const schema=(SC.schemas&&SC.schemas.opportunities)||[];
  for(const row of SC.opportunities){
    const spotifyId=String(scField(row,schema,'spotify_id')||'');
    const status=String(scField(row,schema,'opportunity_status')||'').toLowerCase();
    const genre=String(scField(row,schema,'primary_genre')||'');
    const genreConfidence=Number(scField(row,schema,'genre_confidence'));
    const instrumental=String(scField(row,schema,'instrumental_status')||'').toLowerCase();
    const instrumentalConfidence=Number(scField(row,schema,'instrumental_confidence'));
    const ai=String(scField(row,schema,'ai_risk')||'').toLowerCase();
    const rights=String(scField(row,schema,'rights_status')||'').toLowerCase();
    const artists=Array.isArray(scField(row,schema,'artists'))?scField(row,schema,'artists'):[];
    const structured=artists.length>0&&artists.every(artist=>
      String(artist&&artist.spotify_id||'')&&String(artist&&artist.soundcharts_uuid||''));
    if(!spotifyId||status!=='verified'||!SC_ALLOWED_GENRES.has(genre)
      ||instrumental!=='instrumental'||!Number.isFinite(instrumentalConfidence)||instrumentalConfidence<0.5
      ||!Number.isFinite(genreConfidence)||genreConfidence<0.5
      ||!['low','faible'].includes(ai)
      ||!['self_released','independent_label','indie'].includes(rights)
      ||!structured) continue;
    out.set(spotifyId,{row,genre,genreConfidence,instrumental,instrumentalConfidence,ai,rights,artists});
  }
  return out;
}
const SC_VERIFIED_OPPORTUNITIES=scVerifiedOpportunityIndex();
function scHasCompleteStructuredArtists(artists){
  return Array.isArray(artists)&&artists.length>0&&artists.every(artist=>
    String(artist&&artist.spotify_id||'').trim()
      &&String(artist&&artist.soundcharts_uuid||'').trim());
}
function scArtistPairKey(spotifyId,soundchartsUuid){
  const spotify=String(spotifyId||'').trim();
  const soundcharts=String(soundchartsUuid||'').trim();
  return spotify&&soundcharts?`${spotify}\u0000${soundcharts}`:'';
}
function scSanitizedArtistPairIndex(){
  const out=new Map();
  if(!SC||!Array.isArray(SC.artists)) return out;
  const schema=(SC.schemas&&SC.schemas.artists)||[];
  for(const row of SC.artists){
    const key=scArtistPairKey(
      scField(row,schema,'spotify_id'),
      scField(row,schema,'soundcharts_uuid')
    );
    const rawListeners=scField(row,schema,'monthly_listeners');
    const listeners=Number(rawListeners);
    if(!key||rawListeners===null||rawListeners===''||!Number.isFinite(listeners)
      ||listeners<SC_MIN_LISTENERS||listeners>SC_MAX_LISTENERS) continue;
    out.set(key,{row,listeners});
  }
  return out;
}
const SC_SANITIZED_ARTISTS_BY_PAIR=scSanitizedArtistPairIndex();
function scSanitizedArtistPair(artist){
  const key=scArtistPairKey(
    artist&&artist.spotify_id,
    artist&&artist.soundcharts_uuid
  );
  return key?SC_SANITIZED_ARTISTS_BY_PAIR.get(key)||null:null;
}
function scHasEligibleSanitizedArtists(artists){
  return scHasCompleteStructuredArtists(artists)
    &&artists.every(artist=>Boolean(scSanitizedArtistPair(artist)));
}
/* General catalogue views only promote explicitly eligible instrumental
   tracks. Unknown/needs-listen material remains available to the track-first
   A&R radar through SC.opportunities, but never becomes a general-view source. */
function scGeneralTrackEligible(row,schema){
  const spotifyId=String(scField(row,schema,'spotify_id')||'').trim();
  const soundchartsUuid=String(scField(row,schema,'soundcharts_uuid')||'').trim();
  const genre=String(scField(row,schema,'primary_genre')||'');
  const genreConfidence=Number(scField(row,schema,'genre_confidence'));
  const instrumental=String(scField(row,schema,'instrumental_status')||'').toLowerCase();
  const instrumentalConfidence=Number(scField(row,schema,'instrumental_confidence'));
  const ai=String(scField(row,schema,'ai_risk')||'').toLowerCase();
  const rights=String(scField(row,schema,'rights_status')||'').toLowerCase();
  const rightsConfidence=Number(scField(row,schema,'rights_confidence'));
  const expansion=String(scField(row,schema,'expansion_status')||'').toLowerCase();
  const rawStreams=scField(row,schema,'streams');
  const streams=Number(rawStreams);
  const artists=scField(row,schema,'artists');
  return Boolean(spotifyId&&soundchartsUuid)
    &&SC_ALLOWED_GENRES.has(genre)
    &&Number.isFinite(genreConfidence)&&genreConfidence>=0.5
    &&instrumental==='instrumental'
    &&Number.isFinite(instrumentalConfidence)&&instrumentalConfidence>=0.5
    &&['low','faible'].includes(ai)
    &&['self_released','independent_label','indie'].includes(rights)
    &&Number.isFinite(rightsConfidence)&&rightsConfidence>=0.5
    &&expansion==='eligible'
    &&rawStreams!==null&&rawStreams!==''
    &&Number.isFinite(streams)&&streams>=0&&streams<=SC_MAX_TRACK_STREAMS
    &&scHasEligibleSanitizedArtists(artists);
}
function scEditorialIndex(){
  const out=new Map();
  if(!SC||!SC.editorial||!Array.isArray(SC.editorial.artists)) return out;
  const schema=SC.editorial.artist_schema||[];
  for(const row of SC.editorial.artists){
    const uuid=scField(row,schema,'soundcharts_uuid'); if(!uuid) continue;
    out.set(uuid,{
      uuid,
      spotifyId:scField(row,schema,'spotify_id')||'',
      name:scField(row,schema,'name')||'',
      listeners:Number(scField(row,schema,'monthly_listeners'))||0,
      qualifies:Number(scField(row,schema,'qualifies'))===1,
      genre:String(scField(row,schema,'primary_genre')||''),
      genreConfidence:Number(scField(row,schema,'genre_confidence')),
      instrumental:String(scField(row,schema,'instrumental_status')||'').toLowerCase(),
      instrumentalConfidence:Number(scField(row,schema,'instrumental_confidence')),
      ai:String(scField(row,schema,'ai_risk')||'').toLowerCase(),
      expansion:String(scField(row,schema,'expansion_status')||'review').toLowerCase()
    });
  }
  return out;
}
const SC_EDITORIAL_BY_UUID=scEditorialIndex();
function scScopeEligible(uuid,listeners,rights='unknown'){
  const meta=SC_EDITORIAL_BY_UUID.get(uuid); if(!meta) return false;
  const audience=Number(listeners||meta.listeners||0);
  const normalizedRights=String(rights||'unknown').toLowerCase();
  return meta.expansion==='eligible'
    && meta.instrumental==='instrumental'
    && Number.isFinite(meta.instrumentalConfidence) && meta.instrumentalConfidence>=0.5
    && ['low','faible'].includes(meta.ai)
    && SC_ALLOWED_GENRES.has(meta.genre)
    && Number.isFinite(meta.genreConfidence) && meta.genreConfidence>=0.5
    && audience>=SC_MIN_LISTENERS && audience<=SC_MAX_LISTENERS
    && !['major','major_label','mixed'].includes(normalizedRights);
}
function mergeSoundchartsStaging(){
  if(!SC) return;
  const artistById=new Map(), artistByUuid=new Map();
  /* A structured ID may exist on an old malformed display-credit row. Do not
     let that row become visible again through an otherwise safe SC merge. */
  A.forEach((a,i)=>{
    if(a[7]&&!isGeneralArtistQuarantined(a[0])) artistById.set(a[7],i);
  });
  const addArtist=(name,id,meta={},allowNew=false)=>{
    const structuredComplete=Boolean(String(id||'').trim()&&String(meta.uuid||'').trim());
    if(isGeneralArtistQuarantined(name,structuredComplete)) return -1;
    const mergeArtist=(i)=>{
      const artist=A[i];
      if(id&&!artist[7]) artist[7]=id;
      artist.sc=Object.assign({listeners:0,sources:0,rank:null,qualifies:false},artist.sc||{},meta);
      if(id) artistById.set(id,i);
      if(meta.uuid) artistByUuid.set(String(meta.uuid),i);
      return i;
    };
    const uuid=String(meta.uuid||'');
    if(uuid&&artistByUuid.has(uuid)) return mergeArtist(artistByUuid.get(uuid));
    if(id&&artistById.has(id)) return mergeArtist(artistById.get(id));
    /* Never resolve an identity from a display name. A missing structured ID
       keeps the artist in staging quarantine and prevents composite credits. */
    if(!name||!id||!allowNew) return -1;
    const row=[name,0,'sc',false,true,'soundcharts_staging','fans_also_like',id||'','','',''];
    row.sc=Object.assign({listeners:0,sources:0,rank:null,qualifies:false},meta);
    const i=A.push(row)-1; artistById.set(id,i); if(uuid)artistByUuid.set(uuid,i); SC_STAGING.artists++; return i;
  };
  /* Editorial profiles are the strict public artist allowlist: instrumental,
     in-scope genre, low AI risk and bounded audience. */
  for(const profile of SC_EDITORIAL_BY_UUID.values()){
    if(!scScopeEligible(profile.uuid,profile.listeners)) continue;
    addArtist(profile.name,profile.spotifyId,{
      listeners:profile.listeners,
      qualifies:profile.qualifies,
      uuid:profile.uuid,
      scopeEligible:true,
      classification:{genre:profile.genre,genre_confidence:profile.genreConfidence,genre_source:'soundcharts_strict',instrumental:profile.instrumental,instrumental_confidence:profile.instrumentalConfidence,ai_risk:profile.ai,ai_risk_source:'soundcharts_strict'}
    },true);
  }
  const artistSchema=(SC.schemas&&SC.schemas.artists)||[];
  for(const row of (SC.artists||[])){
    const uuid=scField(row,artistSchema,'soundcharts_uuid')||'';
    const listeners=Number(scField(row,artistSchema,'monthly_listeners'))||0;
    const eligible=scScopeEligible(uuid,listeners);
    if(!eligible) continue;
    const profile=SC_EDITORIAL_BY_UUID.get(uuid);
    addArtist(scField(row,artistSchema,'name'),scField(row,artistSchema,'spotify_id'),{
      listeners,
      qualifies:Number(scField(row,artistSchema,'qualifies'))===1,
      uuid,
      scopeEligible:true,
      classification:{genre:profile.genre,genre_confidence:profile.genreConfidence,genre_source:'soundcharts_strict',instrumental:profile.instrumental,instrumental_confidence:profile.instrumentalConfidence,ai_risk:profile.ai,ai_risk_source:'soundcharts_strict'}
    },true);
  }
  const falSchema=(SC.schemas&&SC.schemas.fal)||[];
  for(const row of (SC.fal||[])){
    const uuid=scField(row,falSchema,'soundcharts_uuid')||'';
    const listeners=Number(scField(row,falSchema,'monthly_listeners'))||0;
    const rights=scField(row,falSchema,'rights_status')||'unknown';
    const eligible=scScopeEligible(uuid,listeners,rights)
      && ['self_released','independent_label','indie'].includes(String(rights).toLowerCase());
    if(!eligible) continue;
    addArtist(scField(row,falSchema,'name'),scField(row,falSchema,'spotify_id'),{
      listeners,
      sources:Number(scField(row,falSchema,'source_count'))||0,
      rank:Number(scField(row,falSchema,'best_rank'))||null,
      qualifies:Number(scField(row,falSchema,'qualifies'))===1,
      uuid,
      rights,
      scopeEligible:true,
      classification:{genre:SC_EDITORIAL_BY_UUID.get(uuid).genre,genre_confidence:SC_EDITORIAL_BY_UUID.get(uuid).genreConfidence,genre_source:'soundcharts_strict',instrumental:SC_EDITORIAL_BY_UUID.get(uuid).instrumental,instrumental_confidence:SC_EDITORIAL_BY_UUID.get(uuid).instrumentalConfidence,ai_risk:SC_EDITORIAL_BY_UUID.get(uuid).ai,ai_risk_source:'soundcharts_strict'}
    },true);
  }
  const trackById=new Map(R.map(r=>[r[6],r]).filter(([id])=>Boolean(id)));
  const trackSchema=(SC.schemas&&SC.schemas.tracks)||[];
  for(const row of (SC.tracks||[])){
    const id=scField(row,trackSchema,'spotify_id')||('soundcharts:'+String(scField(row,trackSchema,'soundcharts_uuid')||''));
    if(id==='soundcharts:') continue;
    if(!scGeneralTrackEligible(row,trackSchema)) continue;
    const existingTrack=trackById.has(id);
    const opportunity=SC_VERIFIED_OPPORTUNITIES.get(String(id))||null;
    const directGenre=String(scField(row,trackSchema,'primary_genre')||'');
    const directClassification=directGenre?{
      genre:directGenre,
      genreConfidence:Number(scField(row,trackSchema,'genre_confidence')),
      instrumental:String(scField(row,trackSchema,'instrumental_status')||'unknown').toLowerCase(),
      instrumentalConfidence:Number(scField(row,trackSchema,'instrumental_confidence')),
      ai:String(scField(row,trackSchema,'ai_risk')||'unknown').toLowerCase(),
      source:String(scField(row,trackSchema,'classification_source')||'soundcharts_instrumental_pool')
    }:null;
    if(existingTrack){
      const existing=trackById.get(id); if(!existing.sc){existing.sc=true; SC_STAGING.tracks++;}
      if(directClassification) existing.scClassification={
        genre:directClassification.genre,genre_confidence:directClassification.genreConfidence,genre_source:directClassification.source,
        instrumental:directClassification.instrumental,instrumental_confidence:directClassification.instrumentalConfidence,
        ai_risk:directClassification.ai,ai_risk_source:directClassification.source
      };
      const image=String(scField(row,trackSchema,'image_url')||''); if(image&&!existing[8]) existing[8]=image;
      const delta24=Number(scField(row,trackSchema,'delta'));
      const previousSourceDate=String(scField(row,trackSchema,'previous_source_date')||'').slice(0,10);
      const sourceDate=String(scField(row,trackSchema,'source_date')||'').slice(0,10);
      existing.scDelta24=/^\d{4}-\d{2}-\d{2}$/.test(previousSourceDate)
        && /^\d{4}-\d{2}-\d{2}$/.test(sourceDate)
        && dayGap(previousSourceDate,sourceDate)>=1
        && Number.isFinite(delta24) ? delta24 : null;
      continue;
    }
    const rights=String(scField(row,trackSchema,'rights_status')||'').toLowerCase();
    /* `artist` is a display credit and may contain "A & B". Identity comes
       exclusively from the structured Soundcharts/Spotify artist links. */
    const structured=Array.isArray(scField(row,trackSchema,'artists'))
      ? scField(row,trackSchema,'artists') : [];
    const linked=[];
    let trackClassificationMeta=directClassification||(opportunity?{genre:opportunity.genre,genreConfidence:opportunity.genreConfidence,instrumental:opportunity.instrumental,instrumentalConfidence:opportunity.instrumentalConfidence,ai:opportunity.ai,source:'soundcharts_verified_opportunity'}:null);
    for(const person of structured){
      const uuid=String(person&&person.soundcharts_uuid||'');
      const id=String(person&&person.spotify_id||'');
      const name=String(person&&person.name||'').trim();
      if(!id||!uuid) continue;
      const sanitizedArtist=scSanitizedArtistPair(person);
      if(!sanitizedArtist) continue;
      const meta=SC_EDITORIAL_BY_UUID.get(uuid);
      /* The exact Spotify + Soundcharts pair must exist in the sanitized public
         artist projection. A complete pair from the track alone is not proof. */
      if(['major','major_label','mixed'].includes(rights)) continue;
      if(meta&&!scScopeEligible(uuid,sanitizedArtist.listeners,rights)) continue;
      if(!trackClassificationMeta&&meta) trackClassificationMeta={genre:meta.genre,genreConfidence:meta.genreConfidence,instrumental:meta.instrumental,instrumentalConfidence:meta.instrumentalConfidence,ai:meta.ai,source:'soundcharts_strict'};
      const artistMeta={
        listeners:sanitizedArtist.listeners,
        uuid,
        role:String(person&&person.role||'unknown'),
        scopeEligible:true
      };
      const classificationSource=meta||opportunity;
      if(classificationSource) artistMeta.classification={genre:classificationSource.genre,genre_confidence:classificationSource.genreConfidence,genre_source:meta?'soundcharts_strict':'soundcharts_verified_opportunity',instrumental:classificationSource.instrumental, instrumental_confidence:classificationSource.instrumentalConfidence,ai_risk:classificationSource.ai,ai_risk_source:meta?'soundcharts_strict':'soundcharts_verified_opportunity'};
      const index=addArtist(name,id,artistMeta,true);
      if(index>=0) linked.push({index,role:String(person&&person.role||'unknown')});
    }
    linked.sort((a,b)=>(a.role==='main'?-1:1)-(b.role==='main'?-1:1)||a.index-b.index);
    const ai=linked[0]&&linked[0].index; if(ai==null||ai<0) continue;
    const label=scField(row,trackSchema,'label')||scField(row,trackSchema,'copyright')||'Soundcharts staging';
    const rawStreams=scField(row,trackSchema,'streams'), parsedStreams=Number(rawStreams);
    const streams=rawStreams==null||rawStreams===''||!Number.isFinite(parsedStreams)?-1:parsedStreams;
    const delta24=Number(scField(row,trackSchema,'delta'));
    const previousSourceDate=String(scField(row,trackSchema,'previous_source_date')||'').slice(0,10);
    const sourceDate=String(scField(row,trackSchema,'source_date')||'').slice(0,10);
    const hasDailyBaseline=/^\d{4}-\d{2}-\d{2}$/.test(previousSourceDate)
      && /^\d{4}-\d{2}-\d{2}$/.test(sourceDate)
      && dayGap(previousSourceDate,sourceDate)>=1;
    const track=[ai,scField(row,trackSchema,'title')||'Titre non renseigné',scField(row,trackSchema,'release_date')||'',streams,
      rights==='self_released'?0:1,label,id,scField(row,trackSchema,'observed_at')||'',scField(row,trackSchema,'image_url')||''];
    track.sc=true;
    track.scArtistIndexes=linked.map(item=>item.index);
    track.scCredit=scField(row,trackSchema,'artist')||'';
    if(trackClassificationMeta) track.scClassification={genre:trackClassificationMeta.genre,genre_confidence:trackClassificationMeta.genreConfidence,genre_source:trackClassificationMeta.source,instrumental:trackClassificationMeta.instrumental,instrumental_confidence:trackClassificationMeta.instrumentalConfidence,ai_risk:trackClassificationMeta.ai,ai_risk_source:trackClassificationMeta.source};
    track.scDelta24=hasDailyBaseline&&Number.isFinite(delta24)?delta24:null;
    R.push(track); trackById.set(id,track); SC_STAGING.tracks++;
  }
}
mergeSoundchartsStaging();
const GENRE_TAXONOMY = Object.freeze({
  version:'2026-07-v1',
  genres:Object.freeze([
    'Lofi hip-hop','Guitare / acoustic / fingerstyle','Halloween Lofi',
    'Nature / soundscapes','Christmas Lofi','Jazz / jazzhop','Classique',
    'Ambient','Piano','Dark ambient','Phonk instrumental','DnB instrumental',
    'Autre / à définir'
  ])
});
const UNCLASSIFIED_GENRE = 'À classifier';
function perfHistory(entry){
  if (Array.isArray(entry)) return entry;
  return entry && Array.isArray(entry.history) ? entry.history : [];
}
const HIST = Object.assign({}, D.hist || {}); // tid -> [[dateISO, compteur cumulatif], ...]
for (const [tid,entry] of Object.entries(PERF_TRACKS)){
  const pts = perfHistory(entry); if (pts.length) HIST[tid] = pts;
}
const AG = A.map((a,i)=>({i, name:a[0], lofi:a[1], flag:a[2], done:a[3], disco:a[4],
  origin:a[5], seedSrc:a[6], id:a[7]||'', img:a[8]||'', email:a[9]||'', link:a[10]||'', sc:a.sc||null,
  source:a.sc?'soundcharts_staging':'catalogue', listeners:a.sc&&a.sc.listeners||null, n:0, self:0, streams:0, streams24:null, streams7:null, streams30:null, mstreams:0, hot:0, last:'', top:null, perf:null}));
const TRACKS_BY_ARTIST = new Map();
for (const r of R){
  const artistIndexes=[...new Set(Array.isArray(r.scArtistIndexes)&&r.scArtistIndexes.length
    ? r.scArtistIndexes : [r[0]])];
  for(const artistIndex of artistIndexes){
    const g = AG[artistIndex]; if(!g) continue;
    if (!TRACKS_BY_ARTIST.has(artistIndex)) TRACKS_BY_ARTIST.set(artistIndex, []);
    TRACKS_BY_ARTIST.get(artistIndex).push(r);
    g.n++; if (r[4]===0) g.self++;
    if (r[3]>0) g.streams += r[3];
    const pm = perMonth(r); if (pm>0) g.mstreams += pm;
    if (r[3]>=HOT) g.hot++;
    if (r[2] > g.last) g.last = r[2];
    if (!g.top || r[3] > g.top[3]) g.top = r;
  }
}
for (const g of AG){
  const rows = TRACKS_BY_ARTIST.get(g.i) || [];
  g.perf = performanceForRows(rows);
  g.streams24 = g.perf[1].current;
  g.streams7 = g.perf[7].current;
  g.streams30 = g.perf[30].current;
}
const withTracks = AG.filter(g=>(g.n>0 || g.source==='soundcharts_staging')
  && (!g.disco || (g.sc&&g.sc.scopeEligible===true)));
const totStreams = withTracks.reduce((s,g)=>s+g.streams,0);
const totMonthlyStreams = withTracks.reduce((s,g)=>s+g.mstreams,0);
const totMonthlyRev = totMonthlyStreams*RATE;
const nHot = R.reduce((s,r)=>s+(r[3]>=HOT?1:0),0);
const nSelf = R.reduce((s,r)=>s+(r[4]===0?1:0),0);

/* ---------- module Playlists (scanner Codex/ChatGPT, base indépendante du catalogue Artistes/Tracks) ---------- */
const PL = window.SPOTIFY_PLAYLISTS || null;
const PLmeta = (PL && PL.meta) || null;
const PLrows = (PL && PL.rows) || [];
const PLhist = Object.assign({}, (PL && PL.hist) || {});
for (const [pid,entry] of Object.entries(PERF_PLAYLISTS)){
  const pts = perfHistory(entry); if (pts.length) PLhist[pid] = pts;
}
/* colonnes PLrows : id,name,owner,curator,followers,tracks,first_seen,last_seen,lang,genre,use_case,fit,kw,enriched,big10k */

/* ---------- module Labels (récap par label, dérivé des tracks "Autre label") ---------- */
const LB = window.SPOTIFY_LABELS || null;
const LBmeta = (LB && LB.meta) || null;
const LBrows = (LB && LB.rows) || [];
/* colonnes LBrows : key,name,tracks,streams,revenue,since,nArtists */

function fmt(n){
  if (n===-1||n==null) return '?';
  if (n>=1e9) return (n/1e9).toFixed(2)+' B';
  if (n>=1e6) return (n/1e6).toFixed(n>=1e7?0:1)+' M';
  if (n>=1e3) return Math.round(n/1e3)+' k';
  return ''+n;
}
function fmtFull(n){ return n===-1?'?':n.toLocaleString('fr-FR'); }
function monthsSince(d){
  if(!d) return null;
  const raw=String(d);
  const parsed=new Date(raw.includes('T')?raw:raw+'T00:00:00');
  if(!Number.isFinite(parsed.getTime())) return null;
  const days = (TODAY - parsed)/864e5;
  return days<0 ? null : Math.max(days/30.4368,1);
}
function perMonth(r){
  const m = monthsSince(r[2]);
  return (m===null||r[3]<0) ? -1 : Math.round(r[3]/m);
}
function normalizeCounterHistory(raw){
  const daily = new Map();
  for (const p of (raw||[])){
    const d = Array.isArray(p) ? p[0] : (p&&p.date);
    const v = Number(Array.isArray(p) ? p[1] : (p&&p.value));
    const day = (d||'').toString().slice(0,10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(v)) daily.set(day,v);
  }
  return [...daily.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
}
function shiftDay(day,offset){
  const d = new Date(day+'T00:00:00Z');
  if (!Number.isFinite(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate()+offset);
  return d.toISOString().slice(0,10);
}
function dayGap(a,b){
  const x=new Date(a+'T00:00:00Z').getTime(), y=new Date(b+'T00:00:00Z').getTime();
  return Math.round((y-x)/864e5);
}
/* Une fenêtre n'est valide que si les baselines existent aux dates exactes D-N et D-2N.
   Le T0 seul ne produit donc jamais un faux zéro et aucun trou n'est extrapolé. */
function counterWindow(raw,days){
  const pts = normalizeCounterHistory(raw);
  const empty = {days,current:null,previous:null,comparisonCurrent:null,change:null,pct:null,currentReady:false,comparisonReady:false,points:pts.length};
  if (!pts.length) return empty;
  const latest = pts[pts.length-1], byDay = new Map(pts);
  const d1 = shiftDay(latest[0],-days), d2 = shiftDay(latest[0],-2*days);
  if (!byDay.has(d1)) return Object.assign(empty,{latestDate:latest[0]});
  const current = latest[1]-byDay.get(d1);
  if (!byDay.has(d2)) return Object.assign(empty,{latestDate:latest[0],current,currentReady:true});
  const previous = byDay.get(d1)-byDay.get(d2);
  const change = current-previous;
  return {days,current,previous,comparisonCurrent:current,change,pct:previous>0?change/previous*100:null,currentReady:true,comparisonReady:true,points:pts.length,latestDate:latest[0]};
}
function aggregateWindowForRows(rows,days){
  let current=0,currentCount=0,comparableCurrent=0,previous=0,comparisonCount=0,points=0;
  for (const r of rows){
    const w = counterWindow(HIST[r[6]]||[],days); points+=w.points||0;
    if (w.currentReady){ current+=w.current; currentCount++; }
    if (w.comparisonReady){ comparableCurrent+=w.current; previous+=w.previous; comparisonCount++; }
  }
  const total=rows.length, change=comparableCurrent-previous;
  return {days,current:currentCount?current:null,previous:comparisonCount?previous:null,comparisonCurrent:comparisonCount?comparableCurrent:null,
    change:comparisonCount?change:null,pct:comparisonCount&&previous>0?change/previous*100:null,currentReady:currentCount>0,comparisonReady:comparisonCount>0,
    currentCount,comparisonCount,total,partial:currentCount<total,comparisonPartial:comparisonCount<total,points};
}
function performanceForRows(rows){ return {1:aggregateWindowForRows(rows,1),7:aggregateWindowForRows(rows,7),30:aggregateWindowForRows(rows,30)}; }
function trackWindow(r,days){
  const w=counterWindow(HIST[r[6]]||[],days);
  if(days===1 && !w.currentReady && r.sc && Number.isFinite(r.scDelta24)){
    return Object.assign(w,{current:r.scDelta24,currentReady:true,currentCount:1,partial:false,source:'soundcharts_daily_delta'});
  }
  return Object.assign(w,{currentCount:w.currentReady?1:0,comparisonCount:w.comparisonReady?1:0,total:1,partial:!w.currentReady,comparisonPartial:!w.comparisonReady});
}
function dailyFlowSeries(raw){
  const pts=normalizeCounterHistory(raw), out=[];
  for(let i=1;i<pts.length;i++) if(dayGap(pts[i-1][0],pts[i][0])===1) out.push([pts[i][0],pts[i][1]-pts[i-1][1]]);
  return out;
}
function aggregateDailyFlow(rows){
  const sums=new Map(), coverage=new Map();
  for(const r of rows) for(const p of dailyFlowSeries(HIST[r[6]]||[])){
    sums.set(p[0],(sums.get(p[0])||0)+p[1]); coverage.set(p[0],(coverage.get(p[0])||0)+1);
  }
  return {points:[...sums.entries()].sort((a,b)=>a[0].localeCompare(b[0])),coverage,total:rows.length};
}
function streams30(r){
  const w=trackWindow(r,30);
  return {val:w.current,real:w.currentReady,partial:w.partial,window:w};
}
function fmtMetric(v){ return v==null?'—':fmt(v); }
function fmtFullMetric(v){ return v==null?'—':fmtFull(v); }
function moneyMetric(v){ return v==null?'—':money(v); }
function revenueEstimate(v){
  if(v==null || !Number.isFinite(Number(v))) return '—';
  const n=Number(v), out=money(Math.abs(n)*RATE);
  return n<0?'-'+out:out;
}
function streamMetricLabel(days){
  const revenue=S.metricMode==='revenue';
  if(days===0) return T(revenue?'Revenus total':'Streams total');
  if(days===30) return T(revenue?'Revenus 30 jours':'Streams 30 jours');
  if(days===7) return T(revenue?'Revenus 7 jours':'Streams 7 jours');
  return T(revenue?'Revenus 24 heures':'Streams 24 heures');
}
function streamStackHtml(v,full,signed){
  const valid=v==null||v===-1?null:Number(v);
  let main='—';
  if(valid!=null){
    if(S.metricMode==='revenue') main=(signed&&valid>0?'+':'')+revenueEstimate(valid);
    else main=signed?signedFull(valid):(full?fmtFull(valid):fmt(valid));
  }
  return `<span class="stream-stack"><span class="stream-number">${main}</span></span>`;
}
function metricModeToggleHtml(){
  return `<div class="metric-toggle" role="group" aria-label="Streams ou revenus">
    <button type="button" class="${S.metricMode==='streams'?'on':''}" data-metric-mode="streams" title="${T('Vue streams')}">▶ ${T('Streams')}</button>
    <button type="button" class="${S.metricMode==='revenue'?'on':''}" data-metric-mode="revenue" title="${T('Vue revenus')}">$ ${T('Revenus')}</button>
  </div>`;
}
function metricSeries(points){
  return S.metricMode==='revenue'?(points||[]).map(p=>[p[0],p[1]*RATE]):points;
}
function bindMetricModeToggle(renderFn,root){
  (root||document).querySelectorAll('[data-metric-mode]').forEach(button=>button.addEventListener('click',()=>{
    const mode=button.dataset.metricMode;
    if(mode===S.metricMode) return;
    S.metricMode=mode;
    const y=window.scrollY;
    renderFn();
    window.scrollTo(0,y);
  }));
}
function signedFull(v){ return v==null?'—':(v>0?'+':'')+fmtFull(v); }
function signedPct(v){ return v==null?'':` (${v>0?'+':''}${v.toFixed(1)}%)`; }
function previousPeriodName(days){ return days===1?T('24 h précédentes'):days===7?T('7 j précédents'):T('30 j précédents'); }
function perfCardHtml(label,w,withRevenue){
  const value=withRevenue?streamStackHtml(w.currentReady?w.current:null,true,true):(w.currentReady?signedFull(w.current):'—');
  let compare=T("Comparaison indisponible tant que la période précédente n'est pas complète.");
  let cls='';
  if(w.comparisonReady){
    const change=withRevenue?streamStackHtml(w.change,true,true):signedFull(w.change);
    compare=`${T('vs période précédente')} ${change}${signedPct(w.pct)}`;
    cls=w.change>0?'good':(w.change<0?'bad':'');
  }
  let partial='';
  if(!w.currentReady) partial=T('Historique quotidien requis pour cette fenêtre.');
  else if(w.total>1 && w.partial) partial=`${T('Données partielles')} · ${w.currentCount}/${w.total} ${T('tracks couvertes')}`;
  else if(w.comparisonPartial) partial=T('Données partielles');
  return `<div class="perf-card"><div class="plabel" title="${T('Flux réel sur la période')}">${label}</div><div class="pvalue">${value}</div><div class="pcompare ${cls}">${compare}</div>${partial?`<span class="ppartial">${partial} · ${T('Aucune extrapolation')}</span>`:''}</div>`;
}
function totalMetricCardHtml(prefix,total,withRevenue){
  const label=prefix==='Streams'?streamMetricLabel(0):T('Followers total');
  const value=withRevenue?streamStackHtml(total,false,false):fmtMetric(total);
  const sub=prefix==='Streams'?(S.metricMode==='revenue'?T('Revenu lifetime estimé'):T('Compteur lifetime')):T('Compteur actuel');
  return `<div class="perf-card"><div class="plabel">${label}</div><div class="pvalue">${value}</div><div class="pcompare">${sub}</div></div>`;
}
function periodMetricLabel(prefix,days){
  if(prefix==='Streams') return streamMetricLabel(days);
  return days===30?T('Followers 30 jours'):(days===7?T('Followers 7 jours'):T('Followers 24 heures'));
}
function perfGridHtml(perf,prefix,total,withRevenue){
  return `<div class="perf-grid">${totalMetricCardHtml(prefix,total,withRevenue)}${perfCardHtml(periodMetricLabel(prefix,30),perf[30],withRevenue)}${perfCardHtml(periodMetricLabel(prefix,7),perf[7],withRevenue)}${perfCardHtml(periodMetricLabel(prefix,1),perf[1],withRevenue)}</div>`;
}
function trackPerfEntry(r){ return PERF_TRACKS[r[6]] || {}; }
function artistPerfEntry(g){ return PERF_ARTISTS[g.id] || PERF_ARTISTS[g.name] || {}; }
function playlistPerfEntry(r){ return PERF_PLAYLISTS[r[0]] || {}; }
function confidenceText(value){
  if(value==null || value==='') return '—';
  if(typeof value==='string' && !/^\s*\d+(?:[.,]\d+)?\s*%?\s*$/.test(value)) return esc(value);
  const n=Number(String(value).replace(',','.').replace('%','').trim());
  if(!Number.isFinite(n)) return '—';
  const pct=n<=1?n*100:n;
  return Math.round(pct)+'%';
}
function classificationFromEntry(entry){
  const root=entry&&typeof entry==='object'?entry:{};
  const c=root.classification&&typeof root.classification==='object'?root.classification:root;
  const rawGenre=typeof c.genre==='string'?c.genre.trim():'';
  const subgenres=Array.isArray(c.subgenres)?c.subgenres.filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim()):[];
  let instrumental='À vérifier';
  if(c.instrumental===true || String(c.instrumental).toLowerCase()==='instrumental') instrumental='Instrumental';
  else if(c.instrumental===false || ['non instrumental','vocal','vocals'].includes(String(c.instrumental).toLowerCase())) instrumental='Non instrumental';
  const riskRaw=String(c.ai_risk==null?'':c.ai_risk).trim().toLowerCase();
  const aiRisk=['faible','low'].includes(riskRaw)?'faible':(['élevé','eleve','high'].includes(riskRaw)?'élevé':'à vérifier');
  return {
    genre:rawGenre||UNCLASSIFIED_GENRE,
    subgenres,
    genreConfidence:c.genre_confidence,
    genreSource:c.genre_source||c.source||null,
    instrumental,
    instrumentalConfidence:c.instrumental_confidence,
    aiRisk,
    aiRiskConfidence:c.ai_risk_confidence,
    aiRiskSource:c.ai_risk_source||null
  };
}
function trackClassification(r){ return classificationFromEntry(Object.assign({},r.scClassification||{},trackPerfEntry(r))); }
function artistClassification(g){ return classificationFromEntry(Object.assign({},g.sc&&g.sc.classification||{},artistPerfEntry(g))); }
function riskPass(c,mode){
  if(mode==='high_only') return c.aiRisk==='élevé';
  if(mode==='hide_high') return c.aiRisk!=='élevé';
  return true;
}
function aiRiskBadgeHtml(c){
  const cls=c.aiRisk==='faible'?'ai-low':(c.aiRisk==='élevé'?'ai-high':'ai-check');
  const label=c.aiRisk==='à vérifier'?'À vérifier':c.aiRisk.charAt(0).toUpperCase()+c.aiRisk.slice(1);
  return `<span class="badge ${cls}">${label}</span>`;
}
function classificationCellHtml(c){
  const conf=confidenceText(c.instrumentalConfidence);
  return `<div class="genre-cell"><div class="genre-main">${esc(c.genre)}</div><div class="genre-sub">${esc(c.instrumental)}${conf==='—'?'':' · '+conf}</div></div>`;
}
function classificationAnalyticsHtml(c){
  const sub=c.subgenres.length?c.subgenres.map(esc).join(' · '):'—';
  const instConf=confidenceText(c.instrumentalConfidence);
  const riskConf=confidenceText(c.aiRiskConfidence);
  return `<div class="analytics-section classification-analytics">
    <h4>Classification <span class="analytics-note">Taxonomie ${esc(GENRE_TAXONOMY.version)} · raccord export progressif</span></h4>
    <div class="analytics-kpis">
      <div class="analytics-kpi"><div class="l">Genre principal</div><div class="v">${esc(c.genre)}</div></div>
      <div class="analytics-kpi"><div class="l">Sous-genres</div><div class="v">${sub}</div></div>
      <div class="analytics-kpi"><div class="l">Confiance genre</div><div class="v">${confidenceText(c.genreConfidence)}</div></div>
      <div class="analytics-kpi"><div class="l">Source genre</div><div class="v">${c.genreSource?esc(c.genreSource):'—'}</div></div>
      <div class="analytics-kpi"><div class="l">Statut instrumental</div><div class="v">${esc(c.instrumental)}</div><div class="genre-sub">Confiance ${instConf}</div></div>
      <div class="analytics-kpi"><div class="l">Risque IA</div><div class="v">${aiRiskBadgeHtml(c)}</div><div class="genre-sub">Confiance ${riskConf}</div></div>
      <div class="analytics-kpi"><div class="l">Source risque IA</div><div class="v">${c.aiRiskSource?esc(c.aiRiskSource):'—'}</div></div>
    </div>
  </div>`;
}
function scArtistRow(g){
  if(!SC || !Array.isArray(SC.artists)) return null;
  const schema=(SC.schemas&&SC.schemas.artists)||[];
  const idIx=schema.indexOf('spotify_id'), nameIx=schema.indexOf('name');
  return SC.artists.find(r=>(idIx>=0&&g.id&&r[idIx]===g.id)||(nameIx>=0&&r[nameIx]===g.name))||null;
}
function artistAudience(g){
  const entry=artistPerfEntry(g), hist=normalizeCounterHistory(entry.monthly_listeners_history||[]);
  if(hist.length){
    const last=hist[hist.length-1], prev=hist.length>1?hist[hist.length-2]:null;
    return {current:last[1],delta:prev?last[1]-prev[1]:null,date:last[0],history:hist,partial:hist.length<2};
  }
  const row=scArtistRow(g);
  if(row){
    const schema=SC.schemas.artists||[], cur=Number(row[schema.indexOf('monthly_listeners')]), delta=Number(row[schema.indexOf('delta')]);
    return {current:Number.isFinite(cur)?cur:null,delta:Number.isFinite(delta)?delta:null,date:row[schema.indexOf('source_date')]||null,history:[],partial:true};
  }
  return {current:null,delta:null,date:null,history:[],partial:true};
}
function performanceSignal(perf,entry){
  if(entry&&entry.signal) return esc(entry.signal);
  if(entry&&entry.hot===true) return T('Hot');
  const w=perf&&perf[7];
  if(w&&w.comparisonReady&&w.change>0) return `${T('Rising')} · 7 j vs 7 j`;
  return '—';
}
function contributorRows(rows,days){
  const out=[];
  for(const r of rows){ const w=trackWindow(r,days); if(w.currentReady) out.push({r,w}); }
  out.sort((a,b)=>b.w.current-a.w.current);
  return out.slice(0,5);
}
function contributorsHtml(rows,days){
  const top=contributorRows(rows,days);
  if(!top.length) return `<div class="analytics-note">${T('Historique insuffisant')} · ${T('Aucune extrapolation')}</div>`;
  return `<div class="contributors">${top.map(x=>`<div class="contributor"><span class="cn">${esc(x.r[1])}</span><span class="cv">${streamStackHtml(x.w.current,false,true)}</span></div>`).join('')}</div>`;
}
function dailyChartHtml(points,emptyText){
  return points&&points.length>=2?sparkline(points):`<div class="analytics-note" style="padding:18px 2px">${emptyText||T('Historique insuffisant')} · ${T('Aucune extrapolation')}</div>`;
}
function revTotal(r){ return r[3]>0 ? r[3]*RATE : 0; }
function rev30(r){ const v=streams30(r).val; return v==null?null:v*RATE; }
function daysAgo(d){ return d ? Math.round((TODAY-new Date(d+'T00:00:00'))/864e5) : 1e9; }
function esc(s){ return (''+s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
const trackUrl = id => 'https://open.spotify.com/track/'+id;
const artistSearch = n => 'https://open.spotify.com/search/'+encodeURIComponent(n)+'/artists';

/* ---------- Radar A&R : lecture seule du flux Soundcharts exporté ---------- */
function scValue(row, schema, name){
  const index=(schema||[]).indexOf(name);
  return index>=0 ? row[index] : null;
}
function arEditorialArtist(uuid){
  if(!SC || !SC.editorial || !Array.isArray(SC.editorial.artists)) return null;
  const schema=SC.editorial.artist_schema||[];
  return SC.editorial.artists.find(row=>scValue(row,schema,'soundcharts_uuid')===uuid)||null;
}
function arTrackRights(name){
  if(!SC || !Array.isArray(SC.tracks)) return 'À vérifier';
  const schema=SC.schemas&&SC.schemas.tracks||[];
  const rows=SC.tracks.filter(row=>String(scValue(row,schema,'artist')||'').trim().toLowerCase()===String(name||'').trim().toLowerCase());
  if(rows.some(row=>['major','major_label','mixed'].includes(String(scValue(row,schema,'rights_status')||'')))) return 'Major détecté';
  if(rows.some(row=>['self_released','independent_label'].includes(String(scValue(row,schema,'rights_status')||'')))) return 'À confirmer';
  return 'À vérifier';
}
const AR_ALLOWED_GENRES = SC_ALLOWED_GENRES;
const AR_MIN_MONTHLY_LISTENERS = SC_MIN_LISTENERS;
const AR_MAX_MONTHLY_LISTENERS = SC_MAX_LISTENERS;
function arClassification(uuid, name, candidateRights){
  const normalizedRights=String(candidateRights||'').toLowerCase();
  const rights=['major','major_label','mixed'].includes(normalizedRights)
    ? 'Major détecté'
    : (['self_released','independent_label','indie'].includes(normalizedRights) ? 'À confirmer' : arTrackRights(name));
  const row=arEditorialArtist(uuid);
  if(!row) return {genre:'À classifier', genreConfidence:null, instrumental:'À vérifier', instrumentalConfidence:null, ai:'À vérifier', rights, expansionStatus:'review', backgroundEligible:false};
  const schema=SC.editorial.artist_schema||[];
  const genre=scValue(row,schema,'primary_genre')||'À classifier';
  const genreConfidence=Number(scValue(row,schema,'genre_confidence'));
  const rawInstrumental=String(scValue(row,schema,'instrumental_status')||'').toLowerCase();
  const instrumentalConfidence=Number(scValue(row,schema,'instrumental_confidence'));
  const rawAi=String(scValue(row,schema,'ai_risk')||'').toLowerCase();
  const expansionStatus=String(scValue(row,schema,'expansion_status')||'review').toLowerCase();
  const instrumental=rawInstrumental==='instrumental'?'Instrumental':(rawInstrumental==='vocal'?'Vocal':'À vérifier');
  const ai=['low','faible'].includes(rawAi)?'Faible':(['high','élevé','eleve'].includes(rawAi)?'Élevé':'À vérifier');
  const backgroundEligible=expansionStatus==='eligible' && instrumental==='Instrumental' && ai==='Faible'
    && AR_ALLOWED_GENRES.has(genre) && Number.isFinite(genreConfidence) && genreConfidence>=0.5
    && Number.isFinite(instrumentalConfidence) && instrumentalConfidence>=0.5;
  return {
    genre,
    genreConfidence:Number.isFinite(genreConfidence)?genreConfidence:null,
    instrumental,
    instrumentalConfidence:Number.isFinite(instrumentalConfidence)?instrumentalConfidence:null,
    ai,
    rights,
    expansionStatus,
    backgroundEligible,
  };
}
function arCandidates(){
  if(!SC || !Array.isArray(SC.fal)) return [];
  const schema=SC.schemas&&SC.schemas.fal||[];
  return SC.fal.map(row=>{
    const uuid=scValue(row,schema,'soundcharts_uuid');
    const name=scValue(row,schema,'name')||'Artiste sans nom';
    const spotifyId=scValue(row,schema,'spotify_id');
    const listeners=Number(scValue(row,schema,'monthly_listeners'))||0;
    const sources=Number(scValue(row,schema,'source_count'))||0;
    const rank=Number(scValue(row,schema,'best_rank'))||null;
    const qualifies=Number(scValue(row,schema,'qualifies'))===1;
    const classification=arClassification(uuid,name,scValue(row,schema,'rights_status'));
    const scale=listeners<50000?8:listeners<250000?18:listeners<1000000?22:15;
    const network=Math.min(20,sources*4);
    const proximity=rank==null?0:Math.max(0,15-(rank-1)*2);
    const score=Math.min(100,(qualifies?15:0)+scale+network+proximity+(spotifyId?8:0)+20);
    const review=classification.instrumental==='Instrumental' && classification.ai==='Faible' && classification.rights!=='À vérifier';
    return {uuid,name,spotifyId,listeners,sources,rank,qualifies,classification,score,review};
  }).filter(candidate=>candidate.classification.backgroundEligible
    && candidate.listeners>=AR_MIN_MONTHLY_LISTENERS
    && candidate.listeners<=AR_MAX_MONTHLY_LISTENERS
    && candidate.classification.rights==='À confirmer')
    .sort((a,b)=>b.score-a.score||b.sources-a.sources||a.listeners-b.listeners||a.name.localeCompare(b.name));
}
function arTrackCandidates(){
  if(!SC || !Array.isArray(SC.tracks)) return [];
  const byArtist=new Map(arCandidates().map(candidate=>[scKey(candidate.name),candidate]));
  const schema=(SC.schemas&&SC.schemas.tracks)||[];
  return SC.tracks.map(row=>{
    const spotifyId=scValue(row,schema,'spotify_id');
    const artist=scValue(row,schema,'artist')||'';
    const candidate=byArtist.get(scKey(artist));
    if(!spotifyId || !candidate || !candidate.qualifies) return null;
    const streams=Number(scValue(row,schema,'streams'))||0;
    const title=scValue(row,schema,'title')||'Titre non renseigné';
    const lift=Math.min(18,Math.max(0,Math.round(Math.log10(Math.max(streams,1))*2)));
    return {spotifyId,artist,title,streams,candidate,score:Math.min(100,candidate.score+lift)};
  }).filter(Boolean).sort((a,b)=>b.score-a.score||b.streams-a.streams||a.title.localeCompare(b.title));
}
function playArTrack(spotifyId){ S.radarTrackId=spotifyId; renderRadar(); }
function arClusters(){
  if(!SC || !SC.editorial || !Array.isArray(SC.editorial.tracks)) return [];
  const schema=SC.editorial.track_schema||[];
  const groups=new Map();
  for(const row of SC.editorial.tracks){
    const genre=scValue(row,schema,'primary_genre');
    const genreConfidence=Number(scValue(row,schema,'genre_confidence'));
    const instrumental=String(scValue(row,schema,'instrumental_status')||'').toLowerCase();
    const instrumentalConfidence=Number(scValue(row,schema,'instrumental_confidence'));
    const ai=String(scValue(row,schema,'ai_risk')||'').toLowerCase();
    const artist=scValue(row,schema,'artist');
    if(!AR_ALLOWED_GENRES.has(genre)
      || !Number.isFinite(genreConfidence) || genreConfidence<0.5
      || instrumental!=='instrumental'
      || !Number.isFinite(instrumentalConfidence) || instrumentalConfidence<0.5
      || !['low','faible'].includes(ai)) continue;
    if(!groups.has(genre)) groups.set(genre,{genre,artists:new Set(),tracks:0});
    const group=groups.get(genre); group.tracks++; if(artist) group.artists.add(artist);
  }
  return [...groups.values()]
    .map(group=>({genre:group.genre,artists:group.artists.size,tracks:group.tracks}))
    .filter(group=>group.artists>=5 && group.tracks>=10)
    .sort((a,b)=>b.artists-a.artists||b.tracks-a.tracks);
}
function arKnownContact(name){
  const match=AG.find(artist=>artist.name.toLowerCase()===String(name||'').toLowerCase() && artist.email);
  return match ? match.email : null;
}

/* ---------- état ---------- */
const S = {
  view:'opps', back:null, palier:'100/0', sel:new Set(), wltab:'tracks', publishing:false, metricMode:'streams',
  q:'', statut:'all', min:0, period:'all', artist:-1, rel:'all', genres:new Set(),
  sort:{k:3, dir:-1}, shown:100,
  aq:'', asort:'streams', adir:-1, shownA:60, aseg:'all', agenres:new Set(),
  newDays:90, shownN:100,
  plq:'', plcur:'all', plsort:'followers', pldir:-1, plonly:false, shownPL:80, plview:'qualified', plmode:'table',
  amode:'table', omode:'table',
  lbq:'', lbsort:'streams', lbdir:-1, shownLB:80, lbmode:'table', labelKey:null, lbModalArtist:null,
  radarFilter:'distribution', radarLimit:100, radarTrackId:'', radarQ:'', radarGenre:'all', radarSort:'score',
};

/* ---------- navigation ---------- */
function syncHash(){
  try{
    const route = S.view==='radar' ? 'opps' : S.view==='opps' ? 'tracks' : S.view;
    history.replaceState(null,'','#'+route);
  }catch(e){}
}
document.getElementById('nav').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  document.querySelectorAll('#nav button').forEach(x=>x.classList.toggle('active', x===b));
  S.view = b.dataset.v; S.shown = 100; S.shownA = 60; S.shownN = 100; S.shownPL = 80; S.artist = -1;
  syncHash(); render(); window.scrollTo(0,0);
});
function goArtist(i){
  S.artist = i; S.labelKey = null; S.sel = new Set();
  renderArtistModal();
  document.getElementById('artist-modal').style.display='flex';
}
function goTab(v){
  S.view = v;
  document.querySelectorAll('#nav button').forEach(x=>x.classList.toggle('active', x.dataset.v===v));
  syncHash(); render(); window.scrollTo(0,0);
}
function closeArtistModal(){
  document.getElementById('artist-modal').style.display='none';
  S.artist = -1; S.labelKey = null;
}
document.addEventListener('keydown', e=>{ if(e.key==='Escape'){ closeArtistModal(); closeArModal(); } });

/* ---------- filtres opportunités ---------- */
function rowsBeforePeriod(){
  const q = S.q.trim().toLowerCase();
  return R.filter(r=>{
    const classification=trackClassification(r);
    if (S.artist>=0 && r[0]!==S.artist) return false;
    if (S.rel!=='all' && seg(AG[r[0]])!==S.rel) return false;
    if (S.statut==='self' && r[4]!==0) return false;
    if (S.statut==='other' && r[4]!==1) return false;
    if (S.min>0 && r[3]<S.min) return false;
    if (S.genres.size && !S.genres.has(classification.genre)) return false;
    if (q && !(r[1].toLowerCase().includes(q) || A[r[0]][0].toLowerCase().includes(q) || r[5].toLowerCase().includes(q))) return false;
    return true;
  });
}
function filteredRows(){
  const base = rowsBeforePeriod();
  let rows = S.period==='all' ? base : base.filter(r=>daysAgo(r[2]) <= +S.period);
  const {k,dir} = S.sort;
  rows.sort((a,b)=>{
    let x,y;
    if (k===0){ x=A[a[0]][0].toLowerCase(); y=A[b[0]][0].toLowerCase(); }
    else if (k===7){ x=perMonth(a); y=perMonth(b); }
    else if (k===30){ x=trackClassification(a).genre.toLowerCase(); y=trackClassification(b).genre.toLowerCase(); }
    else if (k===20){ x=trackWindow(a,1).current; y=trackWindow(b,1).current; }
    else if (k===21){ x=trackWindow(a,7).current; y=trackWindow(b,7).current; }
    else if (k===10){ x=trackWindow(a,30).current; y=trackWindow(b,30).current; }
    else if (k===11){ x=revTotal(a); y=revTotal(b); }
    else if (k===12){ x=rev30(a); y=rev30(b); }
    else if (k===13){ x=advance(Math.max(perMonth(a),0)); y=advance(Math.max(perMonth(b),0)); }
    else if (k===5){ x=(a[5]||'').toLowerCase(); y=(b[5]||'').toLowerCase(); }
    else { x=a[k]; y=b[k]; }
    if (x==null || y==null) return x==null ? (y==null?0:1) : -1;
    const c = x<y ? -1 : (x>y ? 1 : 0);
    return c*dir;
  });
  return rows;
}

/* ---------- rendus ---------- */
const V = document.getElementById('view');

/* Dropdowns custom (bords arrondis y compris sur la liste déroulante ouverte, ce qu'un
   <select> natif ne permet pas sur tous les navigateurs). On garde le <select> natif
   caché dans le DOM comme source de vérité (valeur + événement 'change' natif dispatché
   à la sélection), donc toute la logique métier existante (addEventListener('change',...))
   continue de fonctionner sans modification. */
function enhanceSelects(root){
  (root||document).querySelectorAll('select').forEach(sel=>{
    if (sel.dataset.cselDone) return;
    sel.dataset.cselDone = '1';
    const wrap = document.createElement('span');
    wrap.className = 'csel-wrap';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('csel-native');
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'csel-btn';
    const list = document.createElement('div');
    list.className = 'csel-list';
    wrap.appendChild(btn); wrap.appendChild(list);
    function paint(){
      const opt = sel.options[sel.selectedIndex];
      btn.innerHTML = `<span class="csel-label">${opt?esc(opt.textContent):''}</span><span class="csel-chevron">▾</span>`;
      list.innerHTML = [...sel.options].map((o,i)=>`<div class="csel-opt${i===sel.selectedIndex?' on':''}" data-i="${i}">${esc(o.textContent)}</div>`).join('');
    }
    paint();
    btn.addEventListener('click', e=>{
      e.stopPropagation();
      const willOpen = !wrap.classList.contains('open');
      document.querySelectorAll('.csel-wrap.open,.msel.open').forEach(w=>{ if(w!==wrap) w.classList.remove('open'); });
      wrap.classList.toggle('open', willOpen);
    });
    list.addEventListener('click', e=>{
      const optEl = e.target.closest('.csel-opt'); if (!optEl) return;
      sel.selectedIndex = Number(optEl.dataset.i);
      wrap.classList.remove('open');
      paint();
      sel.dispatchEvent(new Event('change', {bubbles:true}));
    });
  });
}
function genreFilterHtml(id,selected){
  const values=[...GENRE_TAXONOMY.genres,UNCLASSIFIED_GENRE];
  const count=selected.size;
  const label=count===0?'🎼 Genre : tous':(count===1?'🎼 '+[...selected][0]:'🎼 Genres · '+count);
  return `<div class="msel" id="${id}">
    <button type="button" class="msel-btn" aria-haspopup="true" aria-expanded="false"><span class="msel-label">${esc(label)}</span><span class="msel-chevron">▾</span></button>
    <div class="msel-list">
      <label class="msel-opt"><input type="checkbox" value="" ${count===0?'checked':''}><span>Tous les genres</span></label>
      ${values.map(v=>`<label class="msel-opt"><input type="checkbox" value="${esc(v)}" ${selected.has(v)?'checked':''}><span>${esc(v)}</span></label>`).join('')}
      <div class="msel-foot">Taxonomie ${esc(GENRE_TAXONOMY.version)} · extensible</div>
    </div>
  </div>`;
}
function bindGenreFilter(id,selected,onChange){
  const root=document.getElementById(id); if(!root) return;
  const btn=root.querySelector('.msel-btn'), list=root.querySelector('.msel-list');
  btn.addEventListener('click',e=>{
    e.stopPropagation();
    const open=!root.classList.contains('open');
    document.querySelectorAll('.csel-wrap.open,.msel.open').forEach(w=>{if(w!==root)w.classList.remove('open');});
    root.classList.toggle('open',open); btn.setAttribute('aria-expanded',open?'true':'false');
  });
  list.addEventListener('click',e=>e.stopPropagation());
  list.querySelectorAll('input[type=checkbox]').forEach(input=>input.addEventListener('change',()=>{
    if(input.value===''){ if(input.checked) selected.clear(); }
    else { if(input.checked) selected.add(input.value); else selected.delete(input.value); }
    onChange();
  }));
}
function enhanceResponsiveTables(root){
  (root||document).querySelectorAll('table').forEach(table=>{
    if (table.dataset.responsiveDone) return;
    table.dataset.responsiveDone = '1';
    table.classList.add('responsive-table');
    if (table.querySelector('th[data-k],th[data-asort],th[data-plsort],th[data-lbsort]')) {
      table.classList.add('has-sort');
    }
    const headers = [...table.querySelectorAll('thead th')].map(th=>(th.textContent||'')
      .replace(/[▲▼▴▾]/g,'').replace(/\s+/g,' ').trim());
    table.querySelectorAll('tbody tr').forEach(tr=>{
      [...tr.children].forEach((cell,i)=>{
        if (cell.tagName === 'TD') cell.dataset.label = headers[i] || '';
      });
    });
  });
}
document.addEventListener('click', ()=>{ document.querySelectorAll('.csel-wrap.open,.msel.open').forEach(w=>w.classList.remove('open')); });
new MutationObserver(()=>enhanceSelects()).observe(V, {childList:true, subtree:true});
new MutationObserver(()=>enhanceSelects()).observe(document.getElementById('am-body'), {childList:true, subtree:true});
new MutationObserver(()=>enhanceResponsiveTables()).observe(V, {childList:true, subtree:true});
new MutationObserver(()=>enhanceResponsiveTables()).observe(document.getElementById('am-body'), {childList:true, subtree:true});
new MutationObserver(()=>enhanceResponsiveTables()).observe(document.getElementById('tmbox'), {childList:true, subtree:true});

function kpi(lbl,val,sub,hl){
  return `<div class="kpi ${hl?'hl':''}"><div class="lbl">${lbl}</div><div class="val">${val}</div><div class="sub">${sub||''}</div></div>`;
}
function avatarHtml(g){
  if (g.img) return `<img class="avp on" src="${esc(g.img)}" alt="">`;
  if (g.top && g.top[8]) return `<img class="avp on" src="${esc(g.top[8])}" alt="">`;
  if (g.top) return `<img class="avp" data-tid="${g.top[6]}" alt="">`;
  return '';
}
/* même logique que avatarHtml, mais en cover plein-largeur (vue grille, style aligné sur All tracks/All playlists) */
function artistCoverHtml(g){
  if (g.img) return `<div class="cov has" style="background-image:url('${esc(g.img)}')"></div>`;
  if (g.top && g.top[8]) return `<div class="cov has" style="background-image:url('${esc(g.top[8])}')"></div>`;
  if (g.top) return `<div class="cov" data-tid="${g.top[6]}"></div>`;
  return `<div class="cov"></div>`;
}

/* relation au label, 4 paliers par nb de sorties chez Lofi (vert>jaune>orange>rouge) */
function seg(g){ return g.lofi>50 ? 'top' : (g.lofi>=25 ? 'reg' : (g.lofi>0 ? 'occ' : 'ext')); }
function segBadge(g){
  const s = seg(g);
  if (s==='top') return '<span class="badge seg-top">★ '+T('fidèle')+'</span>';
  if (s==='reg') return '<span class="badge seg-reg">'+T('régulier')+'</span>';
  if (s==='occ') return '<span class="badge seg-occ">'+T('occasionnel')+'</span>';
  return '<span class="badge seg-ext">'+T('hors label')+'</span>';
}

function renderOverview(){
  const done = AG.filter(g=>g.done).length;
  const disco = AG.filter(g=>g.disco).length;
  const recent = R.filter(r=>daysAgo(r[2])<=90).length;
  const nTop = withTracks.filter(g=>seg(g)==='top').length;
  const nReg = withTracks.filter(g=>seg(g)==='reg').length;
  const nOcc = withTracks.filter(g=>seg(g)==='occ').length;
  const nExt = withTracks.filter(g=>seg(g)==='ext').length;
  const top = [...withTracks].sort((a,b)=>b.streams-a.streams).slice(0,10);
  const years = {};
  for (const r of R){ const y = r[2].slice(0,4); if(y>='2015') years[y]=(years[y]||0)+1; }
  const yk = Object.keys(years).sort();
  const maxY = Math.max(...Object.values(years),1);
  const pSelf = R.length ? Math.round(nSelf/R.length*100) : 0;

  const OVN = 9;
  const topTracks = [...R].sort((a,b)=>b[3]-a[3]).slice(0,OVN);
  const topLb = LBrows.slice().sort((a,b)=>b[4]-a[4]).slice(0,OVN);
  const topPl = PLmeta ? PLrows.filter(r=>r[17]).slice().sort((a,b)=>b[4]-a[4]).slice(0,OVN) : [];
  const top5 = top.slice(0,OVN);
  const catalogPerf = performanceForRows(R);
  const playlistsPerf = playlistPerformance(PLrows);
  const labelCatalogRows = R.filter(r=>r[4]===1);
  const labelsPerf = performanceForRows(labelCatalogRows);
  const labelsTotalStreams = labelCatalogRows.reduce((s,r)=>s+(r[3]>0?r[3]:0),0);
  const labelsArtists = new Set(labelCatalogRows.map(r=>r[0])).size;

  V.innerHTML = `
  <div class="page-head">
    <div>
      <h2>${T("Vue d'ensemble")}</h2>
    </div>
    ${metricModeToggleHtml()}
  </div>
  <div class="ovgrid">

    <div class="panel ovp">
      <div class="ovh"><h3>🎶 Tracks</h3><button class="chip" onclick="goTab('opps')">${T('Tout voir')} →</button></div>
      <div class="ov-stats">
        <div class="ov-st"><div class="v">${fmt(R.length)}</div><div class="l">${T('tracks hors Lofi')}</div></div>
        <div class="ov-st"><div class="v" style="color:var(--acc2)">${fmt(nHot)}</div><div class="l">≥ 500k (${T('priorités')})</div></div>
        <div class="ov-st"><div class="v" style="color:var(--cyan)">${S.metricMode==='revenue'?money(totMonthlyRev):fmt(totMonthlyStreams)}</div><div class="l">${T(S.metricMode==='revenue'?'revenu mensuel est.':'streams mensuels est.')}</div></div>
      </div>
      ${perfGridHtml(catalogPerf,'Streams',totStreams,true)}
      ${topTracks.map((r,ix)=>`
      <div class="top-row" onclick="openTrack('${r[6]}')">
        <span class="rank">${ix+1}</span>
        ${r[8]?`<div class="cov has" style="width:40px;height:40px;border-radius:9px;margin:0;background-image:url('${esc(r[8])}')"></div>`:`<div class="cov" data-tid="${r[6]}" style="width:40px;height:40px;border-radius:9px;margin:0"></div>`}
        <div class="ti">
          <div class="nm"><span class="nmtxt">${esc(r[1])}</span></div>
          <div class="sub">${esc(A[r[0]][0])} · ${fmtDate(r[2])}</div>
        </div>
        <div class="vals"><div class="v1">${streamStackHtml(r[3],false,false)}</div><div class="v2">${streamMetricLabel(0)}</div></div>
      </div>`).join('')}
    </div>

    <div class="panel ovp">
      <div class="ovh"><h3>🎸 ${T('Artistes')}</h3><button class="chip" onclick="goTab('artists')">${T('Tout voir')} →</button></div>
      <div class="ov-stats">
        <div class="ov-st"><div class="v">${done}</div><div class="l">${T('artistes scannés')}</div></div>
        <div class="ov-st"><div class="v">${nTop+nReg}</div><div class="l">top + ${T('réguliers')}</div></div>
        <div class="ov-st"><div class="v">${fmtFull(recent)}</div><div class="l">${T('sorties 90 j')}</div></div>
      </div>
      ${perfGridHtml(catalogPerf,'Streams',totStreams,true)}
      ${top5.map((g,ix)=>`
      <div class="top-row" onclick="goArtist(${g.i})">
        <span class="rank">${ix+1}</span>
        <div class="ov-cov">${esc(g.name[0]||'?').toUpperCase()}${avatarHtml(g)}</div>
        <div class="ti">
          <div class="nm"><span class="nmtxt">${esc(g.name)}</span></div>
          <div class="sub">${g.n} tracks · <span style="color:var(--green)">${g.self} ${T('indé')}</span></div>
        </div>
        <div class="vals"><div class="v1">${streamStackHtml(g.streams,false,false)}</div><div class="v2">${streamMetricLabel(0)}</div></div>
      </div>`).join('')}
    </div>

    <div class="panel ovp">
      <div class="ovh"><h3>📻 Playlists</h3><button class="chip" onclick="goTab('playlists')">${T('Tout voir')} →</button></div>
      ${PLmeta ? `
      <div class="ov-stats">
        <div class="ov-st"><div class="v">${fmt(PLmeta.playlists_discovered)}</div><div class="l">${T('découvertes')}</div></div>
        <div class="ov-st"><div class="v" style="color:var(--acc2)">${fmtFull(PLmeta.playlists_10k_plus)}</div><div class="l">≥ 10k followers</div></div>
      </div>
      ${perfGridHtml(playlistsPerf,'Followers',PLmeta.followers_sum,false)}
      ${topPl.map((r,ix)=>`
      <div class="top-row" onclick="openPlaylist('${r[0]}')">
        <span class="rank">${ix+1}</span>
        <div class="cov" data-plid="${r[0]}" style="width:40px;height:40px;border-radius:9px;margin:0"></div>
        <div class="ti">
          <div class="nm"><span class="nmtxt">${esc(r[1])}</span> ${plCuratorBadge(r[3])}</div>
          <div class="sub">${esc(r[2])} · ${r[6]||'?'} tracks</div>
        </div>
        <div class="vals"><div class="v1">${plFollowersCell(r)}</div><div class="v2">${T('Followers total')}</div></div>
      </div>`).join('')}` : `<div class="empty">${T('Aucune donnée playlists chargée.')}</div>`}
    </div>

    <div class="panel ovp">
      <div class="ovh"><h3>🏷️ Labels</h3><button class="chip" onclick="goTab('labels')">${T('Tout voir')} →</button></div>
      ${LBmeta ? `
      <div class="ov-stats">
        <div class="ov-st"><div class="v">${fmt(LBrows.length)}</div><div class="l">labels ${T('identifiés')}</div></div>
        <div class="ov-st"><div class="v">${fmt(LBmeta.tracks_covered)}</div><div class="l">tracks ${T('couvertes')}</div></div>
        <div class="ov-st"><div class="v">${fmt(labelsArtists)}</div><div class="l">${T('artistes')}</div></div>
      </div>
      ${perfGridHtml(labelsPerf,'Streams',labelsTotalStreams,true)}
      ${topLb.map((r,ix)=>`
      <div class="top-row lbl-row" data-lbkey="${esc(r[0])}">
        <span class="rank">${ix+1}</span>
        <div style="width:40px;flex:none">${labelCover(r[1], false, r[7]).replace('class="cov lblcov"','class="cov lblcov" style="width:40px;height:40px;border-radius:9px;margin:0;font-size:15px"')}</div>
        <div class="ti">
          <div class="nm"><span class="nmtxt">${esc(r[1])}</span></div>
          <div class="sub">${fmtFull(r[2])} tracks · ${r[6]} ${T('artistes')}</div>
        </div>
        <div class="vals"><div class="v1">${streamStackHtml(r[3],false,false)}</div><div class="v2">${streamMetricLabel(0)}</div></div>
      </div>`).join('')}` : `<div class="empty">${T('Aucune donnée labels chargée.')}</div>`}
    </div>

  </div>
  ${S.metricMode==='revenue'?`<div style="font-size:11px;color:var(--dim);margin:14px 0 0 2px">${T('Revenus estimés à')} ${RATE}$/stream (${T('all-in Spotify, fourchette')} 0,003-0,005$ ; ${T('source Duetti / Loud & Clear 2025-26')}).</div>`:''}`;

  bindMetricModeToggle(renderOverview,V);
  document.querySelectorAll('#view .lbl-row[data-lbkey]').forEach(el=>el.addEventListener('click', ()=>openLabel(el.dataset.lbkey)));
}

function offerHtml(g, selMonthly, selCount, totCount){
  const p = palier();
  const none = selCount===0;
  const adv = none?0:advance(selMonthly);
  const lm = none?0:labelMonthly(selMonthly);
  const pb = none?null:payback(selMonthly);
  const contact = g.email?`<a href="mailto:${esc(g.email)}" style="color:var(--cyan)">✉ ${esc(g.email)}</a>`:(g.link?`<a href="${esc(g.link)}" target="_blank" style="color:var(--violet)">${g.link.includes('instagram')?'📷 Instagram':'🔗 Site'}</a>`:'<span style="color:var(--dim)">'+T('contact à trouver')+'</span>');
  return `<div class="offer">
    <h3>💰 ${T("Simulation d'offre de rachat")}</h3>
    <div class="osub">${T("Coche les tracks à racheter ci-dessous, choisis le split artiste / label : l'avance et le payback se recalculent. Objectif payback 2-3 ans.")}</div>
    <div class="pal">
      ${BUY.paliers.map(pp=>`<button class="${pp.k===S.palier?'on':''}" onclick="setPalier('${pp.k}')">${pp.k}${pp.k==='100/0'?' · '+T('rachat total'):''}</button>`).join('')}
      <label class="selall" style="margin-left:12px"><input type="checkbox" class="ck" ${S.publishing?'checked':''} onchange="S.publishing=this.checked;render()"> Publishing +10%</label>
    </div>
    <div class="ogrid">
      <div class="ob"><div class="l">${T('Tracks sélectionnées')}</div><div class="v">${selCount}<span style="font-size:12px;color:var(--dim);font-weight:600"> / ${totCount}</span></div></div>
      <div class="ob"><div class="l">${T('Avance à verser')}</div><div class="v" style="color:var(--acc2)">${none?'—':eur(adv)}</div></div>
      <div class="ob"><div class="l">${T('Revenu capté /mois')}</div><div class="v" style="color:var(--cyan)">${none?'—':eur(lm)}</div></div>
      <div class="ob"><div class="l">${T('Payback')}</div><div class="v ${none?'':paybackClass(pb)}">${none?'—':paybackTxt(pb)}</div></div>
      <div class="ob"><div class="l">${T('Contact')}</div><div class="v" style="font-size:12.5px;font-family:Inter;font-weight:600;margin-top:8px">${contact}</div></div>
    </div>
    <div style="font-size:10.5px;color:var(--dim);margin-top:12px">${T("Base : revenu 24 mois projeté (vélocité × 0,0035$/stream, +20% Apple Music & autres plateformes) → EUR ×0,875, −8% Orchard, −12% coûts, −15% décote. Grille du modèle LOFI RECORDS. Publishing = +10% sur l'avance. Coche des tracks pour simuler. Estimation indicative, hors CIPP.")}</div>
  </div>`;
}
function setPalier(k){ S.palier = k; render(); }

/* ---------- Fiche artiste en pop-up (simulateur + tracks) ---------- */
/* fiche artiste = uniquement les tracks indé (self-released), les tracks sous label
   se rachètent via la fiche label correspondante */
function artistRows(i){ return R.filter(r=>r[0]===i && r[4]===0).sort((a,b)=>b[3]-a[3]); }
function artistTableRows(rows){
  return rows.map(r=>{ const w30=trackWindow(r,30), w7=trackWindow(r,7), w1=trackWindow(r,1); return `
    <tr data-basehot="${r[3]>=HOT?1:0}" class="${r[3]>=HOT||S.sel.has(r[6])?'hot':''}">
      <td class="selc"><input type="checkbox" class="ck sel-track" data-tid="${r[6]}" ${S.sel.has(r[6])?'checked':''}></td>
      <td class="covtd">${r[8]?`<div class="cov has" style="background-image:url('${esc(r[8])}')"></div>`:`<div class="cov" data-tid="${r[6]}"></div>`}</td>
      <td><span class="tk" style="cursor:pointer" onclick="openTrack('${r[6]}')">${esc(r[1])}</span> ${wlStar('t',r[6])}${r[7]?' <span class="badge new">'+T('détectée')+' '+r[7].slice(5)+'</span>':''}</td>
      <td class="num" title="${fmtFull(r[3])}">${streamStackHtml(r[3]>=0?r[3]:null,false,false)}</td>
      <td class="num">${streamStackHtml(w30.current,false,false)}</td>
      <td class="num">${streamStackHtml(w7.current,false,false)}</td>
      <td class="num">${streamStackHtml(w1.current,false,false)}</td>
      <td class="num"><span style="color:var(--acc2);font-weight:600">${perMonth(r)<0?'—':eur(advance(perMonth(r)))}</span></td>
      <td>${fmtDate(r[2])}</td>
      <td><span class="badge ${r[4]===0?'self':'other'}">${r[4]===0?T('Indé'):'Label'}</span></td>
    </tr>`;}).join('');
}
function renderArtistModal(){
  const i = S.artist; const g = AG[i]; if(!g) return;
  const rows = artistRows(i);
  const allRows = TRACKS_BY_ARTIST.get(i) || [];
  const perf = g.perf || performanceForRows(allRows);
  const flows = aggregateDailyFlow(allRows);
  const audience = artistAudience(g);
  const entry = artistPerfEntry(g);
  const classification = artistClassification(g);
  const selfPct = g.n ? Math.round(g.self/g.n*100) : 0;
  const selM = rows.filter(r=>S.sel.has(r[6])).reduce((s,r)=>s+Math.max(perMonth(r),0),0);
  const selN = rows.filter(r=>S.sel.has(r[6])).length;
  const box = document.getElementById('am-body');
  box.innerHTML = `
    <div class="thd">
      <div class="av-sm">${esc(g.name[0]||'?').toUpperCase()}${avatarHtml(g)}</div>
      <div style="min-width:0;flex:1">
        <h3>${esc(g.name)}</h3>
        <div class="tar" style="cursor:default">${T('Fiche Analytics')} · ${segBadge(g)} · ${rows.length} ${T('tracks indé')} (${T('sur')} ${g.n} ${T('hors Lofi')})</div>
        <a class="chip" style="display:inline-flex;margin-top:8px;text-decoration:none" href="${g.id?'https://open.spotify.com/artist/'+encodeURIComponent(g.id):artistSearch(g.name)}" target="_blank" rel="noopener">▶ ${T('Ouvrir sur Spotify')}</a>
      </div>
      <button class="tclose" onclick="closeArtistModal()">✕</button>
    </div>
    <div class="tgrid">
      <div class="tg"><div class="l">Tracks</div><div class="v">${fmtFull(g.n)}</div></div>
      <div class="tg"><div class="l">${T('Indé')}</div><div class="v">${fmtFull(g.self)} · ${selfPct}%</div></div>
      <div class="tg"><div class="l">≥ 500k</div><div class="v">${fmtFull(g.hot)}</div></div>
      <div class="tg"><div class="l">${T('Dernière sortie')}</div><div class="v" style="font-size:13px">${fmtDate(g.last)}</div></div>
      <div class="tg"><div class="l">${T('Signal performance')}</div><div class="v" style="font-size:13px">${performanceSignal(perf,entry)}</div></div>
    </div>
    <div class="toolbar" style="justify-content:flex-end;margin:0 0 10px">${metricModeToggleHtml()}</div>
    ${perfGridHtml(perf,'Streams',g.streams,true)}
    ${classificationAnalyticsHtml(classification)}
    <div class="analytics-section">
      <h4>${T(S.metricMode==='revenue'?'Courbe quotidienne des revenus estimés':'Courbe quotidienne des streams')} <span class="analytics-note">${T(S.metricMode==='revenue'?'Revenu quotidien estimé d’après les streams':'Flux quotidien, pas compteur lifetime')}</span></h4>
      ${dailyChartHtml(metricSeries(flows.points),T('Historique quotidien insuffisant pour tracer la courbe.'))}
      ${flows.points.length?`<div class="analytics-note">${T('Données partielles')} · ${T('couverture variable selon les tracks')}</div>`:''}
    </div>
    <div class="analytics-section">
      <h4>${T('Évolution des monthly listeners')}</h4>
      <div class="analytics-kpis">
        <div class="analytics-kpi"><div class="l">Monthly listeners</div><div class="v">${fmtFullMetric(audience.current)}</div></div>
        <div class="analytics-kpi"><div class="l">${T('Dernière variation')}</div><div class="v">${signedFull(audience.delta)}</div></div>
        <div class="analytics-kpi"><div class="l">${T('Dernière observation')}</div><div class="v">${audience.date?fmtDate(audience.date):'—'}</div></div>
      </div>
      ${dailyChartHtml(audience.history,T("Historique de monthly listeners non raccordé."))}
    </div>
    <div class="analytics-section">
      <h4>${T('Tracks les plus contributrices')} <span class="analytics-note">7 j</span></h4>
      ${contributorsHtml(allRows,7)}
    </div>
    ${offerHtml(g, selM, selN, rows.length)}
    <label class="selall" style="margin:2px 0 8px"><input type="checkbox" class="ck" id="am-sel-all" ${rows.length&&rows.every(r=>S.sel.has(r[6]))?'checked':''}> ${T('Tout sélectionner')}</label>
    <table><thead><tr>
      <th class="selc"></th><th></th><th>Track</th>
      <th class="num">${streamMetricLabel(0)}</th><th class="num">${streamMetricLabel(30)}</th>
      <th class="num">${streamMetricLabel(7)}</th><th class="num">${streamMetricLabel(1)}</th><th class="num">${T('Rachat')} ${S.palier}</th>
      <th>${T('Sortie')}</th><th>${T('Statut')}</th>
    </tr></thead><tbody>${artistTableRows(rows)}</tbody></table>
    ${rows.length===0?'<div class="empty">'+T('Aucune track indé. Les tracks de cet artiste sont toutes sous label : passe par la fiche du label (onglet All labels).')+'</div>':''}
  `;
  bindMetricModeToggle(renderArtistModal,box);
  attachCovers();
  function updateSel(){
    const selM2 = rows.filter(r=>S.sel.has(r[6])).reduce((s,r)=>s+Math.max(perMonth(r),0),0);
    const selN2 = rows.filter(r=>S.sel.has(r[6])).length;
    const off = box.querySelector('.offer');
    if (off) off.outerHTML = offerHtml(g, selM2, selN2, rows.length);
    box.querySelectorAll('.sel-track').forEach(cb=>{
      const tr=cb.closest('tr'); const on=S.sel.has(cb.dataset.tid);
      cb.checked=on; if(tr) tr.classList.toggle('hot', on || tr.dataset.basehot==='1');
    });
    const allOn = rows.length && rows.every(r=>S.sel.has(r[6]));
    const sa=document.getElementById('am-sel-all'); if(sa) sa.checked=allOn;
  }
  box.querySelectorAll('.sel-track').forEach(cb=>{
    cb.addEventListener('change', ()=>{ if(cb.checked)S.sel.add(cb.dataset.tid); else S.sel.delete(cb.dataset.tid); updateSel(); });
  });
  const sa = document.getElementById('am-sel-all');
  if (sa) sa.addEventListener('change', ()=>{ if(sa.checked) rows.forEach(r=>S.sel.add(r[6])); else rows.forEach(r=>S.sel.delete(r[6])); updateSel(); });
}

/* ---------- Watchlist (épinglage tracks + artistes, localStorage) ---------- */
function wlGet(){ try{ return Object.assign({t:[],a:[]}, JSON.parse(localStorage.getItem('sr_wl')||'{}')); }catch(e){ return {t:[],a:[]}; } }
function wlSet(w){ try{ localStorage.setItem('sr_wl', JSON.stringify(w)); }catch(e){} }
function wlHas(type,k){ return wlGet()[type].includes(k); }
function toggleWL(type,k,ev){
  if(ev) ev.stopPropagation();
  const w=wlGet(); const i=w[type].indexOf(k);
  if(i>=0) w[type].splice(i,1); else w[type].push(k);
  wlSet(w);
  const el=document.getElementById('c-watch'); if(el) el.textContent=w.t.length+w.a.length||'';
  if(ev&&ev.currentTarget){ const on=w[type].includes(k); ev.currentTarget.classList.toggle('on',on); ev.currentTarget.textContent=on?'⭐':'☆'; if(on){ ev.currentTarget.classList.remove('pop'); void ev.currentTarget.offsetWidth; ev.currentTarget.classList.add('pop'); } }
  if(S.view==='watch') render();
}
function wlStar(type,k){
  const on=wlHas(type,k);
  return `<button class="wl-star ${on?'on':''}" title="${T('Ajouter / retirer de la watchlist')}" onclick="toggleWL('${type}','${String(k).replace(/'/g,"\\'")}',event)">${on?'⭐':'☆'}</button>`;
}
function fmtDate(iso){ const m=(''+iso).match(/^(\d{4})-(\d{2})-(\d{2})/); return m?m[3]+'/'+m[2]+'/'+m[1]:(iso||'?'); }

/* ---------- Fiche track (analytics) ---------- */
function sparkline(pts){
  if (!pts || pts.length<2) return '';
  const w=560, h=120, pad=6;
  const xs=pts.map(p=>+new Date(p[0])), ys=pts.map(p=>p[1]);
  const x0=Math.min(...xs), x1=Math.max(...xs), y0=Math.min(...ys), y1=Math.max(...ys);
  const sx=v=>pad+(x1===x0?0:(v-x0)/(x1-x0))*(w-2*pad);
  const sy=v=>h-pad-(y1===y0?0.5*(h-2*pad):(v-y0)/(y1-y0)*(h-2*pad));
  const d=pts.map((p,i)=>(i?'L':'M')+sx(+new Date(p[0])).toFixed(1)+' '+sy(p[1]).toFixed(1)).join(' ');
  const up = ys[ys.length-1]>=ys[0];
  const col = up?'#4ade80':'#fb7185';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="100%" height="120" preserveAspectRatio="none">
    <path d="${d}" fill="none" stroke="${col}" stroke-width="2.5"/>
    <path d="${d} L ${sx(x1)} ${h-pad} L ${sx(x0)} ${h-pad} Z" fill="${col}" opacity="0.12"/>
  </svg>`;
}
/* mini simulateur d'offre pour une track seule (pop-up track) */
function trackOfferHtml(r){
  const m = Math.max(perMonth(r), 0);
  const adv = advance(m), lm = labelMonthly(m), pb = payback(m);
  return `<div class="offer" style="margin:14px 0 0;padding:14px 16px">
    <h3 style="margin:0 0 8px">💰 ${T('Offre suggérée pour cette track')}</h3>
    <div class="pal" style="margin-bottom:10px">
      ${BUY.paliers.map(pp=>`<button class="${pp.k===S.palier?'on':''}" onclick="S.palier='${pp.k}';openTrack('${r[6]}')">${pp.k}</button>`).join('')}
      <label class="selall" style="margin-left:12px"><input type="checkbox" class="ck" ${S.publishing?'checked':''} onchange="S.publishing=this.checked;openTrack('${r[6]}')"> Publishing +10%</label>
    </div>
    <div class="ogrid" style="grid-template-columns:repeat(3,1fr)">
      <div class="ob"><div class="l">${T('Avance à proposer')}</div><div class="v" style="color:var(--acc2)">${m>0?eur(adv):'—'}</div></div>
      <div class="ob"><div class="l">${T('Revenu capté /mois')}</div><div class="v" style="color:var(--cyan)">${m>0?eur(lm):'—'}</div></div>
      <div class="ob"><div class="l">${T('Payback')}</div><div class="v ${m>0?paybackClass(pb):''}">${m>0?paybackTxt(pb):'—'}</div></div>
    </div>
  </div>`;
}
function openTrack(tid){
  const r = R.find(x=>x[6]===tid); if(!r) return;
  const g = AG[r[0]];
  const perf = {1:trackWindow(r,1),7:trackWindow(r,7),30:trackWindow(r,30)};
  const daily = dailyFlowSeries(HIST[tid] || []);
  const entry = trackPerfEntry(r);
  const classification = trackClassification(r);
  const velocity = perf[7].currentReady ? perf[7].current/7 : null;
  const cadence = Number.isFinite(Number(entry.cadence_days)) ? Number(entry.cadence_days)+' j' : '—';
  const label = entry.label || (r[4]===1 ? r[5] : null);
  const box = document.getElementById('tmbox');
  box.innerHTML = `
    <div class="thd">
      <div class="tcov" ${r[8]?`style="background-image:url('${esc(r[8])}')"`:''}></div>
      <div style="min-width:0">
        <h3>${esc(r[1])}</h3>
        <div class="tar" onclick="closeTrack();goArtist(${r[0]})">${T('Fiche Analytics')} · ${esc(A[r[0]][0])} ${segBadge(g)}</div>
      </div>
      <button class="tclose" onclick="closeTrack()">✕</button>
    </div>
    <div class="tgrid">
      <div class="tg"><div class="l">${T(S.metricMode==='revenue'?'Revenu estimé / jour':'Vélocité réelle')}</div><div class="v" style="color:var(--cyan)">${velocity==null?'—':(S.metricMode==='revenue'?revenueEstimate(velocity):fmt(Math.round(velocity))+'/'+T('jour'))}</div></div>
      <div class="tg"><div class="l">${T('Cadence')}</div><div class="v">${cadence}</div></div>
      <div class="tg"><div class="l">${T('Signal performance')}</div><div class="v" style="font-size:13px">${performanceSignal(perf,entry)}</div></div>
      <div class="tg"><div class="l">${T('Sortie')}</div><div class="v">${fmtDate(r[2])}</div></div>
      <div class="tg"><div class="l">${T('Classification')}</div><div class="v" style="font-size:13px">${r[4]===0?T('Indépendant'):'Label'}</div></div>
      <div class="tg"><div class="l">${T('Label')}</div><div class="v" style="font-size:12px;line-height:1.4">${label?esc(label):'—'}</div></div>
      <div class="tg"><div class="l">© / ℗</div><div class="v" style="font-size:12px;line-height:1.4">${r[5]?esc(r[5]):'—'}</div></div>
    </div>
    <div class="toolbar" style="justify-content:flex-end;margin:0 0 10px">${metricModeToggleHtml()}</div>
    ${perfGridHtml(perf,'Streams',r[3]>=0?r[3]:null,true)}
    ${classificationAnalyticsHtml(classification)}
    <div class="analytics-section">
      <h4>${T(S.metricMode==='revenue'?'Courbe quotidienne des revenus estimés':'Courbe quotidienne des streams')} <span class="analytics-note">${T(S.metricMode==='revenue'?'Revenu quotidien estimé d’après les streams':'Flux quotidien, pas compteur lifetime')}</span></h4>
      ${dailyChartHtml(metricSeries(daily),T('Historique quotidien insuffisant pour tracer la courbe.'))}
    </div>
    ${trackOfferHtml(r)}
    <div style="display:flex;gap:10px;margin-top:14px">
      <a class="btn-back" style="margin:0;text-decoration:none" href="${trackUrl(r[6])}" target="_blank" rel="noopener">▶ ${T('Ouvrir sur Spotify')}</a>
      <button class="chip" onclick="toggleWL('t','${r[6]}',event);openTrack('${r[6]}')">${wlHas('t',r[6])?'⭐ '+T('Épinglé'):'☆ '+T('Épingler')}</button>
    </div>
    <div class="tnote">${T("Les fenêtres Analytics utilisent uniquement l'historique quotidien et comparent des périodes de même durée. Le simulateur de rachat reste une estimation séparée.")}</div>`;
  bindMetricModeToggle(()=>openTrack(tid),box);
  document.getElementById('track-modal').style.display='flex';
}
function closeTrack(){ document.getElementById('track-modal').style.display='none'; }
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeTrack(); });

function arNoteKey(uuid){ return 'sr_ar_note_'+uuid; }
function arGetNote(uuid){ try{return localStorage.getItem(arNoteKey(uuid))||'';}catch(e){return '';} }
function arSetNote(uuid,value){ try{localStorage.setItem(arNoteKey(uuid),value);}catch(e){} }
function arDraft(candidate,note){
  const detail=(note||'un détail précis que tu as aimé après écoute').trim();
  const variants=[
    `Hi ${candidate.name},\n\nI came across your project while we were mapping independent instrumental artists, and I spent some time with your music. ${detail}.\n\nAt Lofi Girl, we are building long-term artist partnerships around releases, distribution, publishing and, when it makes sense, advances or master partnerships. Your project felt like one we should get to know properly.\n\nWould you be open to a short call next week?\n\nBest,\n[Name]`,
    `Hi ${candidate.name},\n\nI wanted to reach out personally after listening to your work. ${detail}. It has a very clear identity, and that is exactly what we look for when we discover artists outside our existing network.\n\nWe are exploring a few ways we could be useful, from release strategy and distribution to publishing or a deeper partnership when the timing is right. No pressure at all, but I would love to compare notes on where you want to take the project.\n\nWould a 20-minute conversation be useful?\n\nBest,\n[Name]`,
    `Hi ${candidate.name},\n\nYour music came up while our A&R team was digging into independent projects, and I wanted to write rather than send a generic message. ${detail}.\n\nLofi Girl can support artists across releases, label services, publishing and selected master deals. We also have our own editorial ecosystem, although any playlist or Station support always remains editorial and never guaranteed.\n\nIf you are open to it, I would be glad to set up a quick introduction.\n\nBest,\n[Name]`,
  ];
  let hash=0; for(const ch of String(candidate.uuid||candidate.name)) hash=(hash*31+ch.charCodeAt(0))>>>0;
  return variants[hash%variants.length];
}
function closeArModal(){ const modal=document.getElementById('ar-modal'); if(modal) modal.style.display='none'; }
function openArMessage(uuid){
  const candidate=arCandidates().find(item=>item.uuid===uuid); if(!candidate) return;
  const box=document.getElementById('ar-body');
  const note=arGetNote(uuid);
  const renderDraft=()=>{
    const currentNote=document.getElementById('ar-note')?.value||'';
    const draft=arDraft(candidate,currentNote);
    const output=document.getElementById('ar-draft'); if(output) output.value=draft;
  };
  box.className='tmbox ambox ar-composer';
  box.innerHTML=`
    <div class="thd">
      <div class="av-sm">${esc((candidate.name[0]||'?').toUpperCase())}</div>
      <div style="min-width:0;flex:1"><h3>${esc(candidate.name)}</h3><div class="tar" style="cursor:default">Brouillon A&R personnel · non envoyé</div></div>
      <button class="tclose" onclick="closeArModal()">✕</button>
    </div>
    <div class="analytics-section">
      <h4>Le détail qui rend le message personnel</h4>
      <div class="analytics-note" style="margin-bottom:10px">Ajoute après écoute un élément précis : un titre, une texture, une progression, une intention artistique. Le brouillon ne doit jamais partir sans cette note.</div>
      <textarea id="ar-note" style="width:100%;min-height:76px" placeholder="Ex. J'ai aimé la façon dont [track] garde une mélodie très simple tout en laissant beaucoup d'espace…">${esc(note)}</textarea>
      <div class="toolbar" style="margin:10px 0 0"><button class="chip on" id="ar-refresh">Mettre à jour le brouillon</button><span class="spacer"></span><button class="chip" id="ar-copy">Copier</button></div>
    </div>
    <div class="analytics-section"><h4>Message proposé</h4><textarea id="ar-draft" readonly style="width:100%;min-height:300px"></textarea></div>`;
  const noteInput=document.getElementById('ar-note');
  noteInput.addEventListener('input',()=>arSetNote(uuid,noteInput.value));
  document.getElementById('ar-refresh').addEventListener('click',renderDraft);
  document.getElementById('ar-copy').addEventListener('click',async()=>{
    const text=document.getElementById('ar-draft').value;
    try{await navigator.clipboard.writeText(text); document.getElementById('ar-copy').textContent='Copié';}
    catch(e){document.getElementById('ar-draft').select(); document.execCommand('copy'); document.getElementById('ar-copy').textContent='Copié';}
  });
  renderDraft();
  document.getElementById('ar-modal').style.display='flex';
}
function radarAiFilterHtml(){
  return `<select id="radar-ai">
    <option value="hide_high" ${S.radarAiRisk==='hide_high'?'selected':''}>Risque IA : masquer élevé</option>
    <option value="all" ${S.radarAiRisk==='all'?'selected':''}>Risque IA : tous</option>
    <option value="high_only" ${S.radarAiRisk==='high_only'?'selected':''}>Risque IA : élevé uniquement</option>
  </select>`;
}
function bindRadarAiFilter(){
  const select=document.getElementById('radar-ai');
  if(select) select.addEventListener('change',event=>{S.radarAiRisk=event.target.value;renderRadar();});
}
function renderRadarLegacy(){
  if(!SC){
    V.innerHTML=`<div class="page-head"><div><h2>${T('Opportunités A&R')}</h2><p>${T('Données Soundcharts non encore exportées.')}</p></div></div><div class="toolbar">${radarAiFilterHtml()}</div>`;
    bindRadarAiFilter();
    return;
  }
  const all=arCandidates();
  const aiFiltered=all.filter(candidate=>S.radarAiRisk==='all'
    || (S.radarAiRisk==='hide_high' && candidate.classification.ai!=='Élevé')
    || (S.radarAiRisk==='high_only' && candidate.classification.ai==='Élevé'));
  const priorityPool=aiFiltered.filter(candidate=>candidate.qualifies && candidate.listeners>=50000 && candidate.sources>=2 && candidate.classification.rights!=='À vérifier');
  const candidates=aiFiltered.filter(candidate=>S.radarFilter==='all'
    || (S.radarFilter==='priority' && priorityPool.includes(candidate))
    || (S.radarFilter==='qualified' && candidate.qualifies)
    || (S.radarFilter==='review' && candidate.review));
  const qualified=aiFiltered.filter(candidate=>candidate.qualifies);
  const ready=aiFiltered.filter(candidate=>candidate.review);
  const trackPool=arTrackCandidates().filter(track=>aiFiltered.includes(track.candidate)).slice(0,25);
  const selectedTrack=trackPool.find(track=>track.spotifyId===S.radarTrackId)||trackPool[0]||null;
  const clusters=arClusters();
  const rows=candidates.slice(0,S.radarFilter==='priority'?S.radarLimit:500);
  V.innerHTML=`
    <div class="page-head"><div><h2>${T('Opportunités A&R')}</h2><p>Radar strictement instrumental/background : genre éditorial vérifié, preuve instrumentale, risque IA faible, droits indé/self-released repérés et audience de 10k à 750k. Les profils inconnus, majors, trop installés ou grand public sont exclus.</p></div></div>
    <div class="ovgrid" style="margin-bottom:16px">
      <div class="panel ovp"><div class="ovh"><h3>💎 ${T('Pépites à écouter')}</h3></div><div class="ov-stats"><div class="ov-st"><div class="v">${fmtFull(qualified.length)}</div><div class="l">≥ 50k ${T('Auditeurs mensuels').toLowerCase()}</div></div><div class="ov-st"><div class="v">${fmtFull(all.length)}</div><div class="l">profils instrumentaux vérifiés</div></div></div></div>
      <div class="panel ovp"><div class="ovh"><h3>✅ ${T('Prêt à contacter')}</h3></div><div class="ov-stats"><div class="ov-st"><div class="v">${fmtFull(ready.length)}</div><div class="l">genre + instrumental + IA + droits assez renseignés</div></div></div></div>
      <div class="panel ovp"><div class="ovh"><h3>🌊 ${T('Filons confirmés')}</h3></div><div class="ov-stats"><div class="ov-st"><div class="v">${fmtFull(clusters.length)}</div><div class="l">clusters instrumentaux validés</div></div></div></div>
    </div>
    <div class="toolbar">
      <button class="chip ${S.radarFilter==='priority'?'on':''}" data-radar-filter="priority">Top priorités (${fmtFull(Math.min(S.radarLimit,priorityPool.length))})</button>
      <button class="chip ${S.radarFilter==='qualified'?'on':''}" data-radar-filter="qualified">${T('Pépites à écouter')} (${fmtFull(qualified.length)})</button>
      <button class="chip ${S.radarFilter==='review'?'on':''}" data-radar-filter="review">${T('Prêt à contacter')} (${fmtFull(ready.length)})</button>
      <button class="chip ${S.radarFilter==='all'?'on':''}" data-radar-filter="all">Pool instrumental vérifié (${fmtFull(aiFiltered.length)})</button>
      <select id="radar-limit"><option value="100" ${S.radarLimit===100?'selected':''}>Top 100 / jour</option><option value="500" ${S.radarLimit===500?'selected':''}>Top 500 / jour</option></select>
      ${radarAiFilterHtml()}
    </div>
    <div class="panel" style="padding:6px 14px 14px"><table><thead><tr><th>#</th><th>${T('Artiste')}</th><th>${T('Signal de découverte')}</th><th class="num">${T('Auditeurs mensuels')}</th><th>${T('Réseau Fans Also Like')}</th><th>${T('Contact')}</th><th>${T('Étape suivante')}</th></tr></thead><tbody>
      ${rows.map((candidate,index)=>{const contact=arKnownContact(candidate.name);return `<tr>
        <td class="num">${index+1}</td>
        <td><a class="ar" href="${artistSearch(candidate.name)}" target="_blank" rel="noopener">${esc(candidate.name)}</a></td>
        <td><span class="badge ${candidate.score>=70?'self':'new'}">${candidate.score}/100</span><div class="genre-sub">${candidate.qualifies?'pré-sélection ≥50k':'audience à confirmer'}</div></td>
        <td class="num">${fmtFull(candidate.listeners)}</td>
        <td>${candidate.sources} source${candidate.sources>1?'s':''}${candidate.rank?` · rang ${candidate.rank}`:''}</td>
        <td>${contact?`<a href="mailto:${esc(contact)}" class="ar">${esc(contact)}</a>`:'<span class="genre-sub">À enrichir</span>'}</td>
        <td>${candidate.qualifies?`<button class="chip ${candidate.review?'on':''}" onclick="openArMessage('${esc(candidate.uuid)}')">Préparer message</button>`:`<span class="genre-sub">${T('Écoute + genre / IA / droits')}</span>`}</td>
      </tr>`;}).join('')}
    </tbody></table>${rows.length===0?`<div class="empty">${T('Données insuffisantes')}</div>`:''}</div>
    <div class="analytics-section" style="margin-top:16px"><h4>${T('Filons confirmés')}</h4>${clusters.length?`<div class="contributors">${clusters.map(cluster=>`<div class="contributor"><span class="cn">${esc(cluster.genre)}</span><span class="cv">${cluster.artists} artistes · ${cluster.tracks} tracks</span></div>`).join('')}</div>`:`<div class="analytics-note">${T('Aucun filon confirmé')} · ${T('Historique en cours : un filon nécessite des genres fiables, plusieurs artistes et des mesures successives.')}</div>`}</div>`;
  if(trackPool.length){
    const trackPanel=`<div class="panel ar-track-panel">
      <div class="ar-track-head"><div><h3>🎧 Tracks prioritaires à écouter</h3><p>Les titres passent avant les profils : score A&R, réseau Fans Also Like et volume Soundcharts.</p></div><span class="badge new">${trackPool.length} titres</span></div>
      <div class="ar-track-list">${trackPool.map((track,index)=>`<div class="ar-track-row">
        <button class="ar-track-play" title="Écouter ${esc(track.title)}" onclick="playArTrack('${esc(track.spotifyId)}')">${track.spotifyId===S.radarTrackId?'❚❚':'▶'}</button>
        <div><div class="ar-track-title">${index+1}. ${esc(track.title)}</div><div class="ar-track-artist">${esc(track.artist)} · ${fmtFull(track.candidate.listeners)} auditeurs mensuels</div></div>
        <div class="ar-track-num">${fmt(track.streams)}<div class="genre-sub">streams total</div></div>
        <div class="ar-track-score"><span class="badge ${track.score>=80?'self':'new'}">${track.score}/100</span></div>
      </div>`).join('')}</div>
      ${selectedTrack?`<div class="ar-player"><div><div class="ar-player-label">Lecture intégrée Spotify</div><div class="ar-player-name">${esc(selectedTrack.title)} <span style="color:var(--muted);font-weight:500">· ${esc(selectedTrack.artist)}</span></div></div><iframe title="Spotify player · ${esc(selectedTrack.title)}" src="https://open.spotify.com/embed/track/${esc(selectedTrack.spotifyId)}?utm_source=generator" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe></div>`:''}
    </div>`;
    V.querySelector('.toolbar').insertAdjacentHTML('afterend',trackPanel);
  }
  document.querySelectorAll('[data-radar-filter]').forEach(button=>button.addEventListener('click',()=>{S.radarFilter=button.dataset.radarFilter;renderRadar();}));
  document.getElementById('radar-limit').addEventListener('change',event=>{S.radarLimit=+event.target.value;S.radarFilter='priority';renderRadar();});
  bindRadarAiFilter();
}

/* ---------- Opportunités A&R v2 : track-first, explicable et actionnable ---------- */
let AR_OPPORTUNITY_CACHE=null;
let AR_TRACK_ROW_CACHE=null;
function arNullableNumber(value){
  if(value==null || value==='') return null;
  const number=Number(value);
  return Number.isFinite(number)?number:null;
}
function arTrackRowById(spotifyId){
  if(!AR_TRACK_ROW_CACHE) AR_TRACK_ROW_CACHE=new Map(R.filter(row=>row&&row[6]).map(row=>[String(row[6]),row]));
  return AR_TRACK_ROW_CACHE.get(String(spotifyId||''))||null;
}
function arHasCompleteStructuredArtists(artists){
  return Array.isArray(artists)&&artists.length>0&&artists.every(artist=>
    String(artist&&artist.spotify_id||'').trim()&&String(artist&&artist.soundcharts_uuid||'').trim());
}
function arIsContactable(opportunity){
  const contactStatus=String(opportunity&&opportunity.contactStatus||'').toLowerCase();
  const hasChannel=(contactStatus==='ready'&&Boolean(opportunity&&opportunity.contactEmail))
    ||(contactStatus==='social'&&Boolean(opportunity&&opportunity.contactUrl));
  return Boolean(opportunity
    &&opportunity.status==='verified'
    &&SC_ALLOWED_GENRES.has(opportunity.genre)
    &&opportunity.genreConfidence!=null
    &&opportunity.genreConfidence>=.5
    &&opportunity.instrumental==='instrumental'
    &&opportunity.instrumentalConfidence!=null
    &&opportunity.instrumentalConfidence>=.5
    &&opportunity.aiRisk==='low'
    &&['self_released','independent_label','indie'].includes(opportunity.rights)
    &&arHasCompleteStructuredArtists(opportunity.artists)
    &&hasChannel);
}
function arOpportunityRows(){
  if(AR_OPPORTUNITY_CACHE) return AR_OPPORTUNITY_CACHE;
  if(!SC || !Array.isArray(SC.opportunities)) return [];
  const schema=SC.schemas&&SC.schemas.opportunities||[];
  AR_OPPORTUNITY_CACHE=SC.opportunities.map(row=>{
    const spotifyId=String(scValue(row,schema,'spotify_id')||'');
    const structured=Array.isArray(scValue(row,schema,'artists'))?scValue(row,schema,'artists'):[];
    const status=String(scValue(row,schema,'opportunity_status')||'needs_listen').toLowerCase();
    const genre=String(scValue(row,schema,'primary_genre')||'other').toLowerCase();
    const genreConfidence=arNullableNumber(scValue(row,schema,'genre_confidence'));
    const instrumental=String(scValue(row,schema,'instrumental_status')||'unknown').toLowerCase();
    const instrumentalConfidence=arNullableNumber(scValue(row,schema,'instrumental_confidence'));
    const aiRisk=String(scValue(row,schema,'ai_risk')||'unknown').toLowerCase();
    const rights=String(scValue(row,schema,'rights_status')||'unknown').toLowerCase();
    const rawContactEmail=String(scValue(row,schema,'contact_email')||'');
    const rawContactUrl=String(scValue(row,schema,'contact_url')||'');
    const rawContactPlatform=String(scValue(row,schema,'contact_platform')||'');
    const rawContactStatus=String(scValue(row,schema,'contact_status')||'enrich').toLowerCase();
    const contactProbe={status,genre,genreConfidence,instrumental,instrumentalConfidence,aiRisk,rights,artists:structured,
      contactEmail:rawContactEmail,contactUrl:rawContactUrl,contactStatus:rawContactStatus};
    const contactable=arIsContactable(contactProbe);
    const reasons=Array.isArray(scValue(row,schema,'reasons'))?scValue(row,schema,'reasons').filter(Boolean):[];
    const reasonCodes=Array.isArray(scValue(row,schema,'reason_codes'))?scValue(row,schema,'reason_codes').filter(Boolean):[];
    const labels=Array.isArray(scValue(row,schema,'labels'))?scValue(row,schema,'labels').filter(Boolean):[];
    const rosterRelationship=scValue(row,schema,'roster_relationship');
    const relationshipArtists=rosterRelationship&&typeof rosterRelationship==='object'&&Array.isArray(rosterRelationship.artists)
      ? rosterRelationship.artists.filter(Boolean)
      : [];
    /* A legacy numeric/boolean roster flag is not enough to assert a Lofi
       relationship publicly. Require the structured relationship evidence. */
    const knownRoster=Boolean(rosterRelationship&&typeof rosterRelationship==='object'
      && rosterRelationship.status==='existing'&&relationshipArtists.length);
    const credit=String(scValue(row,schema,'credit_name')||structured.map(artist=>artist&&artist.name).filter(Boolean).join(' & ')||'Artiste non renseigné');
    return {
      status,
      spotifyId,
      soundchartsUuid:String(scValue(row,schema,'soundcharts_uuid')||''),
      title:String(scValue(row,schema,'title')||'Titre non renseigné'),
      credit,
      artists:structured,
      releaseDate:String(scValue(row,schema,'release_date')||''),
      genre,
      subgenres:Array.isArray(scValue(row,schema,'subgenres'))?scValue(row,schema,'subgenres'):[],
      genreConfidence,
      instrumental,
      instrumentalConfidence,
      aiRisk,
      aiRiskScore:arNullableNumber(scValue(row,schema,'ai_risk_score')),
      rights,
      label:String(scValue(row,schema,'label')||labels[0]||''),
      labels,
      copyright:String(scValue(row,schema,'copyright')||''),
      distributor:String(scValue(row,schema,'distributor')||''),
      streams:arNullableNumber(scValue(row,schema,'streams')),
      streamsSourceDate:String(scValue(row,schema,'streams_source_date')||''),
      streamsObservedAt:String(scValue(row,schema,'streams_observed_at')||''),
      delta24:arNullableNumber(scValue(row,schema,'streams_delta_24h')),
      deltaPreviousDate:String(scValue(row,schema,'delta_previous_source_date')||''),
      deltaWindowHours:arNullableNumber(scValue(row,schema,'delta_window_hours')),
      playlistCount:arNullableNumber(scValue(row,schema,'editorial_placement_count'))||0,
      bestPosition:arNullableNumber(scValue(row,schema,'editorial_best_position')),
      playlistFollowers:arNullableNumber(scValue(row,schema,'editorial_followers_total')),
      playlistFollowersKnown:arNullableNumber(scValue(row,schema,'editorial_followers_known_count'))||0,
      topPlaylist:String(scValue(row,schema,'editorial_top_playlist')||''),
      firstPlaylistSeen:String(scValue(row,schema,'editorial_first_seen_at')||''),
      lastPlaylistSeen:String(scValue(row,schema,'editorial_last_seen_at')||''),
      knownRoster,
      relationshipArtists,
      score:arNullableNumber(scValue(row,schema,'score'))||0,
      scoreMomentum:arNullableNumber(scValue(row,schema,'score_momentum'))||0,
      scoreEditorial:arNullableNumber(scValue(row,schema,'score_editorial'))||0,
      scoreTraction:arNullableNumber(scValue(row,schema,'score_traction'))||0,
      scoreRecency:arNullableNumber(scValue(row,schema,'score_recency'))||0,
      scoreRelationship:arNullableNumber(scValue(row,schema,'score_relationship'))||0,
      scoreConfidence:arNullableNumber(scValue(row,schema,'score_confidence')),
      reasonCodes,
      reasons,
      metadataUpdatedAt:String(scValue(row,schema,'metadata_updated_at')||''),
      dealType:String(scValue(row,schema,'deal_type')||'rights_review'),
      dealPriority:arNullableNumber(scValue(row,schema,'deal_priority')),
      artistMonthlyListeners:arNullableNumber(scValue(row,schema,'artist_monthly_listeners')),
      artistSpotifyId:String(scValue(row,schema,'artist_spotify_id')||''),
      artistSoundchartsUuid:String(scValue(row,schema,'artist_soundcharts_uuid')||''),
      contactEmail:contactable?rawContactEmail:'',
      contactUrl:contactable?rawContactUrl:'',
      contactPlatform:contactable?rawContactPlatform:'',
      contactStatus:contactable?rawContactStatus:'blocked',
      contactable,
      streams7:arNullableNumber(scValue(row,schema,'streams_7d')),
      streams30:arNullableNumber(scValue(row,schema,'streams_30d')),
      streamsPrevious7:arNullableNumber(scValue(row,schema,'streams_previous_7d')),
      acceleration7:arNullableNumber(scValue(row,schema,'acceleration_7d')),
      growthPct7:arNullableNumber(scValue(row,schema,'growth_pct_7d')),
      velocityPerListener:arNullableNumber(scValue(row,schema,'velocity_per_listener')),
      releaseAgeDays:arNullableNumber(scValue(row,schema,'release_age_days')),
      rightsConfidence:arNullableNumber(scValue(row,schema,'rights_confidence')),
      classificationStatus:String(scValue(row,schema,'classification_status')||status),
      selectionTier:String(scValue(row,schema,'selection_tier')||'review'),
      sourceTier:String(scValue(row,schema,'source_tier')||'soundcharts_measured'),
    };
  }).filter(item=>item.spotifyId&&item.title&&arHasCompleteStructuredArtists(item.artists));
  return AR_OPPORTUNITY_CACHE;
}
function arGenreLabel(genre){
  return ({lofi_hip_hop:'Lofi hip-hop',guitar:'Guitare',nature:'Nature',jazz_jazzhop:'Jazz / jazzhop',classical:'Classique',ambient:'Ambient',piano:'Piano',halloween_lofi:'Halloween lofi',christmas_lofi:'Christmas lofi',dark_ambient:'Dark ambient',phonk_instrumental:'Phonk instrumental',dnb_instrumental:'DnB instrumental'})[genre]||String(genre||'À classifier').replaceAll('_',' ');
}
function arRightsLabel(rights){
  return rights==='self_released'?'Self-release confirmé':(['indie','independent_label'].includes(rights)?'Label indépendant':'Droits à vérifier');
}
function arDealLabel(type){
  return ({distribution:'Distribution',label_advance:'Label + avance',catalog_acquisition:'Rachat catalogue',rights_review:'Droits à vérifier'})[type]||'Opportunité';
}
function arDealHelp(type){
  return ({distribution:'Sortie récente indépendante à approcher pour la distribution.',label_advance:'Traction suffisante pour une offre label ou une avance.',catalog_acquisition:'Flux installé à étudier pour un rachat de catalogue.',rights_review:'Signal fort, propriété des droits à confirmer.'})[type]||'';
}
function arContactHtml(opportunity,compact=false){
  if(!arIsContactable(opportunity)) return '<span class="ar-contact-missing">Contact bloqué par les garde-fous</span>';
  if(opportunity.contactEmail) return `<a class="ar-contact-link" href="mailto:${esc(opportunity.contactEmail)}" onclick="event.stopPropagation()">✉ ${compact?'E-mail':esc(opportunity.contactEmail)}</a>`;
  if(opportunity.contactUrl) return `<a class="ar-contact-link" href="${esc(opportunity.contactUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">↗ ${compact?(opportunity.contactPlatform||'Contact'):esc(opportunity.contactPlatform||'Contact')}</a>`;
  return '<span class="ar-contact-missing">Contact à enrichir</span>';
}
function arConfidenceLabel(value){
  if(value==null) return 'preuve en construction';
  if(value>=.8) return 'confiance haute';
  if(value>=.55) return 'confiance moyenne';
  return 'à confirmer';
}
function arReleaseAgeDays(opportunity){
  if(!/^\d{4}-\d{2}-\d{2}/.test(opportunity.releaseDate)) return null;
  const value=Math.floor((TODAY-new Date(opportunity.releaseDate.slice(0,10)+'T00:00:00'))/864e5);
  return Number.isFinite(value)?Math.max(0,value):null;
}
function arOpportunityMetric(opportunity,days){
  if(days===1&&opportunity.delta24!=null) return opportunity.delta24;
  if(days===7&&opportunity.streams7!=null) return opportunity.streams7;
  if(days===30&&opportunity.streams30!=null) return opportunity.streams30;
  const track=arTrackRowById(opportunity.spotifyId);
  if(track){
    const window=trackWindow(track,days);
    if(window&&window.currentReady&&window.current!=null) return window.current;
  }
  return null;
}
function arOpportunityTotal(opportunity){
  if(opportunity.streams!=null) return opportunity.streams;
  const track=arTrackRowById(opportunity.spotifyId);
  return track&&Number(track[3])>=0?Number(track[3]):null;
}
function arStrongEditorial(opportunity){
  return opportunity.playlistCount>=2 || (opportunity.bestPosition!=null&&opportunity.bestPosition<=30) || (opportunity.playlistFollowers!=null&&opportunity.playlistFollowers>=100000);
}
function arOpportunityReasons(opportunity){
  const reasonRank=code=>(code==='streams_24h'||/^streams_24h_/.test(code))?0
    : code==='acceleration_7d'?1
    : code==='streams_7d'?2
    : code==='streams_observed'?3
    : code==='current_editorial_placement'?4
    : code==='editorial_followers_observed'?5
    : code==='editorial_best_position'?6
    : code==='recent_release'?7
    : /^deal_/.test(code)?8
    : code==='existing_roster_relationship'?9
    : code==='self_released_confirmed'||code==='indie_rights_confirmed'?10
    : /instrumental/.test(code)?11
    : /genre/.test(code)?12
    : 20;
  const reasons=opportunity.reasons.map((reason,index)=>({reason,index,rank:reasonRank(opportunity.reasonCodes[index]||'')}))
    .sort((a,b)=>a.rank-b.rank||a.index-b.index).map(item=>item.reason);
  const delta=arOpportunityMetric(opportunity,1), total=arOpportunityTotal(opportunity), age=arReleaseAgeDays(opportunity);
  if(!reasons.length){
    if(delta!=null&&delta>0) reasons.push(`+${fmt(Math.round(delta))} streams sur 24 h`);
    if(opportunity.playlistCount>0) reasons.push(`${fmtFull(opportunity.playlistCount)} placement${opportunity.playlistCount>1?'s':''} éditorial${opportunity.playlistCount>1?'ux':''}`);
    if(opportunity.bestPosition!=null) reasons.push(`meilleure position #${Math.round(opportunity.bestPosition)}`);
    if(total!=null&&total>0) reasons.push(`${fmt(total)} streams total`);
    if(age!=null&&age<=180) reasons.push(`sortie il y a ${age} jours`);
  }
  if(opportunity.status==='needs_listen'&&!reasons.some(reason=>/instrumental/i.test(reason))) reasons.push('instrumental à valider par écoute');
  if(opportunity.knownRoster&&!reasons.some(reason=>/relation|connu/i.test(reason))) reasons.push('artiste déjà en relation avec Lofi');
  return reasons.length?reasons:['Découverte éditoriale qualifiée · historique performance en construction'];
}
function arMetricCompact(value,signed=false){
  if(value==null) return '—';
  return signed?signedFull(Math.round(value)):fmt(value);
}
function arOpportunityFiltered(all){
  const query=S.radarQ.trim().toLowerCase();
  let rows=all.filter(opportunity=>{
    if(S.radarGenre!=='all'&&opportunity.genre!==S.radarGenre) return false;
    if(query&&!`${opportunity.title} ${opportunity.credit} ${opportunity.genre} ${opportunity.label} ${opportunity.contactEmail} ${opportunity.contactPlatform}`.toLowerCase().includes(query)) return false;
    if(['distribution','label_advance','catalog_acquisition','rights_review'].includes(S.radarFilter)) return opportunity.dealType===S.radarFilter;
    if(S.radarFilter==='rising') return (arOpportunityMetric(opportunity,1)||0)>0;
    if(S.radarFilter==='accelerating') return (opportunity.acceleration7||0)>0;
    if(S.radarFilter==='contactable') return arIsContactable(opportunity);
    if(S.radarFilter==='editorial') return arStrongEditorial(opportunity);
    if(S.radarFilter==='recent') { const age=opportunity.releaseAgeDays??arReleaseAgeDays(opportunity); return age!=null&&age<=180; }
    if(S.radarFilter==='verified') return opportunity.status==='verified';
    if(S.radarFilter==='needs_listen') return opportunity.status==='needs_listen';
    if(S.radarFilter==='known') return opportunity.knownRoster;
    return true;
  });
  rows.sort((a,b)=>{
    if(S.radarSort==='momentum') return (arOpportunityMetric(b,1)||-Infinity)-(arOpportunityMetric(a,1)||-Infinity)||b.score-a.score;
    if(S.radarSort==='acceleration') return (b.acceleration7??-Infinity)-(a.acceleration7??-Infinity)||b.score-a.score;
    if(S.radarSort==='streams') return (arOpportunityTotal(b)||-Infinity)-(arOpportunityTotal(a)||-Infinity)||b.score-a.score;
    if(S.radarSort==='editorial') return (b.playlistFollowers||0)-(a.playlistFollowers||0)||b.playlistCount-a.playlistCount||b.score-a.score;
    if(S.radarSort==='recent') return (a.releaseAgeDays??arReleaseAgeDays(a)??Infinity)-(b.releaseAgeDays??arReleaseAgeDays(b)??Infinity)||b.score-a.score;
    if(S.radarSort==='listeners') return (a.artistMonthlyListeners??Infinity)-(b.artistMonthlyListeners??Infinity)||b.score-a.score;
    return b.score-a.score||(b.scoreConfidence||0)-(a.scoreConfidence||0)||a.title.localeCompare(b.title);
  });
  return rows;
}
function arKpiButton(filter,label,value,help){
  return `<button class="ar-kpi-action ${S.radarFilter===filter?'on':''}" data-radar-filter="${filter}" data-radar-kpi="1"><span class="ar-kpi-label">${esc(label)}</span><span class="ar-kpi-value">${fmtFull(value)}</span><span class="ar-kpi-help">${esc(help)}</span></button>`;
}
function arOpportunityCard(opportunity,index){
  const total=arOpportunityTotal(opportunity), d30=arOpportunityMetric(opportunity,30), d7=arOpportunityMetric(opportunity,7), d1=arOpportunityMetric(opportunity,1);
  const reasons=arOpportunityReasons(opportunity), genre=arGenreLabel(opportunity.genre);
  const proof=`${arRightsLabel(opportunity.rights)} · ${genre} · ${opportunity.status==='verified'?'instrumental vérifié':'instrumental à écouter'}`;
  const listeners=opportunity.artistMonthlyListeners==null?'—':fmt(opportunity.artistMonthlyListeners);
  const accel=opportunity.acceleration7==null?'—':signedFull(Math.round(opportunity.acceleration7));
  return `<article class="ar-opportunity-card ${S.radarTrackId===opportunity.spotifyId?'playing':''}" tabindex="0" data-ar-card="${esc(opportunity.spotifyId)}">
    <div class="ar-rank-play"><span class="ar-rank">${index+1}</span><button class="ar-play-main" data-ar-play="${esc(opportunity.spotifyId)}" title="Écouter ${esc(opportunity.title)}">${S.radarTrackId===opportunity.spotifyId?'❚❚':'▶'}</button></div>
    <div class="ar-opp-main"><div class="ar-opp-title">${esc(opportunity.title)}</div><div class="ar-opp-artist">${esc(opportunity.credit)}</div><div class="ar-opp-tags"><span class="ar-mini-tag deal ${esc(opportunity.dealType)}">${esc(arDealLabel(opportunity.dealType))}</span><span class="ar-mini-tag good">${esc(arRightsLabel(opportunity.rights))}</span><span class="ar-mini-tag">${esc(genre)}</span>${opportunity.status==='needs_listen'?'<span class="ar-mini-tag">À valider à l’écoute</span>':''}</div><div class="ar-card-contact">${arContactHtml(opportunity,true)} · ${listeners} auditeurs/mois</div></div>
    <div class="ar-why"><div class="ar-why-label">Pourquoi elle est ici</div><div class="ar-why-text">${esc(reasons.slice(0,2).join(' · '))}</div><div class="ar-why-proof">${esc(proof)} · accélération 7 j ${esc(accel)}</div></div>
    <div class="ar-opp-metrics"><div class="ar-opp-metric"><div class="l">Total</div><div class="v">${arMetricCompact(total)}</div></div><div class="ar-opp-metric"><div class="l">30 jours</div><div class="v">${arMetricCompact(d30)}</div></div><div class="ar-opp-metric"><div class="l">7 jours</div><div class="v">${arMetricCompact(d7)}</div></div><div class="ar-opp-metric"><div class="l">24 heures</div><div class="v ${d1!=null&&d1>0?'up':''}">${arMetricCompact(d1,true)}</div></div></div>
    <div class="ar-score-box"><div class="ar-score-value">${Math.round(opportunity.score)}</div><div class="ar-score-confidence">${esc(arConfidenceLabel(opportunity.scoreConfidence))}</div><button class="ar-open-detail" data-ar-open="${esc(opportunity.spotifyId)}">Pourquoi ?</button></div>
  </article>`;
}
function arScoreLine(label,value,max){
  const width=Math.max(0,Math.min(100,(Number(value)||0)/max*100));
  return `<div class="ar-score-line"><span>${esc(label)}</span><span class="ar-score-track"><span class="ar-score-fill" style="width:${width}%"></span></span><span class="n">${Math.round(Number(value)||0)}/${max}</span></div>`;
}
function openArOpportunity(spotifyId){
  const opportunity=arOpportunityRows().find(item=>item.spotifyId===spotifyId); if(!opportunity) return;
  S.radarTrackId=spotifyId;
  const box=document.getElementById('ar-body'), reasons=arOpportunityReasons(opportunity);
  const total=arOpportunityTotal(opportunity), d30=arOpportunityMetric(opportunity,30), d7=arOpportunityMetric(opportunity,7), d1=arOpportunityMetric(opportunity,1);
  const track=arTrackRowById(spotifyId), confidence=arConfidenceLabel(opportunity.scoreConfidence);
  box.className='tmbox ambox';
  box.innerHTML=`<div class="thd"><div class="av-sm">♫</div><div style="min-width:0;flex:1"><h3>${esc(opportunity.title)}</h3><div class="tar" style="cursor:default">${esc(opportunity.credit)} · opportunité de track</div></div><button class="tclose" onclick="closeArModal()">✕</button></div>
    <div class="ar-detail-player"><iframe title="Spotify player · ${esc(opportunity.title)}" src="https://open.spotify.com/embed/track/${esc(spotifyId)}?utm_source=generator" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe></div>
    <div class="perf-grid">${totalMetricCardHtml('Streams',total,true)}${perfCardHtml(streamMetricLabel(30),{current:d30,currentReady:d30!=null,comparisonReady:false,total:1},true)}${perfCardHtml(streamMetricLabel(7),{current:d7,currentReady:d7!=null,comparisonReady:false,total:1},true)}${perfCardHtml(streamMetricLabel(1),{current:d1,currentReady:d1!=null,comparisonReady:false,total:1},true)}</div>
    <div class="analytics-section"><h4>Pourquoi cette musique est dans la liste</h4><div class="ar-detail-reasons">${reasons.map(reason=>`<div class="ar-detail-reason">${esc(reason)}</div>`).join('')}</div></div>
    <div class="analytics-section"><h4>Score track <span class="analytics-note">${Math.round(opportunity.score)}/100 · ${esc(confidence)}</span></h4><div class="ar-score-breakdown">${arScoreLine('Momentum',opportunity.scoreMomentum,35)}${arScoreLine('Signal éditorial',opportunity.scoreEditorial,20)}${arScoreLine('Traction',opportunity.scoreTraction,25)}${arScoreLine('Récence',opportunity.scoreRecency,15)}${arScoreLine('Relation',opportunity.scoreRelationship,5)}</div></div>
    <div class="tgrid"><div class="tg"><div class="l">Type d'offre</div><div class="v" style="font-size:13px">${esc(arDealLabel(opportunity.dealType))}</div><div class="genre-sub">${esc(arDealHelp(opportunity.dealType))}</div></div><div class="tg"><div class="l">Genre</div><div class="v" style="font-size:13px">${esc(arGenreLabel(opportunity.genre))}</div></div><div class="tg"><div class="l">Droits</div><div class="v" style="font-size:13px">${esc(arRightsLabel(opportunity.rights))}</div><div class="genre-sub">confiance ${opportunity.rightsConfidence==null?'—':Math.round(opportunity.rightsConfidence*100)+' %'}</div></div><div class="tg"><div class="l">Audience artiste</div><div class="v">${opportunity.artistMonthlyListeners==null?'—':fmt(opportunity.artistMonthlyListeners)}</div><div class="genre-sub">auditeurs mensuels Spotify</div></div><div class="tg"><div class="l">Accélération 7 j</div><div class="v">${opportunity.acceleration7==null?'—':signedFull(Math.round(opportunity.acceleration7))}</div><div class="genre-sub">vs 7 jours précédents</div></div><div class="tg"><div class="l">Contact</div><div class="v" style="font-size:12px">${arContactHtml(opportunity,false)}</div></div><div class="tg"><div class="l">Sortie</div><div class="v">${opportunity.releaseDate?fmtDate(opportunity.releaseDate.slice(0,10)):'—'}</div></div><div class="tg"><div class="l">Label / distributeur</div><div class="v" style="font-size:12px;line-height:1.4">${esc(opportunity.label||opportunity.distributor||'—')}</div></div><div class="tg"><div class="l">© / ℗</div><div class="v" style="font-size:11px;line-height:1.4">${esc(opportunity.copyright||'—')}</div></div><div class="tg"><div class="l">Playlists éditoriales</div><div class="v">${fmtFull(opportunity.playlistCount)}</div><div class="genre-sub">${opportunity.bestPosition==null?'position —':'meilleure #'+Math.round(opportunity.bestPosition)}</div></div></div>
    <div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:14px"><a class="btn-back" style="margin:0;text-decoration:none" href="${trackUrl(spotifyId)}" target="_blank" rel="noopener">▶ Ouvrir sur Spotify</a>${opportunity.artistSpotifyId?`<a class="chip" style="text-decoration:none" href="https://open.spotify.com/artist/${esc(opportunity.artistSpotifyId)}" target="_blank" rel="noopener">Profil artiste</a>`:''}${track?`<button class="chip" id="ar-open-full-track">Fiche analytics complète</button>`:''}</div>
    <div class="tnote">Les valeurs 24 h / 7 j / 30 j restent à « — » tant qu’aucune vraie baseline n’existe. Le score ne fabrique aucune croissance manquante.</div>`;
  if(track) document.getElementById('ar-open-full-track').addEventListener('click',()=>{closeArModal();openTrack(spotifyId);});
  document.getElementById('ar-modal').style.display='flex';
}
function renderRadar(){
  const all=arOpportunityRows();
  if(!SC || !Array.isArray(SC.opportunities)){
    V.innerHTML=`<div class="page-head"><div><h2>Opportunités A&R</h2><p class="ar-radar-intro">Le moteur A&R dynamique n’est pas encore disponible.</p></div></div><div class="ar-empty-state">Export Soundcharts en préparation.</div>`;
    return;
  }
  const scoring=SC.opportunity_scoring||{}, pool=SC.instrumental_pool||{};
  const distributions=all.filter(item=>item.dealType==='distribution');
  const advances=all.filter(item=>item.dealType==='label_advance');
  const catalogues=all.filter(item=>item.dealType==='catalog_acquisition');
  const rightsReview=all.filter(item=>item.dealType==='rights_review');
  const accelerating=all.filter(item=>(item.acceleration7||0)>0);
  const contactable=all.filter(arIsContactable);
  const verified=all.filter(item=>item.status==='verified'), needsListen=all.filter(item=>item.status==='needs_listen');
  const filtered=arOpportunityFiltered(all), rows=filtered.slice(0,S.radarLimit), selected=all.find(item=>item.spotifyId===S.radarTrackId)||null;
  const genres=[...new Set(all.map(item=>item.genre).filter(Boolean))].sort((a,b)=>arGenreLabel(a).localeCompare(arGenreLabel(b)));
  const catalogTotal=Number(scoring.catalog_total||pool.catalog_total||0), measured=Number(scoring.measured_target_tracks||pool.measured||0), targetTotal=Number(pool.target_editorial_total||0);
  V.innerHTML=`<div class="page-head"><div><h2>Radar A&R · musiques instrumentales</h2><p class="ar-radar-intro">Le moteur classe des tracks indépendantes par vélocité réelle, accélération, fit instrumental, droits, taille d’artiste et contactabilité. Les majors, droits mixtes et superstars sont retirés avant le scoring.</p></div></div>
    <div class="ar-coverage-strip"><div><strong>${fmtFull(catalogTotal)}</strong><span>discographie Soundcharts</span></div><div><strong>${fmtFull(targetTotal||measured)}</strong><span>tracks cible classifiées</span></div><div><strong>${fmtFull(measured)}</strong><span>tracks cible mesurées</span></div><div><strong>${fmtFull(all.length)}</strong><span>leads actionnables</span></div><div><strong>${fmtFull(contactable.length)}</strong><span>contacts disponibles</span></div></div>
    <div class="ar-kpi-actions">${arKpiButton('distribution','Distribution',distributions.length,'Sorties récentes self-release à approcher.')}${arKpiButton('label_advance','Label + avance',advances.length,'Traction suffisante pour une offre structurée.')}${arKpiButton('catalog_acquisition','Rachat catalogue',catalogues.length,'Flux récurrent sur des titres installés.')}${arKpiButton('rights_review','Droits à vérifier',rightsReview.length,'Signaux forts bloqués par la preuve de propriété.')}${arKpiButton('accelerating','En accélération',accelerating.length,'7 jours actuels supérieurs aux 7 jours précédents.')}</div>
    <div class="ar-data-note"><span>ⓘ</span><span><strong>Lecture :</strong> 24 h, 7 j et 30 j utilisent uniquement des compteurs Soundcharts datés. Aucun trou n’est extrapolé. « À valider à l’écoute » conserve les titres prometteurs dont l’instrumentalité doit être vérifiée humainement.</span></div>
    <div class="ar-filterbar"><button class="chip ${S.radarFilter==='verified'?'on':''}" data-radar-filter="verified">Instrumental vérifié (${fmtFull(verified.length)})</button><button class="chip ${S.radarFilter==='needs_listen'?'on':''}" data-radar-filter="needs_listen">À écouter (${fmtFull(needsListen.length)})</button><button class="chip ${S.radarFilter==='contactable'?'on':''}" data-radar-filter="contactable">Contactables (${fmtFull(contactable.length)})</button><button class="chip ${S.radarFilter==='all'?'on':''}" data-radar-filter="all">Toutes (${fmtFull(all.length)})</button><input class="search" id="radar-q" value="${esc(S.radarQ)}" placeholder="Rechercher une track, un artiste, un genre…"><select id="radar-genre"><option value="all">Tous les genres</option>${genres.map(genre=>`<option value="${esc(genre)}" ${S.radarGenre===genre?'selected':''}>${esc(arGenreLabel(genre))}</option>`).join('')}</select><select id="radar-sort"><option value="score" ${S.radarSort==='score'?'selected':''}>Trier : priorité A&R</option><option value="momentum" ${S.radarSort==='momentum'?'selected':''}>Trier : 24 h</option><option value="acceleration" ${S.radarSort==='acceleration'?'selected':''}>Trier : accélération 7 j</option><option value="streams" ${S.radarSort==='streams'?'selected':''}>Trier : streams total</option><option value="listeners" ${S.radarSort==='listeners'?'selected':''}>Trier : audience artiste</option><option value="recent" ${S.radarSort==='recent'?'selected':''}>Trier : récence</option></select><select id="radar-limit"><option value="100" ${S.radarLimit===100?'selected':''}>Afficher 100</option><option value="250" ${S.radarLimit===250?'selected':''}>Afficher 250</option><option value="500" ${S.radarLimit===500?'selected':''}>Afficher 500</option><option value="1000" ${S.radarLimit===1000?'selected':''}>Afficher 1 000</option></select></div>
    ${selected?`<div class="ar-player-shell"><div><div class="ar-player-kicker">Lecture en cours · ${esc(arDealLabel(selected.dealType))}</div><div class="ar-player-title">${esc(selected.title)}</div><div class="ar-player-meta">${esc(selected.credit)} · ${esc(arGenreLabel(selected.genre))} · score ${Math.round(selected.score)}/100</div></div><iframe title="Spotify player · ${esc(selected.title)}" src="https://open.spotify.com/embed/track/${esc(selected.spotifyId)}?utm_source=generator" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe></div>`:''}
    <div class="ar-opportunity-list">${rows.map(arOpportunityCard).join('')}</div>${rows.length===0?`<div class="ar-empty-state">Aucune track ne correspond à ce filtre. Les critères restent stricts et aucune donnée manquante n’est inventée.</div>`:''}${filtered.length>rows.length?`<div class="analytics-note" style="text-align:center;margin-top:12px">${fmtFull(rows.length)} affichées sur ${fmtFull(filtered.length)} · augmente « Afficher » pour voir la suite.</div>`:''}`;
  document.querySelectorAll('[data-radar-filter]').forEach(button=>button.addEventListener('click',()=>{
    S.radarFilter=button.dataset.radarFilter; S.radarTrackId='';
    if(button.dataset.radarKpi){S.radarQ='';S.radarGenre='all';S.radarSort=button.dataset.radarFilter==='accelerating'?'acceleration':'score';}
    renderRadar();
  }));
  document.querySelectorAll('[data-ar-play]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();const id=button.dataset.arPlay;S.radarTrackId=S.radarTrackId===id?'':id;renderRadar();}));
  document.querySelectorAll('[data-ar-open]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();openArOpportunity(button.dataset.arOpen);}));
  document.querySelectorAll('[data-ar-card]').forEach(card=>{const open=event=>{if(event.target.closest('button,a,input,select')) return;openArOpportunity(card.dataset.arCard);};card.addEventListener('click',open);card.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openArOpportunity(card.dataset.arCard);}});});
  document.getElementById('radar-q').addEventListener('input',event=>{S.radarQ=event.target.value;renderRadar();keepFocus('radar-q');});
  document.getElementById('radar-genre').addEventListener('change',event=>{S.radarGenre=event.target.value;renderRadar();});
  document.getElementById('radar-sort').addEventListener('change',event=>{S.radarSort=event.target.value;renderRadar();});
  document.getElementById('radar-limit').addEventListener('change',event=>{S.radarLimit=Number(event.target.value)||100;renderRadar();});
}

function renderWatch(){
  const w=wlGet();
  const tabs=[['tracks','🎶 Tracks',w.t.length],['artists','🎸 '+T('Artistes'),w.a.length]];
  let h=`<div class="page-head"><div><h2>Watchlist</h2></div>${metricModeToggleHtml()}</div>`;
  h+='<div class="toolbar">'+tabs.map(t=>`<button class="chip ${S.wltab===t[0]?'on':''}" onclick="S.wltab='${t[0]}';render()">${t[1]} (${t[2]})</button>`).join('')+'</div>';
  if(S.wltab==='tracks'){
    const rows=R.filter(r=>w.t.includes(r[6])).sort((a,b)=>b[3]-a[3]);
    if(!rows.length){ h+=`<div class="empty">${T("Aucune track épinglée. Clique sur l'étoile ☆ d'une track pour la suivre ici.")}</div>`; V.innerHTML=h; return; }
    h+=`<div class="panel" style="padding:6px 14px 14px"><table><thead><tr><th></th><th></th><th>Track</th><th>${T('Artiste')}</th><th class="num">${streamMetricLabel(0)}</th><th class="num">${streamMetricLabel(30)}</th><th class="num">${streamMetricLabel(7)}</th><th class="num">${streamMetricLabel(1)}</th><th class="num">${T('Rachat')} ${S.palier}</th><th>${T('Sortie')}</th></tr></thead><tbody>`;
    h+=rows.map(r=>{const w30=trackWindow(r,30),w7=trackWindow(r,7),w1=trackWindow(r,1);return `<tr class="${r[3]>=HOT?'hot':''}">
      <td>${wlStar('t',r[6])}</td>
      <td class="covtd">${r[8]?`<div class="cov has" style="background-image:url('${esc(r[8])}')"></div>`:`<div class="cov" data-tid="${r[6]}"></div>`}</td>
      <td><span class="tk" style="cursor:pointer" onclick="openTrack('${r[6]}')">${esc(r[1])}</span></td>
      <td><span class="ar" onclick="goArtist(${r[0]})">${esc(A[r[0]][0])}</span></td>
      <td class="num">${streamStackHtml(r[3]>=0?r[3]:null,false,false)}</td>
      <td class="num">${streamStackHtml(w30.current,false,false)}</td>
      <td class="num">${streamStackHtml(w7.current,false,false)}</td>
      <td class="num">${streamStackHtml(w1.current,false,false)}</td>
      <td class="num"><span style="color:var(--acc2);font-weight:600">${perMonth(r)<0?'—':eur(advance(perMonth(r)))}</span></td>
      <td>${fmtDate(r[2])}</td></tr>`;}).join('');
    h+='</tbody></table></div>';
  } else {
    const gs=AG.filter(g=>w.a.includes(g.name)).sort((a,b)=>b.streams-a.streams);
    if(!gs.length){ h+=`<div class="empty">${T("Aucun artiste épinglé. Clique sur l'étoile ☆ d'une carte artiste.")}</div>`; V.innerHTML=h; return; }
    h+='<div class="acards">'+gs.map(g=>{const p=g.n?Math.round(g.self/g.n*100):0; return `
      <div class="acard" onclick="goArtist(${g.i})">
        ${wlStar('a',g.name)}
        <div class="top"><div class="av">${esc(g.name[0]||'?').toUpperCase()}${avatarHtml(g)}</div>
          <div style="min-width:0"><div class="nm">${esc(g.name)}</div><div style="font-size:11px;color:var(--dim);margin-top:7px">${segBadge(g)}</div></div></div>
        <div class="stats stats2"><div class="st"><div class="v">${streamStackHtml(g.streams,false,false)}</div><div class="l">${streamMetricLabel(0)}</div></div>
          <div class="st"><div class="v">${streamStackHtml(g.streams30,false,false)}</div><div class="l">${streamMetricLabel(30)}</div></div>
          <div class="st"><div class="v">${streamStackHtml(g.streams7,false,false)}</div><div class="l">${streamMetricLabel(7)}</div></div>
          <div class="st"><div class="v">${streamStackHtml(g.streams24,false,false)}</div><div class="l">${streamMetricLabel(1)}</div></div></div>
        <div class="foot"><span>${g.n} tracks · ${g.hot} ≥ 500k</span></div>
      </div>`;}).join('')+'</div>';
  }
  V.innerHTML=h; bindMetricModeToggle(renderWatch,V); attachCovers();
}

function sortArrow(k){ return S.sort.k===k ? `<span class="arr">${S.sort.dir===-1?'▼':'▲'}</span>` : ''; }

function renderOpps(){
  const rows = filteredRows();
  const slice = rows.slice(0, S.shown);
  const ag = null;
  const pbase = rowsBeforePeriod();
  const pcnt = {
    '30': pbase.filter(r=>daysAgo(r[2])<=30).length,
    '90': pbase.filter(r=>daysAgo(r[2])<=90).length,
    '180': pbase.filter(r=>daysAgo(r[2])<=180).length,
    '365': pbase.filter(r=>daysAgo(r[2])<=365).length,
    'all': pbase.length,
  };
  const tableView = `
  <div class="panel" style="padding:6px 14px 14px">
    <table>
      <thead><tr>
        ${ag?`<th class="selc"><input type="checkbox" class="ck" id="sel-all" title="${T('Tout sélectionner')}" ${rows.length&&rows.every(r=>S.sel.has(r[6]))?'checked':''}></th>`:''}
        <th></th>
        <th data-k="1">Track ${sortArrow(1)}</th>
        <th data-k="0">${T('Artiste')} ${sortArrow(0)}</th>
        <th data-k="30">Genre principal ${sortArrow(30)}</th>
        <th data-k="3" class="num">${streamMetricLabel(0)}</th>
        <th data-k="10" class="num" title="${T('Flux réel sur la période')}">${streamMetricLabel(30)} ${sortArrow(10)}</th>
        <th data-k="21" class="num" title="${T('Flux réel sur la période')}">${streamMetricLabel(7)} ${sortArrow(21)}</th>
        <th data-k="20" class="num" title="${T('Flux réel sur la période')}">${streamMetricLabel(1)} ${sortArrow(20)}</th>
        <th data-k="13" class="num">${T('Rachat')} ${S.palier} ${sortArrow(13)}</th>
        <th data-k="2">${T('Sortie')} ${sortArrow(2)}</th>
        <th data-k="4">${T('Statut')} ${sortArrow(4)}</th>
        <th data-k="5">Copyright ${sortArrow(5)}</th>
      </tr></thead>
      <tbody>
      ${slice.map(r=>{ const w1=trackWindow(r,1), w7=trackWindow(r,7), w30=trackWindow(r,30), classification=trackClassification(r); return `
        <tr data-basehot="${r[3]>=HOT?1:0}" class="${r[3]>=HOT||(ag&&S.sel.has(r[6]))?'hot':''}">
          ${ag?`<td class="selc"><input type="checkbox" class="ck sel-track" data-tid="${r[6]}" ${S.sel.has(r[6])?'checked':''}></td>`:''}
          <td class="covtd">${r[8]?`<div class="cov has" style="background-image:url('${esc(r[8])}')"></div>`:`<div class="cov" data-tid="${r[6]}"></div>`}</td>
          <td><span class="tk" style="cursor:pointer" onclick="openTrack('${r[6]}')">${esc(r[1])}</span> ${wlStar('t',r[6])}${r[7]?' <span class="badge new">'+T('détectée')+' '+r[7].slice(5)+'</span>':''}</td>
          <td><span class="ar" onclick="goArtist(${r[0]})">${esc(A[r[0]][0])}</span></td>
          <td>${classificationCellHtml(classification)}</td>
          <td class="num" title="${fmtFull(r[3])}">${streamStackHtml(r[3]>=0?r[3]:null,false,false)}</td>
          <td class="num" title="${T('Streams des 30 derniers jours')} · ${T('Aucune extrapolation')}">${streamStackHtml(w30.current,false,false)}</td>
          <td class="num" title="${T('Streams des 7 derniers jours')} · ${T('Aucune extrapolation')}">${streamStackHtml(w7.current,false,false)}</td>
          <td class="num" title="${T('Streams des dernières 24 h')} · ${T('Aucune extrapolation')}">${streamStackHtml(w1.current,false,false)}</td>
          <td class="num" title="${perMonth(r)<0?'':T('Payback')+' '+paybackTxt(payback(perMonth(r)))}"><span style="color:var(--acc2);font-weight:600">${perMonth(r)<0?'—':eur(advance(perMonth(r)))}</span></td>
          <td style="white-space:nowrap;font-variant-numeric:tabular-nums">${fmtDate(r[2])}</td>
          <td><span class="badge ${r[4]===0?'self':'other'}">${r[4]===0?T('Indé'):'Label'}</span></td>
          <td><span class="lb" title="${esc(r[5])}">${esc(r[5])}</span></td>
        </tr>`;}).join('')}
      </tbody>
    </table>
    ${rows.length===0?'<div class="empty">'+T('Aucune track ne correspond à ces filtres.')+'</div>':''}
    ${sentinel(rows.length-S.shown)}
  </div>`;
  const gridView = `
  <div class="acards">
    ${slice.map(r=>{ const w1=trackWindow(r,1), w7=trackWindow(r,7), w30=trackWindow(r,30), classification=trackClassification(r); return `
    <div class="acard plcard grid-clean" onclick="openTrack('${r[6]}')">
      ${r[8]?`<div class="cov has" style="background-image:url('${esc(r[8])}')"></div>`:`<div class="cov" data-tid="${r[6]}"></div>`}
      <div class="nm">${esc(r[1])} ${wlStar('t',r[6])}${r[7]?' <span class="badge new">'+T('détectée')+'</span>':''}</div>
      <div style="font-size:11px;color:var(--dim);margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="ar" onclick="event.stopPropagation();goArtist(${r[0]})">${esc(A[r[0]][0])}</span>
        <span class="genre-main">${esc(classification.genre)}</span>
        <span class="genre-sub">${esc(classification.instrumental)}</span>
        <span class="badge ${r[4]===0?'self':'other'}">${r[4]===0?T('Indé'):'Label'}</span>
      </div>
      <div class="stats stats2">
        <div class="st"><div class="v">${streamStackHtml(r[3]>=0?r[3]:null,false,false)}</div><div class="l">${streamMetricLabel(0)}</div></div>
        <div class="st"><div class="v">${streamStackHtml(w30.current,false,false)}</div><div class="l">${streamMetricLabel(30)}</div></div>
        <div class="st"><div class="v">${streamStackHtml(w7.current,false,false)}</div><div class="l">${streamMetricLabel(7)}</div></div>
        <div class="st"><div class="v">${streamStackHtml(w1.current,false,false)}</div><div class="l">${streamMetricLabel(1)}</div></div>
      </div>
      <div class="stats stats2">
        <div class="st" style="grid-column:1/-1"><div class="v" style="color:var(--acc2)">${perMonth(r)<0?'—':eur(advance(perMonth(r)))}</div><div class="l">${T('Rachat')}</div></div>
      </div>
    </div>`;}).join('')}
  </div>
  ${rows.length===0?'<div class="empty">'+T('Aucune track ne correspond à ces filtres.')+'</div>':''}
  ${sentinel(rows.length-S.shown)}`;
  V.innerHTML = `
  <div class="page-head">
    <div>
      <h2>${T('Toutes les pistes')}</h2>
    </div>
  </div>
  <div class="toolbar">
    <div class="search-wrap"><span class="sico">🔍</span><input type="text" id="f-q" placeholder="${T('Rechercher track, artiste, label…')}" value="${esc(S.q)}"></div>
    ${genreFilterHtml('f-genres',S.genres)}
    <select id="f-period">
      <option value="30" ${S.period==='30'?'selected':''}>🟢 ${T('1 dernier mois')} (${fmtFull(pcnt['30'])})</option>
      <option value="90" ${S.period==='90'?'selected':''}>🟡 ${T('3 derniers mois')} (${fmtFull(pcnt['90'])})</option>
      <option value="180" ${S.period==='180'?'selected':''}>🟠 ${T('6 derniers mois')} (${fmtFull(pcnt['180'])})</option>
      <option value="365" ${S.period==='365'?'selected':''}>🔴 ${T('12 derniers mois')} (${fmtFull(pcnt['365'])})</option>
      <option value="all" ${S.period==='all'?'selected':''}>🔵 ${T("Tout l'historique")} (${fmtFull(pcnt['all'])})</option>
    </select>
    <select id="f-st">
      <option value="all" ${S.statut==='all'?'selected':''}>🌍 ${T('Type de sortie : tous')}</option>
      <option value="self" ${S.statut==='self'?'selected':''}>🎛️ Self-released</option>
      <option value="other" ${S.statut==='other'?'selected':''}>🏷️ ${T('Autre label')}</option>
    </select>
    <select id="f-min">
      <option value="0" ${S.min===0?'selected':''}>📊 ${T('Streams : tous')}</option>
      <option value="100000" ${S.min===100000?'selected':''}>🔥 ≥ 100k</option>
      <option value="500000" ${S.min===500000?'selected':''}>🔥 ≥ 500k</option>
      <option value="1000000" ${S.min===1000000?'selected':''}>🚀 ≥ 1M</option>
      <option value="5000000" ${S.min===5000000?'selected':''}>💎 ≥ 5M</option>
    </select>
    <select id="f-rel">
      <option value="all" ${S.rel==='all'?'selected':''}>🎸 ${T("Type d'artiste : tous")}</option>
      <option value="top" ${S.rel==='top'?'selected':''}>⭐ Loyal (>50)</option>
      <option value="reg" ${S.rel==='reg'?'selected':''}>🔁 Regulars (25-50)</option>
      <option value="occ" ${S.rel==='occ'?'selected':''}>🎲 Occasional (1-24)</option>
      <option value="ext" ${S.rel==='ext'?'selected':''}>🚫 ${T('Jamais')}</option>
    </select>
    ${metricModeToggleHtml()}
    <span class="spacer"></span>
    <span class="result-count">${fmtFull(rows.length)} ${T('tracks')}</span>
    <div class="viewtoggle">
      <button class="${S.omode==='table'?'on':''}" data-omode="table" title="${T('Vue liste')}"><span class="view-ico">☰</span><span class="view-label">${T('Vue liste')}</span></button>
      <button class="${S.omode==='grid'?'on':''}" data-omode="grid" title="${T('Vue grille')}"><span class="view-ico">▦</span><span class="view-label">${T('Vue grille')}</span></button>
    </div>
  </div>
  ${S.omode==='grid' ? gridView : tableView}`;

  document.getElementById('f-q').addEventListener('input', e=>{ S.q=e.target.value; S.shown=100; keepScroll(renderOpps); keepFocus('f-q'); });
  bindMetricModeToggle(renderOpps,V);
  bindGenreFilter('f-genres',S.genres,()=>{ S.shown=100; keepScroll(renderOpps); });
  document.getElementById('f-st').addEventListener('change', e=>{ S.statut=e.target.value; S.shown=100; keepScroll(renderOpps); });
  document.getElementById('f-min').addEventListener('change', e=>{ S.min=+e.target.value; S.shown=100; keepScroll(renderOpps); });
  document.getElementById('f-period').addEventListener('change', e=>{ S.period=e.target.value; S.shown=100; keepScroll(renderOpps); });
  document.getElementById('f-rel').addEventListener('change', e=>{ S.rel=e.target.value; S.shown=100; keepScroll(renderOpps); });
  document.querySelectorAll('.viewtoggle button[data-omode]').forEach(b=>b.addEventListener('click', ()=>{ S.omode=b.dataset.omode; keepScroll(renderOpps); }));
  const ca = document.getElementById('f-clear-artist');
  if (ca) ca.addEventListener('click', ()=>{ S.artist=-1; S.shown=100; keepScroll(renderOpps); });
  attachInfinite(()=>{ const y=window.scrollY; S.shown+=200; renderOpps(); window.scrollTo(0,y); });
  document.querySelectorAll('th[data-k]').forEach(h=>h.addEventListener('click', ()=>{
    const k=+h.dataset.k;
    if (S.sort.k===k) S.sort.dir*=-1; else S.sort={k, dir:[0,1,5,30].includes(k)?1:-1};
    keepScroll(renderOpps);
  }));
  function updateSel(){
    // mise à jour SANS re-render (pas de saut de page) : offre + surlignage + compteurs
    const selM = rows.filter(r=>S.sel.has(r[6])).reduce((s,r)=>s+Math.max(perMonth(r),0),0);
    const selN = rows.filter(r=>S.sel.has(r[6])).length;
    const off = document.querySelector('.offer');
    if (off) off.outerHTML = offerHtml(ag, selM, selN, rows.length);
    document.querySelectorAll('.sel-track').forEach(cb=>{
      const tr=cb.closest('tr'); const on=S.sel.has(cb.dataset.tid);
      cb.checked=on; if(tr) tr.classList.toggle('hot', on || tr.dataset.basehot==='1');
    });
    const allOn = rows.length && rows.every(r=>S.sel.has(r[6]));
    ['sel-all','sel-all-bar'].forEach(id=>{ const e=document.getElementById(id); if(e) e.checked=allOn; });
  }
  document.querySelectorAll('.sel-track').forEach(cb=>{
    cb.addEventListener('change', ()=>{ if(cb.checked)S.sel.add(cb.dataset.tid); else S.sel.delete(cb.dataset.tid); updateSel(); });
  });
  ['sel-all','sel-all-bar'].forEach(id=>{ const el=document.getElementById(id); if(el) el.addEventListener('change', ()=>{
    if (el.checked) rows.forEach(r=>S.sel.add(r[6])); else rows.forEach(r=>S.sel.delete(r[6]));
    updateSel();
  }); });
  if (typeof attachCovers==='function') attachCovers();
}
function keepFocus(id){ const el=document.getElementById(id); if(el){ el.focus(); el.setSelectionRange(el.value.length,el.value.length);} }
function keepScroll(fn){ const y=window.scrollY; fn(); window.scrollTo(0,y); }
function artistSortArrow(k){ return S.asort===k ? `<span class="arr">${S.adir===-1?'▼':'▲'}</span>` : ''; }

function renderArtists(){
  const q = S.aq.trim().toLowerCase();
  let list = withTracks.filter(g=>{
    const classification=artistClassification(g);
    return (!q || g.name.toLowerCase().includes(q)) &&
      (S.aseg==='all' || seg(g)===S.aseg) &&
      (!S.agenres.size || S.agenres.has(classification.genre));
  });
  const aSorters = {
    name:(a,b)=>a.name.localeCompare(b.name),
    genre:(a,b)=>artistClassification(a).genre.localeCompare(artistClassification(b).genre),
    status:(a,b)=>({ext:0,occ:1,reg:2,top:3}[seg(a)]-({ext:0,occ:1,reg:2,top:3}[seg(b)])),
    streams:(a,b)=>a.streams-b.streams,
    revenue:(a,b)=>a.streams-b.streams,
    streams24:(a,b)=>(a.streams24==null?(S.adir===-1?-Infinity:Infinity):a.streams24)-(b.streams24==null?(S.adir===-1?-Infinity:Infinity):b.streams24),
    streams7:(a,b)=>(a.streams7==null?(S.adir===-1?-Infinity:Infinity):a.streams7)-(b.streams7==null?(S.adir===-1?-Infinity:Infinity):b.streams7),
    streams30:(a,b)=>(a.streams30==null?(S.adir===-1?-Infinity:Infinity):a.streams30)-(b.streams30==null?(S.adir===-1?-Infinity:Infinity):b.streams30),
    n:(a,b)=>a.n-b.n,
    hot:(a,b)=>a.hot-b.hot,
    self:(a,b)=>(a.n?a.self/a.n:0)-(b.n?b.self/b.n:0),
    last:(a,b)=>(a.last||'').localeCompare(b.last||''),
  };
  const aSorter = aSorters[S.asort] || aSorters.streams;
  list = list.slice().sort((a,b)=>S.adir*aSorter(a,b));
  const slice = list.slice(0,S.shownA);
  const gridView = `
  <div class="acards">
    ${slice.map(g=>{ const classification=artistClassification(g); return `
      <div class="acard plcard grid-clean" onclick="goArtist(${g.i})">
        ${wlStar('a',g.name)}
        ${artistCoverHtml(g)}
        <div class="nm">${esc(g.name)}</div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:3px 0 9px"><span class="genre-main">${esc(classification.genre)}</span><span class="genre-sub">${esc(classification.instrumental)}</span></div>
        <div style="font-size:11px;color:var(--dim);margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">${segBadge(g)} <span>${g.lofi?g.lofi+' '+T('tracks chez Lofi'):''}${g.disco?' · '+T('découverte')+' ('+esc(g.origin||'related')+')':''}</span></div>
        <div class="stats stats2">
          <div class="st"><div class="v">${streamStackHtml(g.streams,false,false)}</div><div class="l">${streamMetricLabel(0)}</div></div>
          <div class="st"><div class="v">${streamStackHtml(g.streams30,false,false)}</div><div class="l">${streamMetricLabel(30)}</div></div>
          <div class="st"><div class="v">${streamStackHtml(g.streams7,false,false)}</div><div class="l">${streamMetricLabel(7)}</div></div>
          <div class="st"><div class="v">${streamStackHtml(g.streams24,false,false)}</div><div class="l">${streamMetricLabel(1)}</div></div>
        </div>
      </div>`;}).join('')}
  </div>
  ${sentinel(list.length-S.shownA)}`;
  const tableView = `
  <div class="panel" style="padding:6px 14px 14px">
    <table>
      <thead><tr>
        <th></th>
        <th data-asort="name">${T('Artiste')} ${artistSortArrow('name')}</th>
        <th data-asort="genre">Genre principal ${artistSortArrow('genre')}</th>
        <th data-asort="status">${T('Statut')} ${artistSortArrow('status')}</th>
        <th data-asort="streams" class="num">${streamMetricLabel(0)}</th>
        <th data-asort="streams30" class="num" title="${T('Flux réel sur la période')}">${streamMetricLabel(30)} ${artistSortArrow('streams30')}</th>
        <th data-asort="streams7" class="num" title="${T('Flux réel sur la période')}">${streamMetricLabel(7)} ${artistSortArrow('streams7')}</th>
        <th data-asort="streams24" class="num" title="${T('Flux réel sur la période')}">${streamMetricLabel(1)} ${artistSortArrow('streams24')}</th>
        <th data-asort="n" class="num">tracks ${artistSortArrow('n')}</th>
        <th data-asort="hot" class="num">≥ 500k ${artistSortArrow('hot')}</th>
        <th data-asort="self" class="num">${T('indé')} ${artistSortArrow('self')}</th>
        <th data-asort="last">${T('dernière sortie')} ${artistSortArrow('last')}</th>
      </tr></thead>
      <tbody>
      ${slice.map(g=>{
        const p = g.n ? Math.round(g.self/g.n*100) : 0;
        const classification = artistClassification(g);
        return `
        <tr onclick="goArtist(${g.i})" style="cursor:pointer">
          <td class="covtd">${artistCoverHtml(g)}</td>
          <td>${esc(g.name)} ${wlStar('a',g.name)}</td>
          <td>${classificationCellHtml(classification)}</td>
          <td style="white-space:nowrap"><div>${segBadge(g)}</div><div style="font-size:11px;color:var(--dim);margin-top:3px">${g.lofi||0} ${T('tracks chez Lofi')}</div></td>
          <td class="num">${streamStackHtml(g.streams,false,false)}</td>
          <td class="num">${streamStackHtml(g.streams30,false,false)}</td>
          <td class="num">${streamStackHtml(g.streams7,false,false)}</td>
          <td class="num">${streamStackHtml(g.streams24,false,false)}</td>
          <td class="num">${g.n}</td>
          <td class="num" style="color:${g.hot?'var(--acc2)':'inherit'}">${g.hot}</td>
          <td class="num">${p}%</td>
          <td style="white-space:nowrap">${g.last||'?'}</td>
        </tr>`;}).join('')}
      </tbody>
    </table>
    ${list.length===0?'<div class="empty">'+T('Aucun artiste ne correspond à ces filtres.')+'</div>':''}
    ${sentinel(list.length-S.shownA)}
  </div>`;

  V.innerHTML = `
  <div class="page-head">
    <div>
      <h2>${T('Tous les artistes')}</h2>
    </div>
  </div>
  <div class="toolbar">
    <div class="search-wrap"><span class="sico">🔍</span><input type="text" id="a-q" placeholder="${T('Rechercher un artiste…')}" value="${esc(S.aq)}"></div>
    ${genreFilterHtml('a-genres',S.agenres)}
    <select id="a-seg">
      <option value="all" ${S.aseg==='all'?'selected':''}>🌍 ${T('Tous')}</option>
      <option value="top" ${S.aseg==='top'?'selected':''}>🏆 Top artists</option>
      <option value="reg" ${S.aseg==='reg'?'selected':''}>🔁 Regulars</option>
      <option value="occ" ${S.aseg==='occ'?'selected':''}>🎲 ${T('Occasionnels')}</option>
      <option value="ext" ${S.aseg==='ext'?'selected':''}>🚫 ${T('Jamais')}</option>
    </select>
    ${metricModeToggleHtml()}
    <span class="spacer"></span>
    <span class="result-count">${list.length} ${T('artistes')}</span>
    <div class="viewtoggle">
      <button class="${S.amode==='table'?'on':''}" data-amode="table" title="${T('Vue liste')}"><span class="view-ico">☰</span><span class="view-label">${T('Vue liste')}</span></button>
      <button class="${S.amode==='grid'?'on':''}" data-amode="grid" title="${T('Vue grille')}"><span class="view-ico">▦</span><span class="view-label">${T('Vue grille')}</span></button>
    </div>
  </div>
  ${S.amode==='table' ? tableView : gridView}`;

  document.querySelectorAll('.viewtoggle button[data-amode]').forEach(b=>b.addEventListener('click', ()=>{ S.amode=b.dataset.amode; keepScroll(renderArtists); }));
  bindMetricModeToggle(renderArtists,V);
  document.getElementById('a-q').addEventListener('input', e=>{ S.aq=e.target.value; S.shownA=60; keepScroll(renderArtists); keepFocus('a-q'); });
  bindGenreFilter('a-genres',S.agenres,()=>{ S.shownA=60; keepScroll(renderArtists); });
  document.getElementById('a-seg').addEventListener('change', e=>{ S.aseg=e.target.value; S.shownA=60; keepScroll(renderArtists); });
  document.querySelectorAll('th[data-asort]').forEach(h=>h.addEventListener('click', ()=>{
    const key=h.dataset.asort;
    if (S.asort===key) S.adir*=-1;
    else { S.asort=key; S.adir=['name','genre'].includes(key)?1:-1; }
    keepScroll(renderArtists);
  }));
  attachInfinite(()=>{ const y=window.scrollY; S.shownA+=60; renderArtists(); window.scrollTo(0,y); });
  if (typeof attachCovers==='function') attachCovers();
}

function renderNew(){
  let rows = R.filter(r=>daysAgo(r[2])<=S.newDays && r[3]>=1000);
  rows.sort((a,b)=>(b[2]||'').localeCompare(a[2]||'') || b[3]-a[3]);
  const detected = R.filter(r=>r[7]).length;
  const slice = rows.slice(0,S.shownN);
  V.innerHTML = `
  <div class="page-head">
    <div>
      <h2>${T('Sorties récentes')}</h2>
      <p>${T("Nouvelles sorties hors Lofi des artistes suivis. Le badge « détectée » signale les tracks apparues lors d'un rafraîchissement de veille (après le")} ${D.seed}).</p>
    </div>
    ${metricModeToggleHtml()}
  </div>
  <div class="toolbar">
    ${[30,90,180,365].map(d=>`<button class="chip ${S.newDays===d?'on':''}" data-d="${d}">${d} ${T('j')}</button>`).join('')}
    <span class="spacer"></span>
    <span class="result-count">${fmtFull(rows.length)} ${T('sorties')} · ${detected} ${T('détectées par la veille')}</span>
  </div>
  <div class="panel" style="padding:6px 14px 14px">
    <table>
      <thead><tr><th></th><th></th><th>${T('Date de sortie')}</th><th>Track</th><th>${T('Artiste')}</th><th class="num">${streamMetricLabel(0)}</th><th class="num">${streamMetricLabel(30)}</th><th class="num">${streamMetricLabel(7)}</th><th class="num">${streamMetricLabel(1)}</th><th>${T('Statut')}</th><th>Copyright</th></tr></thead>
      <tbody>
      ${slice.map(r=>{const w30=trackWindow(r,30),w7=trackWindow(r,7),w1=trackWindow(r,1);return `
        <tr class="${r[3]>=HOT?'hot':''}">
          <td>${wlStar('t',r[6])}</td>
          <td class="covtd">${r[8]?`<div class="cov has" style="background-image:url('${esc(r[8])}')"></div>`:`<div class="cov" data-tid="${r[6]}"></div>`}</td>
          <td style="white-space:nowrap;font-variant-numeric:tabular-nums">${fmtDate(r[2])}</td>
          <td><span class="tk" style="cursor:pointer" onclick="openTrack('${r[6]}')">${esc(r[1])}</span>${r[7]?' <span class="badge new">'+T('détectée')+'</span>':''}</td>
          <td><span class="ar" onclick="goArtist(${r[0]})">${esc(A[r[0]][0])}</span></td>
          <td class="num">${streamStackHtml(r[3]>=0?r[3]:null,false,false)}</td>
          <td class="num">${streamStackHtml(w30.current,false,false)}</td>
          <td class="num">${streamStackHtml(w7.current,false,false)}</td>
          <td class="num">${streamStackHtml(w1.current,false,false)}</td>
          <td><span class="badge ${r[4]===0?'self':'other'}">${r[4]===0?T('Indé'):'Label'}</span></td>
          <td><span class="lb" title="${esc(r[5])}">${esc(r[5])}</span></td>
        </tr>`;}).join('')}
      </tbody>
    </table>
    ${rows.length===0?'<div class="empty">'+T('Aucune sortie sur la période. La veille hebdomadaire alimentera cette vue automatiquement.')+'</div>':''}
    ${sentinel(rows.length-S.shownN)}
  </div>`;
  bindMetricModeToggle(renderNew,V);
  document.querySelectorAll('.chip[data-d]').forEach(c=>c.addEventListener('click', ()=>{ S.newDays=+c.dataset.d; S.shownN=100; renderNew(); }));
  attachInfinite(()=>{ const y=window.scrollY; S.shownN+=200; renderNew(); window.scrollTo(0,y); });
  if (typeof attachCovers==='function') attachCovers();
}

/* ---------- covers (lazy, via oEmbed Spotify, sans clé API) ---------- */
const covCache = new Map();
try{
  const saved = JSON.parse(localStorage.getItem('sr_covs')||'[]');
  for (const [k,v] of saved) covCache.set(k,v);
}catch(e){}
let covSaveTimer = null;
function covPersist(){
  clearTimeout(covSaveTimer);
  covSaveTimer = setTimeout(()=>{
    try{
      const entries = [...covCache.entries()].slice(-4000);
      localStorage.setItem('sr_covs', JSON.stringify(entries));
    }catch(e){}
  }, 1200);
}
function covKeyUrl(img){
  if (img.dataset.tid) return {key:'t'+img.dataset.tid, url:'https://open.spotify.com/track/'+img.dataset.tid};
  if (img.dataset.plid) return {key:'p'+img.dataset.plid, url:'https://open.spotify.com/playlist/'+img.dataset.plid};
  return {key:'a'+img.dataset.aid, url:'https://open.spotify.com/artist/'+img.dataset.aid};
}
function covShow(el, u){
  if (!el.isConnected) return;
  if (el.tagName === 'IMG'){
    el.onload = ()=>el.classList.add('on');
    el.src = u; if (el.complete && el.naturalWidth>0) el.classList.add('on');
  } else {
    const im = new Image();
    im.onload = ()=>{ if (el.isConnected){ el.style.backgroundImage = 'url("'+u+'")'; el.classList.add('has'); } };
    im.src = u;
  }
}
const covQueue = []; let covActive = 0;
function covPump(){
  while (covActive < 8 && covQueue.length){
    const {key, url, img} = covQueue.shift();
    if (!img.isConnected) continue;
    covActive++;
    fetch('https://open.spotify.com/oembed?url='+url)
      .then(r=>r.ok?r.json():null)
      .then(j=>{
        const u = j && j.thumbnail_url;
        if (u){ covCache.set(key,u); covPersist(); covShow(img,u); }
      })
      .catch(()=>{})
      .finally(()=>{ covActive--; setTimeout(covPump, 30); });
  }
}
let covObserver = null;
function attachCovers(){
  // préchargement immédiat de TOUTE la liste rendue (cache d'abord, réseau ensuite),
  // l'observer ne sert plus qu'à faire passer en tête de file ce qui approche de l'écran.
  if (covObserver) covObserver.disconnect();
  covQueue.length = 0;
  // covers/avatars avec URL directe (data.js) : affichage immédiat, aucune requête
  document.querySelectorAll('.cov[data-cover], .avp[data-img]').forEach(el=>{
    covShow(el, el.dataset.cover || el.dataset.img);
  });
  const imgs = [...document.querySelectorAll('.cov[data-tid], .cov[data-plid], img.avp[data-tid]')];
  const pending = [];
  for (const img of imgs){
    const {key, url} = covKeyUrl(img);
    const hit = covCache.get(key);
    if (hit) covShow(img, hit);
    else pending.push({key, url, img});
  }
  covObserver = new IntersectionObserver(es=>{
    for (const e of es){
      if (!e.isIntersecting) continue;
      covObserver.unobserve(e.target);
      const idx = covQueue.findIndex(q=>q.img===e.target);
      if (idx>0) covQueue.unshift(covQueue.splice(idx,1)[0]);
    }
    covPump();
  }, {rootMargin:'900px'});
  for (const p of pending){ covQueue.push(p); covObserver.observe(p.img); }
  covPump();
}
/* ---------- scroll infini ---------- */
let endObserver = null;
function attachInfinite(fn){
  if (endObserver) endObserver.disconnect();
  const s = document.getElementById('scroll-sentinel');
  if (!s) return;
  endObserver = new IntersectionObserver(es=>{
    if (es.some(e=>e.isIntersecting)){ endObserver.disconnect(); fn(); }
  }, {rootMargin:'600px'});
  endObserver.observe(s);
}
function sentinel(remaining){
  return remaining>0 ? `<div id="scroll-sentinel" class="empty" style="padding:18px">${T('Chargement…')} (${fmtFull(remaining)} ${T('restantes')})</div>` : '';
}

/* colonnes PLrows (v2) : id,name,owner,curatorCat,followers,notes,tracks,first_seen,last_seen,lang,genre,use_case,fit,kw,estDate,estConf,enriched,big10k */
function plFiltered(){
  const q = S.plq.trim().toLowerCase();
  let rows = PLrows.filter(r=>{
    if (S.plview==='qualified' && !r[17]) return false;
    if (S.plcur!=='all' && r[3]!==S.plcur) return false;
    if (S.plonly && !r[16]) return false;
    if (q && !((r[1]||'').toLowerCase().includes(q) || (r[2]||'').toLowerCase().includes(q) || (r[10]||'').toLowerCase().includes(q))) return false;
    return true;
  });
  const sorters = {
    name: (a,b)=>(a[1]||'').localeCompare(b[1]||''),
    curator: (a,b)=>(a[2]||'').localeCompare(b[2]||''),
    followers: (a,b)=>(a[4]||0)-(b[4]||0),
    tracks: (a,b)=>(a[6]||0)-(b[6]||0),
    fit: (a,b)=>(a[12]||0)-(b[12]||0),
    genre: (a,b)=>(a[10]||'').localeCompare(b[10]||''),
    usage: (a,b)=>(a[11]||'').localeCompare(b[11]||''),
    created: (a,b)=>(a[14]||'').localeCompare(b[14]||''),
    recent: (a,b)=>(a[8]||'').localeCompare(b[8]||''),
    growth24: (a,b)=>(playlistWindow(a,1).current==null?(S.pldir===-1?-Infinity:Infinity):playlistWindow(a,1).current)-(playlistWindow(b,1).current==null?(S.pldir===-1?-Infinity:Infinity):playlistWindow(b,1).current),
    growth7: (a,b)=>(playlistWindow(a,7).current==null?(S.pldir===-1?-Infinity:Infinity):playlistWindow(a,7).current)-(playlistWindow(b,7).current==null?(S.pldir===-1?-Infinity:Infinity):playlistWindow(b,7).current),
    growth30: (a,b)=>(playlistWindow(a,30).current==null?(S.pldir===-1?-Infinity:Infinity):playlistWindow(a,30).current)-(playlistWindow(b,30).current==null?(S.pldir===-1?-Infinity:Infinity):playlistWindow(b,30).current),
  };
  const sorter = sorters[S.plsort] || sorters.followers;
  rows = rows.slice().sort((a,b)=>S.pldir*sorter(a,b));
  return rows;
}
function plSortArrow(k){ return S.plsort===k ? `<span class="arr">${S.pldir===-1?'▼':'▲'}</span>` : ''; }
function plCuratorBadge(cat){
  if (cat==='editorial') return `<span class="badge lofi" style="margin-left:6px">${T('Éditoriale')}</span>`;
  if (cat==='independent') return `<span class="badge self" style="margin-left:6px">${T('Indépendante')}</span>`;
  return `<span class="badge undet" style="margin-left:6px">${T('Non déterminé')}</span>`;
}
function plFollowersCell(r){
  if (r[5]==='ok') return fmt(r[4]);
  if (r[5]==='no_visible_followers') return `<span class="kwtag" title="${T('Spotify ne montre pas le compteur de followers pour cette playlist')}">${T('Non affiché par Spotify')}</span>`;
  return '—';
}
function plEstDateCell(r){
  if (!r[14]) return `<span style="color:var(--dim)">${T('Non estimée')}</span>`;
  const confTxt = r[15] ? ' ('+T('confiance')+' '+esc(r[15])+')' : '';
  return `<span title="${T('Estimation, pas une date certaine')}${confTxt}">${T('Estimation')} ${fmtDate(r[14])}</span>`;
}
function plGrowthCell(r){
  if (r[5]!=='ok') return '<span style="color:var(--dim)">—</span>';
  if (r[18]==null) return `<span style="color:var(--dim)" title="${T("Pas encore assez d'historique pour calculer une évolution, repasser dans quelques jours")}">${T('Historique en cours')}</span>`;
  const g = r[18], days = r[19];
  const sign = g>0?'+':'';
  const color = g>0?'var(--acc2)':(g<0?'var(--red)':'var(--dim)');
  const daysTxt = days<30 ? ` <span style="color:var(--dim);font-size:10.5px">(${days}${T('j')})</span>` : '';
  return `<span style="color:${color};font-weight:600">${sign}${fmtFull(g)}</span>${daysTxt}`;
}

function plHistory(r){
  const pts = (PLhist[r[0]] || []).map(p=>[p[0],+p[1]]).filter(p=>p[0] && Number.isFinite(p[1]));
  const currentDate = ((r[8] || (PLmeta&&PLmeta.snapshot_ts) || '')+'').slice(0,10);
  if (r[5]==='ok' && currentDate && !pts.some(p=>p[0]===currentDate)) pts.push([currentDate,+r[4]]);
  pts.sort((a,b)=>a[0].localeCompare(b[0]));
  return pts;
}
function playlistWindow(r,days){
  const w=counterWindow(plHistory(r),days);
  return Object.assign(w,{currentCount:w.currentReady?1:0,comparisonCount:w.comparisonReady?1:0,total:1,partial:!w.currentReady,comparisonPartial:!w.comparisonReady});
}
function playlistPerformance(rows){
  const eligible=(rows||[]).filter(r=>r[5]==='ok');
  const one=days=>{
    let current=0,currentCount=0,comparableCurrent=0,previous=0,comparisonCount=0;
    for(const r of eligible){
      const w=playlistWindow(r,days);
      if(w.currentReady){current+=w.current;currentCount++;}
      if(w.comparisonReady){comparableCurrent+=w.current;previous+=w.previous;comparisonCount++;}
    }
    const change=comparableCurrent-previous, total=eligible.length;
    return {days,current:currentCount?current:null,previous:comparisonCount?previous:null,comparisonCurrent:comparisonCount?comparableCurrent:null,
      change:comparisonCount?change:null,pct:comparisonCount&&previous>0?change/previous*100:null,currentReady:currentCount>0,comparisonReady:comparisonCount>0,
      currentCount,comparisonCount,total,partial:currentCount<total,comparisonPartial:comparisonCount<total};
  };
  return {1:one(1),7:one(7),30:one(30)};
}
function playlistWindowCell(r,days){
  const w=playlistWindow(r,days);
  const main=w.currentReady?signedFull(w.current):'—';
  const color=w.currentReady?(w.current>0?'var(--acc2)':(w.current<0?'var(--red)':'var(--muted)')):'var(--dim)';
  const compare=w.comparisonReady?`${T('vs période précédente')} ${signedFull(w.change)}${signedPct(w.pct)}`:T('Données partielles');
  return `<span class="delta-stack" title="${w.currentReady?'':T('Historique quotidien requis pour cette fenêtre.')}"><span class="delta-main" style="color:${color}">${main}</span><span class="delta-compare">${compare}</span></span>`;
}
function playlistRecentVariations(r){
  const pts=normalizeCounterHistory(plHistory(r)), out=[];
  for(let i=1;i<pts.length;i++) if(dayGap(pts[i-1][0],pts[i][0])===1) out.push([pts[i][0],pts[i][1]-pts[i-1][1]]);
  return out.slice(-5).reverse();
}

function openPlaylist(pid){
  const r = PLrows.find(x=>x[0]===pid); if(!r) return;
  const hist = plHistory(r);
  const perf={1:playlistWindow(r,1),7:playlistWindow(r,7),30:playlistWindow(r,30)};
  const entry=playlistPerfEntry(r);
  const placements=Array.isArray(entry.placements)?entry.placements:[];
  const variations=Array.isArray(entry.last_variations)&&entry.last_variations.length?entry.last_variations:playlistRecentVariations(r);
  const box = document.getElementById('tmbox');
  box.innerHTML = `
    <div class="thd">
      <div class="tcov cov" data-plid="${r[0]}"></div>
      <div style="min-width:0">
        <h3>${esc(r[1])}</h3>
        <div class="tar" style="cursor:default">${T('Fiche Analytics')} · ${esc(r[2]||T('Curateur non renseigné'))} ${plCuratorBadge(r[3])}</div>
      </div>
      <button class="tclose" onclick="closeTrack()">✕</button>
    </div>
    <div class="tgrid">
      <div class="tg"><div class="l">Tracks</div><div class="v">${r[16]?(r[6]||'?'):'—'}</div></div>
      <div class="tg"><div class="l">Fit score</div><div class="v">${r[16]?(r[12]||0):'—'}</div></div>
      <div class="tg"><div class="l">Genre</div><div class="v" style="font-size:13px">${esc(r[10]||'?')}</div></div>
      <div class="tg"><div class="l">Usage</div><div class="v" style="font-size:13px">${esc(r[11]||'?')}</div></div>
      <div class="tg"><div class="l">${T('Première observation')}</div><div class="v" style="font-size:13px">${fmtDate(r[7])}</div></div>
      <div class="tg"><div class="l">${T('Dernière observation')}</div><div class="v" style="font-size:13px">${fmtDate(r[8])}</div></div>
      <div class="tg"><div class="l">${T('Création estimée')}</div><div class="v" style="font-size:13px">${plEstDateCell(r)}</div></div>
    </div>
    ${perfGridHtml(perf,'Followers',r[5]==='ok'?r[4]:null,false)}
    <div class="analytics-section">
      <h4>${T('Courbe historique des followers')} <span class="analytics-note">${T('Compteur followers')}</span></h4>
      ${dailyChartHtml(hist,T('Historique quotidien insuffisant pour tracer la courbe.'))}
    </div>
    <div class="analytics-section">
      <h4>${T('Placements et rangs connus')}</h4>
      ${placements.length?`<div class="contributors">${placements.slice(0,10).map(p=>`<div class="contributor"><span class="cn">${esc(p.name||p.playlist||String(p))}</span><span class="cv">${p.rank!=null?'#'+esc(p.rank):'—'}</span></div>`).join('')}</div>`:`<div class="analytics-note">— · ${T('Donnée non disponible dans le raccord actuel')}</div>`}
    </div>
    <div class="analytics-section">
      <h4>${T('Dernières variations')}</h4>
      ${variations.length?`<div class="contributors">${variations.slice(0,5).map(p=>{const d=Array.isArray(p)?p[0]:(p.date||'');const v=Number(Array.isArray(p)?p[1]:p.value);return `<div class="contributor"><span class="cn">${fmtDate(d)}</span><span class="cv">${Number.isFinite(v)?signedFull(v):'—'}</span></div>`;}).join('')}</div>`:`<div class="analytics-note">— · ${T('Historique insuffisant')}</div>`}
    </div>
    <div style="display:flex;gap:10px;margin-top:14px">
      <a class="btn-back" style="margin:0;text-decoration:none" href="https://open.spotify.com/playlist/${r[0]}" target="_blank" rel="noopener">▶ ${T('Ouvrir sur Spotify')}</a>
    </div>
    <div class="tnote">${T("Les évolutions comparent toujours des fenêtres de même durée et utilisent uniquement les snapshots quotidiens réellement disponibles.")}</div>`;
  document.getElementById('track-modal').style.display='flex';
  if (typeof attachCovers==='function') attachCovers();
}

function renderPlaylists(){
  if (!PLmeta){
    V.innerHTML = `<div class="page-head"><div><h2>${T('Toutes les playlists')}</h2><p>${T('Aucune donnée playlists chargée pour le moment.')}</p></div></div>`;
    return;
  }
  const rows = plFiltered();
  const slice = rows.slice(0, S.shownPL);
  const tableView = `
  <div class="panel" style="padding:6px 14px 14px">
    <table>
      <thead><tr>
        <th></th>
        <th data-plsort="name">Playlist ${plSortArrow('name')}</th>
        <th data-plsort="curator">${T('Curateur')} ${plSortArrow('curator')}</th>
        <th data-plsort="followers" class="num">${T('Followers total')}</th>
        <th data-plsort="growth30" class="num" title="${T('Évolution followers sur les 30 derniers jours')}">${T('Followers 30 jours')} ${plSortArrow('growth30')}</th>
        <th data-plsort="growth7" class="num" title="${T('Évolution followers sur les 7 derniers jours')}">${T('Followers 7 jours')} ${plSortArrow('growth7')}</th>
        <th data-plsort="growth24" class="num" title="${T('Évolution followers sur les dernières 24 h')}">${T('Followers 24 heures')} ${plSortArrow('growth24')}</th>
        <th data-plsort="tracks" class="num">Tracks ${plSortArrow('tracks')}</th>
        <th data-plsort="fit" class="num">Fit score ${plSortArrow('fit')}</th>
        <th data-plsort="genre">Genre ${plSortArrow('genre')}</th>
        <th data-plsort="usage">Usage ${plSortArrow('usage')}</th>
        <th data-plsort="created">${T('Création estimée')} ${plSortArrow('created')}</th>
        <th data-plsort="recent">${T('Dernière observation')} ${plSortArrow('recent')}</th>
        <th>${T('Lien')}</th>
      </tr></thead>
      <tbody>
      ${slice.map(r=>`
        <tr onclick="openPlaylist('${r[0]}')" style="cursor:pointer">
          <td class="covtd"><div class="cov" data-plid="${r[0]}"></div></td>
          <td><span class="tk">${esc(r[1])}</span>${r[16]?'':' <span class="badge new" title="'+T('Détail pas encore récupéré')+'">'+T('en attente')+'</span>'}</td>
          <td>${esc(r[2])} ${plCuratorBadge(r[3])}</td>
          <td class="num" title="${fmtFull(r[4])}">${plFollowersCell(r)}</td>
          <td class="num">${playlistWindowCell(r,30)}</td>
          <td class="num">${playlistWindowCell(r,7)}</td>
          <td class="num">${playlistWindowCell(r,1)}</td>
          <td class="num">${r[16]?(r[6]||'?'):'—'}</td>
          <td class="num">${r[16]?(r[12]||0):'—'}</td>
          <td>${esc(r[10]||'?')}</td>
          <td>${esc(r[11]||'?')}</td>
          <td style="white-space:nowrap">${plEstDateCell(r)}</td>
          <td style="white-space:nowrap;font-variant-numeric:tabular-nums">${fmtDate(r[8])}</td>
          <td><a href="https://open.spotify.com/playlist/${r[0]}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${T('Ouvrir')} ↗</a></td>
        </tr>`).join('')}
      </tbody>
    </table>
    ${rows.length===0?'<div class="empty">'+T('Aucune playlist ne correspond à ces filtres.')+'</div>':''}
    ${sentinel(rows.length-S.shownPL)}
  </div>`;
  const gridView = `
  <div class="acards">
    ${slice.map(r=>`
    <div class="acard plcard grid-clean" onclick="openPlaylist('${r[0]}')">
      <div class="cov" data-plid="${r[0]}"></div>
      <div class="nm">${esc(r[1])}${r[16]?'':' <span class="badge new" title="'+T('Détail pas encore récupéré')+'">'+T('en attente')+'</span>'}</div>
      <div style="font-size:11px;color:var(--dim);margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">${esc(r[2])} ${plCuratorBadge(r[3])}</div>
      <div class="stats stats2">
        <div class="st"><div class="v">${plFollowersCell(r)}</div><div class="l">${T('Followers total')}</div></div>
        <div class="st"><div class="v">${playlistWindowCell(r,30)}</div><div class="l">${T('Followers 30 jours')}</div></div>
        <div class="st"><div class="v">${playlistWindowCell(r,7)}</div><div class="l">${T('Followers 7 jours')}</div></div>
        <div class="st"><div class="v">${playlistWindowCell(r,1)}</div><div class="l">${T('Followers 24 heures')}</div></div>
      </div>
      <div class="stats stats2">
        <div class="st" style="grid-column:1/-1"><div class="v">${r[16]?(r[6]||'?'):'—'}</div><div class="l">Tracks</div></div>
      </div>
    </div>`).join('')}
  </div>
  ${rows.length===0?'<div class="empty">'+T('Aucune playlist ne correspond à ces filtres.')+'</div>':''}
  ${sentinel(rows.length-S.shownPL)}`;

  V.innerHTML = `
  <div class="page-head">
    <div>
      <h2>${T('Toutes les playlists')} <span class="badge new" style="vertical-align:middle">${T('Scan incomplet, pause sécurité Spotify')}</span></h2>
    </div>
  </div>
  <div class="toolbar">
    <div class="search-wrap"><span class="sico">🔍</span><input type="text" id="pl-q" placeholder="${T('Rechercher playlist, curateur, genre…')}" value="${esc(S.plq)}"></div>
    <select id="pl-cur">
      <option value="all" ${S.plcur==='all'?'selected':''}>🌍 ${T('Tous')}</option>
      <option value="editorial" ${S.plcur==='editorial'?'selected':''}>🏛️ ${T('Éditoriales')}</option>
      <option value="independent" ${S.plcur==='independent'?'selected':''}>🌱 ${T('Indépendantes')}</option>
    </select>
    <span class="spacer"></span>
    <span class="result-count">${fmtFull(rows.length)} playlists</span>
    <div class="viewtoggle">
      <button class="${S.plmode==='table'?'on':''}" data-plmode="table" title="${T('Vue liste')}"><span class="view-ico">☰</span><span class="view-label">${T('Vue liste')}</span></button>
      <button class="${S.plmode==='grid'?'on':''}" data-plmode="grid" title="${T('Vue grille')}"><span class="view-ico">▦</span><span class="view-label">${T('Vue grille')}</span></button>
    </div>
  </div>
  ${S.plmode==='grid' ? gridView : tableView}`;

  document.querySelectorAll('.viewtoggle button[data-plmode]').forEach(b=>b.addEventListener('click', ()=>{ S.plmode=b.dataset.plmode; keepScroll(renderPlaylists); }));
  document.getElementById('pl-q').addEventListener('input', e=>{ S.plq=e.target.value; S.shownPL=80; keepScroll(renderPlaylists); keepFocus('pl-q'); });
  document.getElementById('pl-cur').addEventListener('change', e=>{ S.plcur=e.target.value; S.shownPL=80; keepScroll(renderPlaylists); });
  document.querySelectorAll('th[data-plsort]').forEach(h=>h.addEventListener('click', ()=>{
    const key=h.dataset.plsort;
    if (S.plsort===key) S.pldir*=-1;
    else {
      S.plsort=key;
      S.pldir=['name','curator','genre','usage'].includes(key)?1:-1;
    }
    keepScroll(renderPlaylists);
  }));
  attachInfinite(()=>{ const y=window.scrollY; S.shownPL+=80; renderPlaylists(); window.scrollTo(0,y); });
  if (typeof attachCovers==='function') attachCovers();
}

/* colonnes LBrows : key,name,tracks,streams,revenue,since,nArtists,logo */
/* logo en <img> avec onerror : si l'URL curée est fausse/morte, l'image disparaît
   et l'avatar lettre reste visible (jamais d'image cassée à l'écran) */
function labelCover(name, big, logo){
  const letter = esc((name[0]||'?').toUpperCase());
  const img = logo ? `<img class="lblogo" src="${esc(logo)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  return `<div class="cov lblcov${big?' big':''}">${letter}${img}</div>`;
}
function lbFiltered(){
  const q = S.lbq.trim().toLowerCase();
  let rows = LBrows.filter(r=>!q || r[1].toLowerCase().includes(q));
  const sorters = {
    name: (a,b)=>(a[1]||'').localeCompare(b[1]||''),
    revenue: (a,b)=>a[4]-b[4],
    streams: (a,b)=>a[3]-b[3],
    tracks: (a,b)=>a[2]-b[2],
    since: (a,b)=>(a[5]||'').localeCompare(b[5]||''),
    streams30: (a,b)=>(labelStreams(a[0],30)==null?(S.lbdir===-1?-Infinity:Infinity):labelStreams(a[0],30))-(labelStreams(b[0],30)==null?(S.lbdir===-1?-Infinity:Infinity):labelStreams(b[0],30)),
    streams7: (a,b)=>(labelStreams(a[0],7)==null?(S.lbdir===-1?-Infinity:Infinity):labelStreams(a[0],7))-(labelStreams(b[0],7)==null?(S.lbdir===-1?-Infinity:Infinity):labelStreams(b[0],7)),
    streams24: (a,b)=>(labelStreams(a[0],1)==null?(S.lbdir===-1?-Infinity:Infinity):labelStreams(a[0],1))-(labelStreams(b[0],1)==null?(S.lbdir===-1?-Infinity:Infinity):labelStreams(b[0],1)),
    artists: (a,b)=>(a[6]||0)-(b[6]||0),
  };
  const sorter = sorters[S.lbsort] || sorters.streams;
  return rows.slice().sort((a,b)=>S.lbdir*sorter(a,b));
}
function labelSortArrow(k){ return S.lbsort===k ? `<span class="arr">${S.lbdir===-1?'▼':'▲'}</span>` : ''; }
/* ---------- Fiche label en pop-up (tracks groupées par artiste + simulateur) ---------- */
/* extraction du label côté client : même logique que gen_labels_data.py */
const LB_LICENSE_RE = /(?:under\s+(?:an?\s+)?|on\s+)?exclusive\s+licen[cs]e\s+(?:to|with|from)\s+(.+?)(?:\s*[;.]|$)/i;
const LB_LICENSED_TO_RE = /licen[cs]ed\s+to\s+(.+?)(?:\s*[;.]|$)/i;
const LB_YEAR_STRIP_RE = /^[©℗()pcPC\s]*\d{4}\s*/;
function labelKeyOf(cop){
  if (!cop) return null;
  const m = LB_LICENSE_RE.exec(cop) || LB_LICENSED_TO_RE.exec(cop);
  let name;
  if (m) name = m[1].trim().replace(/\.$/,'');
  else name = cop.split(';')[0].trim().replace(LB_YEAR_STRIP_RE,'').trim();
  if (!name) return null;
  // même ordre que gen_labels_data.py : lower PUIS NFKD PUIS retrait des marques combinantes
  // (sauf sélecteurs de variation U+FE00-FE0F : classe combinante 0, Python les conserve)
  return name.trim().toLowerCase().normalize('NFKD').replace(/(?![\uFE00-\uFE0F])\p{M}/gu,'').replace(/\s+/g,' ');
}
let LBTRACKS = null; // key -> rows, construit à la demande (une seule passe sur R)
function labelRowsOf(key){
  if (!LBTRACKS){
    LBTRACKS = new Map();
    for (const r of R){
      if (r[4] !== 1) continue;
      const k = labelKeyOf(r[5]);
      if (!k) continue;
      let a = LBTRACKS.get(k); if(!a){ a=[]; LBTRACKS.set(k,a); }
      a.push(r);
    }
  }
  return LBTRACKS.get(key) || [];
}
let LB_PERF = null; // key -> fenêtres streams agrégées, construit à la demande
function labelPerformance(key){
  if(!LB_PERF) LB_PERF=new Map();
  if(!LB_PERF.has(key)) LB_PERF.set(key,performanceForRows(labelRowsOf(key)));
  return LB_PERF.get(key);
}
function labelStreams(key,days){ return labelPerformance(key)[days].current; }
function labelStreams30(key){ return labelStreams(key,30); }
function openLabel(key){
  S.labelKey = key; S.sel = new Set(); S.lbModalArtist = null;
  renderLabelModal();
  document.getElementById('artist-modal').style.display='flex';
}
function labelModalArtistOptions(rows){
  // liste des artistes uniques du label, triés par streams cumulés desc
  const byArtist = new Map();
  for (const r of rows){ let a=byArtist.get(r[0]); if(!a){a={n:0,tot:0};byArtist.set(r[0],a);} a.n++; a.tot+=Math.max(r[3],0); }
  return [...byArtist.entries()].map(([ai,a])=>({ai, n:a.n, tot:a.tot})).sort((a,b)=>b.tot-a.tot);
}
function labelModalRows(rows){
  // liste plate, triée par streams desc (plus de sous-en-têtes par artiste, cf. filtre artiste dédié)
  const sorted = rows.slice().sort((a,b)=>b[3]-a[3]);
  return sorted.map(r=>{const w30=trackWindow(r,30),w7=trackWindow(r,7),w1=trackWindow(r,1);return `
    <tr data-basehot="${r[3]>=HOT?1:0}" class="${r[3]>=HOT||S.sel.has(r[6])?'hot':''}">
      <td class="selc"><input type="checkbox" class="ck sel-track" data-tid="${r[6]}" ${S.sel.has(r[6])?'checked':''}></td>
      <td class="covtd">${r[8]?`<div class="cov has" style="background-image:url('${esc(r[8])}')"></div>`:`<div class="cov" data-tid="${r[6]}"></div>`}</td>
      <td><span class="tk" style="cursor:pointer" onclick="openTrack('${r[6]}')">${esc(r[1])}</span> ${wlStar('t',r[6])}</td>
      <td><span class="ar" onclick="closeArtistModal();goArtist(${r[0]})">${esc(A[r[0]][0])}</span></td>
      <td class="num" title="${fmtFull(r[3])}">${streamStackHtml(r[3]>=0?r[3]:null,false,false)}</td>
      <td class="num">${streamStackHtml(w30.current,false,false)}</td>
      <td class="num">${streamStackHtml(w7.current,false,false)}</td>
      <td class="num">${streamStackHtml(w1.current,false,false)}</td>
      <td class="num"><span style="color:var(--acc2);font-weight:600">${perMonth(r)<0?'—':eur(advance(perMonth(r)))}</span></td>
      <td>${fmtDate(r[2])}</td>
    </tr>`;}).join('');
}
function renderLabelModal(){
  const key = S.labelKey; if(!key) return;
  const lb = LBrows.find(x=>x[0]===key);
  const rows = labelRowsOf(key);
  const artistOpts = labelModalArtistOptions(rows);
  const filtRows = (S.lbModalArtist!=null) ? rows.filter(r=>r[0]===S.lbModalArtist) : rows;
  const name = lb ? lb[1] : (rows.length ? rows[0][5] : key);
  const logo = lb && lb[7];
  const nArt = new Set(rows.map(r=>r[0])).size;
  const selM = rows.filter(r=>S.sel.has(r[6])).reduce((s,r)=>s+Math.max(perMonth(r),0),0);
  const selN = rows.filter(r=>S.sel.has(r[6])).length;
  const box = document.getElementById('am-body');
  box.innerHTML = `
    <div class="thd">
      <div class="cov lblcov" style="width:52px;height:52px;font-size:19px;margin:0">${esc((name[0]||'?').toUpperCase())}${logo?`<img class="lblogo" src="${esc(logo)}" alt="" onerror="this.remove()">`:''}</div>
      <div style="min-width:0;flex:1">
        <h3>${esc(name)}</h3>
        <div class="tar" style="cursor:default">🏷️ Label · ${rows.length} tracks · ${nArt} ${T('artistes')}${lb&&lb[5]?' · '+T('Connu depuis')+' '+fmtDate(lb[5]):''}</div>
        ${lb && lb[8] ? `<div style="margin-top:4px"><a href="mailto:${esc(lb[8])}" style="color:var(--cyan);font-size:12.5px">✉ ${esc(lb[8])}</a></div>` : ''}
      </div>
      <button class="tclose" onclick="closeArtistModal()">✕</button>
    </div>
    <div class="toolbar" style="justify-content:flex-end;margin:0 0 10px">${metricModeToggleHtml()}</div>
    ${perfGridHtml(labelPerformance(key),'Streams',lb?lb[3]:rows.reduce((s,r)=>s+(r[3]>0?r[3]:0),0),true)}
    ${offerHtml({}, selM, selN, rows.length)}
    <div class="toolbar" style="padding:0 0 8px;margin:0">
      <select id="lbm-artist">
        <option value="" ${S.lbModalArtist==null?'selected':''}>${T('Tous les artistes')} (${rows.length} tracks)</option>
        ${artistOpts.map(o=>`<option value="${o.ai}" ${S.lbModalArtist===o.ai?'selected':''}>${esc(A[o.ai][0])} · ${o.n} tracks · ${S.metricMode==='revenue'?revenueEstimate(o.tot):fmt(o.tot)+' streams'}</option>`).join('')}
      </select>
    </div>
    <label class="selall" style="margin:2px 0 8px"><input type="checkbox" class="ck" id="am-sel-all" ${filtRows.length&&filtRows.every(r=>S.sel.has(r[6]))?'checked':''}> ${T('Tout sélectionner')}</label>
    <table><thead><tr>
      <th class="selc"></th><th></th><th>Track</th><th>${T('Artiste')}</th>
      <th class="num">${streamMetricLabel(0)}</th><th class="num">${streamMetricLabel(30)}</th>
      <th class="num">${streamMetricLabel(7)}</th><th class="num">${streamMetricLabel(1)}</th><th class="num">${T('Rachat')} ${S.palier}</th>
      <th>${T('Sortie')}</th>
    </tr></thead><tbody>${labelModalRows(filtRows)}</tbody></table>
    ${filtRows.length===0?'<div class="empty">'+T('Aucune track retrouvée pour ce label dans la base actuelle.')+'</div>':''}
  `;
  bindMetricModeToggle(renderLabelModal,box);
  attachCovers();
  function updateSel(){
    const selM2 = rows.filter(r=>S.sel.has(r[6])).reduce((s,r)=>s+Math.max(perMonth(r),0),0);
    const selN2 = rows.filter(r=>S.sel.has(r[6])).length;
    const off = box.querySelector('.offer');
    if (off) off.outerHTML = offerHtml({}, selM2, selN2, rows.length);
    box.querySelectorAll('.sel-track').forEach(cb=>{
      const tr=cb.closest('tr'); const on=S.sel.has(cb.dataset.tid);
      cb.checked=on; if(tr) tr.classList.toggle('hot', on || tr.dataset.basehot==='1');
    });
    const allOn = filtRows.length && filtRows.every(r=>S.sel.has(r[6]));
    const sa=document.getElementById('am-sel-all'); if(sa) sa.checked=allOn;
  }
  box.querySelectorAll('.sel-track').forEach(cb=>{
    cb.addEventListener('change', ()=>{ if(cb.checked)S.sel.add(cb.dataset.tid); else S.sel.delete(cb.dataset.tid); updateSel(); });
  });
  const sa = document.getElementById('am-sel-all');
  if (sa) sa.addEventListener('change', ()=>{ if(sa.checked) filtRows.forEach(r=>S.sel.add(r[6])); else filtRows.forEach(r=>S.sel.delete(r[6])); updateSel(); });
  const artSel = document.getElementById('lbm-artist');
  if (artSel) artSel.addEventListener('change', e=>{ S.lbModalArtist = e.target.value===''? null : Number(e.target.value); renderLabelModal(); });
}
function renderLabels(){
  if (!LBmeta){
    V.innerHTML = `<div class="page-head"><div><h2>${T('Tous les labels')}</h2><p>${T('Aucune donnée labels chargée pour le moment.')}</p></div></div>`;
    return;
  }
  const rows = lbFiltered();
  const slice = rows.slice(0, S.shownLB);
  const tableView = `
  <div class="panel" style="padding:6px 14px 14px">
    <table>
      <thead><tr>
        <th></th>
        <th data-lbsort="name">${T('Label')} ${labelSortArrow('name')}</th>
        <th data-lbsort="tracks" class="num">Tracks ${labelSortArrow('tracks')}</th>
        <th data-lbsort="streams" class="num">${streamMetricLabel(0)}</th>
        <th data-lbsort="streams30" class="num">${streamMetricLabel(30)} ${labelSortArrow('streams30')}</th>
        <th data-lbsort="streams7" class="num">${streamMetricLabel(7)} ${labelSortArrow('streams7')}</th>
        <th data-lbsort="streams24" class="num">${streamMetricLabel(1)} ${labelSortArrow('streams24')}</th>
        <th data-lbsort="since">${T('Connu depuis')} ${labelSortArrow('since')}</th>
        <th data-lbsort="artists" class="num">${T('Artistes')} ${labelSortArrow('artists')}</th>
      </tr></thead>
      <tbody>
      ${slice.map(r=>`
        <tr class="lbl-row" data-lbkey="${esc(r[0])}" style="cursor:pointer">
          <td class="covtd">${labelCover(r[1], false, r[7])}</td>
          <td>${esc(r[1])}</td>
          <td class="num">${fmtFull(r[2])}</td>
          <td class="num">${streamStackHtml(r[3],false,false)}</td>
          <td class="num">${streamStackHtml(labelStreams(r[0],30),false,false)}</td>
          <td class="num">${streamStackHtml(labelStreams(r[0],7),false,false)}</td>
          <td class="num">${streamStackHtml(labelStreams(r[0],1),false,false)}</td>
          <td style="white-space:nowrap">${r[5]?T('Connu depuis')+' '+fmtDate(r[5]):T('Non estimé')}</td>
          <td class="num">${r[6]}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    ${rows.length===0?'<div class="empty">'+T('Aucun label ne correspond à cette recherche.')+'</div>':''}
    ${sentinel(rows.length-S.shownLB)}
  </div>`;
  const gridView = `
  <div class="acards">
    ${slice.map(r=>`
    <div class="acard plcard lbl-row" data-lbkey="${esc(r[0])}">
      ${labelCover(r[1], true, r[7])}
      <div class="nm">${esc(r[1])}</div>
      <div class="stats stats2">
        <div class="st"><div class="v">${streamStackHtml(r[3],false,false)}</div><div class="l">${streamMetricLabel(0)}</div></div>
        <div class="st"><div class="v">${streamStackHtml(labelStreams(r[0],30),false,false)}</div><div class="l">${streamMetricLabel(30)}</div></div>
        <div class="st"><div class="v">${streamStackHtml(labelStreams(r[0],7),false,false)}</div><div class="l">${streamMetricLabel(7)}</div></div>
        <div class="st"><div class="v">${streamStackHtml(labelStreams(r[0],1),false,false)}</div><div class="l">${streamMetricLabel(1)}</div></div>
      </div>
      <div class="foot">${fmtFull(r[2])} tracks · ${r[5]?T('Connu depuis')+' '+fmtDate(r[5]):T('Non estimé')} · ${r[6]} ${T('artistes')}</div>
    </div>`).join('')}
  </div>
  ${rows.length===0?'<div class="empty">'+T('Aucun label ne correspond à cette recherche.')+'</div>':''}
  ${sentinel(rows.length-S.shownLB)}`;

  V.innerHTML = `
  <div class="page-head">
    <div>
      <h2>${T('Tous les labels')} <span class="badge new" style="vertical-align:middle">${T('Non exhaustif')}</span></h2>
    </div>
  </div>
  <div class="toolbar">
    <div class="search-wrap"><span class="sico">🔍</span><input type="text" id="lb-q" placeholder="${T('Rechercher un label…')}" value="${esc(S.lbq)}"></div>
    ${metricModeToggleHtml()}
    <span class="spacer"></span>
    <span class="result-count">${fmtFull(rows.length)} labels</span>
    <div class="viewtoggle">
      <button class="${S.lbmode==='table'?'on':''}" data-lbmode="table" title="${T('Vue liste')}"><span class="view-ico">☰</span><span class="view-label">${T('Vue liste')}</span></button>
      <button class="${S.lbmode==='grid'?'on':''}" data-lbmode="grid" title="${T('Vue grille')}"><span class="view-ico">▦</span><span class="view-label">${T('Vue grille')}</span></button>
    </div>
  </div>
  ${S.lbmode==='grid' ? gridView : tableView}`;

  document.querySelectorAll('.lbl-row[data-lbkey]').forEach(el=>el.addEventListener('click', ()=>openLabel(el.dataset.lbkey)));
  bindMetricModeToggle(renderLabels,V);
  document.querySelectorAll('.viewtoggle button[data-lbmode]').forEach(b=>b.addEventListener('click', ()=>{ S.lbmode=b.dataset.lbmode; keepScroll(renderLabels); }));
  document.getElementById('lb-q').addEventListener('input', e=>{ S.lbq=e.target.value; S.shownLB=80; keepScroll(renderLabels); keepFocus('lb-q'); });
  document.querySelectorAll('th[data-lbsort]').forEach(h=>h.addEventListener('click', ()=>{
    const key=h.dataset.lbsort;
    if (S.lbsort===key) S.lbdir*=-1;
    else { S.lbsort=key; S.lbdir=key==='name'?1:-1; }
    keepScroll(renderLabels);
  }));
  attachInfinite(()=>{ const y=window.scrollY; S.shownLB+=80; renderLabels(); window.scrollTo(0,y); });
}

function render(){
  if (S.view==='overview') renderOverview();
  else if (S.view==='radar') renderRadar();
  else if (S.view==='opps') renderOpps();
  else if (S.view==='artists') renderArtists();
  else if (S.view==='playlists') renderPlaylists();
  else if (S.view==='labels') renderLabels();
  else if (S.view==='watch') renderWatch();
  attachCovers();
  if (document.getElementById('artist-modal').style.display==='flex'){
    if (S.labelKey) renderLabelModal();
    else if (S.artist>=0) renderArtistModal();
  }
}

/* ---------- init ---------- */
document.getElementById('c-opps').textContent = fmt(R.length);
(() => { const c=document.getElementById('c-radar'); if(c) c.textContent=SC&&Array.isArray(SC.opportunities)?fmt(SC.opportunities.length):''; })();
document.getElementById('c-art').textContent = withTracks.length;
(function(){ const c=document.getElementById('c-pl'); if(c && PLmeta) c.textContent = fmt(PLmeta.playlists_10k_plus); })();
(function(){ const c=document.getElementById('c-lb'); if(c && LBmeta) c.textContent = fmt(LBrows.length); })();
(function(){ const w=wlGet(); const c=document.getElementById('c-watch'); if(c) c.textContent = (w.t.length+w.a.length)||''; })();
function fmtTs(ts){
  const raw=''+(ts||'');
  if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)){
    const date=new Date(raw);
    if(!Number.isNaN(date.getTime())) return new Intl.DateTimeFormat(LANG==='fr'?'fr-FR':'en-GB',{timeZone:'Europe/Paris',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(date).replace(',',LANG==='fr'?' à':'');
  }
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}:\d{2}))?/);
  if (!m) return ts;
  // format européen (jour/mois/année) dans les deux langues, jamais le format américain
  if (LANG==='fr') return m[3]+'/'+m[2]+'/'+m[1] + (m[4] ? ' à '+m[4] : '');
  return m[3]+'/'+m[2]+'/'+m[1] + (m[4] ? ', '+m[4] : '');
}
function updateFooter(){
  // volontairement compact (peu de texte) : icône + date, détail complet dans un popover custom au clic/survol
  const trRow = document.getElementById('sync-row-tr');
  const trTxt = document.getElementById('sync-txt-tr');
  const trDetail = document.getElementById('sync-detail-tr');
  const strictTimestamp=SC&&(SC.generated_at||(SC.freshness&&SC.freshness.tracks_at))||D.ts||D.t;
  trTxt.innerHTML = '🎶 '+esc(fmtTs(strictTimestamp));
  trDetail.innerHTML = `<b>${T('Tracks')} · ${T('Catalogue + staging Soundcharts strict')}</b><br>${fmtFull(R.length)} tracks · ${fmtFull(withTracks.length)} ${T('artistes visibles')}<br>${fmtFull(SC_STAGING.tracks)} ${T('tracks Soundcharts strictes intégrées')} · ${T('Export Soundcharts le')} ${esc(fmtTs(strictTimestamp))}`;
  const plRow = document.getElementById('sync-row-pl');
  const plTxt = document.getElementById('sync-txt-pl');
  const plDot = document.getElementById('sync-dot-pl');
  const plDetail = document.getElementById('sync-detail-pl');
  if (plRow){
    if (PLmeta){
      const paused = PLmeta.scan_status && PLmeta.scan_status !== 'ok';
      plTxt.innerHTML = '📻 '+esc(fmtTs(PLmeta.snapshot_ts))+(paused?' ⏸':'');
      const c = paused ? '#fbbf24' : 'var(--green)';
      plDot.style.background = c; plDot.style.boxShadow = '0 0 8px '+c;
      plDetail.innerHTML = `<b>${T('Playlists')}</b><br>${fmtFull(PLmeta.playlists_discovered)} ${T('Playlists découvertes')} · ${fmtFull(PLmeta.playlists_10k_plus)} ≥10k<br>${T('Snapshot')} ${esc(fmtTs(PLmeta.snapshot_ts))}${paused?'<br><span style="color:#fbbf24">⏸ '+T('Scan incomplet, pause sécurité Spotify')+'</span>':''}`;
      plRow.style.display = '';
    } else {
      plRow.style.display = 'none';
    }
  }
}
function toggleSyncDetail(row){
  document.querySelectorAll('.sync-row.open').forEach(r=>{ if(r!==row) r.classList.remove('open'); });
  row.classList.toggle('open');
}
document.getElementById('sync-row-tr').addEventListener('click', e=>{ e.stopPropagation(); toggleSyncDetail(e.currentTarget); });
document.getElementById('sync-row-pl').addEventListener('click', e=>{ e.stopPropagation(); toggleSyncDetail(e.currentTarget); });
document.addEventListener('click', ()=>{ document.querySelectorAll('.sync-row.open').forEach(r=>r.classList.remove('open')); });
function applyLang(){
  document.querySelectorAll('[data-fr]').forEach(el=>{
    if (el.tagName==='SMALL' || el.classList.contains('nav-label')){ el.textContent = T(el.dataset.fr); return; }
    for (const n of el.childNodes){
      if (n.nodeType===3 && n.nodeValue.trim()){ n.nodeValue = T(el.dataset.fr); break; }
    }
  });
  const lsw = document.getElementById('lang-switch');
  if (lsw){
    lsw.dataset.lang = LANG;
    lsw.title = LANG==='fr' ? 'Français / English' : 'English / Français';
    lsw.querySelectorAll('.ls-flag').forEach(f=>f.classList.toggle('active', f.dataset.l===LANG));
  }
  document.documentElement.lang = LANG;
  updateFooter(); render();
}
document.getElementById('lang-switch').addEventListener('click', ()=>{
  LANG = LANG==='fr' ? 'en' : 'fr';
  try{ localStorage.setItem('sr_lang', LANG); }catch(e){}
  applyLang();
});
/* restauration de la vue après F5 (hash d'URL) */
const initV = location.hash.slice(1);
const initialView = initV==='opps' ? 'radar' : initV==='tracks' ? 'opps' : initV;
if (['radar','opps','artists','watch','playlists','labels','tracks'].includes(initV)){
  S.view = initialView;
  document.querySelectorAll('#nav button').forEach(x=>x.classList.toggle('active', x.dataset.v===initialView));
}else if(initV==='overview'){
  history.replaceState(null,'',location.pathname+location.search+'#tracks');
}
applyLang();
