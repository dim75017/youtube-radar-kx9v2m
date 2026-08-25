import { rankPostsByPublicMetric } from "./social-ranking.ts";
import type { NormalizedPost } from "./social-scanner.ts";

export type EditorialAnalysisStatus =
  | "comparative"
  | "content-only"
  | "no-differentiator";

export type EditorialEvidence = {
  postId: string;
  field: "title" | "text" | "format" | "durationSeconds" | "pollChoices";
  excerpt: string;
};

export type EditorialMechanism = {
  label: string;
  observation: string;
  evidence: EditorialEvidence[];
};

export type EditorialWhy = {
  status: EditorialAnalysisStatus;
  scope: "copy-and-format";
  primarySignal: EditorialSignalKey | "insufficient";
  headline: string;
  mechanism: string;
  comparison: string;
  transferableLesson: string;
  mechanisms: EditorialMechanism[];
  comparatorPostIds: string[];
  limitations: string[];
  confidence: "medium" | "low";
  version: "editorial-v1";
};

export type EditorialAnalysisPost = Pick<
  NormalizedPost,
  | "platform"
  | "externalId"
  | "title"
  | "text"
  | "format"
  | "publishedAt"
  | "views"
  | "likes"
  | "comments"
  | "shares"
  | "saves"
  | "raw"
>;

export type EditorialSignalKey =
  | "absurd_poll"
  | "co_creation"
  | "identity_choice"
  | "micro_progress"
  | "student_meme"
  | "collective_ritual"
  | "immersive_activation"
  | "fourth_wall"
  | "ironic_collective"
  | "narrative_open_loop"
  | "cultural_bridge"
  | "care_ritual"
  | "relatable_humour"
  | "commercial_copy"
  | "compressed_hook";

type RawSignal =
  | "academic"
  | "achievement"
  | "brand_world"
  | "care"
  | "character_event"
  | "collective"
  | "commercial"
  | "cultural"
  | "direct_address"
  | "everyday"
  | "identity"
  | "immersive"
  | "meme_language"
  | "micro_progress"
  | "open_loop"
  | "participation"
  | "seasonal"
  | "self_deprecating"
  | "short_copy"
  | "twist";

type PreparedPost = {
  post: EditorialAnalysisPost;
  key: string;
  copy: string;
  normalized: string;
  wordCount: number;
  signals: Set<RawSignal>;
  primarySignal: EditorialSignalKey | "insufficient";
};

type PreparedCohortContext = {
  size: number;
  orderedIndex: ReadonlyMap<PreparedPost, number>;
  signalCounts: ReadonlyMap<PreparedPost["primarySignal"], number>;
  comparators: ReadonlyMap<PreparedPost, PreparedPost>;
};

type ComparatorCandidate = {
  item: PreparedPost;
  orderedIndex: number;
  publishedAt: number | null;
  territoryMask: number;
};

type ComparatorChoice = {
  candidate: PreparedPost;
  score: number;
};

type ComparatorTarget = {
  item: PreparedPost;
  orderedIndex: number;
  publishedAt: number | null;
  upperHalf: boolean;
  best: ComparatorChoice | null;
};

type SignalTemplate = {
  headline: string;
  mechanism: string;
  differentiator: string;
  weakerBaseline: string;
  lesson: string;
  label: string;
};

const GENERIC_HASHTAGS = new Set([
  "fyp",
  "foryou",
  "foryoupage",
  "xyzbc",
  "viral",
  "trending",
  "lofi",
  "lofigirl",
  "lofihiphop",
  "study",
  "studying",
  "studytok",
  "studygram",
  "studywithme",
  "animation",
  "art",
]);

