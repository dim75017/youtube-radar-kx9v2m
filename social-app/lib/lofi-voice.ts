/**
 * Lofi Girl comment voice.
 *
 * The comments that worked were never "nice comments under a big video". They
 * worked because the character reacted in character: under the GTA VI trailer,
 * the girl who has been studying at the same desk for years said she would put
 * her pen down. The joke only exists because everyone knows she never stops.
 *
 * This module encodes that: the canon a line may draw from, the archetypes
 * that reliably land, and the hard rules a proposal must satisfy before a
 * community manager ever sees it. Nothing here posts anything.
 */

import {
  COMMENT_OPPORTUNITY_MAX_COMMENT_LENGTH,
  isPromotionalComment,
  type CommentOpportunity,
  type CommentOpportunityCategory,
  type CommentOpportunityTone,
  type CommentSuggestion,
} from "./comment-opportunities.ts";

export const LOFI_VOICE_MODEL = "claude-sonnet-5";

/** Canon a line may lean on. Everything else has to be invented, so it is not. */
export const LOFI_VOICE_CANON = `Lofi Girl is a character, not a logo.

Who she is:
- A girl named Jade, studying at a desk by a window, headphones on, one lamp,
  one notebook, one pen, a mug. She has been there since 2017.
- Pocky, her cat, sits on the windowsill. Pocky judges. Pocky never studies.
- Outside the window: a city, rain more often than not, sometimes snow, once a
  summer river. The scene loops forever.
- The stream never stops. Millions of people study to it at the same time,
  silently, alone together. That shared solitude is the whole brand.
- Her tagline is "beats to relax/study to". She has never shouted once.

How she speaks:
- English, lowercase, calm, understated, a little deadpan.
- One idea per comment. No lists, no build-up, no punchline explained.
- Dry humour, never mean, never edgy, never ironic about other people's work.
- She is the smallest voice in a loud comment section, which is why she is read.

What makes a comment work:
- It reacts *in character*. The value is the contrast between a girl who never
  stops studying and an event big enough to interrupt her.
- It is specific to what is actually in this video, not a compliment that would
  fit any video.
- It reads like a person, not like a brand account doing outreach.`;

export type LofiCommentArchetype = {
  id: string;
  label: string;
  when: string;
  example: string;
};

/**
 * Reusable shapes, not templates to fill. They are handed to the model as
 * angles of attack so the three proposals do not collapse into one joke.
 */
export const LOFI_COMMENT_ARCHETYPES: readonly LofiCommentArchetype[] = [
  {
    id: "pen-down",
    label: "Le stylo qu'on pose",
    when: "Un drop assez énorme pour interrompre une routine de huit ans.",
    example: "ok i will put my pen down for this one",
  },
  {
    id: "study-playlist",
    label: "Ça part dans la session",
    when: "Un contenu musical, ou une ambiance qui colle à une session de travail.",
    example: "this is going straight into the 2am session",
  },
  {
    id: "pocky",
    label: "Le chat",
    when: "Un contenu avec un animal, du chaos, ou quelque chose d'ostensiblement confortable.",
    example: "pocky watched this twice and still refuses to help me revise",
  },
  {
    id: "window",
    label: "La fenêtre",
    when: "Un contenu très visuel, une météo, un paysage, une atmosphère.",
    example: "my window has been showing the same rain for six years, jealous",
  },
  {
    id: "the-loop",
    label: "La boucle",
    when: "Une nostalgie, un anniversaire, un retour de franchise.",
    example: "i was already at this desk when the first one came out",
  },
  {
    id: "deadline",
    label: "Le devoir à rendre",
    when: "Une distraction irrésistible, un truc qu'on va regarder au lieu de bosser.",
    example: "i have an essay due tomorrow and now i have plans",
  },
  {
    id: "volume",
    label: "Le volume",
    when: "Un son, un score, une bande-annonce dont la musique porte tout.",
    example: "turning my own beats down for this, that never happens",
  },
  {
    id: "same-desk",
    label: "Le temps qui passe",
    when: "Un événement qui marque une époque, un retour attendu depuis des années.",
    example: "same desk, same chair, entirely different decade",
  },
];

/** Real lines that landed. Few-shot ground truth beats any amount of adjectives. */
export const LOFI_VOICE_HALL_OF_FAME: readonly {
  context: string;
  comment: string;
  why: string;
}[] = [
  {
    context: "Bande-annonce GTA VI, sortie Rockstar Games, des dizaines de millions de vues en quelques heures.",
    comment: "ok i will put my pen down for this one",
    why: "Elle ne parle pas du jeu, elle parle d'elle. Tout le monde sait qu'elle n'arrête jamais : l'aveu vaut plus qu'un compliment.",
  },
];

