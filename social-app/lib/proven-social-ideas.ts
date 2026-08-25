import type { NormalizedPost, SocialPlatform } from "./social-scanner.ts";
import {
  buildEditorialAnalysisMapForTargets,
  editorialPostKey,
  type EditorialWhy,
} from "./social-editorial-analysis.ts";
import {
  rankPostsByPublicMetric,
  type PublicRankingMetric,
} from "./social-ranking.ts";
import {
  rankPosts,
  type RankedPost,
  type ScoreConfidence,
} from "./social-score.ts";

export type EditorialPattern =
  | "student_milestone_absurdity"
  | "cultural_meme_reframe"
  | "routine_interruption"
  | "audience_inner_voice"
  | "instant_identity_question"
  | "consequential_participation"
  | "iconic_world_remix"
  | "narrative_anomaly"
  | "immersive_activation"
  | "friendly_care"
  | "cat_conflict";

export type IdeaConfidence = "high" | "medium" | "low";

export type IdeaContentType =
  | "Vidéo courte"
  | "Visuel statique"
  | "Texte court"
  | "Question visuelle"
  | "Carrousel";

export type SocialIdeaSeed = {
  platform: SocialPlatform;
  externalId: string;
  url: string;
  label: string;
  format: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  performanceScore: number;
  scoreConfidence: ScoreConfidence;
  platformRank: number | null;
  cohortRank: number;
  cohortSize: number;
  rankingMetric: Exclude<PublicRankingMetric, null>;
  rankingValue: number;
};

export type SocialIdea = {
  id: string;
  title: string;
  pattern: EditorialPattern;
  patternLabel: string;
  primaryPlatform: SocialPlatform;
  platformRank: number;
  potentialScore: number;
  contentType: IdeaContentType;
  seedPosts: SocialIdeaSeed[];
  comparisonPost: SocialIdeaSeed | null;
  comparisonInsight: string | null;
  observedSignal: {
    summary: string;
    evidence: string[];
  };
  proposedFormat: string;
  hook: string;
  whyItWorked: string;
  borrowedMechanic: string;
  novelty: string;
  proofLabel: string;
  confidence: IdeaConfidence;
  confidenceScore: number;
  confidenceRationale: string;
  limits: string[];
  assetPolicy: "official-assets-only";
};

export type SocialIdeaPlan = {
  generatedAt: string;
  eligiblePostCount: number;
  winnerCount: number;
  ideas: SocialIdea[];
  caveats: string[];
};

export type GenerateSocialIdeasOptions = {
  now?: Date | string | number;
  maxIdeas?: number;
  winnersPerPlatform?: number;
};

type IdeaRankedPost = RankedPost & {
  publicCohortKey: string;
  publicCohortRank: number;
  publicCohortSize: number;
  publicRankingMetric: Exclude<PublicRankingMetric, null>;
};

type PublicWinnerSelection = {
  eligible: IdeaRankedPost[];
  winners: IdeaRankedPost[];
};

type ProvenRecipe = {
  key: string;
  title: string;
  contentType: IdeaContentType;
  proposedFormat: string;
  hook: string;
  novelty: string;
  priority: number;
};

type ProvenFamily = {
  key: EditorialPattern;
  label: string;
  matcher: RegExp;
  comparisonMatcher?: RegExp;
  priorityBoost: number;
  whyItWorked: string;
  borrowedMechanic: string;
  comparisonLesson?: string;
  recipes: readonly ProvenRecipe[];
};

type Candidate = {
  key: string;
  family: ProvenFamily;
  recipe: ProvenRecipe;
  posts: IdeaRankedPost[];
  comparisonPost: IdeaRankedPost | null;
  repeatedCreative: boolean;
  primaryPlatform: SocialPlatform;
  exactRecipeEvidence: boolean;
};

const PLATFORM_ORDER: SocialPlatform[] = [
  "youtube",
  "instagram",
  "tiktok",
  "x",
];