const SIGNAL_TEMPLATES: Record<EditorialSignalKey, SignalTemplate> = {
  absurd_poll: {
    label: "Détournement du format",
    headline: "Le sondage transforme le choix en gag",
    mechanism:
      "La question semble demander une préférence, puis les options retirent toute vraie décision. La mécanique native du sondage devient elle-même la chute.",
    differentiator:
      "fait participer avant même d’exiger une opinion et rend la blague compréhensible en un regard",
    weakerBaseline:
      "reste une question de préférence classique",
    lesson:
      "Utiliser l’interface native comme partie de l’idée, pas seulement comme contenant.",
  },
  co_creation: {
    label: "Pouvoir donné à la communauté",
    headline: "La participation donne un pouvoir symbolique sur la suite",
    mechanism:
      "La réponse ne sert pas seulement à parler de soi : elle permet à la communauté d’influencer un personnage, une sortie ou une prochaine étape de l’univers Lofi Girl.",
    differentiator:
      "donne une conséquence claire au vote au lieu de collecter une préférence abstraite",
    weakerBaseline:
      "demande un avis sans effet perceptible sur la suite",
    lesson:
      "Poser des choix qui donnent à la communauté une prise visible sur l’univers de marque.",
  },
  identity_choice: {
    label: "Choix identitaire",
    headline: "Une réponse immédiate qui permet de se définir",
    mechanism:
      "La question porte sur une habitude, une préférence ou une appartenance facile à reconnaître. Répondre devient une petite déclaration d’identité, sans connaissance préalable nécessaire.",
    differentiator:
      "offre des positions dans lesquelles on peut se reconnaître immédiatement",
    weakerBaseline:
      "demande une association plus abstraite ou un effort de réflexion",
    lesson:
      "Formuler un choix simple où chaque option raconte quelque chose de la personne qui répond.",
  },
  micro_progress: {
    label: "Micro-victoire auto-dérisoire",
    headline: "Une victoire minuscule est racontée comme un exploit",
    mechanism:
      "L’accroche détourne le langage de la réussite pour célébrer un progrès volontairement banal. La disproportion crée l’humour tout en déculpabilisant la productivité imparfaite.",
    differentiator:
      "incarne le message dans une action très précise au lieu de rester dans la motivation générale",
    weakerBaseline:
      "donne un conseil positif plus générique",
    lesson:
      "Partir d’un progrès banal et le raconter avec un faux niveau d’héroïsme.",
  },
  student_meme: {
    label: "Étape étudiante + langage de mème",
    headline: "Un cap étudiant est transformé en formule de mème",
    mechanism:
      "Le sujet touche directement le quotidien historique de la communauté, mais il n’est pas traité comme une réussite institutionnelle. La formulation étrange ou détournée lui donne une chute rejouable.",
    differentiator:
      "ajoute une transformation et une formule mémorisable à un thème scolaire déjà familier",
    weakerBaseline:
      "exprime le stress ou le besoin de soutien de manière plus littérale",
    lesson:
      "Ancrer le post dans une vraie étape de vie de l’audience, puis la condenser en formule inattendue.",
  },
  collective_ritual: {
    label: "Rituel collectif",
    headline: "L’anxiété individuelle devient une promesse partagée",
    mechanism:
      "Le texte part d’une tension personnelle puis inclut explicitement la personne qui lit. Lofi Girl prend la place d’une alliée d’étude et transforme le post en rituel d’encouragement collectif.",
    differentiator:
      "fait passer le lecteur du rôle de spectateur à celui de partenaire dans la même situation",
    weakerBaseline:
      "reste un souhait individuel ou une formule d’encouragement abstraite",
    lesson:
      "Faire basculer une émotion personnelle vers un « nous » ou un « toi aussi » crédible.",
  },
  immersive_activation: {
    label: "Activation vécue",
    headline: "L’activation fait entrer le public dans le décor",
    mechanism:
      "La copie ne se contente pas d’annoncer une collaboration. Elle décrit une action concrète à vivre dans un élément déjà iconique de l’univers : explorer, chercher, personnaliser ou découvrir.",
    differentiator:
      "présente l’expérience depuis ce que le public peut y faire, pas depuis le partenariat lui-même",
    weakerBaseline:
      "reste une annonce de collaboration ou de disponibilité",
    lesson:
      "Présenter une activation par l’expérience vécue dans l’univers Lofi Girl, avant les informations pratiques.",
  },
  fourth_wall: {
    label: "Rupture de routine",
    headline: "Une routine familière bascule en micro-histoire",
    mechanism:
      "Le titre introduit un événement qui modifie la situation habituelle du personnage : il prend conscience du regard extérieur. Cette rupture promet une réaction plutôt qu’une simple boucle d’ambiance.",
    differentiator:
      "annonce un changement d’état du personnage et ouvre une attente narrative",
    weakerBaseline:
      "décrit une ambiance ou un personnage sans événement",
    lesson:
      "Partir d’une routine connue, puis introduire un petit événement qui oblige le personnage à réagir.",
  },
  ironic_collective: {
    label: "Complicité chill/chaos",
    headline: "Le contraste entre calme lofi et chaos réel devient une complicité",
    mechanism:
      "La formulation inclut le lecteur dans une situation imparfaite et utilise l’ironie plutôt qu’un message de bien-être lisse. La marque reste réconfortante sans nier le stress réel.",
    differentiator:
      "crée une connivence précise avec l’audience au lieu de décrire simplement une humeur",
    weakerBaseline:
      "énonce une émotion ou une ambiance sans contraste",
    lesson:
      "Mettre la promesse de calme face à une difficulté quotidienne réelle, avec douceur plutôt qu’avec morale.",
  },
  narrative_open_loop: {
    label: "Micro-histoire ouverte",
    headline: "Le titre promet un événement, pas seulement une ambiance",
    mechanism:
      "La phrase installe une anomalie, une question ou un changement d’état sans donner immédiatement la résolution. Elle donne une raison narrative de regarder la publication.",
    differentiator:
      "ouvre une question concrète que le contenu doit résoudre",
    weakerBaseline:
      "décrit une atmosphère ou une offre sans tension narrative",
    lesson:
      "Écrire le titre comme le début d’une scène : situation connue, incident précis, résolution laissée au contenu.",
  },
  cultural_bridge: {
    label: "Pont culturel natif",
    headline: "Un code culturel extérieur est absorbé par l’univers Lofi Girl",
    mechanism:
      "La référence n’est pas ajoutée comme un simple clin d’œil. Elle sert à reformuler le personnage ou sa situation dans un langage que la plateforme reconnaît déjà.",
    differentiator:
      "fait de Lofi Girl la protagoniste du code culturel au lieu de juxtaposer deux marques",
    weakerBaseline:
      "nomme une tendance ou une collaboration sans la transformer",
    lesson:
      "Choisir un code culturel compatible, puis le réécrire depuis le point de vue du personnage.",
  },
  care_ritual: {
    label: "Rituel de care",
    headline: "Lofi Girl agit comme un compagnon, pas comme un annonceur",
    mechanism:
      "Le message intervient dans un moment quotidien précis — sommeil, stress, santé mentale ou découragement — avec une voix courte et familière. Il ressemble davantage à un rappel d’ami qu’à une citation inspirante.",
    differentiator:
      "s’adresse à un moment concret de la journée au lieu de proposer une motivation interchangeable",
    weakerBaseline:
      "reste une affirmation positive sans situation précise",
    lesson:
      "Transformer une valeur de marque en petit rituel utile, formulé comme une présence familière.",
  },
  relatable_humour: {
    label: "Miroir identitaire",
    headline: "Une faiblesse ordinaire devient une identité partageable",
    mechanism:
      "Le texte nomme une habitude ou une contradiction suffisamment précise pour que la personne se reconnaisse sans explication. L’auto-dérision évite le ton de conseil.",
    differentiator:
      "donne une scène et un défaut reconnaissables plutôt qu’une observation générale",
    weakerBaseline:
      "reste une humeur ou une formule générique",
    lesson:
      "Choisir un comportement quotidien très précis et laisser l’audience se reconnaître avant de lui parler.",
  },
  commercial_copy: {
    label: "Friction promotionnelle",
    headline: "Le message informe davantage qu’il ne crée une micro-situation",
    mechanism:
      "La copie cumule annonce, bénéfices, consignes ou lien externe. Elle peut être utile, mais elle demande plus d’attention et laisse moins de place à l’identification immédiate.",
    differentiator:
      "apporte des informations pratiques, avec une entrée plus commerciale",
    weakerBaseline:
      "concentre l’idée sur une seule situation ou une seule émotion",
    lesson:
      "Séparer la promesse éditoriale des détails pratiques et garder un seul geste principal par publication.",
  },
  compressed_hook: {
    label: "Compression",
    headline: "Une seule idée est comprise avant même le contexte",
    mechanism:
      "La formule est autonome, courte et centrée sur un seul geste ou état. Cette compression facilite la reconnaissance et la reprise sans explication supplémentaire.",
    differentiator:
      "retire les informations secondaires et laisse une seule idée nette",
    weakerBaseline:
      "multiplie les précisions ou les intentions dans la même publication",
    lesson:
      "Conserver une prémisse, une émotion et une seule bascule par post.",
  },
};