export const LOFI_TONE_BRIEFS: Record<
  CommentOpportunityTone,
  { label: string; brief: string }
> = {
  funny: {
    label: "Drôle",
    brief:
      "Une vanne sèche, en une phrase, dont la chute est la routine d'étude. Jamais un jeu de mots forcé.",
  },
  smart: {
    label: "Smart",
    brief:
      "Une observation qui recadre le contenu en une idée propre. Elle doit donner envie de répondre, pas d'applaudir.",
  },
  complice: {
    label: "Complice",
    brief:
      "Un clin d'œil à ceux qui reconnaîtront : la communauté qui révise, ou le créateur du post. Chaleureux, jamais flagorneur.",
  },
};

const CATEGORY_BRIEFS: Record<CommentOpportunityCategory, string> = {
  gaming: "Gaming : la sortie interrompt la session de révision, ou la remplace.",
  cinema: "Ciné, séries, anime : l'ambiance, la bande-son, l'attente entre deux épisodes.",
  music: "Musique : terrain naturel, mais ne jamais se comparer ni se recommander.",
  tech: "Tech : le bureau, les outils, la promesse de productivité qui ne tient jamais.",
  sport: "Sport : l'intensité contre le calme, un contraste, jamais un pronostic.",
  internet: "Créateurs : parler au créateur comme à quelqu'un qu'on regarde, pas comme à un partenaire.",
  other: "Sans thème dominant : s'accrocher au détail concret visible dans la vidéo.",
};

/** Refused outright: a brand joke next to any of this is a crisis, not a win. */
const SENSITIVE_COMMENT_PATTERN =
  /\b(?:rip|r\.i\.p|death|died|dead|funeral|grief|cancer|suicide|overdose|war|shooting|murder|victim|tragedy|terror|racist|nazi|election|vote|president|politics|lawsuit|arrested|abuse)\b/iu;
const EMOJI_PATTERN = /\p{Extended_Pictographic}/gu;

export type LofiCommentRejection = { ok: false; reason: string };
export type LofiCommentAcceptance = { ok: true };

/**
 * Last gate before a proposal is written to the feed. The model is good; it is
 * not the thing standing between the brand and a bad comment.
 */