const PROVEN_FAMILIES: readonly ProvenFamily[] = [
  {
    key: "student_milestone_absurdity",
    label: "Étape étudiante + chute absurde",
    matcher: /\b(?:girl i just graduado|just graduado|less+s+go+.*graduat)\b/i,
    comparisonMatcher: /\bi may not have officially graduated yet\b/i,
    priorityBoost: 7,
    whyItWorked:
      "Le cap étudiant est compris immédiatement, puis la formulation volontairement bancale et la chute absurde le transforment en mème. Le post reste drôle sans contexte et sans message promotionnel.",
    borrowedMechanic:
      "Un vrai moment de vie étudiant, réduit à une phrase très courte, puis détourné par une conséquence ridicule comprise en une seconde.",
    comparisonLesson:
      "La version plus longue et promotionnelle autour de la même graduation a nettement moins circulé : la force vient du gag autonome, pas du thème seul.",
    recipes: [
      {
        key: "one-task-diploma",
        title: "Le diplôme pour une seule tâche terminée",
        contentType: "Vidéo courte",
        proposedFormat:
          "Lofi Girl coche enfin une tâche. Confettis, bonnet de diplômée et pose solennelle apparaissent, puis la caméra révèle les 46 tâches restantes.",
        hook: "girl i just graduated from one task 🎓",
        novelty: "On remplace la vraie graduation par une micro-victoire ridicule et immédiatement relatable.",
        priority: 4,
      },
      {
        key: "procrastination-degree",
        title: "Le diplôme officiel de procrastination",
        contentType: "Visuel statique",
        proposedFormat:
          "Lofi Girl reçoit un faux diplôme « Certified Professional Procrastinator ». Derrière elle, le devoir est toujours ouvert à la première ligne.",
        hook: "finally got my degree in avoiding the assignment 🎓",
        novelty: "Le symbole du diplôme devient la récompense du défaut le plus partagé par l’audience.",
        priority: 3,
      },
      {
        key: "cat-steals-cap",
        title: "Le bonnet de diplômée volé par le chat",
        contentType: "Vidéo courte",
        proposedFormat:
          "Lofi Girl lance son bonnet avec fierté. Le chat l’attrape, part avec, et elle retourne aussitôt à son bureau comme si rien ne s’était passé.",
        hook: "graduation lasted four seconds. the cat had other plans 🎓🐈",
        novelty: "La célébration est interrompue par le chat, ce qui crée une nouvelle chute visuelle sans copier la scène gagnante.",
        priority: 2,
      },
      {
        key: "wrong-result-letter",
        title: "Elle ouvre enfin ses résultats… du mauvais examen",
        contentType: "Vidéo courte",
        proposedFormat:
          "Lofi Girl ouvre une enveloppe en tremblant, célèbre, puis lit la petite ligne : ce sont les résultats d’un vieux contrôle déjà passé.",
        hook: "passed the exam. wrong exam, but still 🎓",
        novelty: "On conserve le soulagement étudiant, mais la révélation finale retourne complètement la victoire.",
        priority: 1,
      },
      {
        key: "micro-win-ceremony",
        title: "La cérémonie pour une micro-victoire",
        contentType: "Carrousel",
        proposedFormat:
          "Premier visuel : Lofi Girl ferme trois onglets inutiles. Deuxième : cérémonie démesurée avec tapis rouge, diplôme et le chat en jury.",
        hook: "closed three tabs today. please hold your applause 👩‍🎓",
        novelty: "La réussite devient universelle même hors période d’examens, tout en gardant l’exagération cérémonielle.",
        priority: 0,
      },
    ],
  },
  {
    key: "cultural_meme_reframe",
    label: "Mème culturel réécrit avec Lofi Girl",
    matcher: /\b(?:final form|canon event|chill guy|glitch in the matrix|head empty|saw this trend)\b/i,
    priorityBoost: 5,
    whyItWorked:
      "Les meilleurs détournements ne se contentent pas de citer une tendance : Lofi Girl devient le personnage central de sa mécanique. La référence est reconnue instantanément, puis la scène d’étude lui donne une nouvelle lecture.",
    borrowedMechanic:
      "Une phrase ou une transformation culturelle déjà reconnaissable, reconstruite avec les codes visuels de Lofi Girl et une situation d’étude précise.",
    recipes: [
      {
        key: "final-study-form",
        title: "La forme ultime de Lofi Girl après huit heures d’étude",
        contentType: "Vidéo courte",
        proposedFormat:
          "Lofi Girl termine une tâche et passe brièvement en « mode étude ultime » : posture parfaite, bureau lumineux, pages qui se tournent seules. Une nouvelle notification la ramène immédiatement à la normale.",
        hook: "this is not even my final study form 📚",
        novelty: "On reprend la transformation gagnante, mais la chute vient d’une nouvelle tâche qui détruit instantanément le power-up.",
        priority: 4,
      },
      {
        key: "deadline-canon-event",
        title: "Le canon event de chaque étudiant",
        contentType: "Vidéo courte",
        proposedFormat:
          "Lofi Girl travaille calmement. Elle découvre que le devoir est à rendre dans cinq minutes ; l’image se fige comme un « canon event » impossible à éviter.",
        hook: "realising the deadline was today is a canon event 😭",
        novelty: "La mécanique du destin inévitable est appliquée à un incident étudiant précis plutôt qu’à une référence générique.",
        priority: 3,
      },
      {
        key: "chill-during-chaos",
        title: "Juste une chill girl au milieu du chaos",
        contentType: "Visuel statique",
        proposedFormat:
          "Lofi Girl reste parfaitement calme au bureau tandis que la to-do list déborde, l’imprimante clignote et le chat renverse les feuilles autour d’elle.",
        hook: "just a chill girl with 47 urgent tasks ✨",
        novelty: "Le contraste visuel entre calme absolu et chaos remplace la simple citation du mème.",
        priority: 2,
      },
      {
        key: "coffee-glitch",
        title: "Le café qui revient sans arrêt",
        contentType: "Vidéo courte",
        proposedFormat:
          "Lofi Girl finit sa tasse, la pose, puis elle réapparaît pleine à chaque coupe. Au dernier plan, le chat fixe la tasse comme s’il connaissait le bug.",
        hook: "a glitch in the study matrix ☕",
        novelty: "Le glitch devient un gag répétitif dans l’objet le plus familier du décor.",
        priority: 1,
      },
      {
        key: "head-empty-cat",
        title: "Head empty, just Lofi Cat",
        contentType: "Vidéo courte",
        proposedFormat:
          "Zoom dramatique sur Lofi Girl censée réfléchir. La bulle de pensée ne contient que le chat qui tourne lentement sur lui-même.",
        hook: "head empty, just lofi cat",
        novelty: "On conserve la formule très courte, mais la pensée vide devient une scène originale avec le chat.",
        priority: 0,
      },
    ],
  },
  {
    key: "routine_interruption",
    label: "Routine iconique interrompue",
    matcher: /\b(?:being recorded|gets? her test score|too much stress|infinite (?:number of )?pages|studying 24\/7|finally stops? studying)\b/i,
    comparisonMatcher: /\bdon.?t let me catch you procrastinating\b/i,
    priorityBoost: 4,
    whyItWorked:
      "La scène familière donne un point de départ immédiat. Un incident unique casse ensuite la routine et provoque une réaction lisible, ce qui raconte une histoire complète sans explication.",
    borrowedMechanic:
      "Routine connue, incident très concret, réaction nette du personnage. Le titre annonce l’incident plutôt qu’une ambiance vague.",
    comparisonLesson:
      "Les injonctions génériques sur la procrastination ont moins fonctionné que les scènes où Lofi Girl vit réellement le problème.",
    recipes: [
      {
        key: "cat-reveals-grade",
        title: "Lofi Girl cache sa note, le chat la révèle",
        contentType: "Vidéo courte",
        proposedFormat:
          "Lofi Girl retourne discrètement sa copie pour cacher la note. Le chat marche dessus, la feuille glisse face caméra et elle se fige.",
        hook: "when your cat leaks the test score you were hiding 📝",
        novelty: "Le résultat d’examen reste le déclencheur, mais le chat provoque la révélation et la chute.",
        priority: 4,
      },
      {
        key: "camera-caught-break",
        title: "Elle remarque la caméra pendant sa pause secrète",
        contentType: "Vidéo courte",
        proposedFormat:
          "Lofi Girl danse seule pendant une pause. Elle aperçoit la caméra, remet son casque et reprend instantanément sa pose d’étude officielle.",
        hook: "when you realise the study cam was still on 👀",
        novelty: "Le quatrième mur revient, mais révèle cette fois une personnalité cachée pendant la pause.",
        priority: 3,
      },
      {
        key: "page-number-backwards",
        title: "Le livre dont les pages reculent",
        contentType: "Vidéo courte",
        proposedFormat:
          "Lofi Girl tourne les pages de plus en plus vite. Le numéro passe de 128 à 127 puis 126 ; elle comprend que le livre ne finira jamais.",
        hook: "the pages are going the wrong way 😐",
        novelty: "L’infini n’est plus seulement déclaré : une anomalie très simple le rend visible dès le deuxième plan.",
        priority: 2,
      },
      {
        key: "notes-collapse",
        title: "La pile de notes finit par gagner",
        contentType: "Vidéo courte",
        proposedFormat:
          "Une feuille tombe sur le bureau, puis dix, puis toute la pile engloutit Lofi Girl. Seule sa main ressort pour continuer à écrire.",
        hook: "just one more chapter, they said 📚",
        novelty: "Le stress devient un incident physique exagéré au lieu d’un simple visage fatigué.",
        priority: 1,
      },
      {
        key: "room-reacts-to-break",
        title: "Quand Lofi Girl arrête enfin d’étudier",
        contentType: "Vidéo courte",
        proposedFormat:
          "Elle ferme son livre. Tous les objets du décor s’arrêtent, le chat la regarde et la lampe clignote comme si personne n’avait prévu ce moment.",
        hook: "lofi girl stopped studying. nobody knows what happens next 😳",
        novelty: "La rupture de routine touche tout l’univers, pas seulement le personnage.",
        priority: 0,
      },
    ],
  },
  {
    key: "audience_inner_voice",
    label: "Pensée intérieure de l’audience",
    matcher: /\b(?:quick nap if that.?s okay|i will pass my exams|like this post if you.?re procrastinating|my cat ate my homework|in my study era|take a break at your own risk)\b/i,
    comparisonMatcher: /\bstudy tip:.*procrastinat/i,
    priorityBoost: 4,
    whyItWorked:
      "La phrase ressemble à une pensée que l’audience pourrait copier-coller telle quelle. La voix est personnelle, courte et imparfaite ; elle crée de l’identification au lieu de donner un conseil.",
    borrowedMechanic:
      "Une confession à la première personne en moins de douze mots, sauf lorsque la répétition constitue elle-même la blague.",
    comparisonLesson:
      "Le conseil pédagogique long autour du même sujet a moins circulé que la confession courte et immédiatement partageable.",
    recipes: [
      {
        key: "five-minute-nap",
        title: "La sieste de cinq minutes qui mange la journée",
        contentType: "Vidéo courte",
        proposedFormat:
          "Lofi Girl pose la tête « cinq minutes ». La lumière passe du jour à la nuit ; elle se réveille, regarde l’heure et se recouche par déni.",
        hook: "hey so i’m taking a five-minute nap until tomorrow",
        novelty: "La pensée gagnante devient une micro-histoire visuelle avec une conséquence claire.",
        priority: 4,
      },
      {
        key: "exam-mantra-screen",
        title: "Le mantra d’examen qui envahit l’écran",
        contentType: "Vidéo courte",
        proposedFormat:
          "Lofi Girl écrit « I will pass my exams ». La phrase se répète sur les murs, les feuilles et l’écran jusqu’à remplir tout le décor.",
        hook: "I WILL PASS MY EXAMS I WILL PASS MY EXAMS I WILL PASS MY EXAMS",
        novelty: "La répétition textuelle déjà gagnante devient un emballement visuel entièrement Lofi Girl.",
        priority: 3,
      },
      {
        key: "opened-document",
        title: "Ouvrir le document compte comme du progrès",
        contentType: "Visuel statique",
        proposedFormat:
          "Lofi Girl regarde fièrement un document vide intitulé « Final_final_v7 ». Le chat tient une pancarte de félicitations disproportionnée.",
        hook: "opened the document. that counts as progress.",
        novelty: "La confession reste autonome, mais le décor lui donne une preuve visuelle drôle.",
        priority: 2,
      },
      {
        key: "study-era-one-minute",
        title: "In my study era… depuis une minute",
        contentType: "Carrousel",
        proposedFormat:
          "Premier visuel : Lofi Girl annonce sa « study era ». Deuxième : une minute plus tard, elle choisit déjà une nouvelle playlist au lieu de travailler.",
        hook: "in my study era (started 60 seconds ago)",
        novelty: "L’identité aspirante est immédiatement contredite par un comportement précis.",
        priority: 1,
      },
      {
        key: "cat-homework-alibi",
        title: "Le chat a mangé le devoir numérique",
        contentType: "Visuel statique",
        proposedFormat:
          "Le chat est assis sur le clavier devant un fichier supprimé. Lofi Girl montre l’écran comme une preuve parfaitement sérieuse.",
        hook: "my cat ate the homework. digitally.",
        novelty: "On actualise l’excuse classique dans le bureau numérique de Lofi Girl.",
        priority: 0,
      },
    ],
  },
  {
    key: "instant_identity_question",
    label: "Question identitaire instantanée",
    matcher: /\b(?:how many languages can you speak|what time do you usually go to bed|which sibling are you|right-handed or left-handed|most productive|how many hours do you study|favorite school subject|where do you live)\b/i,
    comparisonMatcher: /\bif age is only a state of mind\b/i,
    priorityBoost: 3,
    whyItWorked:
      "Chacun connaît déjà sa réponse. La question parle d’identité ou d’habitude personnelle, et les choix sont compris en une seconde sans devoir réfléchir à une opinion abstraite.",
    borrowedMechanic:
      "Une caractéristique personnelle simple, trois à cinq réponses exhaustives et un visuel unique utilisable partout.",
    comparisonLesson:
      "Les formulations abstraites demandant une justification ont moins fonctionné que les questions auxquelles on répond instantanément.",
    recipes: [
      {
        key: "focus-hour",
        title: "À quelle heure ton cerveau se met vraiment à travailler ?",
        contentType: "Question visuelle",
        proposedFormat:
          "Un même bureau décliné en quatre heures : 8 h, 14 h, 20 h et 2 h. La communauté choisit simplement le moment où elle est réellement productive.",
        hook: "when does your brain actually start working? ☀️ 8am · ☕ 2pm · 🌙 8pm · 🦉 2am",
        novelty: "La question sur la productivité devient un choix visuel très concret lié au décor.",
        priority: 4,
      },
      {
        key: "sleep-schedule",
        title: "Ton heure de coucher réelle, pas celle que tu annonces",
        contentType: "Question visuelle",
        proposedFormat:
          "Quatre horloges entourent Lofi Girl : avant 22 h, minuit, 2 h, « quand le travail est fini ». Un seul choix à commenter.",
        hook: "what time do you actually go to bed? 😴",
        novelty: "On garde la question gagnante, mais la précision « réelle » ajoute une légère confession collective.",
        priority: 3,
      },
      {
        key: "language-desk",
        title: "Combien de langues vivent sur ton bureau ?",
        contentType: "Question visuelle",
        proposedFormat:
          "Des livres et notes en plusieurs langues entourent Lofi Girl. Les réponses proposées vont de 1 à 4+ sans demander d’explication.",
        hook: "how many languages can you study, speak or dream in? 🌍",
        novelty: "La question identitaire la plus forte est reliée visuellement à l’apprentissage et au monde Lofi Girl.",
        priority: 2,
      },
      {
        key: "current-mission",
        title: "Quelle est ta mission du moment ?",
        contentType: "Question visuelle",
        proposedFormat:
          "Quatre cartes posées sur le bureau : examen, mémoire, projet créatif, travail. Chacun choisit la mission qui occupe son quotidien.",
        hook: "what are you working toward right now? 📚 exam · 📝 thesis · 🎨 project · 💼 work",
        novelty: "On remplace la matière scolaire par un objectif actuel, donc plus inclusif pour toute l’audience.",
        priority: 1,
      },
      {
        key: "desk-personality",
        title: "Quel type de bureau te ressemble vraiment ?",
        contentType: "Question visuelle",
        proposedFormat:
          "Le même bureau apparaît en quatre états : minimal, organisé, cosy et chaos total. La personne choisit celui qui lui ressemble aujourd’hui.",
        hook: "your desk personality today: ✨ clean · 📚 organised · ☕ cosy · 🌪️ chaos",
        novelty: "La caractéristique personnelle est révélée par un élément iconique de Lofi Girl plutôt que par un sondage abstrait.",
        priority: 0,
      },
    ],
  },
  {
    key: "consequential_participation",
    label: "Contribution avec conséquence visible",
    matcher: /\b(?:caption this|choosing my outfit|which country would you like to see next|studying essentials|1, 2, 3, 4 or 5|which costume is your favou?rite)\b/i,
    comparisonMatcher: /\bcaption this picture\b/i,
    priorityBoost: 3,
    whyItWorked:
      "La demande est très précise et la réponse peut réellement modifier le contenu suivant. Cette conséquence visible donne une raison de participer au-delà d’un simple appel aux commentaires.",
    borrowedMechanic:
      "Une contribution facile, une règle de sélection claire et une conséquence annoncée : réponse publiée, détail choisi ou création suivante influencée.",
    comparisonLesson:
      "Une simple demande de légende sans sélection ni suite visible a généré nettement moins de réponses.",
    recipes: [
      {
        key: "caption-becomes-canon",
        title: "La meilleure légende devient le titre officiel du lendemain",
        contentType: "Visuel statique",
        proposedFormat:
          "Publier une image muette et demander une légende. Le lendemain, la légende sélectionnée réapparaît intégrée au même visuel avec crédit.",
        hook: "caption this — our favourite becomes tomorrow’s official title ✍️",
        novelty: "La récompense n’est pas un produit : la contribution devient réellement une partie du contenu.",
        priority: 3,
      },
      {
        key: "choose-outfit-detail",
        title: "La communauté choisit un détail de la prochaine tenue",
        contentType: "Carrousel",
        proposedFormat:
          "Deux détails de tenue validés sont montrés côte à côte. Le choix majoritaire est utilisé dans une scène publiée ensuite.",
        hook: "pick one detail for the next scene: A or B?",
        novelty: "Le choix porte sur un détail réalisable et sa conséquence est montrée, sans promettre de modifier le lore.",
        priority: 2,
      },
      {
        key: "next-room-country",
        title: "Quel pays inspire la prochaine version du bureau ?",
        contentType: "Question visuelle",
        proposedFormat:
          "Montrer quatre objets culturels précis et demander quel pays doit inspirer une prochaine création humaine créditée.",
        hook: "which country should inspire the next Lofi room? 🌍",
        novelty: "La question historique devient un brief de création visible plutôt qu’une demande sans suite.",
        priority: 1,
      },
      {
        key: "community-essential",
        title: "L’objet d’étude manquant sera ajouté au bureau",
        contentType: "Visuel statique",
        proposedFormat:
          "Présenter les essentiels déjà sur le bureau et demander l’objet manquant. La réponse choisie apparaît réellement dans l’image suivante.",
        hook: "what study essential is missing? we’ll add one to the desk 👇",
        novelty: "La participation produit un changement concret et facilement vérifiable dans le décor iconique.",
        priority: 0,
      },
    ],
  },
  {
    key: "iconic_world_remix",
    label: "Univers iconique transformé",
    matcher: /\b(?:minecraft x lofi girl|digital repaint|enfant ecrivant|lofi girl is underwater|view into lofi girl.?s future|star wars edition|taiwanese lofi girl)\b/i,
    priorityBoost: 2,
    whyItWorked:
      "La composition reste immédiatement reconnaissable, puis une seule transformation visuelle forte renouvelle tout le tableau. Le public comprend simultanément la référence Lofi Girl et le nouvel univers.",
    borrowedMechanic:
      "Conserver la silhouette, le bureau ou le cadrage iconique ; remplacer un seul univers avec une création humaine originale et un artiste crédité.",
    recipes: [
      {
        key: "public-domain-painting",
        title: "Lofi Girl dans un tableau du domaine public",
        contentType: "Visuel statique",
        proposedFormat:
          "Recomposer le bureau et la posture dans l’esthétique d’un tableau du domaine public, tout en gardant les éléments iconiques immédiatement lisibles.",
        hook: "Lofi Girl, painted a century before the playlist existed 🎨",
        novelty: "La référence artistique change, mais la composition reconnaissable reste le point d’ancrage.",
        priority: 3,
      },
      {
        key: "pixel-study-room",
        title: "Le bureau Lofi Girl construit comme un niveau de jeu",
        contentType: "Carrousel",
        proposedFormat:
          "Une création humaine transforme la chambre en pixel art. Chaque slide zoome sur un détail fidèle : casque, chat, fenêtre puis bureau complet.",
        hook: "new study level unlocked 🎮",
        novelty: "On reprend la force du crossover Minecraft sans réutiliser sa licence ni son visuel.",
        priority: 2,
      },
      {
        key: "underwater-library",
        title: "La bibliothèque sous-marine de Lofi Girl",
        contentType: "Vidéo courte",
        proposedFormat:
          "Le bureau reste identique, mais l’extérieur devient sous-marin ; les pages flottent doucement et le chat suit un poisson derrière la fenêtre.",
        hook: "deep focus, literally 🌊📚",
        novelty: "L’univers aquatique est reconstruit autour d’une petite action du chat, pas seulement d’un changement de fond.",
        priority: 1,
      },
      {
        key: "lofi-girl-2050",
        title: "Le bureau de Lofi Girl en 2050",
        contentType: "Visuel statique",
        proposedFormat:
          "Imaginer humainement la même scène en 2050 : objets transformés, nouvelles lumières, mais posture, chat et fenêtre strictement reconnaissables.",
        hook: "same focus, different year — Lofi Girl in 2050",
        novelty: "Le futur n’est pas une nouvelle marque : c’est une variation visuelle précise du tableau iconique.",
        priority: 0,
      },
    ],
  },
  {
    key: "narrative_anomaly",
    label: "Anomalie qui ouvre une histoire",
    matcher: /\b(?:she knows something we don.t|lofi girl.?s neighbou?r|window.{0,35}(?:sus|blue)|something is happening with the blue window|be ready, i.?m coming)\b/i,
    comparisonMatcher: /\bdid you spot the new track\b/i,
    priorityBoost: 3,
    whyItWorked:
      "Le public voit un détail qui ne devrait pas être là et comprend qu’une vraie révélation suivra. Le suspense vient de l’image elle-même, pas d’une question artificielle ajoutée à une publication ordinaire.",
    borrowedMechanic:
      "Une anomalie visible, une phrase volontairement incomplète et une révélation réellement prévue dans le contenu suivant.",
    comparisonLesson:
      "Une question de type « as-tu repéré ? » fonctionne moins bien lorsqu’aucune anomalie narrative forte n’est perceptible.",
    recipes: [
      {
        key: "opposite-window-light",
        title: "Une lumière répond depuis la fenêtre d’en face",
        contentType: "Vidéo courte",
        proposedFormat:
          "Lofi Girl éteint sa lampe. Une lumière s’allume dans la fenêtre opposée avec exactement le même rythme, puis s’éteint avant qu’elle puisse répondre.",
        hook: "the window answered back. that wasn’t supposed to happen 👀",
        novelty: "La fenêtre devient un échange concret, avec une action et une conséquence plutôt qu’un simple détail suspect.",
        priority: 3,
      },
      {
        key: "moved-object",
        title: "Un objet change de place entre deux images",
        contentType: "Carrousel",
        proposedFormat:
          "Deux vues presque identiques de la chambre. Un seul objet officiel a bougé ; la dernière slide zoome sur l’anomalie sans encore l’expliquer.",
        hook: "something moved while she was studying. did you catch it?",
        novelty: "Le suspense repose sur une différence objectivement visible et vérifiable par le public.",
        priority: 2,
      },
      {
        key: "note-under-door",
        title: "Le mot glissé sous la porte",
        contentType: "Vidéo courte",
        proposedFormat:
          "Une note glisse sous la porte. Lofi Girl la lit, regarde la fenêtre d’en face, puis le plan coupe avant de montrer le message.",
        hook: "someone left a note. she knows who it is.",
        novelty: "On ouvre une interaction entre personnages avec un objet simple et une vraie suite narrative.",
        priority: 1,
      },
      {
        key: "hidden-date-room",
        title: "La date cachée dans le décor",
        contentType: "Visuel statique",
        proposedFormat:
          "Une date confirmée est répartie discrètement entre l’horloge, le calendrier et les pages. La légende affirme seulement qu’une information est déjà visible.",
        hook: "the date is already in the room 🕯",
        novelty: "Le teaser contient une réponse réelle à trouver, sans inventer une promesse ni masquer l’information dans du bruit.",
        priority: 0,
      },
    ],
  },
  {
    key: "immersive_activation",
    label: "À garder pour un lancement · ouvrir un nouveau monde",
    matcher: /\b(?:now on fortnite|introducing (?:a |our )?(?:brand )?new (?:24\/7|character)|brand new 24\/7 medieval|new realm of retro-futuristic|synthwave launch)\b/i,
    comparisonMatcher: /\bnew vinyl out now\b/i,
    priorityBoost: 3,
    whyItWorked:
      "Les activations fortes commencent par un personnage, un lieu ou une expérience à vivre. Le lien et le produit viennent ensuite ; le post reste intéressant même pour quelqu’un qui ne clique pas.",
    borrowedMechanic:
      "Ouvrir une porte vers un nouvel espace de l’univers Lofi Girl avant d’annoncer la date, le lien ou l’objet commercial.",
    comparisonLesson:
      "Les publications centrées directement sur le produit ont moins circulé que celles qui ouvraient d’abord un monde ou une expérience.",
    recipes: [
      {
        key: "enter-new-room",
        title: "La porte vers le prochain univers Lofi",
        contentType: "Vidéo courte",
        proposedFormat:
          "Lofi Girl ouvre une porte apparue dans sa chambre. On découvre seulement trois détails du nouvel univers avant la date et le lien en dernière seconde.",
        hook: "a new room just opened in the Lofi universe 🚪",
        novelty: "L’annonce commence par une exploration visuelle et garde l’information pratique pour la fin.",
        priority: 3,
      },
      {
        key: "new-character-pov",
        title: "La première minute vue par le nouveau personnage",
        contentType: "Vidéo courte",
        proposedFormat:
          "Présenter un nouveau personnage depuis son propre point de vue : ce qu’il voit, l’objet qu’il touche et la lumière qu’il allume avant de montrer son visage.",
        hook: "you’ve seen the room. now meet the person on the other side.",
        novelty: "Le personnage est introduit par une expérience vécue, pas par un paragraphe d’annonce.",
        priority: 2,
      },
      {
        key: "collaboration-experience",
        title: "La collaboration racontée comme une mission",
        contentType: "Carrousel",
        proposedFormat:
          "Quatre étapes montrent ce que le public peut découvrir, faire et débloquer dans la collaboration. Le logo et le lien n’apparaissent qu’à la dernière étape.",
        hook: "your next Lofi mission starts here 🗺️",
        novelty: "La valeur est formulée comme une expérience concrète plutôt que comme une annonce de partenariat.",
        priority: 1,
      },
      {
        key: "day-after-recap",
        title: "Le lendemain du lancement vu depuis la chambre",
        contentType: "Vidéo courte",
        proposedFormat:
          "Revenir dans la chambre après le lancement : objets déplacés, messages reçus, personnage fatigué mais heureux. Trois réactions réelles de la communauté apparaissent dans le décor.",
        hook: "the quiet morning after a very loud launch 🧡",
        novelty: "Le récapitulatif devient une micro-histoire humaine au lieu d’une liste de résultats.",
        priority: 0,
      },
    ],
  },
  {
    key: "friendly_care",
    label: "Message de care sans vente",
    matcher: /\b(?:stay hydrated|hug your cat day|study girl is in quarantine|this is your sign to take a break|this is your sign to drink some water|today is going to be a good day)\b/i,
    comparisonMatcher: /\b(?:travel mug|mug).{0,80}hydrat/i,
    priorityBoost: 2,
    whyItWorked:
      "Le message parle comme un ami présent au bon moment. Il demande une action simple, n’enseigne rien et ne vend rien ; la relation avec Lofi Girl suffit.",
    borrowedMechanic:
      "Un rappel concret lié au moment de la journée, formulé avec chaleur et sans aucun produit ni appel commercial.",
    comparisonLesson:
      "Le même sujet lié à un produit a moins fonctionné que le rappel gratuit et désintéressé.",
    recipes: [
      {
        key: "water-before-next-task",
        title: "Le verre d’eau avant la prochaine tâche",
        contentType: "Visuel statique",
        proposedFormat:
          "Lofi Girl pousse doucement sa to-do list sur le côté et tend un verre d’eau vers la caméra. Aucun produit, aucun lien, une seule phrase.",
        hook: "before the next task: one sip of water 💧",
        novelty: "Le rappel est relié à un geste précis du personnage plutôt qu’à une formule générique.",
        priority: 3,
      },
      {
        key: "permission-to-stop",
        title: "La permission de s’arrêter pour aujourd’hui",
        contentType: "Visuel statique",
        proposedFormat:
          "Lofi Girl ferme son carnet alors qu’il reste des tâches. La lampe passe en mode nuit et le texte valide explicitement le droit de reprendre demain.",
        hook: "you’re allowed to stop for today. tomorrow still exists 🧡",
        novelty: "Le care ne promet pas de productivité ; il donne une permission rarement exprimée.",
        priority: 2,
      },
      {
        key: "proud-of-showing-up",
        title: "Fière de toi juste parce que tu es venu",
        contentType: "Texte court",
        proposedFormat:
          "Une phrase unique sur un fond officiel très calme. Aucun conseil, seulement la reconnaissance d’avoir essayé aujourd’hui.",
        hook: "you showed up today. i’m proud of you.",
        novelty: "On remplace l’injonction à réussir par une reconnaissance minimale et crédible.",
        priority: 1,
      },
      {
        key: "night-check-in",
        title: "Le check-in de fin de soirée",
        contentType: "Visuel statique",
        proposedFormat:
          "Lofi Girl éteint sa lampe et demande simplement à la personne de relâcher ses épaules avant de quitter l’écran.",
        hook: "night check-in: unclench your jaw, drop your shoulders, breathe 🌙",
        novelty: "Le message vise un instant physique très précis plutôt qu’un encouragement abstrait.",
        priority: 0,
      },
    ],
  },
  {
    key: "cat_conflict",
    label: "Le chat comme obstacle comique",
    matcher: /\b(?:push the cat|finally concentrated.{0,80}(?:cat|pet)|cat.{0,40}(?:keyboard|homework|study)|lofi cat is living his best life|cat by the window)\b/i,
    comparisonMatcher: /\bdo your pets listen to the livestream\b/i,
    priorityBoost: 2,
    whyItWorked:
      "Le chat a son propre objectif, opposé à celui de Lofi Girl. Le conflit est compris dès le premier plan et se termine par une réaction, ce qui fonctionne mieux qu’une simple image mignonne.",
    borrowedMechanic:
      "Donner au chat une action très claire qui empêche Lofi Girl d’étudier, puis laisser le personnage choisir entre résister et céder.",
    comparisonLesson:
      "Les publications où le chat est seulement mignon ont moins circulé que celles où il provoque réellement l’histoire.",
    recipes: [
      {
        key: "cat-steals-chair",
        title: "Le chat prend la chaise pendant la pause",
        contentType: "Vidéo courte",
        proposedFormat:
          "Lofi Girl se lève cinq secondes. Le chat prend toute la chaise ; elle revient, hésite, puis s’assoit par terre pour continuer à travailler.",
        hook: "left the chair for five seconds. rookie mistake 🐈",
        novelty: "Le conflit porte sur un objet central du décor et se résout par la capitulation de Lofi Girl.",
        priority: 4,
      },
      {
        key: "cat-closes-notebook",
        title: "Le chat décide que la session est terminée",
        contentType: "Vidéo courte",
        proposedFormat:
          "À chaque fois que Lofi Girl ouvre son carnet, le chat le referme avec une patte. Au troisième essai, elle accepte enfin la pause.",
        hook: "my study supervisor says we’re done for today",
        novelty: "La répétition transforme le chat en autorité comique, pas seulement en distraction.",
        priority: 3,
      },
      {
        key: "cat-steals-pen",
        title: "Le stylo disparaît à chaque ligne",
        contentType: "Vidéo courte",
        proposedFormat:
          "Lofi Girl écrit une ligne, cherche son stylo, en prend un autre. Le dernier plan révèle le chat entouré de tous les stylos volés.",
        hook: "the pen thief has been identified 🐾",
        novelty: "La révélation finale donne au chat un plan et recontextualise toute la boucle.",
        priority: 2,
      },
      {
        key: "cat-sends-message",
        title: "Le chat envoie le devoir inachevé",
        contentType: "Vidéo courte",
        proposedFormat:
          "Le chat marche sur le clavier et déclenche « Envoyer ». Lofi Girl et le chat regardent l’écran, puis se regardent en silence.",
        hook: "the cat submitted it. it was not ready.",
        novelty: "L’obstacle a une conséquence irréversible et immédiatement relatable pour le travail numérique.",
        priority: 1,
      },
      {
        key: "cat-blocks-alarm",
        title: "Le chat annule le réveil d’étude",
        contentType: "Vidéo courte",
        proposedFormat:
          "Le réveil sonne. Le chat pose une patte dessus avant Lofi Girl ; tous les deux se rendorment avec un synchronisme parfait.",
        hook: "we had a study plan. the cat vetoed it.",
        novelty: "Le chat n’interrompt pas le travail : il empêche même la session de commencer.",
        priority: 0,
      },
    ],
  },
];