export function buildEditorialAnalysisMap(
  posts: readonly EditorialAnalysisPost[],
): Map<string, EditorialWhy> {
  return buildEditorialAnalysisMapInternal(posts, null);
}

/**
 * Analyse uniquement les publications demandées tout en conservant l'ensemble
 * de leur cohorte comme base de comparaison. Cette variante est destinée aux
 * aperçus et aux fiches ouvertes à la demande : elle produit exactement la
 * même analyse que `buildEditorialAnalysisMap`, sans calculer les milliers de
 * fiches qui ne sont pas encore consultées.
 */
export function buildEditorialAnalysisMapForTargets(
  posts: readonly EditorialAnalysisPost[],
  targetKeys: Iterable<string>,
): Map<string, EditorialWhy> {
  const targets = new Set(targetKeys);
  if (targets.size === 0) return new Map();
  return buildEditorialAnalysisMapInternal(posts, targets);
}

function buildEditorialAnalysisMapInternal(
  posts: readonly EditorialAnalysisPost[],
  targetKeys: ReadonlySet<string> | null,
): Map<string, EditorialWhy> {
  const prepared = posts.map(preparePost);
  const cohorts = new Map<string, PreparedPost[]>();
  for (const item of prepared) {
    const cohortKey = `${item.post.platform}:${canonicalFormat(item.post.format)}`;
    const cohort = cohorts.get(cohortKey);
    if (cohort) cohort.push(item);
    else cohorts.set(cohortKey, [item]);
  }

  const result = new Map<string, EditorialWhy>();
  for (const cohort of cohorts.values()) {
    const targets = targetKeys
      ? cohort.filter((item) => targetKeys.has(item.key))
      : cohort;
    if (targets.length === 0) continue;
    const ordered = orderPreparedPosts(cohort);
    const orderedIndex = new Map(
      ordered.map((item, index) => [item, index] as const),
    );
    const signalCounts = new Map<PreparedPost["primarySignal"], number>();
    for (const item of cohort) {
      signalCounts.set(
        item.primarySignal,
        (signalCounts.get(item.primarySignal) ?? 0) + 1,
      );
    }
    const context: PreparedCohortContext = {
      size: cohort.length,
      orderedIndex,
      signalCounts,
      comparators: selectComparators(
        cohort,
        ordered,
        orderedIndex,
        signalCounts,
        new Set(targets),
      ),
    };
    for (const target of targets) {
      result.set(target.key, analyzePreparedPost(target, context));
    }
  }
  return result;
}

export function analyzeEditorialPost(
  post: EditorialAnalysisPost,
  posts: readonly EditorialAnalysisPost[],
): EditorialWhy {
  const analyses = buildEditorialAnalysisMapForTargets(posts, [editorialPostKey(post)]);
  return analyses.get(editorialPostKey(post)) ?? insufficientAnalysis(post);
}

export function editorialPostKey(
  post: Pick<EditorialAnalysisPost, "platform" | "externalId">,
): string {
  return `${post.platform}:${post.externalId}`;
}