export function validateLofiComment(text: unknown): LofiCommentAcceptance | LofiCommentRejection {
  if (typeof text !== "string") return { ok: false, reason: "texte absent" };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: "texte vide" };
  if (trimmed.length > COMMENT_OPPORTUNITY_MAX_COMMENT_LENGTH) {
    return { ok: false, reason: `plus de ${COMMENT_OPPORTUNITY_MAX_COMMENT_LENGTH} caractères` };
  }
  if (trimmed !== text) return { ok: false, reason: "espaces en bord de texte" };
  if (/\s{2,}|\n/u.test(trimmed)) return { ok: false, reason: "mise en forme sur plusieurs lignes" };
  if (isPromotionalComment(trimmed)) return { ok: false, reason: "lien, hashtag ou appel à l'action" };
  if (SENSITIVE_COMMENT_PATTERN.test(trimmed)) return { ok: false, reason: "sujet sensible" };
  if ((trimmed.match(EMOJI_PATTERN)?.length ?? 0) > 1) return { ok: false, reason: "plus d'un emoji" };
  if (/["“”]/u.test(trimmed)) return { ok: false, reason: "guillemets parasites" };
  if (/\b(?:as an ai|language model)\b/iu.test(trimmed)) return { ok: false, reason: "fuite de modèle" };
  return { ok: true };
}

export type LofiCommentPrompt = { system: string; user: string };

export function buildLofiCommentPrompt(
  opportunity: Pick<
    CommentOpportunity,
    | "platform"
    | "category"
    | "author"
    | "title"
    | "caption"
    | "momentTier"
    | "metrics"
    | "velocity"
    | "publishedAt"
  >,
): LofiCommentPrompt {
  const archetypes = LOFI_COMMENT_ARCHETYPES.map(
    (archetype) => `- ${archetype.id} — ${archetype.when}\n  ex : "${archetype.example}"`,
  ).join("\n");
  const hallOfFame = LOFI_VOICE_HALL_OF_FAME.map(
    (entry) => `- Contexte : ${entry.context}\n  Commentaire : "${entry.comment}"\n  Pourquoi ça marche : ${entry.why}`,
  ).join("\n");
  const tones = (Object.keys(LOFI_TONE_BRIEFS) as CommentOpportunityTone[])
    .map((tone) => `- ${tone} : ${LOFI_TONE_BRIEFS[tone].brief}`)
    .join("\n");

  const system = `${LOFI_VOICE_CANON}

Archétypes qui fonctionnent (angles d'attaque, pas des gabarits à remplir) :
${archetypes}

Commentaires réels qui ont marché :
${hallOfFame}

Les trois tons demandés :
${tones}

Règles dures, non négociables :
- Anglais, minuscules, une seule idée, ${COMMENT_OPPORTUNITY_MAX_COMMENT_LENGTH} caractères maximum.
- Aucun lien, aucun hashtag, aucune mention @, aucun appel à l'action.
- Ne jamais citer la chaîne, la playlist, la radio ni la marque comme une recommandation. Incarner le personnage est autorisé, se promouvoir ne l'est pas.
- Aucun emoji, sauf si un seul emoji est manifestement la meilleure réponse.
- Zéro affirmation factuelle sur ce que la vidéo contient au-delà de ce qui est fourni ci-dessous.
- Si le sujet touche à un décès, une tragédie, un procès, une maladie, une guerre ou la politique : ne rien proposer et le dire.
- Trois propositions distinctes, chacune sur un archétype différent.

Réponds uniquement par un objet JSON de la forme :
{"usable":true,"comments":[{"tone":"funny","archetype":"pen-down","text":"..."},{"tone":"smart","archetype":"...","text":"..."},{"tone":"complice","archetype":"...","text":"..."}]}
Si le sujet est inadapté : {"usable":false,"reason":"..."}`;

  const facts = [
    `Plateforme : ${opportunity.platform}`,
    `Compte : ${opportunity.author}`,
    `Titre : ${opportunity.title}`,
    opportunity.caption && opportunity.caption !== opportunity.title
      ? `Description : ${opportunity.caption.slice(0, 600)}`
      : null,
    `Thème : ${CATEGORY_BRIEFS[opportunity.category]}`,
    opportunity.publishedAt ? `Publié le : ${opportunity.publishedAt}` : null,
    opportunity.velocity
      ? `Vitesse mesurée : +${opportunity.velocity.perHour.toLocaleString("fr-FR")} ${opportunity.velocity.metric} par heure sur ${opportunity.velocity.windowHours} h`
      : "Vitesse : pas encore mesurée (un seul relevé).",
    opportunity.metrics.views !== null
      ? `Vues publiques au dernier relevé : ${opportunity.metrics.views.toLocaleString("fr-FR")}`
      : null,
    opportunity.momentTier === "s"
      ? "Poids : moment culturel majeur, la section de commentaires va être saturée en une heure."
      : null,
  ].filter(Boolean).join("\n");

  return {
    system,
    user: `Voici la vidéo sur laquelle Lofi Girl peut réagir.\n\n${facts}\n\nPropose les trois commentaires.`,
  };
}

export type LofiVoiceResult =
  | { usable: true; comments: CommentSuggestion[] }
  | { usable: false; reason: string };

/**
 * Parses and gates a model answer. A single unusable line invalidates the whole
 * triplet: publishing two good comments and one broken one is worse than
 * publishing none, because nobody re-reads the third.
 */
export function parseLofiVoiceResponse(raw: string): LofiVoiceResult {
  let payload: unknown;
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("aucun objet JSON");
    payload = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    return { usable: false, reason: `réponse illisible : ${error instanceof Error ? error.message : "inconnue"}` };
  }
  if (!payload || typeof payload !== "object") {
    return { usable: false, reason: "réponse vide" };
  }
  const answer = payload as { usable?: unknown; reason?: unknown; comments?: unknown };
  if (answer.usable === false) {
    return {
      usable: false,
      reason: typeof answer.reason === "string" && answer.reason.trim().length > 0
        ? answer.reason.trim()
        : "sujet écarté par le moteur de voix",
    };
  }
  if (!Array.isArray(answer.comments) || answer.comments.length !== 3) {
    return { usable: false, reason: "trois commentaires attendus" };
  }

  const wanted: CommentOpportunityTone[] = ["funny", "smart", "complice"];
  const comments: CommentSuggestion[] = [];
  const seen = new Set<string>();
  for (const tone of wanted) {
    const entry = (answer.comments as Array<{ tone?: unknown; text?: unknown }>).find(
      (candidate) => candidate?.tone === tone,
    );
    if (!entry) return { usable: false, reason: `ton manquant : ${tone}` };
    const verdict = validateLofiComment(entry.text);
    if (!verdict.ok) return { usable: false, reason: `${tone} rejeté (${verdict.reason})` };
    const text = entry.text as string;
    const normalized = text.toLocaleLowerCase("en");
    if (seen.has(normalized)) return { usable: false, reason: "deux propositions identiques" };
    seen.add(normalized);
    comments.push({ tone, label: LOFI_TONE_BRIEFS[tone].label, text });
  }
  return { usable: true, comments };
}