const RECIPE_EVIDENCE_MATCHERS: Readonly<Record<string, RegExp>> = {
  "cultural_meme_reframe:final-study-form": /\bthis\s+is\s+not\s+even\s+my\s+final\s+form\b/i,
  "cultural_meme_reframe:deadline-canon-event": /\bcanon\s+event\b/i,
  "cultural_meme_reframe:chill-during-chaos": /\bchill\s+(?:guy|girl)\b/i,
  "cultural_meme_reframe:coffee-glitch": /\bglitch\s+in\s+the\s+matrix\b/i,
  "cultural_meme_reframe:head-empty-cat": /\bhead\s+empty\b/i,
  "routine_interruption:cat-reveals-grade": /\b(?:lofi girl )?gets? her test score(?: back)?\b/i,
  "routine_interruption:camera-caught-break": /\bbeing recorded\b/i,
  "routine_interruption:page-number-backwards": /\binfinite (?:number of )?pages\b/i,
  "routine_interruption:notes-collapse": /\btoo much stress\b/i,
  "routine_interruption:room-reacts-to-break": /\b(?:studying 24\/7|finally stops? studying)\b/i,
  "audience_inner_voice:five-minute-nap": /\bquick nap if that.?s okay\b/i,
  "audience_inner_voice:exam-mantra-screen": /\bi will pass my exams\b/i,
  "audience_inner_voice:opened-document": /\blike this post if you.?re procrastinating\b/i,
  "audience_inner_voice:study-era-one-minute": /\bin my study era\b/i,
  "audience_inner_voice:cat-homework-alibi": /\bmy cat ate my homework\b/i,
  "instant_identity_question:focus-hour": /\b(?:most productive|how many hours do you study)\b/i,
  "instant_identity_question:sleep-schedule": /\bwhat time do you usually go to bed\b/i,
  "instant_identity_question:language-desk": /\bhow many languages can you speak\b/i,
  "instant_identity_question:current-mission": /\bfavou?rite school subject\b/i,
  "instant_identity_question:desk-personality": /\b(?:right-handed or left-handed|which sibling are you)\b/i,
  "consequential_participation:caption-becomes-canon": /\bcaption this\b/i,
  "consequential_participation:choose-outfit-detail": /\b(?:choosing my outfit|which costume is your favou?rite)\b/i,
  "consequential_participation:next-room-country": /\bwhich country would you like to see next\b/i,
  "consequential_participation:community-essential": /\bstudying essentials\b/i,
  "iconic_world_remix:public-domain-painting": /\b(?:digital repaint|enfant ecrivant)\b/i,
  "iconic_world_remix:pixel-study-room": /\bminecraft x lofi girl\b/i,
  "iconic_world_remix:underwater-library": /\blofi girl is underwater\b/i,
  "iconic_world_remix:lofi-girl-2050": /\bview into lofi girl.?s future\b/i,
  "narrative_anomaly:opposite-window-light": /\b(?:blue window|window.{0,35}(?:sus|blue))\b/i,
  "narrative_anomaly:moved-object": /\bshe knows something we don.t\b/i,
  "narrative_anomaly:note-under-door": /\blofi girl.?s neighbou?r\b/i,
  "narrative_anomaly:hidden-date-room": /\b(?:she knows something we don.t|be ready, i.?m coming)\b/i,
  "immersive_activation:enter-new-room": /\b(?:new realm of retro-futuristic|brand new 24\/7 medieval|synthwave launch)\b/i,
  "immersive_activation:new-character-pov": /\bintroducing (?:a |our )?(?:brand )?new (?:24\/7|character)\b/i,
  "immersive_activation:collaboration-experience": /\bnow on fortnite\b/i,
  "immersive_activation:day-after-recap": /\b(?:now on fortnite|new realm of retro-futuristic)\b/i,
  "friendly_care:water-before-next-task": /\b(?:stay hydrated|sign to drink some water)\b/i,
  "friendly_care:permission-to-stop": /\bthis is your sign to take a break\b/i,
  "friendly_care:proud-of-showing-up": /\btoday is going to be a good day\b/i,
  "friendly_care:night-check-in": /\b(?:study girl is in quarantine|hug your cat day)\b/i,
  "cat_conflict:cat-steals-chair": /\bpush the cat\b/i,
  "cat_conflict:cat-closes-notebook": /\bfinally concentrated.{0,80}(?:cat|pet)\b/i,
  "cat_conflict:cat-steals-pen": /\bcat.{0,40}(?:keyboard|homework|study)\b/i,
  "cat_conflict:cat-sends-message": /\bcat.{0,40}(?:keyboard|homework)\b/i,
  "cat_conflict:cat-blocks-alarm": /\blofi cat is living his best life\b/i,
};