export function editorialThemeLabel(post: EditorialAnalysisPost): string {
  const signal = preparePost(post).primarySignal;
  if (signal === "student_meme" || signal === "micro_progress") {
    return "Études & petites victoires";
  }
  if (signal === "collective_ritual" || signal === "care_ritual") {
    return "Care & communauté";
  }
  if (signal === "co_creation" || signal === "identity_choice" || signal === "absurd_poll") {
    return "Participation";
  }
  if (signal === "immersive_activation" || signal === "cultural_bridge") {
    return "Activation incarnée";
  }
  if (signal === "fourth_wall" || signal === "narrative_open_loop") {
    return "Personnage & micro-histoire";
  }
  if (signal === "commercial_copy") return "Information & activation";
  if (signal === "insufficient") return "Lecture à compléter";
  return "Relatable & humour";
}

function analyzePreparedPost(
  target: PreparedPost,
  context: PreparedCohortContext,
): EditorialWhy {
  if (target.primarySignal === "insufficient") return insufficientAnalysis(target.post);

  const template = SIGNAL_TEMPLATES[target.primarySignal];
  const peerCount = Math.max(0, context.size - 1);
  const sameSignalPeerCount = Math.max(
    0,
    (context.signalCounts.get(target.primarySignal) ?? 0) - 1,
  );
  const noDifferentiator =
    peerCount >= 2 && sameSignalPeerCount / peerCount >= 0.8;
  const comparator = noDifferentiator
    ? null
    : context.comparators.get(target) ?? null;
  const targetIndex = context.orderedIndex.get(target) ?? -1;
  const comparatorIndex = comparator
    ? context.orderedIndex.get(comparator) ?? -1
    : -1;
  const targetComesFirst =
    comparator !== null &&
    targetIndex >= 0 &&
    comparatorIndex >= 0 &&
    targetIndex < comparatorIndex;

  const comparison = noDifferentiator
    ? "Dans cette catégorie, presque tous les posts comparables utilisent déjà le même ressort. Le titre et le format observés ne suffisent donc pas à isoler ce qui fait la différence entre eux."
    : comparator
      ? targetComesFirst
        ? `Face à « ${shortExcerpt(comparator.copy)} », centré surtout sur ${comparatorMechanismLabel(comparator)}, celui-ci ${template.differentiator}.`
        : `Face à « ${shortExcerpt(comparator.copy)} », qui articule plus nettement ${comparatorMechanismLabel(comparator)}, celui-ci mobilise ${template.label.toLowerCase()}, mais de façon moins distinctive dans la cohorte observée.`
      : `Dans cette catégorie, ${template.differentiator}. La cohorte disponible ne fournit toutefois pas de contre-exemple assez proche pour attribuer précisément l’écart à ce seul ressort.`;

  const formatMechanism = formatSpecificMechanism(target);
  const evidence = primaryEvidence(target);
  const mechanisms: EditorialMechanism[] = [
    {
      label: template.label,
      observation: template.mechanism,
      evidence,
    },
  ];
  if (formatMechanism) mechanisms.push(formatMechanism);

  return {
    status: noDifferentiator
      ? "no-differentiator"
      : comparator
        ? "comparative"
        : "content-only",
    scope: "copy-and-format",
    primarySignal: target.primarySignal,
    headline: template.headline,
    mechanism: [template.mechanism, formatMechanism?.observation]
      .filter(Boolean)
      .join(" "),
    comparison,
    transferableLesson: template.lesson,
    mechanisms,
    comparatorPostIds: comparator ? [comparator.post.externalId] : [],
    limitations: analysisLimitations(target, context.size),
    confidence: comparator && context.size >= 6 ? "medium" : "low",
    version: "editorial-v1",
  };
}

function preparePost(post: EditorialAnalysisPost): PreparedPost {
  const copy = editorialCopy(post);
  const normalized = normalizeForSignals(copy);
  const signals = detectRawSignals(post, copy, normalized);
  return {
    post,
    key: editorialPostKey(post),
    copy,
    normalized,
    wordCount: words(normalized).length,
    signals,
    primarySignal: selectPrimarySignal(post, normalized, signals),
  };
}