const CURATED_COMMENT_OVERRIDES: Record<
  string,
  Record<CommentOpportunityTone, string>
> = {
  "yt-meoj92ztopa-ab0a1a": {
    funny: "My study break just filed a flight plan on a Boeing 707.",
    smart: "Functional authenticity makes a simulator impossible to treat casually.",
    complice: "Famous Flyer 10 has officially cleared our homework for departure.",
  },
  "yt-aa4pyww2cyc-33e8bb": {
    funny: "Beating every game is a very ambitious definition of one study break.",
    smart: "‘Not ending’ turns a gaming challenge into an endurance syllabus.",
    complice: "Kai Cenat joining is exactly when tomorrow’s schedule stopped mattering.",
  },
  "yt-mt4bk1lw8g-4ced59": {
    funny: "Bloody Paradise just turned the study playlist into a full cinematic emergency.",
    smart: "THE SIN : BLISS makes contradiction feel like an entire visual language.",
    complice: "HATTRICK directed this; our untouched notes can direct complaints elsewhere.",
  },
  "yt-cn0drh49us-809077": {
    funny: "The snow swallowed every footprint and apparently my entire revision schedule.",
    smart: "Fog, frost, and a dreamscape make uncertainty feel strangely inviting.",
    complice: "I would absolutely take that wandering journey instead of finishing one more page.",
  },
  "yt-5rkhlxnknhu-6a67e0": {
    funny: "Sauron’s armies are advancing exactly when my assignment deadline starts advancing too.",
    smart: "‘Fear No Darkness’ is excellent advice for both the North and late-night studying.",
    complice: "Nintendo Switch 2 just made the North feel dangerously cozy tonight.",
  },
  "yt-49mtrzblgda-4b959a": {
    funny: "A24 said prepare for the Onslaught; my quiet evening filed an appeal.",
    smart: "That Adam Wingard cast list reads like controlled cinematic chaos.",
    complice: "September 4 is now circled with an unnecessarily dramatic amount of ink.",
  },
  "yt-fow9bq3mbq8-e2a29a": {
    funny: "Zero Hour has more coordination than my entire group project.",
    smart: "Every precise breach begins with the part squads usually skip: an actual plan.",
    complice: "Solo with AI squadmates sounds perfect for anyone whose group chat vanished.",
  },
  "yt-wrss65uindu-5ec3f7": {
    funny: "The Pitt said ‘back to it’ before my coffee had even agreed.",
    smart: "A January return gives ‘back to it’ a perfectly unforgiving meaning.",
    complice: "Season three is exactly when ‘one more episode’ becomes structurally impossible.",
  },
  "yt-bhyr1bpbyy-300fc3": {
    funny: "A World Cup final halftime sketch just benched my entire weekly schedule.",
    smart: "BTS turning a global final into a sketch is scale meeting playfulness.",
    complice: "2026 suddenly feels very real when this is already on the timeline.",
  },
  "yt-2x4ayn9a9ao-4efaa0": {
    funny: "Those big eyes said MORE before the demon even finished asking.",
    smart: "The demon wanting more is a surprisingly efficient lesson in escalation.",
    complice: "Episode one already has moderation leaving through the emergency exit.",
  },
  "yt-qawbxet88o-89d8d9": {
    funny: "That chip has more suspense than checking whether the assignment uploaded.",
    smart: "Dude Perfect knows a single question mark can carry an entire setup.",
    complice: "Bryson and that chip are exactly why the break keeps getting longer.",
  },
  "yt-syehkmfswhk-7d3ce1": {
    funny: "Night City paired a washed-up edgerunner with a killer netrunner; very calm choice.",
    smart: "A standalone ten-episode story makes chaos feel almost responsibly scheduled.",
    complice: "October 20 just became the deadline my calendar will actually respect.",
  },
  "yt-wkra3yuozkm-fb4f11": {
    funny: "Bloody Paradise needed only two words to cancel tonight’s productivity.",
    smart: "The official MV framing turns Bloody Paradise from a phrase into a whole world.",
    complice: "ENHYPEN is going straight between the focus tracks tonight.",
  },
  "yt-rvzvq0qazvq-b4677a": {
    funny: "A thousand creators and players at COD Next; my focus left the lobby.",
    smart: "Core 6v6, Warzone, and Zodiac make this showcase feel densely engineered.",
    complice: "Modern Warfare 4 arriving mid-study session is extremely on brand for us.",
  },
  "yt-on7ifwoihew-b160c1": {
    funny: "Counter-Strike turns one round into midnight with suspicious efficiency.",
    smart: "‘Caught up in the moment’ is the most honest possible session timer.",
    complice: "Ludwig just documented the point where our schedules quietly surrendered.",
  },
  "yt-9rmxngbvpa-acb791": {
    funny: "A city on a Space Whale makes my desk setup feel underambitious.",
    smart: "Managing supply chains on a Space Whale is peak cosmic urban planning.",
    complice: "October 15, we are apparently moving the study room into space.",
  },
  "yt-vnz0dfvqj5m-168416": {
    funny: "The Terminal List gained a second season; my to-do list gained nothing.",
    smart: "Calling it an official teaser is brave when one title already resets the mood.",
    complice: "Prime Video put another title on the list we were pretending not to keep.",
  },
  "yt-8b07gufyuji-5cc71d": {
    funny: "Ruche said run away together; the group project officially lost another member.",
    smart: "Knowing the game system turns the so-called weakest class into strategy.",
    complice: "Those big-ticket items found Ruche and Elymas before our motivation found us.",
  },
  "yt-f0qgxeaike-ed7481": {
    funny: "Bachiko meeting her natural enemy has more tension than my untouched deadline.",
    smart: "A natural enemy is the fastest way to turn one lesson into a rivalry.",
    complice: "Season four gave Bachiko a problem; our study group immediately took notes.",
  },
  "yt-mfmdxpt7nam-89978d": {
    funny: "One month of saying yes to every email is inbox horror with a calendar.",
    smart: "Repeating the experiment proves one month can turn availability into a full-time system.",
    complice: "We saw ‘again’ and knew the inbox had already won once.",
  },
  "yt-avwffq3xlyc-8ace84": {
    funny: "This week on Xbox has more chapters than the notebook I keep avoiding.",
    smart: "Putting S.T.A.L.K.E.R. beside Mortal Shell II makes this lineup feel relentlessly atmospheric.",
    complice: "Call of Duty, Mortal Shell II, then Forza; there goes the quiet study break.",
  },
  "yt-um3k9v4lkoa-0dedd8": {
    funny: "Ito tried helping Syu; my group project could use that level of optimism.",
    smart: "Moving Ito from only child to eldest sister makes every quiet moment newly complicated.",
    complice: "Reclusive Syu meeting determined Ito is exactly the sibling energy we stayed for.",
  },
  "yt-nna95q3pzto-513663": {
    funny: "An NBA star attempting the impossible shot while my pencil misses the cup.",
    smart: "Calling it an impossible shot turns one attempt into a complete suspense engine.",
    complice: "Dude Perfect found the one shot worth pausing the study timer for.",
  },
  "yt-sdhz4gzglkg-6b1850": {
    funny: "Final-arc battles in 3v3; my study group barely survives one shared document.",
    smart: "Turning the final arc into 3v3 combat makes teamwork part of the storytelling.",
    complice: "September 4 just became the deadline our Nintendo Switch 2 will actually respect.",
  },
  "yt-na14zezutp8-553e91": {
    funny: "Cap versus Red Skull is a slightly louder study-break debate than planned.",
    smart: "Revisiting The First Avenger makes Cap’s original conflict feel newly foundational.",
    complice: "One Cap versus Red Skull clip and the whole evening becomes a rewatch.",
  },
  "yt-qegdhu8ptc-076125": {
    funny: "Marvel gathered every creator; my group chat still cannot pick one reaction.",
    smart: "Collecting reactions in real time turns a special look into a shared premiere.",
    complice: "December 18 feels closer once the entire creator timeline reacts together.",
  },
  "yt-yikfqaz3xq-56b83d": {
    funny: "An underwater soulslike starring a crab; finally, procrastination with a shell.",
    smart: "Making a crustacean the hero gives soulslike difficulty a wonderfully playful contrast.",
    complice: "Free Switch 2 upgrade means our study break just grew another shell.",
  },
  "yt-rrfjvp6quw-b08616": {
    funny: "Twenty hours of battery is enough to ignore an impressive number of deadlines.",
    smart: "H2, stronger noise cancellation, and USB-C lossless make this a focused generational update.",
    complice: "Personalized Spatial Audio and five colors; the study playlist just got ambitious.",
  },
  "yt-encmlxqbvra-5f2506": {
    funny: "Tems brought What You Need; apparently what I needed was another study break.",
    smart: "A COLORS MOMENT lets one song title carry the entire atmosphere.",
    complice: "What You Need is going straight between the focus tracks tonight.",
  },
  "yt-zxu4v1qjssg-e24592": {
    funny: "A new class of talent arrived before I finished the old class notes.",
    smart: "Pairing Netflix icons with emerging talent makes legacy feel like a conversation.",
    complice: "Netflix icons meeting a new class is the crossover our watchlist needed.",
  },
  "yt-tjbzmqjgh4k-4e05af": {
    funny: "An extended look at GTA VI just shortened every plan I had tonight.",
    smart: "Calling it an extended look makes patience sound like an optional game mechanic.",
    complice: "Same desk, new GTA VI footage, absolutely no progress on the next page.",
  },
  "yt-zvcqhurhzwi-533a73": {
    funny: "A Parallel World opened and my assignment apparently stayed in this one.",
    smart: "Open Mic keeps A Parallel World focused on the performance itself.",
    complice: "BINI made the parallel world our whole study room for tonight.",
  },
  "yt-opgr9gc5ozk-4bfbb2": {
    funny: "You Just Made My Night also made tomorrow's notes considerably less complete.",
    smart: "YOU JUST MADE MY NIGHT turns a message into the entire mood.",
    complice: "LE SSERAFIM named exactly what happened to this late-night study session.",
  },
  "yt-fivctzmv4xo-54f510": {
    funny: "Rockstar explained stealing cars; my focus disappeared without any explanation.",
    smart: "Changing how you steal cars is a surprisingly precise GTA 6 promise.",
    complice: "We came for Rockstar Explains and left with a postponed deadline.",
  },
  "yt-98fohkdonau-b5b822": {
    funny: "Gamescom Day 2 arrived before Day 1 left my browser tabs.",
    smart: "A Day 2 broadcast makes gamescom feel less like an event than a season.",
    complice: "XBOX kept Day 2 rolling; our study timer quietly stopped counting.",
  },
  "yt-migclaow9ki-76115e": {
    funny: "A live GTA 6 reaction has more volume than my deadline alarm.",
    smart: "Reacting live turns the new GTA 6 trailer into a shared countdown.",
    complice: "IShowSpeed pressed LIVE and every quiet study plan left the chat.",
  },
  "yt-wsm9gtuttbs-91d853": {
    funny: "Extended gameplay, abbreviated attention span; GTA 6 did the math.",
    smart: "Calling this official extended gameplay makes a trailer feel almost too modest.",
    complice: "We all saw extended gameplay and moved one deadline into next week.",
  },
  "yt-uphthaa97ig-e9c41b": {
    funny: "Netflix said Now Playing; my notebook heard Not Happening Tonight.",
    smart: "Now Playing turns an extended GTA VI look into appointment viewing.",
    complice: "GTA VI reached Netflix and somehow our study break got extended too.",
  },
  "yt-xe3qx0kxara-462c33": {
    funny: "A Doomsday countdown podcast is extremely calm material for the study desk.",
    smart: "A special look delivered as a podcast makes anticipation do the visual work.",
    complice: "We heard Countdown to Avengers: Doomsday and immediately checked every calendar.",
  },
  "yt-v3qx5b0geg-e071ed": {
    funny: "The Avengers joined a podcast and my revision team instantly lost quorum.",
    smart: "Centering The Avengers makes the Doomsday countdown feel like a roll call.",
    complice: "Everyone at this desk heard The Avengers and quietly joined the countdown.",
  },
  "yt-ghsrc0r1a2a-160ef2": {
    funny: "SODA SODA doubled the title and halved tonight's remaining concentration.",
    smart: "Calling it a performance film gives SODA SODA room beyond one format.",
    complice: "TWS brought SODA SODA; the late-night study playlist made room.",
  },
  "yt-xwdamnfs6im-185550": {
    funny: "The Love Hypothesis arrived right when my deadline needed peer review.",
    smart: "A title like The Love Hypothesis makes romance sound beautifully testable.",
    complice: "Prime Video submitted The Love Hypothesis; our study group accepts the premise.",
  },
  "yt-yqai0oqtt7w-202112": {
    funny: "Dust is not what I think; neither is this revision schedule.",
    smart: "Dust Is Not What You Think turns its own title into productive doubt.",
    complice: "Kurzgesagt questioned dust and now every desk particle feels suspicious.",
  },
  "yt-q7wqli6pxpe-6d6f4a": {
    funny: "How many bounces before this officially becomes a study-break experiment?",
    smart: "How Many Bounces builds suspense from a question with no wasted words.",
    complice: "Dude Perfect asked one question; this desk is waiting for the count.",
  },
  "yt-t6fxf4pmvvc-bf3b17": {
    funny: "12 12 12 is either a date or my new study timer malfunction.",
    smart: "Repeating 12 three times makes a date announcement instantly mnemonic.",
    complice: "Apple TV gave us 12 12 12; the calendar finally feels cinematic.",
  },
  "yt-b3kpfdb1pw8-8ce432": {
    funny: "MKBHD locked an iPhone; my focus remains significantly easier to steal.",
    smart: "Taking $10,000 from a locked iPhone turns security into a very expensive puzzle.",
    complice: "A locked iPhone, MKBHD, and $10,000 already have this desk invested.",
  },
  "yt-h06xkc1nju-937794": {
    funny: "She left one sentence unfinished and somehow my entire study group needs answers.",
    smart: "What did she mean turns missing context into the whole reason to watch.",
    complice: "Ludwig asked the question and now nobody at this desk is moving on.",
  },
};