export function generateSocialIdeas(
  posts: readonly NormalizedPost[],
  options: GenerateSocialIdeasOptions = {},
): SocialIdeaPlan {
  const referenceTime = ideaReferenceTime(posts, options.now);
  const winnersPerCohort = boundedInteger(options.winnersPerPlatform, 3, 1, 10);
  const maxIdeas = boundedInteger(options.maxIdeas, 4, 1, 50);
  const performancePosts = posts.filter((post) => !isCommentSeed(post));
  const ranked = rankPosts(performancePosts, referenceTime);
  const selection = selectPublicWinners(ranked, winnersPerCohort);
  const candidates = buildCandidates(selection);
  const seedKeys = uniqueStrings(
    candidates.flatMap((candidate) =>
      candidate.posts.map((post) => editorialPostKey(post)),
    ),
  );
  const editorialAnalyses = buildEditorialAnalysisMapForTargets(ranked, seedKeys);
  const evidenceUseCounts = new Map<string, number>();
  const ideas = candidates
    .map((candidate) => {
      const materialized = materializeIdea(candidate, editorialAnalyses);
      const evidenceSignature = candidate.posts
        .map((post) => `${post.platform}:${post.externalId}`)
        .sort()
        .join("|");
      const priorVariations = evidenceUseCounts.get(evidenceSignature) ?? 0;
      evidenceUseCounts.set(evidenceSignature, priorVariations + 1);
      const contextPenalty = candidate.family.key === "immersive_activation" ? 6 : 0;
      const rawPotentialScore = Math.max(
        1,
        materialized.rawPotentialScore - priorVariations * 5 - contextPenalty,
      );
      return {
        candidate,
        rawPotentialScore,
        idea: {
          ...materialized.idea,
          potentialScore: Math.round(rawPotentialScore),
        },
      };
    })
    .sort(
      (left, right) =>
        right.rawPotentialScore - left.rawPotentialScore ||
        right.idea.confidenceScore - left.idea.confidenceScore ||
        right.candidate.recipe.priority - left.candidate.recipe.priority ||
        left.idea.id.localeCompare(right.idea.id),
    )
    .slice(0, maxIdeas)
    .map(({ idea }, index) => ({ ...idea, platformRank: index + 1 }));

  return {
    generatedAt: referenceTime.toISOString(),
    eligiblePostCount: selection.eligible.length,
    winnerCount: selection.winners.length,
    ideas,
    caveats: [
      "Chaque recommandation affichée possède au moins un précédent direct dans l’historique performant ; aucun test exploratoire n’est mélangé au classement.",
      "Les métriques sont lues dans leur propre combinaison réseau-format et ne sont jamais additionnées ou comparées brutes entre réseaux.",
      "Aucun visuel ni aucune musique générés par IA : utiliser uniquement les assets officiels Lofi Girl, les morceaux existants et les créations humaines validées par l’équipe.",
    ],
  };
}