function editorialCopy(post: EditorialAnalysisPost): string {
  const text = cleanString(post.text);
  const title = cleanString(post.title);
  const source = text || title;
  if (!source) return "";
  return source
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/🎨[\s\S]*$/u, " ")
    .replace(/\b(?:concept and artist|original audio by|artist|artwork)\s*:[\s\S]*$/i, " ")
    .replace(/@[\w.]+/g, " ")
    .replace(/#([\p{L}\p{N}_-]+)/gu, (_match, tag: string) => {
      const normalizedTag = tag.toLowerCase().replace(/[_-]+/g, "");
      return GENERIC_HASHTAGS.has(normalizedTag) ? " " : ` ${tag.replace(/[_-]+/g, " ")} `;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForSignals(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}?!'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectRawSignals(
  post: EditorialAnalysisPost,
  copy: string,
  value: string,
): Set<RawSignal> {
  const signals = new Set<RawSignal>();
  const wordCount = words(value).length;
  const format = canonicalFormat(post.format);
  const raw = rawRecord(post.raw);
  const pollChoices = stringArray(raw?.pollChoices);
  const originalCopy = `${cleanString(post.text)} ${cleanString(post.title)}`;

  addIf(signals, "academic", /\b(?:study|studying|studytok|student|school|exam|exams|examseason|finals|final exams?|graduat\w*|graduado|test score|planner|to do|homework)\b/.test(value));
  addIf(signals, "achievement", /\b(?:graduat\w*|graduado|pass(?:ed)?|test score|task|done|win)\b/.test(value));
  addIf(signals, "brand_world", /\b(?:lofi girl|lofi boy|jade|maya|pocky|neighbou?r|iconic room|lore|the cat|her room)\b/.test(value));
  addIf(signals, "care", /\b(?:go to bed|goodnight|mental health|take care|you got this|so will you|reminder|showing up|pat yourself|peaceful night|stress|napper|blanket)\b/.test(value));
  addIf(signals, "character_event", /\b(?:realizes?|gets?|push|recorded|end up|knows?|turns?|wondered where|test score|final form|whoops|glitch|coming for|being watched)\b/.test(value));
  addIf(signals, "collective", /\b(?:we|us|our|together|so will you|whoever needs|one of us|you too)\b/.test(value));
  addIf(signals, "commercial", /\b(?:pre order|preorder|available now|out now|listen now|stream now|shop now|buy now|latest release|new release|collection|vinyl|album|merch|link in bio|code)\b/.test(value) || /https?:\/\//i.test(originalCopy));
  addIf(signals, "cultural", /\b(?:fortnite|jjk|ketnipz|canon event|final form|touch grass|glitch in the matrix|april 1st|trend|meme|graduado|sus)\b/.test(value));
  addIf(signals, "direct_address", /\b(?:you|your)\b/.test(value) && (/\?/.test(copy) || /\b(?:share|send|tell|go|remember|reminder|will|needs?)\b/.test(value)));
  addIf(signals, "everyday", /\b(?:books?|coffee|cafe|blanket|bed|cat|plants?|task|planner|nap|pollen|stress|introvert|procrastinat\w*|tomorrow|productive|summer|spring)\b/.test(value));
  addIf(signals, "identity", /\b(?:favorite|favourite|which|what kind|who would|current .* status|how long|delete one|more into|represents?|plans?)\b/.test(value));
  addIf(signals, "immersive", /\b(?:explore|solve quests?|uncover|hidden secrets?|customi[sz]e|play along|embark|inside .* room)\b/.test(value));
  addIf(signals, "meme_language", /\b(?:graduado|sike|canon event|final form|touch grass|head empty|sus|glitch in the matrix|we're so done|not to flex|haters will say|catch me if you can)\b/.test(value));
  addIf(signals, "micro_progress", /\b(?:moved one task|to do .* done|showing up is a win|fine i'll do|small win|little win)\b/.test(value));
  addIf(signals, "open_loop", /\?/.test(copy) || /\b(?:how did|what happened|realizes?|whoops|something we don't|secret|reveal|surprise|where i've been|looking .* sus|neighbou?r|final form|coming for)\b/.test(value));
  addIf(signals, "participation", /poll|sondage/.test(format) || /\?/.test(copy));
  addIf(signals, "seasonal", /\b(?:spring|summer|winter|autumn|fall|easter|birthday|april|exam season|graduat\w*)\b/.test(value));
  addIf(signals, "self_deprecating", /\b(?:not to flex|i guess|whoops|life is testing me|head empty|we're so done|too much stress|not my best|i need|addicted|selective memory|i'll do it tomorrow)\b/.test(value));
  addIf(signals, "short_copy", wordCount > 0 && wordCount <= 14);
  addIf(signals, "twist", /\b(?:but|at least|not to flex|sike|actually|suddenly|one of us|haters will say|i call it|i guess|whoops|not even|instead)\b/.test(value));

  if (pollChoices.length >= 2 && new Set(pollChoices.map(normalizeForSignals)).size === 1) {
    signals.add("twist");
  }
  return signals;
}

function selectPrimarySignal(
  post: EditorialAnalysisPost,
  value: string,
  signals: Set<RawSignal>,
): EditorialSignalKey | "insufficient" {
  if (!value) return "insufficient";
  const format = canonicalFormat(post.format);
  const pollChoices = stringArray(rawRecord(post.raw)?.pollChoices);
  const isPoll = /poll|sondage/.test(format);

  if (
    isPoll &&
    pollChoices.length >= 2 &&
    new Set(pollChoices.map(normalizeForSignals)).size === 1
  ) {
    return "absurd_poll";
  }
  if (isPoll && /\b(?:next release|next .* about|who should|choose the next|what should we)\b/.test(value)) {
    return "co_creation";
  }
  if (isPoll && (signals.has("identity") || signals.has("participation"))) {
    return "identity_choice";
  }
  if (signals.has("micro_progress")) return "micro_progress";
  if (signals.has("academic") && signals.has("meme_language")) return "student_meme";
  if (signals.has("academic") && signals.has("collective") && signals.has("direct_address")) {
    return "collective_ritual";
  }
  if (signals.has("immersive") && signals.has("commercial")) return "immersive_activation";
  if (/\brealizes? (?:she|he|they|lofi girl).*recorded\b/.test(value)) return "fourth_wall";
  if (signals.has("collective") && signals.has("twist") && signals.has("care")) {
    return "ironic_collective";
  }
  if (signals.has("character_event") && signals.has("open_loop")) return "narrative_open_loop";
  if (signals.has("cultural") && (signals.has("brand_world") || signals.has("meme_language"))) {
    return "cultural_bridge";
  }
  if (signals.has("care") && signals.has("direct_address")) return "care_ritual";
  if (signals.has("commercial") && words(value).length > 18) return "commercial_copy";
  if (signals.has("self_deprecating") || (signals.has("everyday") && signals.has("twist"))) {
    return "relatable_humour";
  }
  if (signals.has("open_loop")) return "narrative_open_loop";
  if (signals.has("short_copy")) return "compressed_hook";
  if (signals.has("commercial")) return "commercial_copy";
  return "relatable_humour";
}

const COMPARATOR_TERRITORIES: readonly RawSignal[] = [
  "academic",
  "brand_world",
  "care",
  "cultural",
  "everyday",
  "seasonal",
];

const COMPARATOR_DATE_WINDOWS = [
  { milliseconds: 366 * 86_400_000, bonus: 1 },
  { milliseconds: 92 * 86_400_000, bonus: 2 },
  { milliseconds: 31 * 86_400_000, bonus: 3 },
] as const;

/**
 * Selects the same comparator as the former per-post exhaustive scan, but uses
 * the comparator's finite score buckets plus offline rank/date range queries.
 * The number of territory masks and primary signals is bounded, so a cohort is
 * processed in O(n log n) rather than repeatedly scanning and sorting all peers.
 */
function selectComparators(
  cohort: readonly PreparedPost[],
  ordered: readonly PreparedPost[],
  orderedIndex: ReadonlyMap<PreparedPost, number>,
  signalCounts: ReadonlyMap<PreparedPost["primarySignal"], number>,
  targets: ReadonlySet<PreparedPost>,
): Map<PreparedPost, PreparedPost> {
  const result = new Map<PreparedPost, PreparedPost>();
  if (cohort.length <= 1) return result;

  const candidates: ComparatorCandidate[] = ordered.map((item, index) => ({
    item,
    orderedIndex: index,
    publishedAt: parsedDate(item.post.publishedAt),
    territoryMask: comparatorTerritoryMask(item.signals),
  }));
  const targetGroups = new Map<
    string,
    {
      territoryMask: number;
      signal: EditorialSignalKey;
      targets: ComparatorTarget[];
    }
  >();
  const peerCount = cohort.length - 1;

  for (const item of cohort) {
    if (!targets.has(item)) continue;
    if (item.primarySignal === "insufficient") continue;
    const sameSignalPeerCount = Math.max(
      0,
      (signalCounts.get(item.primarySignal) ?? 0) - 1,
    );
    if (peerCount >= 2 && sameSignalPeerCount / peerCount >= 0.8) continue;

    const index = orderedIndex.get(item);
    if (index === undefined) continue;
    const territoryMask = comparatorTerritoryMask(item.signals);
    const groupKey = `${territoryMask}:${item.primarySignal}`;
    const target: ComparatorTarget = {
      item,
      orderedIndex: index,
      publishedAt: parsedDate(item.post.publishedAt),
      upperHalf: index < Math.ceil(ordered.length / 2),
      best: null,
    };
    const group = targetGroups.get(groupKey);
    if (group) group.targets.push(target);
    else {
      targetGroups.set(groupKey, {
        territoryMask,
        signal: item.primarySignal,
        targets: [target],
      });
    }
  }

  for (const group of targetGroups.values()) {
    selectComparatorsForTargetGroup(group, candidates, ordered.length);
    for (const target of group.targets) {
      if (target.best) result.set(target.item, target.best.candidate);
    }
  }
  return result;
}

function selectComparatorsForTargetGroup(
  group: {
    territoryMask: number;
    signal: EditorialSignalKey;
    targets: ComparatorTarget[];
  },
  candidates: readonly ComparatorCandidate[],
  cohortSize: number,
) {
  const scoreBuckets = new Map<number, ComparatorCandidate[]>();
  for (const candidate of candidates) {
    const sharedTerritories = bitCount(
      group.territoryMask & candidate.territoryMask,
    );
    const score =
      sharedTerritories * 6 +
      (candidate.item.primarySignal !== group.signal ? 4 : 0) +
      (candidate.item.copy ? 1 : 0);
    const bucket = scoreBuckets.get(score);
    if (bucket) bucket.push(candidate);
    else scoreBuckets.set(score, [candidate]);
  }

  const datedTargets = group.targets
    .filter(
      (target): target is ComparatorTarget & { publishedAt: number } =>
        target.publishedAt !== null,
    )
    .sort((left, right) =>
      left.publishedAt !== right.publishedAt
        ? left.publishedAt - right.publishedAt
        : left.orderedIndex - right.orderedIndex,
    );

  for (const [baseScore, bucket] of scoreBuckets) {
    const staticTree = new ComparatorRangeMinTree(cohortSize);
    for (const candidate of bucket) {
      staticTree.update(candidate.orderedIndex, candidate);
    }
    for (const target of group.targets) {
      considerDirectionalCandidates(target, staticTree, baseScore, 0, cohortSize);
    }

    if (datedTargets.length === 0) continue;
    const datedCandidates = bucket
      .filter(
        (candidate): candidate is ComparatorCandidate & { publishedAt: number } =>
          candidate.publishedAt !== null,
      )
      .sort((left, right) =>
        left.publishedAt !== right.publishedAt
          ? left.publishedAt - right.publishedAt
          : left.orderedIndex - right.orderedIndex,
      );
    if (datedCandidates.length === 0) continue;

    for (const window of COMPARATOR_DATE_WINDOWS) {
      const tree = new ComparatorRangeMinTree(cohortSize);
      let firstActive = 0;
      let afterLastActive = 0;

      for (const target of datedTargets) {
        const latest = target.publishedAt + window.milliseconds;
        const earliest = target.publishedAt - window.milliseconds;
        while (
          afterLastActive < datedCandidates.length &&
          datedCandidates[afterLastActive].publishedAt <= latest
        ) {
          const candidate = datedCandidates[afterLastActive];
          tree.update(candidate.orderedIndex, candidate);
          afterLastActive += 1;
        }
        while (
          firstActive < afterLastActive &&
          datedCandidates[firstActive].publishedAt < earliest
        ) {
          const candidate = datedCandidates[firstActive];
          tree.update(candidate.orderedIndex, null);
          firstActive += 1;
        }
        considerDirectionalCandidates(
          target,
          tree,
          baseScore,
          window.bonus,
          cohortSize,
        );
      }
    }
  }
}

function considerDirectionalCandidates(
  target: ComparatorTarget,
  tree: ComparatorRangeMinTree,
  baseScore: number,
  dateBonus: number,
  cohortSize: number,
) {
  const before = tree.query(0, target.orderedIndex);
  const after = tree.query(target.orderedIndex + 1, cohortSize);
  const useful = target.upperHalf ? after : before;
  const other = target.upperHalf ? before : after;
  considerComparator(target, useful, baseScore + dateBonus + 3);
  considerComparator(target, other, baseScore + dateBonus);
}

function considerComparator(
  target: ComparatorTarget,
  candidate: ComparatorCandidate | null,
  score: number,
) {
  if (!candidate || candidate.item.key === target.item.key) return;
  if (
    target.best === null ||
    score > target.best.score ||
    (score === target.best.score &&
      candidate.item.key.localeCompare(target.best.candidate.key) < 0)
  ) {
    target.best = { candidate: candidate.item, score };
  }
}

class ComparatorRangeMinTree {
  readonly leafCount: number;
  readonly values: (ComparatorCandidate | null)[];

  constructor(length: number) {
    let leafCount = 1;
    while (leafCount < length) leafCount *= 2;
    this.leafCount = leafCount;
    this.values = Array.from({ length: leafCount * 2 }, () => null);
  }

  update(index: number, value: ComparatorCandidate | null) {
    let cursor = this.leafCount + index;
    this.values[cursor] = value;
    while (cursor > 1) {
      cursor = Math.floor(cursor / 2);
      this.values[cursor] = earlierComparatorCandidate(
        this.values[cursor * 2],
        this.values[cursor * 2 + 1],
      );
    }
  }

  query(start: number, end: number): ComparatorCandidate | null {
    if (start >= end) return null;
    let left = this.leafCount + start;
    let right = this.leafCount + end;
    let best: ComparatorCandidate | null = null;
    while (left < right) {
      if (left % 2 === 1) {
        best = earlierComparatorCandidate(best, this.values[left]);
        left += 1;
      }
      if (right % 2 === 1) {
        right -= 1;
        best = earlierComparatorCandidate(best, this.values[right]);
      }
      left = Math.floor(left / 2);
      right = Math.floor(right / 2);
    }
    return best;
  }
}

function earlierComparatorCandidate(
  left: ComparatorCandidate | null,
  right: ComparatorCandidate | null,
): ComparatorCandidate | null {
  if (!left) return right;
  if (!right) return left;
  const keyDifference = left.item.key.localeCompare(right.item.key);
  if (keyDifference !== 0) return keyDifference < 0 ? left : right;
  return left.orderedIndex <= right.orderedIndex ? left : right;
}

function comparatorTerritoryMask(signals: ReadonlySet<RawSignal>): number {
  let mask = 0;
  for (let index = 0; index < COMPARATOR_TERRITORIES.length; index += 1) {
    if (signals.has(COMPARATOR_TERRITORIES[index])) mask |= 1 << index;
  }
  return mask;
}

function bitCount(value: number): number {
  let count = 0;
  let remaining = value;
  while (remaining !== 0) {
    remaining &= remaining - 1;
    count += 1;
  }
  return count;
}

function parsedDate(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatSpecificMechanism(target: PreparedPost): EditorialMechanism | null {
  const format = canonicalFormat(target.post.format);
  const evidence: EditorialEvidence[] = [
    {
      postId: target.post.externalId,
      field: "format",
      excerpt: format || "format non renseigné",
    },
  ];
  if (/community_image|image|static|photo|carousel/.test(format) && target.wordCount <= 16) {
    return {
      label: "Texte + image",
      observation:
        "La légende prépare une situation sans la sur-expliquer et laisse l’image apporter le reste de l’information. Le contenu visuel lui-même n’est pas interprété ici.",
      evidence,
    };
  }
  if (/community_text|text/.test(format) && target.wordCount <= 18) {
    return {
      label: "Phrase autonome",
      observation:
        "Le texte tient seul, comme une réplique ou une pensée que l’on peut reprendre. Il ne dépend ni d’un préambule ni d’un appel commercial.",
      evidence,
    };
  }
  if (/short|video|reel/.test(format) && target.signals.has("character_event")) {
    return {
      label: "Promesse narrative",
      observation:
        "Le titre annonce une action ou une rupture de situation. L’analyse porte sur cette promesse écrite, pas sur le montage, l’audio ou les images de la vidéo.",
      evidence,
    };
  }
  if (/poll|sondage/.test(format)) {
    return {
      label: "Format natif",
      observation:
        "Le geste demandé est intégré à la publication : la personne peut prendre position sans quitter le post ni rédiger une réponse longue.",
      evidence,
    };
  }
  return null;
}

function primaryEvidence(target: PreparedPost): EditorialEvidence[] {
  const field = cleanString(target.post.text) ? "text" : "title";
  const evidence: EditorialEvidence[] = [
    {
      postId: target.post.externalId,
      field,
      excerpt: shortExcerpt(target.copy, 110),
    },
  ];
  const duration = numberOrNull(rawRecord(target.post.raw)?.durationSeconds);
  if (duration !== null) {
    evidence.push({
      postId: target.post.externalId,
      field: "durationSeconds",
      excerpt: `${duration} secondes`,
    });
  }
  const pollChoices = stringArray(rawRecord(target.post.raw)?.pollChoices);
  if (pollChoices.length) {
    evidence.push({
      postId: target.post.externalId,
      field: "pollChoices",
      excerpt: pollChoices.slice(0, 4).join(" · "),
    });
  }
  return evidence;
}

function analysisLimitations(target: PreparedPost, cohortSize: number): string[] {
  const limitations: string[] = [];
  const format = canonicalFormat(target.post.format);
  if (/short|video|reel/.test(format)) {
    limitations.push(
      "Lecture fondée sur le titre, la légende et le format public ; l’audio, les plans, le montage et la rétention ne sont pas analysés.",
    );
  } else if (/image|static|photo|carousel/.test(format)) {
    limitations.push(
      "Lecture fondée sur la légende et le format ; le contenu détaillé de l’image n’est pas interprété.",
    );
  }
  if (cohortSize < 4) {
    limitations.push(
      "Cohorte trop petite pour isoler solidement un différenciateur éditorial.",
    );
  }
  return limitations;
}

function insufficientAnalysis(post: EditorialAnalysisPost): EditorialWhy {
  return {
    status: "no-differentiator",
    scope: "copy-and-format",
    primarySignal: "insufficient",
    headline: "Matière éditoriale insuffisante",
    mechanism:
      "Le titre et la légende publics ne donnent pas assez d’éléments pour formuler une hypothèse spécifique sans inventer le contenu.",
    comparison:
      "Aucune différence fiable ne peut être établie à partir du texte et du format seuls.",
    transferableLesson:
      "Ajouter une transcription, une annotation visuelle ou une légende exploitable avant de tirer un enseignement.",
    mechanisms: [
      {
        label: "Limite de matière",
        observation:
          "Le radar préfère signaler l’absence d’information plutôt que produire une justification générique.",
        evidence: post.format
          ? [
              {
                postId: post.externalId,
                field: "format",
                excerpt: post.format,
              },
            ]
          : [],
      },
    ],
    comparatorPostIds: [],
    limitations: [
      "Aucune affirmation n’est faite sur le visuel, l’audio ou le montage non observés.",
    ],
    confidence: "low",
    version: "editorial-v1",
  };
}

function orderPreparedPosts(cohort: readonly PreparedPost[]): PreparedPost[] {
  return rankPostsByPublicMetric(
    cohort.map((item) => ({
      item,
      external_post_id: item.post.externalId,
      format: item.post.format ?? "unknown",
      likes: numberOrNull(item.post.likes),
      views: numberOrNull(item.post.views),
      comments: numberOrNull(item.post.comments),
      shares: numberOrNull(item.post.shares),
      saves: numberOrNull(item.post.saves),
      poll_votes: pollVotes(item.post),
    })),
  ).posts.map(({ item }) => item);
}

function comparatorMechanismLabel(comparator: PreparedPost): string {
  if (comparator.primarySignal === "insufficient") {
    return "une formulation peu documentée";
  }
  return `le ressort « ${SIGNAL_TEMPLATES[
    comparator.primarySignal
  ].label.toLowerCase()} »`;
}

function pollVotes(post: EditorialAnalysisPost): number | null {
  const raw = rawRecord(post.raw);
  return (
    numberOrNull(raw?.pollVotes) ?? numberOrNull(raw?.pollTotalVotes)
  );
}

function canonicalFormat(value: string | null): string {
  return cleanString(value)?.toLowerCase().replace(/[\s-]+/g, "_") ?? "unknown";
}

function addIf(signals: Set<RawSignal>, signal: RawSignal, condition: boolean) {
  if (condition) signals.add(signal);
}

function rawRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function words(value: string): string[] {
  return value.match(/[\p{L}\p{N}']+/gu) ?? [];
}

function shortExcerpt(value: string, limit = 76): string {
  const clean = value.trim();
  if (!clean) return "publication sans texte exploitable";
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1).trimEnd()}…`;
}