export function curatedLofiComments(
  opportunity: Pick<CommentOpportunity, "id">,
): CommentSuggestion[] | null {
  const override = CURATED_COMMENT_OVERRIDES[opportunity.id];
  if (!override) return null;
  return (["funny", "smart", "complice"] as CommentOpportunityTone[]).map((tone) => {
    const text = override[tone];
    const verdict = validateLofiComment(text);
    if (!verdict.ok) {
      throw new Error(`Commentaire éditorial ${tone} invalide pour ${opportunity.id}: ${verdict.reason}`);
    }
    return { tone, label: LOFI_TONE_BRIEFS[tone].label, text };
  });
}

/**
 * Metadata-grounded lines used only when the voice engine is unavailable.
 * Every sentence names a short anchor extracted from the post title (or, when
 * needed, its caption/author). That keeps the degraded mode useful without
 * pretending that metadata proves something visible inside the video.
 */
const FALLBACK_TEMPLATES: Record<
  CommentOpportunityTone,
  readonly ((anchor: string) => string)[]
> = {
  funny: [
    (anchor) => `apparently ${anchor} is what finally closed the notebook`,
    (anchor) => `${anchor} just moved the revision plan to tomorrow`,
    (anchor) => `the pen lasted eight years but ${anchor} got it`,
    (anchor) => `pocky saw ${anchor} and approved one study break`,
    (anchor) => `${anchor} was not on the syllabus, somehow it is now`,
    (anchor) => `one tab for notes, one tab for ${anchor}, priorities`,
  ],
  smart: [
    (anchor) => `${anchor} is a very precise title for tonight's distraction`,
    (anchor) => `the title ${anchor} already knows where the attention is going`,
    (anchor) => `${anchor} turns the study break into the main event`,
    (anchor) => `there is the assignment, and then there is ${anchor}`,
    (anchor) => `${anchor} makes a quiet case for closing the notebook`,
    (anchor) => `the timing of ${anchor} is doing real damage to the schedule`,
  ],
  complice: [
    (anchor) => `everyone who paused at ${anchor}, the study session understands`,
    (anchor) => `we all read ${anchor} and silently moved the deadline`,
    (anchor) => `${anchor} found the exact corner of the internet avoiding homework`,
    (anchor) => `the late-night study table has made room for ${anchor}`,
    (anchor) => `if ${anchor} interrupted your notes too, same desk`,
    (anchor) => `the group project can wait; ${anchor} has the room`,
  ],
};