export const generateEditorialIdeas = generateSocialIdeas;

function selectPublicWinners(
  posts: readonly RankedPost[],
  winnersPerCohort: number,
): PublicWinnerSelection {
  const cohorts = groupBy(posts, publicCohortKey);
  const eligible: IdeaRankedPost[] = [];
  const winners: IdeaRankedPost[] = [];

  for (const cohortKey of [...cohorts.keys()].sort()) {
    const cohort = cohorts.get(cohortKey) ?? [];
    const ranking = rankPostsByPublicMetric(
      cohort.map((post) => ({
        post,
        external_post_id: post.externalId,
        format: post.format ?? "unknown",
        likes: publicMetric(post.likes),
        views: publicMetric(post.views),
        comments: publicMetric(post.comments),
        shares: publicMetric(post.shares),
        saves: publicMetric(post.saves),
        poll_votes: pollVotes(post),
      })),
    );
    if (ranking.metric === null) continue;

    const rankable = ranking.posts.filter(
      (entry) => entry[ranking.metric!] !== null,
    );
    const cohortPosts = rankable.map(
      (entry, index): IdeaRankedPost => ({
        ...entry.post,
        publicCohortKey: cohortKey,
        publicCohortRank: index + 1,
        publicCohortSize: rankable.length,
        publicRankingMetric: ranking.metric!,
      }),
    );
    eligible.push(...cohortPosts);
    winners.push(...cohortPosts.slice(0, winnersPerCohort));
  }

  return {
    eligible: eligible.sort(compareFamilyEvidence),
    winners: winners.sort(compareFamilyEvidence),
  };
}

function buildCandidates(selection: PublicWinnerSelection): Candidate[] {
  const candidates: Candidate[] = [];
  for (const family of PROVEN_FAMILIES) {
    const familyMatches = selection.eligible.filter((post) => matches(post, family.matcher));
    if (familyMatches.length === 0) continue;
    const winningFamilyMatches = selection.winners.filter((post) => matches(post, family.matcher));
    const comparisonPost = family.comparisonMatcher
      ? selection.eligible
          .filter((post) => matches(post, family.comparisonMatcher!))
          .sort(compareFamilyEvidence)[0] ?? null
      : null;
    for (const recipe of family.recipes) {
      const recipeMatcher = RECIPE_EVIDENCE_MATCHERS[`${family.key}:${recipe.key}`];
      const exactMatches = recipeMatcher
        ? selection.eligible.filter((post) => matches(post, recipeMatcher))
        : familyMatches;
      const evidencePool = exactMatches.length > 0
        ? exactMatches
        : winningFamilyMatches.length > 0
          ? winningFamilyMatches
          : familyMatches;
      const posts = selectFamilySeeds(evidencePool, 5);
      const repeatedCreative = hasCrossNetworkCreative(posts);
      const primaryPlatform = primaryPlatformFor(posts);
      candidates.push({
        key: `proven-v2:${family.key}:${recipe.key}`,
        family,
        recipe,
        posts,
        comparisonPost,
        repeatedCreative,
        primaryPlatform,
        exactRecipeEvidence: exactMatches.length > 0,
      });
    }
  }
  return candidates;
}