const FALLBACK_TITLE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "announcement",
  "arrested",
  "are",
  "at",
  "be",
  "been",
  "being",
  "by",
  "can",
  "cancer",
  "could",
  "date",
  "dead",
  "death",
  "died",
  "did",
  "do",
  "does",
  "every",
  "for",
  "from",
  "ft",
  "funeral",
  "game",
  "games",
  "get",
  "got",
  "had",
  "has",
  "have",
  "i",
  "in",
  "is",
  "it",
  "just",
  "make",
  "more",
  "murder",
  "mv",
  "not",
  "of",
  "official",
  "on",
  "or",
  "politics",
  "shooting",
  "should",
  "suicide",
  "this",
  "tragedy",
  "the",
  "to",
  "trailer",
  "teaser",
  "until",
  "video",
  "version",
  "war",
  "was",
  "we",
  "were",
  "will",
  "with",
  "would",
  "wants",
  "you",
]);

function metadataWords(value: string) {
  const cleaned = value.normalize("NFKC")
    .replace(/https?:\/\/\S+|www\.\S+/giu, " ")
    .replace(/&(?:#\d+|#x[\da-f]+|[a-z]+);/giu, " ")
    .replace(/\b(?:ft|feat)\.?\b/giu, "with")
    .replace(/\b(?:official\s+)?(?:trailer|teaser|music\s+video|mv)\b.*$/giu, " ");
  return (cleaned.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [])
    .map((word) => word.replace(/’/gu, "'").toLocaleLowerCase("en"));
}

function boundedAnchor(words: string[]) {
  const selected: string[] = [];
  for (const word of words) {
    if (selected.length >= 10) break;
    const candidate = [...selected, word].join(" ");
    if (candidate.length > 52) break;
    selected.push(word);
  }
  return selected.join(" ");
}

function fallbackContextAnchor(
  opportunity: Pick<CommentOpportunity, "title" | "caption" | "author">,
) {
  const titleSegments = opportunity.title.split(/\s+(?:\||[-–—])\s+/gu);
  const captionSegments = opportunity.caption.split(/[\r\n]+|\s+(?:\||[-–—])\s+/gu);
  const candidates = [
    ...titleSegments,
    ...captionSegments,
    opportunity.author.replace(/^@/u, ""),
  ];
  for (let candidate of candidates) {
    const colon = candidate.indexOf(":");
    if (colon > 0 && SENSITIVE_COMMENT_PATTERN.test(candidate.slice(colon + 1))) {
      candidate = candidate.slice(0, colon);
    }
    const words = metadataWords(candidate).filter(
      (word) => !SENSITIVE_COMMENT_PATTERN.test(word),
    );
    const hasSpecificWord = words.some((word) => !FALLBACK_TITLE_STOPWORDS.has(word));
    const anchor = hasSpecificWord ? boundedAnchor(words) : "";
    if (anchor) return anchor;
  }
  throw new Error("Aucun détail textuel exploitable pour les commentaires de secours.");
}

function stableIndex(seed: string, length: number) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return hash % length;
}

export function fallbackLofiComments(
  opportunity: Pick<CommentOpportunity, "id" | "title" | "caption" | "author">,
  reservedTexts: Set<string> = new Set(),
): CommentSuggestion[] {
  const anchor = fallbackContextAnchor(opportunity);
  return (Object.keys(FALLBACK_TEMPLATES) as CommentOpportunityTone[]).map((tone) => {
    const templates = FALLBACK_TEMPLATES[tone];
    const start = stableIndex(`${opportunity.id}:${tone}`, templates.length);
    const candidates = Array.from({ length: templates.length }, (_, offset) =>
      templates[(start + offset) % templates.length](anchor)
    );
    for (const preferredLength of [true, false]) {
      for (const text of candidates) {
        const normalized = text.normalize("NFKC").toLocaleLowerCase("en");
        const wordCount = metadataWords(text).length;
        if (preferredLength && (wordCount < 8 || wordCount > 18)) continue;
        if (reservedTexts.has(normalized)) continue;
        const verdict = validateLofiComment(text);
        if (!verdict.ok) continue;
        reservedTexts.add(normalized);
        return {
          tone,
          label: LOFI_TONE_BRIEFS[tone].label,
          text,
        };
      }
    }
    throw new Error(`Impossible de produire un commentaire ${tone} distinct pour ${opportunity.id}.`);
  });
}

export type LofiVoiceRequestOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  model?: string;
  timeoutMs?: number;
};

/**
 * One call per video. The canon block is marked for prompt caching because it
 * is identical across every call of a run and is by far the largest part.
 */
export async function requestLofiComments(
  opportunity: Parameters<typeof buildLofiCommentPrompt>[0],
  options: LofiVoiceRequestOptions,
): Promise<LofiVoiceResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const prompt = buildLofiCommentPrompt(opportunity);
  const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": options.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: options.model ?? LOFI_VOICE_MODEL,
      max_tokens: 400,
      temperature: 1,
      system: [
        { type: "text", text: prompt.system, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: prompt.user }],
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
  });
  if (!response.ok) {
    return {
      usable: false,
      reason: `moteur de voix indisponible (HTTP ${response.status})`,
    };
  }
  const payload = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = (payload.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
  if (text.trim().length === 0) {
    return { usable: false, reason: "réponse vide du moteur de voix" };
  }
  return parseLofiVoiceResponse(text);
}