function materializeIdea(
  candidate: Candidate,
  analyses: ReadonlyMap<string, EditorialWhy>,
): { idea: SocialIdea; rawPotentialScore: number } {
  const seeds = candidate.posts;
  const seedAnalyses = seeds
    .map((post) => analyses.get(editorialPostKey(post)))
    .filter((analysis): analysis is EditorialWhy => analysis !== undefined);
  const confidenceScore = ideaConfidenceScore(
    seeds,
    seedAnalyses,
    candidate.repeatedCreative,
  );
  const rawPotentialScore = ideaPotentialScore(
    seeds,
    seedAnalyses,
    candidate.recipe.priority,
    candidate.exactRecipeEvidence,
  );
  const seedPosts = seeds.map(toIdeaSeed);
  const comparisonPost = candidate.comparisonPost
    ? toIdeaSeed(candidate.comparisonPost)
    : null;
  const comparisonInsight = comparisonPost && candidate.family.comparisonLesson
    ? `${candidate.family.comparisonLesson} Comparateur : « ${comparisonPost.label} » (${seedMetricLabel(comparisonPost)}).`
    : null;

  const idea: SocialIdea = {
    id: `idea-proven-v2-${stableHash(candidate.key)}`,
    title: candidate.recipe.title,
    pattern: candidate.family.key,
    patternLabel: candidate.family.label,
    primaryPlatform: candidate.primaryPlatform,
    platformRank: 1,
    potentialScore: Math.round(rawPotentialScore),
    contentType: candidate.recipe.contentType,
    seedPosts,
    comparisonPost,
    comparisonInsight,
    observedSignal: {
      summary: proofSummary(candidate.family, seedPosts),
      evidence: seedPosts.map(
        (seed) =>
          `${seed.label} · ${seedMetricLabel(seed)} · n°${seed.cohortRank}/${seed.cohortSize} de son format · ${seed.url}`,
      ),
    },
    proposedFormat: candidate.recipe.proposedFormat,
    hook: candidate.recipe.hook,
    whyItWorked: candidate.family.whyItWorked,
    borrowedMechanic: candidate.family.borrowedMechanic,
    novelty: candidate.recipe.novelty,
    proofLabel: proofLabel(seedPosts, candidate.repeatedCreative),
    confidence: confidenceLevel(confidenceScore),
    confidenceScore,
    confidenceRationale: confidenceRationale(seedPosts, candidate.repeatedCreative),
    limits: buildLimits(seedPosts),
    assetPolicy: "official-assets-only",
  };

  return { idea, rawPotentialScore };
}

function toIdeaSeed(post: IdeaRankedPost): SocialIdeaSeed {
  return {
    platform: post.platform,
    externalId: post.externalId,
    url: post.url,
    label: postLabel(post, 150),
    format: post.format,
    thumbnailUrl: post.thumbnailUrl,
    publishedAt: post.publishedAt,
    views: publicMetric(post.views),
    likes: publicMetric(post.likes),
    comments: publicMetric(post.comments),
    performanceScore: post.performanceScore ?? 0,
    scoreConfidence: post.confidence,
    platformRank: post.platformRank,
    cohortRank: post.publicCohortRank,
    cohortSize: post.publicCohortSize,
    rankingMetric: post.publicRankingMetric,
    rankingValue: publicRankingValue(post),
  };
}

function proofSummary(
  family: ProvenFamily,
  seeds: readonly SocialIdeaSeed[],
): string {
  const evidence = socialSeedEvidenceStats(seeds);
  const examples = seeds
    .slice(0, 3)
    .map((seed) => `« ${seed.label} » (${seedMetricLabel(seed)})`);
  const repetition = evidence.uniqueCreativeCount === 1 && evidence.maxPlatformsForCreative > 1
    ? `Une création directe, reproduite dans ${evidence.maxPlatformsForCreative} historiques et classée dans le top 3 de ${evidence.topThreeInstanceCount} format${evidence.topThreeInstanceCount > 1 ? "s" : ""}.`
    : `${evidence.uniqueCreativeCount} créations directes, dont ${evidence.topThreeCreativeCount} dans le top 3 de leur format.`;
  return `${repetition} ${family.whyItWorked} Preuves : ${joinFrench(examples)}.`;
}

function proofLabel(
  seeds: readonly SocialIdeaSeed[],
  repeatedCreative: boolean,
): string {
  const evidence = socialSeedEvidenceStats(seeds);
  const strength = repeatedCreative && evidence.maxPlatformsForCreative >= 3 && evidence.topThreeInstanceCount >= 1
    ? "Preuve très forte"
    : evidence.topThreeCreativeCount >= 2
      ? "Preuve forte"
      : evidence.topThreeCreativeCount >= 1
        ? "Preuve solide"
        : "Preuve directe";
  const detail = evidence.uniqueCreativeCount === 1 && evidence.maxPlatformsForCreative > 1
    ? `1 création · ${evidence.maxPlatformsForCreative} historiques · ${evidence.topThreeInstanceCount} top 3`
    : `${evidence.uniqueCreativeCount} créations · ${evidence.topThreeCreativeCount} top 3`;
  return `${strength} · ${detail}`;
}

function confidenceRationale(
  seeds: readonly SocialIdeaSeed[],
  repeatedCreative: boolean,
): string {
  const evidence = socialSeedEvidenceStats(seeds);
  const repetition = repeatedCreative
    ? `La même création a répété sa performance dans ${evidence.maxPlatformsForCreative} historiques.`
    : `${evidence.uniqueCreativeCount} créations distinctes utilisent ce mécanisme.`;
  return `${evidence.uniqueCreativeCount} création${evidence.uniqueCreativeCount > 1 ? "s" : ""} directe${evidence.uniqueCreativeCount > 1 ? "s" : ""}, ${evidence.topThreeCreativeCount} classée${evidence.topThreeCreativeCount > 1 ? "s" : ""} dans le top 3. ${repetition} Cela priorise un test ; cela ne garantit pas son résultat.`;
}

function socialSeedEvidenceStats(seeds: readonly SocialIdeaSeed[]) {
  const groups = new Map<string, SocialIdeaSeed[]>();
  for (const seed of seeds) {
    const key = normalizeCreativeText(seed.label) || `${seed.platform}:${seed.externalId}`;
    const group = groups.get(key) ?? [];
    group.push(seed);
    groups.set(key, group);
  }
  const groupedSeeds = [...groups.values()];
  return {
    uniqueCreativeCount: Math.max(1, groupedSeeds.length),
    topThreeCreativeCount: groupedSeeds.filter((group) =>
      group.some((seed) => seed.cohortRank <= 3),
    ).length,
    topThreeInstanceCount: seeds.filter((seed) => seed.cohortRank <= 3).length,
    maxPlatformsForCreative: Math.max(
      1,
      ...groupedSeeds.map(
        (group) => new Set(group.map((seed) => seed.platform)).size,
      ),
    ),
  };
}

function buildLimits(seeds: readonly SocialIdeaSeed[]): string[] {
  const limits = [
    "Les performances observées montrent une corrélation éditoriale ; elles ne garantissent pas le résultat de la nouvelle variation.",
    "Aucun visuel ni aucune musique générés par IA : utiliser exclusivement les assets officiels Lofi Girl, les morceaux existants et les créations humaines validées par l’équipe.",
  ];
  if (new Set(seeds.map((seed) => seed.platform)).size === 1) {
    limits.push(
      "Le précédent direct est concentré dans un seul historique ; la publication commune reste un test à mesurer.",
    );
  }
  return limits;
}

function selectFamilySeeds(
  matches: readonly IdeaRankedPost[],
  limit: number,
): IdeaRankedPost[] {
  const sorted = [...matches].sort(compareFamilyEvidence);
  const groups = new Map<string, IdeaRankedPost[]>();
  for (const post of sorted) {
    const key = creativeKey(post) || `${post.platform}:${post.externalId}`;
    const group = groups.get(key) ?? [];
    group.push(post);
    groups.set(key, group);
  }
  const selectedGroups = [...groups.values()]
    .map((group) => group.sort(compareFamilyEvidence))
    .sort((left, right) => compareFamilyEvidence(left[0]!, right[0]!))
    .slice(0, 3);
  const selected = selectedGroups.map((group) => group[0]!);
  const remaining = selectedGroups
    .flatMap((group) => group.slice(1))
    .sort(compareFamilyEvidence);

  for (const post of remaining) {
    if (selected.length >= limit) break;
    selected.push(post);
  }
  return selected.sort(compareFamilyEvidence).slice(0, limit);
}

function compareFamilyEvidence(
  left: IdeaRankedPost,
  right: IdeaRankedPost,
): number {
  const leftRatio = left.publicCohortRank / Math.max(1, left.publicCohortSize);
  const rightRatio = right.publicCohortRank / Math.max(1, right.publicCohortSize);
  if (leftRatio !== rightRatio) return leftRatio - rightRatio;
  if (left.publicCohortRank !== right.publicCohortRank) {
    return left.publicCohortRank - right.publicCohortRank;
  }
  const scoreDifference =
    (right.performanceScore ?? 0) - (left.performanceScore ?? 0);
  if (scoreDifference !== 0) return scoreDifference;
  const platformDifference =
    PLATFORM_ORDER.indexOf(left.platform) - PLATFORM_ORDER.indexOf(right.platform);
  if (platformDifference !== 0) return platformDifference;
  return left.externalId.localeCompare(right.externalId);
}

function hasCrossNetworkCreative(posts: readonly IdeaRankedPost[]): boolean {
  const platformsByCreative = new Map<string, Set<SocialPlatform>>();
  for (const post of posts) {
    const key = creativeKey(post);
    if (!key) continue;
    const platforms = platformsByCreative.get(key) ?? new Set<SocialPlatform>();
    platforms.add(post.platform);
    platformsByCreative.set(key, platforms);
  }
  return [...platformsByCreative.values()].some((platforms) => platforms.size >= 2);
}

function creativeKey(post: Pick<RankedPost, "title" | "text">): string {
  return normalizeCreativeText(post.text?.trim() || post.title?.trim() || "");
}

function normalizeCreativeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/@[\w.]+/g, "")
    .replace(/#[\w-]+/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join(" ");
}

function matches(post: RankedPost, matcher: RegExp): boolean {
  return matcher.test(`${post.title ?? ""} ${post.text ?? ""}`);
}

function primaryPlatformFor(posts: readonly IdeaRankedPost[]): SocialPlatform {
  return [...posts].sort(compareFamilyEvidence)[0]?.platform ?? "youtube";
}

function ideaConfidenceScore(
  seeds: readonly IdeaRankedPost[],
  analyses: readonly EditorialWhy[],
  repeatedCreative: boolean,
): number {
  const evidence = creativeEvidenceStats(seeds);
  const evidenceQuality = average(analyses.map(editorialConfidenceWeight));
  const comparisonQuality = average(analyses.map(editorialStatusWeight));
  const score =
    12 +
    evidence.bestPercentile * 18 +
    evidence.meanInstancePercentile * 14 +
    (Math.min(evidence.uniqueCreativeCount, 3) / 3) * 6 +
    (Math.min(evidence.maxPlatformsForCreative, 4) / 4) * 14 +
    (Math.min(evidence.topThreeInstanceCount, 4) / 4) * 12 +
    evidenceQuality * 8 +
    comparisonQuality * 6 +
    (repeatedCreative ? 4 : 0);
  return clamp(Math.round(score), 1, 95);
}

function ideaPotentialScore(
  seeds: readonly IdeaRankedPost[],
  analyses: readonly EditorialWhy[],
  recipePriority: number,
  exactRecipeEvidence: boolean,
): number {
  const evidence = creativeEvidenceStats(seeds);
  const analysisConfidence = average(analyses.map(editorialConfidenceWeight));
  const exactSeedRatio = exactRecipeEvidence ? 1 : 0.45;
  const normalizedPriority = clamp((recipePriority + 1) / 5, 0, 1);
  return (
    28 +
    20 * evidence.bestPercentile +
    8 * evidence.meanTopThreePercentile +
    10 * evidence.meanInstancePercentile +
    4 * (Math.min(evidence.uniqueCreativeCount, 3) / 3) +
    8 * (Math.min(evidence.maxPlatformsForCreative, 4) / 4) +
    8 * (Math.min(evidence.topThreeInstanceCount, 4) / 4) +
    6 * exactSeedRatio +
    4 * analysisConfidence +
    2 * normalizedPriority
  );
}

function creativeEvidenceStats(posts: readonly IdeaRankedPost[]) {
  const groups = new Map<string, IdeaRankedPost[]>();
  for (const post of posts) {
    const key = creativeKey(post) || `${post.platform}:${post.externalId}`;
    const group = groups.get(key) ?? [];
    group.push(post);
    groups.set(key, group);
  }
  const creativePercentiles = [...groups.values()]
    .map((group) => Math.max(...group.map(publicRankPercentile)))
    .sort((left, right) => right - left);
  const instancePercentiles = posts.map(publicRankPercentile);
  const maxPlatformsForCreative = Math.max(
    1,
    ...[...groups.values()].map(
      (group) => new Set(group.map((post) => post.platform)).size,
    ),
  );
  return {
    uniqueCreativeCount: Math.max(1, groups.size),
    maxPlatformsForCreative,
    topThreeInstanceCount: posts.filter((post) => post.publicCohortRank <= 3).length,
    bestPercentile: creativePercentiles[0] ?? 0,
    meanTopThreePercentile: average(creativePercentiles.slice(0, 3)),
    meanInstancePercentile: average(instancePercentiles),
  };
}

function publicRankPercentile(post: IdeaRankedPost): number {
  return clamp(
    1 -
      (post.publicCohortRank - 1) /
        Math.max(1, post.publicCohortSize - 1),
    0,
    1,
  );
}

function confidenceLevel(score: number): IdeaConfidence {
  if (score >= 75) return "high";
  if (score >= 50) return "medium";
  return "low";
}

function editorialConfidenceWeight(analysis: EditorialWhy): number {
  return analysis.confidence === "medium" ? 0.8 : 0.4;
}

function editorialStatusWeight(analysis: EditorialWhy): number {
  if (analysis.status === "comparative") return 1;
  if (analysis.status === "content-only") return 0.65;
  return 0.35;
}

function publicCohortKey(post: Pick<RankedPost, "platform" | "format">): string {
  return `${post.platform}:${canonicalFormat(post.format)}`;
}

function canonicalFormat(value: string | null): string {
  return value?.trim().toLowerCase().replace(/[\s-]+/g, "_") || "unknown";
}

function isCommentSeed(post: Pick<NormalizedPost, "format">): boolean {
  const format = canonicalFormat(post.format);
  return /(?:^|_)(?:comment|comments|reply|replies)(?:_|$)/.test(format);
}

function publicMetric(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function pollVotes(post: RankedPost): number | null {
  const raw = post.raw;
  if (!raw) return null;
  const value =
    typeof raw.pollVotes === "number"
      ? raw.pollVotes
      : typeof raw.pollTotalVotes === "number"
        ? raw.pollTotalVotes
        : null;
  return publicMetric(value);
}

function publicRankingValue(post: IdeaRankedPost): number {
  if (post.publicRankingMetric === "poll_votes") return pollVotes(post) ?? 0;
  if (post.publicRankingMetric === "likes") return publicMetric(post.likes) ?? 0;
  if (post.publicRankingMetric === "views") return publicMetric(post.views) ?? 0;
  if (post.publicRankingMetric === "comments") return publicMetric(post.comments) ?? 0;
  if (post.publicRankingMetric === "shares") return publicMetric(post.shares) ?? 0;
  return publicMetric(post.saves) ?? 0;
}

function seedMetricLabel(
  seed: Pick<SocialIdeaSeed, "views" | "likes" | "comments">,
): string {
  const values = [
    seed.views !== null ? `▶ ${compactNumber(seed.views)} vues` : null,
    seed.likes !== null ? `♥ ${compactNumber(seed.likes)} likes` : null,
    seed.comments !== null ? `💬 ${compactNumber(seed.comments)}` : null,
  ].filter((value): value is string => Boolean(value));
  return values.slice(0, 3).join(" · ") || "métrique publique disponible";
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("fr-FR", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1_000_000 ? 1 : 0,
  }).format(value);
}

function postLabel(post: RankedPost, maxLength: number): string {
  const value = post.title?.trim() || post.text?.trim() || post.externalId;
  return value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function joinFrench(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} et ${values.at(-1)}`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function groupBy<T, K>(
  values: readonly T[],
  keyFor: (value: T) => K,
): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const current = groups.get(key);
    if (current) current.push(value);
    else groups.set(key, [value]);
  }
  return groups;
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return clamp(Math.trunc(value as number), minimum, maximum);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function ideaReferenceTime(
  posts: readonly NormalizedPost[],
  value: Date | string | number | undefined,
): Date {
  if (value !== undefined) {
    const explicit = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isFinite(explicit.getTime())) return explicit;
  }
  const latestPublication = posts.reduce((latest, post) => {
    const timestamp = post.publishedAt ? Date.parse(post.publishedAt) : Number.NaN;
    return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
  }, 0);
  return new Date(latestPublication > 0 ? latestPublication + 86_400_000 : 0);
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}
