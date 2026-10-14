const $ = (id) => document.getElementById(id);

const defaults = {
  settings: {
    workerUrl: "",
    appPassword: "",
    model: "openrouter/free",
    temperature: 0.9,
    maxTokens: 900
  },
  scenario: {
    title: "Trapped Hearts-ish Test",
    spiceBalance: 30,
    playerName: "Olivia",
    playerNotes: "A sharp, ambitious attorney. The USER controls Olivia completely.",
    npcNotes: "Caleb Quinn — Olivia's brilliant, infuriating colleague. Confident, observant, dryly funny, and much more emotionally perceptive than Olivia gives him credit for.",
    premise: "Olivia and Caleb are rival attorneys at the same firm. After months of professional friction and unresolved attraction, they become trapped together in an elevator during a blackout. The story should unfold as a contained forced-proximity romance with gradual reveals, tension, banter, and a clear forward-moving plot.",
    styleNotes: "Write immersive contemporary-romance prose with strong dialogue, chemistry, sensory detail, and natural pacing. Advance the situation without rushing major emotional or romantic beats.",
    boundaryNotes: "All characters are adults. Respect consent. Do not decide the player's choices for them."
  },
  messages: [],
  memory: {
    summary: "",
    through: 0
  }
};

const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const makeStory = (scenario = defaults.scenario, messages = [], memory = defaults.memory, guardLessons = []) => ({
  scenario: { ...defaults.scenario, ...scenario },
  messages: Array.isArray(messages) ? messages : [],
  memory: { ...defaults.memory, ...memory },
  guardLessons: Array.isArray(guardLessons) ? [...guardLessons] : [],
  updatedAt: new Date().toISOString()
});

// Every boot-time localStorage read goes through safeParse. A single corrupt
// byte must never white-screen the app or trap stories inside it: corrupt keys
// fall back to defaults, the raw bytes are preserved under a
// "<key>.corrupt-<timestamp>" backup on first save, and a recovery banner keeps
// Export reachable.
const bootCorrupt = { keys: [], raw: {} };
function safeParse(key, fallback) {
  let raw = null;
  try { raw = localStorage.getItem(key); } catch { return fallback; }
  if (raw === null || raw === undefined) return fallback;
  try {
    const value = JSON.parse(raw);
    return value === null || value === undefined ? fallback : value;
  } catch {
    if (!bootCorrupt.keys.includes(key)) {
      bootCorrupt.keys.push(key);
      bootCorrupt.raw[key] = raw;
    }
    return fallback;
  }
}

function normalizeTrash(trash) {
  const t = (trash && typeof trash === "object") ? trash : {};
  return {
    sessions: Array.isArray(t.sessions) ? t.sessions : [],
    profiles: Array.isArray(t.profiles) ? t.profiles : []
  };
}

const isLiveStory = story => Boolean(story) && !story.deletedAt;
const liveStoryIds = () => Object.keys(storyLibrary.stories || {}).filter(id => isLiveStory(storyLibrary.stories[id]));

let storyLibrary = safeParse("rp.stories", null);
if (!storyLibrary || !storyLibrary.stories || !Object.keys(storyLibrary.stories).length) {
  const migratedId = makeId();
  storyLibrary = {
    version: 1,
    activeId: migratedId,
    stories: {
      [migratedId]: makeStory(
        safeParse("rp.scenario", {}),
        safeParse("rp.messages", []),
        safeParse("rp.memory", {})
      )
    },
    profiles: [],
    trash: { sessions: [], profiles: [] }
  };
}
storyLibrary.profiles = Array.isArray(storyLibrary.profiles) ? storyLibrary.profiles : [];
storyLibrary.trash = normalizeTrash(storyLibrary.trash);
storyLibrary.rewindSnapshots = Array.isArray(storyLibrary.rewindSnapshots) ? storyLibrary.rewindSnapshots : [];
if (!isLiveStory(storyLibrary.stories[storyLibrary.activeId])) {
  storyLibrary.activeId = liveStoryIds()[0];
}
if (!storyLibrary.activeId) {
  // Every story is tombstoned (can't happen via the UI, but a damaged cloud
  // copy could). Never strand the app without a live story.
  const freshId = makeId();
  storyLibrary.stories[freshId] = makeStory({ ...defaults.scenario, title: "New Story" });
  storyLibrary.activeId = freshId;
}

let state = {
  settings: { ...defaults.settings, ...safeParse("rp.settings", {}) },
  ...storyLibrary.stories[storyLibrary.activeId]
};
state.guardLessons = Array.isArray(state.guardLessons) ? state.guardLessons : [];
let pendingViolation = null;
let pendingViolationDetail = null;
function clearPendingViolation() {
  pendingViolation = null;
  pendingViolationDetail = null;
}
const SYNC_STORAGE_KEY = "rp.cloudSync.v1";
const PRE_CONNECT_RECOVERY_KEY = "rp.preConnectRecovery.v1";
let cloudSync = safeParse(SYNC_STORAGE_KEY, null);
cloudSync = {
  enabled: false,
  code: "",
  revision: 0,
  lastSyncedAt: "",
  autoSync: true,
  ...((cloudSync && typeof cloudSync === "object") ? cloudSync : {})
};
const syncRuntime = { ready: false, busy: false, timer: null };
let turnInFlight = false;
// Non-canon, per-device request feedback. Never mix API errors into the story transcript.
let turnNotice = null;
let editingProfileId = null;
storyLibrary.updatedAt = storyLibrary.updatedAt || Object.values(storyLibrary.stories)
  .map(story => story.updatedAt || "")
  .sort()
  .at(-1) || new Date().toISOString();

const FRIENDLY_KEY_NAMES = {
  "rp.stories": "stories",
  "rp.settings": "settings",
  "rp.scenario": "old scenario",
  "rp.messages": "old messages",
  "rp.memory": "old memory",
  "rp.cloudSync.v1": "sync connection"
};

// Preserve the raw bytes of any corrupt boot key exactly once, so a damaged
// copy can still be recovered after the app keeps working on fallbacks.
function preserveCorruptBootKeys() {
  if (!bootCorrupt.keys.length) return;
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "");
  bootCorrupt.keys.forEach(key => {
    try { localStorage.setItem(`${key}.corrupt-${stamp}`, bootCorrupt.raw[key]); } catch { /* best effort */ }
  });
  bootCorrupt.keys.length = 0;
}

function showRecoveryBanner() {
  const banner = $("recoveryBanner");
  if (!banner) return;
  const names = bootCorrupt.keys.map(key => FRIENDLY_KEY_NAMES[key] || key).join(", ");
  $("recoveryBannerText").textContent =
    `Some saved data couldn't be read (${names}) and was reset to defaults. ` +
    `The damaged copy was preserved in this browser's storage — export a backup now, and don't clear site storage.`;
  banner.hidden = false;
}

function showStorageBanner() {
  const banner = $("storageBanner");
  if (banner) banner.hidden = false;
}

function save(options = {}) {
  preserveCorruptBootKeys();
  const now = new Date().toISOString();
  storyLibrary.stories[storyLibrary.activeId] = {
    scenario: state.scenario,
    messages: state.messages,
    memory: state.memory,
    guardLessons: state.guardLessons,
    updatedAt: now
  };
  storyLibrary.updatedAt = now;
  try {
    localStorage.setItem("rp.settings", JSON.stringify(state.settings));
    localStorage.setItem("rp.stories", JSON.stringify(storyLibrary));
  } catch (error) {
    // QuotaExceededError (iOS Safari ~5MB cap) or any other write failure. The
    // in-memory state is intact and the UI keeps working; the scheduled cloud
    // push below can still rescue the newest data. Never let a failed write
    // silently kill the app.
    console.warn("RP Studio: local save failed:", error);
    showStorageBanner();
  }
  if (!options.skipSync) scheduleCloudPush();
}

function activateStory(id) {
  if (!isLiveStory(storyLibrary.stories[id])) return;
  clearPendingViolation();
  save();
  storyLibrary.activeId = id;
  const story = storyLibrary.stories[id];
  state = { settings: state.settings, scenario: { ...story.scenario }, messages: [...story.messages], memory: { ...story.memory }, guardLessons: Array.isArray(story.guardLessons) ? [...story.guardLessons] : [] };
  save();
  render();
}

// This is an adjustable pacing preference, not an explicitness control.
function normalizeSpiceBalance(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n / 5) * 5)) : 30;
}
function updateSpiceOutput(inputId, outputId) {
  const input = $(inputId), n = normalizeSpiceBalance(input.value);
  $(outputId).textContent = `${n}% spice · ${100 - n}% story`;
  input.setAttribute("aria-valuetext", `${n} percent spice, ${100 - n} percent story`);
}
function spicePacingInstruction(value) {
  const spice = normalizeSpiceBalance(value), plot = 100 - spice;
  let emphasis;
  if (spice <= 10) emphasis = "Favor plot, dialogue, and character development. Do not initiate new sexual or overtly suggestive beats.";
  else if (spice <= 30) emphasis = "Prioritize plot, conflict, secrets, humor, and emotional growth. Flirting and intimacy can happen when earned, rather than being the default reaction to every interaction.";
  else if (spice <= 60) emphasis = "Balance romantic and sensual tension with plot, character complexity, quiet moments, humor, and independent goals.";
  else if (spice <= 85) emphasis = "Lean toward romance and intimacy without neglecting meaningful plot progress and the NPCs' independent lives.";
  else emphasis = "Favor romance and intimate storytelling where it fits naturally, while preserving genuine emotional depth, continuity, and plot movement.";
  return `STORY / SPICE BALANCE (PACING, NOT EXPLICITNESS)
The preference for this story is about ${plot}% plot, character development, and non-intimate storytelling versus ${spice}% romance, sexual tension, and intimacy over the longer narrative. This is a LOOSE GUIDELINE across many scenes, NEVER a quota for each turn or a request to insert sex at fixed intervals. ${emphasis}
Do not abruptly interrupt, terminate, or redirect an ongoing intimate or non-intimate scene solely to satisfy the balance. Allow transitions to unfold organically. NPCs must remain multifaceted people with distinct goals, conflict, vulnerabilities, and agency, not one-dimensional seducers. Respect consent and the established content boundaries. NEVER write the player character's dialogue, actions, thoughts, feelings, reactions, decisions, or consent. The user's instructions for the current scene take priority over this general pacing preference.`;
}
function systemPrompt() {
  const s = state.scenario;
  const learnedCorrections = state.guardLessons.length
    ? `\n\nSTORY-SPECIFIC CORRECTIONS LEARNED FROM THE USER\n${state.guardLessons.map(note => `- ${note}`).join("\n")}\nTreat these as binding guardrails. Do not mention them in the prose.`
    : "";
  return `ROLE CONTRACT
This is turn-based interactive fiction with a strict division of control.
- USER role: ${s.playerName}. The user's latest message is completed, immutable canon.
- ASSISTANT role: every NPC plus the objective environment.

NPC CAMERA
Continue only with NPC dialogue, NPC behavior, NPC thoughts, and objective events after the user's completed turn. The narrative camera may observe what NPCs do around ${s.playerName}, but it never supplies the player character's next action, words, thought, feeling, sensation, expression, perception, or decision. An NPC may address or approach the player in dialogue/action. Stop before the player's response is determined.

PLAYER POV FIREWALL
The user's prose may use first person, second person, or third person. Never mirror the user's player-character POV. In assistant narration, never use "you" or "your" and never use ${s.playerName} (or a pronoun referring to ${s.playerName}) as the subject of a new action, movement, posture, expression, sensation, perception, recognition, thought, feeling, conclusion, or decision. Treat every player action and position in the latest user message as finished and frozen at the handoff: do not extend it, restage it, paraphrase it, or add body language. Start with an NPC or an objective environmental event and write around the player. "You" may appear only inside NPC dialogue addressed to the player.

NPC KNOWLEDGE FIREWALL
An NPC may know only facts that the transcript or continuity memory establishes the NPC personally witnessed, was told, discovered, or obtained through a specifically established source. Player notes, premise information, narration from the player's perspective, and the player's private thoughts, feelings, motives, medical details, messages, or memories are not automatically known to NPCs. Never convert private setup information into NPC intuition, facial-reading, body-language deduction, convenient surveillance, off-page research, or an invented earlier conversation. If an NPC lacks an established source, preserve that uncertainty and ask or investigate. If the player challenges an NPC's knowledge, do not defend a continuity mistake by fabricating evidence; correct the contradiction unless the existing canon already establishes that the NPC is knowingly lying.

CHRONOLOGY / NO-REPLAY FIREWALL
Time moves forward from the latest valid turn. Treat every completed scene, phone call, conversation, revelation, action, arrival, departure, and exchange in the transcript or continuity memory as already happened. Never reenact, restart, or reproduce completed dialogue or events, even with paraphrased wording. Earlier events may be referenced briefly only when an NPC has a present reason to recall them. Continuity memory is reference material, not prose to reproduce. A flashback or deliberate repetition is allowed only when the user explicitly requests it. If uncertain whether an event already happened, preserve the current timeline and avoid repeating it. Let an NPC respond to the present facts or introduce a new, grounded development instead of stalling.

NPC INITIATIVE AND TURN SHAPE
Always produce a substantive in-world continuation after the player's latest message. If the player directly asks an NPC a question, the NPC must react and meaningfully answer, even if the truthful answer is uncertainty, a refusal grounded in their personality, or a request for clarification. Do not evade a question by handing the turn back without prose.
NPCs have their own goals and initiative: they can make plans, take actions, talk to each other, bring forward credible information, call someone, change course, or trigger a logical plot development. They do not need the player to authorize their own actions. Keep changes consistent with established knowledge, chronology, and tone.
Write one to three purposeful NPC-led paragraphs by default, expanding naturally if a scene needs it. Advance meaningful plot, relationship or tension. End on an NPC line, action, or unfolding event that gives the player a natural opportunity to respond. Never supply that response yourself.
Never stall, output a handoff marker, or create an out-of-story instruction telling the player to continue. Do not present a menu of choices. Do not repeat the user's prose. Write polished story prose only, without analysis, labels, or format tags.

STORY PREMISE
${s.premise}

PLAYER REFERENCE — FACTS ONLY, NOT AN ASSISTANT ROLE
${s.playerName}: ${s.playerNotes}

NPC / CAST
${s.npcNotes}

${spicePacingInstruction(s.spiceBalance)}

WRITING STYLE
${s.styleNotes}

CONTENT BOUNDARIES
${s.boundaryNotes}${learnedCorrections}`;
}

const MAX_GUARD_LESSONS = 12;
function rememberGuardLesson(note) {
  const cleaned = String(note || "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!cleaned) return;
  const duplicate = state.guardLessons.some(item => item.toLowerCase() === cleaned.toLowerCase());
  if (duplicate) return;
  const wasFull = state.guardLessons.length >= MAX_GUARD_LESSONS;
  state.guardLessons = [...state.guardLessons, cleaned].slice(-MAX_GUARD_LESSONS);
  if (wasFull) {
    appendVisual("system", "Guardrails full", `This story already had ${MAX_GUARD_LESSONS} learned guardrails, so the oldest one was dropped to make room. Remove outdated lessons under ✦ Edit story → Learned guardrails.`);
    $("chat").scrollTop = $("chat").scrollHeight;
  }
}

function cleanStoryReply(raw) {
  const text = String(raw || "").trim();
  const tagged = [...text.matchAll(/<story>([\s\S]*?)<\/story>/gi)];
  if (tagged.length) return tagged[tagged.length - 1][1].trim();

  // Conservative fallback for models that ignore the required tags but print
  // their planning around a clearly marked final draft.
  const draftMarker = text.toLowerCase().lastIndexOf("let's write:");
  let cleaned = draftMarker >= 0 ? text.slice(draftMarker + "let's write:".length).trim() : text;
  // Some models emit the opening tag but forget the closing tag. Strip any
  // orphaned output markers so they can never appear in the story card.
  cleaned = cleaned.replace(/<\/?story\b[^>]*>/gi, "").trim();
  // A few RP models echo a final instruction header before the prose. It is
  // never story content, so discard that first line instead of displaying it.
  if (/^(?:NEXT NPC TURN|REPAIR REQUEST|ONE-TURN CORRECTION)\s*:/i.test(cleaned)) {
    const firstLineEnd = cleaned.indexOf("\n");
    cleaned = firstLineEnd >= 0 ? cleaned.slice(firstLineEnd + 1).trim() : "";
  }
  const trailingMeta = cleaned.search(/\n\s*\n(?:we must (?:ensure|check|avoid)|self-check:|analysis:)/i);
  if (trailingMeta >= 0) cleaned = cleaned.slice(0, trailingMeta).trim();
  return cleaned;
}

function isNaturalHandoff(reply) {
  // Legacy models may still return the old token. Treat it as an empty output,
  // but never mistake a story containing that text for a pure handoff.
  return /^<handoff>\s*CONTINUE\s*<\/handoff>$/i.test(String(reply || "").trim());
}

function narrationWithoutDialogue(reply) {
  // Ignore speech, not narration. NPCs may address the player as "you".
  // Support double, curly and single-quoted dialogue, while keeping
  // contractions and possessives (e.g., "don't" and "Matteo's") intact.
  const input = String(reply || "");
  let output = "";
  let closingQuote = "";
  const word = char => /[\p{L}\p{N}]/u.test(char || "");
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const prev = input[i - 1] || "";
    const next = input[i + 1] || "";
    const innerApostrophe = (char === "'" || char === "’") && word(prev) && word(next);
    if (closingQuote) {
      if (char === closingQuote && !innerApostrophe) closingQuote = "";
      output += char === "\n" ? "\n" : " ";
    } else if (char === "“" || char === "„") {
      closingQuote = "”";
      output += " ";
    } else if (char === '"') {
      closingQuote = '"';
      output += " ";
    } else if (char === "‘") {
      closingQuote = "’";
      output += " ";
    } else if (char === "'" && !word(prev) && next && !/\s/.test(next)) {
      closingQuote = "'";
      output += " ";
    } else {
      output += char;
    }
  }
  return output;
}

function latestUserText() {
  return [...state.messages].reverse().find(message => message.role === "user")?.content || "";
}

function canonAlreadyContains(fragment) {
  const normalize = value => String(value || "").toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9']+/g, " ").trim();
  const candidate = normalize(fragment);
  const canon = normalize(latestUserText());
  return candidate.length >= 8 && canon.includes(candidate);
}

function excerptAround(text, index, length) {
  const start = Math.max(0, String(text).lastIndexOf("\n", index - 1) + 1);
  const nextBreak = String(text).indexOf("\n", index + length);
  const end = nextBreak < 0 ? String(text).length : nextBreak;
  return String(text).slice(start, end).trim();
}

function findAgencyViolation(reply) {
  // NPC dialogue may address, challenge, or speculate about the player freely.
  // Only narration and dialogue explicitly attributed to the player are tested.
  const narrationOnly = narrationWithoutDialogue(reply);
  const secondPerson = /\b(?:you|your|yours|yourself|you're|you've|you'll|you'd)\b/i.exec(narrationOnly);
  if (secondPerson) return { type: "Second-person player narration", excerpt: secondPerson[0] };

  const rawNameParts = String(state.scenario.playerName || "")
    .split(/\s+/)
    .filter(part => part.length > 1);
  if (!rawNameParts.length) return null;
  const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fullName = escapeRegex(rawNameParts.join(" "));
  const nameParts = rawNameParts.map(escapeRegex);
  const playerRef = `(?:${[fullName, ...nameParts].join("|")})`;

  // Player named as the subject of an action, perception, decision, speech,
  // movement, or state. Harmless object references such as "behind Jace" pass.
  const playerVerbs = "(?:grins?|grinned|smirks?|smirked|flinches?|flinched|blinks?|blinked|steps?|stepped|moves?|moved|walks?|walked|follows?|followed|nods?|nodded|shakes?|shook|looks?|looked|glances?|glanced|watches?|watched|sees?|saw|hears?|heard|notices?|noticed|recognizes?|recognized|understands?|understood|remembers?|remembered|suspects?|suspected|feels?|felt|thinks?|thought|wonders?|wondered|realizes?|realized|knows?|knew|wants?|wanted|needs?|needed|decides?|decided|chooses?|chose|reaches?|reached|takes?|took|sets?|set|puts?|put|places?|placed|picks?|picked|carries?|carried|brings?|brought|holds?|held|hands?|handed|offers?|offered|sips?|sipped|drinks?|drank|accepts?|accepted|allows?|allowed|lets?|let|leans?|leaned|turns?|turned|pauses?|paused|hesitates?|hesitated|freezes?|froze|smiles?|smiled|frowns?|frowned|laughs?|laughed|breathes?|breathed|sighs?|sighed|gasps?|gasped|replies?|replied|says?|said|asks?|asked|answers?|answered|murmurs?|murmured|whispers?|whispered|speaks?|spoke|opens?|opened|closes?|closed|enters?|entered|leaves?|left|sits?|sat|stands?|stood|waits?|waited|listens?|listened|approaches?|approached|retreats?|retreated|recoils?|recoiled|reacts?|reacted|responds?|responded|stiffens?|stiffened|relaxes?|relaxed|shivers?|shivered|trembles?|trembled|swallows?|swallowed|blushes?|blushed|focuses?|focused|studies?|studied|considers?|considered|finds?|found|drifts?|drifted)";
  const playerAsSubject = new RegExp(`\\b${playerRef}\\b(?:\\s*,[^.!?]{0,45},)?\\s+(?:\\w+ly\\s+)?${playerVerbs}\\b`, "i");
  const subjectMatch = playerAsSubject.exec(narrationOnly);
  if (subjectMatch && !canonAlreadyContains(subjectMatch[0])) {
    return { type: "New player action, perception, or reaction", excerpt: subjectMatch[0] };
  }

  // Copulas need a complement. This catches "Jace is frightened" or
  // "Jace was walking" without falsely flagging identity clauses such as
  // "He knows exactly who Jace is."
  const controlledState = "(?:afraid|angry|anxious|aware|breathless|calm|confused|curious|dizzy|eager|embarrassed|frightened|frozen|frustrated|glad|happy|hesitant|hurt|nervous|overwhelmed|ready|relieved|sad|scared|shocked|silent|still|stunned|surprised|tense|terrified|tired|uncertain|uneasy|uncomfortable|unwilling|willing|worried|\\w+ing)";
  const playerState = new RegExp(`\\b${playerRef}\\b(?:\\s*,[^.!?]{0,45},)?\\s+(?:is|was|becomes?|became|remains?|remained)\\s+(?:not\\s+)?${controlledState}\\b`, "i");
  const stateMatch = playerState.exec(narrationOnly);
  if (stateMatch && !canonAlreadyContains(stateMatch[0])) {
    return { type: "Player state or feeling assigned by the AI", excerpt: stateMatch[0] };
  }

  // Private/internal nouns imply a player reaction even when another character
  // is grammatically doing the observing. Ordinary contact with a named body
  // part ("a hand on Jace's shoulder") remains an NPC action and is allowed.
  const internalPossessive = "(?:mind|thoughts?|attention|reaction|response|expression)";
  const playerInternal = new RegExp(`\\b${playerRef}(?:'s|’s)\\s+${internalPossessive}\\b`, "i");
  const internalMatch = playerInternal.exec(narrationOnly);
  if (internalMatch && !canonAlreadyContains(internalMatch[0])) {
    return { type: "New player body language or internal reaction", excerpt: internalMatch[0] };
  }

  const bodyPart = "(?:eyes?|gaze|hands?|fingers?|breath|heart|pulse|stomach|jaw|mouth|chest|body|face|voice|grip|feet|footsteps?|knees?|shoulders?|posture|muscles?|skin|cheeks?|lips?|head)";
  const reactionVerb = "(?:clenches?|clenched|parts?|parted|curls?|curled|flickers?|flickered|trembles?|trembled|shakes?|shook|tightens?|tightened|tenses?|tensed|stiffens?|stiffened|relaxes?|relaxed|shivers?|shivered|flushes?|flushed|blushes?|blushed|pounds?|pounded|races?|raced|catches?|caught|hitches?|hitched|falters?|faltered|narrows?|narrowed|widens?|widened|drops?|dropped|lifts?|lifted|turns?|turned|recoils?|recoiled|leans?|leaned|echo(?:es)?|echoed|betrays?|betrayed|reveals?|revealed|shows?|showed|is|was|becomes?|became)";
  const playerBodyReaction = new RegExp(`\\b${playerRef}(?:'s|’s)\\s+${bodyPart}\\s+(?:\\w+ly\\s+)?${reactionVerb}\\b`, "i");
  const bodyReactionMatch = playerBodyReaction.exec(narrationOnly);
  if (bodyReactionMatch && !canonAlreadyContains(bodyReactionMatch[0])) {
    return { type: "New player body language or internal reaction", excerpt: bodyReactionMatch[0] };
  }

  const imposedEffect = /\b(?:strangely|oddly|unexpectedly|undeniably|impossibly)\s+(?:compelling|attractive|comforting|intoxicating|reassuring|arousing|tempting|thrilling)\b/i.exec(narrationOnly);
  if (imposedEffect) {
    return { type: "The narration decides how the NPC affects the player", excerpt: imposedEffect[0] };
  }

  // NPC narration that completes physical control of the player rather than
  // merely initiating or offering an action.
  const forcedContact = "(?:pulls?|pushes?|drags?|guides?|leads?|moves?|lifts?|carries?|pins?|restrains?)";
  const playerAsControlledObject = new RegExp(`\\b${forcedContact}\\s+(?:${playerRef}|${playerRef}(?:'s|’s)\\s+(?:arm|hand|wrist|waist|face|chin|body))\\b`, "i");
  const contactMatch = playerAsControlledObject.exec(narrationOnly);
  if (contactMatch) return { type: "NPC physically completes an action for the player", excerpt: contactMatch[0] };
  return null;
}

function hasAgencyViolation(reply) {
  return Boolean(findAgencyViolation(reply));
}

function cleanMemoryReply(raw) {
  const text = String(raw || "").trim();
  const tagged = [...text.matchAll(/<memory>([\s\S]*?)<\/memory>/gi)];
  return (tagged.length ? tagged[tagged.length - 1][1] : text).trim();
}

function render() {
  $("storyTitle").textContent = state.scenario.title;
  $("playerChip").textContent = `You: ${state.scenario.playerName}`;
  const hijackLabel = `Hands off ${state.scenario.playerName}`;
  const hijackFullLabel = $("hijackBtn").querySelector(".button-label-full");
  if (hijackFullLabel) hijackFullLabel.textContent = hijackLabel;
  else $("hijackBtn").textContent = hijackLabel;
  $("hijackBtn").setAttribute("aria-label", hijackLabel);
  $("spiceQuick").value = normalizeSpiceBalance(state.scenario.spiceBalance);
  updateSpiceOutput("spiceQuick", "spiceQuickValue");
  const uncompressed = Math.max(0, state.messages.length - state.memory.through);
  const memoryStatus = $("memoryStatus");
  memoryStatus.className = "memory-status";
  if (uncompressed >= 24) {
    memoryStatus.textContent = `Refresh recommended · ${uncompressed} messages since memory checkpoint`;
    memoryStatus.classList.add("recommended");
  } else if (uncompressed >= 16) {
    memoryStatus.textContent = `Refresh soon · ${uncompressed} messages since memory checkpoint`;
    memoryStatus.classList.add("soon");
  } else {
    memoryStatus.textContent = state.memory.summary
      ? `Memory fresh · latest ${uncompressed} messages in full`
      : `Memory fresh · ${uncompressed} messages in context`;
  }
  const chat = $("chat");
  chat.innerHTML = "";

  if (!state.messages.length) {
    appendVisual("system", "Ready", `Story loaded. You control ${state.scenario.playerName}; the AI controls everyone else.\n\nWrite your opening move below.`);
  } else {
    state.messages.forEach((m, index) => appendVisual(
      m.role,
      m.role === "user" ? state.scenario.playerName : m.role === "handoff" ? "Your move" : "AI",
      m.content,
      index
    ));
  }
  if (turnNotice?.storyId === storyLibrary.activeId) {
    appendVisual("system", turnNotice.label, turnNotice.content);
  }
  const lastUser = state.messages.map(m => m.role).lastIndexOf("user");
  const lastAssistant = state.messages.map(m => m.role).lastIndexOf("assistant");
  $("retryBtn").disabled = turnInFlight || lastUser < 0;
  $("hijackBtn").disabled = turnInFlight || lastAssistant < lastUser;
  $("continuityBtn").disabled = turnInFlight || lastAssistant < lastUser;
  chat.scrollTop = chat.scrollHeight;
}

// Commit both timelines together. A failed save never removes a story turn.
function commitRewindLibrary(candidate) {
  try {
    localStorage.setItem("rp.stories", JSON.stringify(candidate));
  } catch (error) {
    console.warn("RP Studio rewind storage failure:", error);
    showStorageBanner();
    alert("Rewind cancelled: RP Studio could not save the original timeline as a restore point. Your story is unchanged. Export a backup or free browser storage before retrying.");
    return false;
  }
  storyLibrary = candidate;
  scheduleCloudPush();
  return true;
}

function rewindToMessage(index) {
  if (turnInFlight || !Number.isInteger(index) || index < 0 || index >= state.messages.length - 1) return;
  const picked = state.messages[index];
  if (!picked || !["user", "assistant"].includes(picked.role)) return;
  const kept = index + 1, removed = state.messages.length - kept;
  const covered = Number(state.memory.through);
  const invalidMemory = covered > kept || !Number.isFinite(covered) ||
    (Boolean(state.memory.summary) && covered <= 0);
  const prompt = `Rewind to AFTER this ${picked.role === "user" ? "player" : "AI"} message? ${removed} later message${removed === 1 ? "" : "s"} will be removed from the active timeline. A complete restore snapshot will be saved in Story library → Rewind snapshots. Future continuity memory (if any) and story-specific learned corrections will be cleared to prevent timeline leaks. Any typed draft will be kept in the snapshot.`;
  if (!confirm(prompt)) return;
  const now = new Date().toISOString();
  const snapshot = {
    snapshotId: makeId(), createdAt: now, originStoryId: storyLibrary.activeId,
    title: state.scenario.title || "Untitled Story", keptCount: kept,
    scenario: { ...state.scenario },
    messages: state.messages.map(m => ({ ...m })),
    memory: { ...state.memory }, guardLessons: [...state.guardLessons],
    draft: $("input").value
  };
  const nextMessages = state.messages.slice(0, kept).map(m => ({ ...m }));
  const nextMemory = invalidMemory ? { ...defaults.memory } : { ...defaults.memory, ...state.memory };
  const candidate = {
    ...storyLibrary,
    rewindSnapshots: [...storyLibrary.rewindSnapshots, snapshot],
    stories: {
      ...storyLibrary.stories,
      [storyLibrary.activeId]: {
        ...storyLibrary.stories[storyLibrary.activeId],
        scenario: { ...state.scenario }, messages: nextMessages,
        memory: nextMemory, guardLessons: [], updatedAt: now
      }
    },
    updatedAt: now
  };
  if (!commitRewindLibrary(candidate)) return;
  clearPendingViolation();
  state.messages = nextMessages;
  state.memory = nextMemory;
  state.guardLessons = [];
  $("input").value = "";
  render();
}

function restoreRewindSnapshot(snapshotId) {
  if (turnInFlight) return;
  const snapshot = storyLibrary.rewindSnapshots.find(s => s.snapshotId === snapshotId);
  if (!snapshot || !Array.isArray(snapshot.messages)) return;
  if (!confirm(`Restore “${snapshot.title}”'s full ${snapshot.messages.length}-message timeline as a NEW story? The rewound version will be preserved, and the restore snapshot will remain available.`)) return;
  const id = makeId(), now = new Date().toISOString();
  const restored = makeStory(
    { ...defaults.scenario, ...(snapshot.scenario || {}), title: `${snapshot.title || "Untitled Story"} (restored rewind)` },
    snapshot.messages.map(m => ({ ...m })),
    { ...defaults.memory, ...(snapshot.memory || {}) },
    Array.isArray(snapshot.guardLessons) ? snapshot.guardLessons : []
  );
  const candidate = {
    ...storyLibrary,
    activeId: id,
    stories: { ...storyLibrary.stories, [id]: { ...restored, updatedAt: now } },
    updatedAt: now
  };
  if (!commitRewindLibrary(candidate)) return;
  clearPendingViolation();
  state = { settings: state.settings, ...restored };
  $("input").value = snapshot.draft || "";
  render();
  renderLibrary();
  $("libraryDialog").close();
}

function deleteRewindSnapshot(snapshotId) {
  if (turnInFlight) return;
  if (!confirm("Delete this restore snapshot forever? The timeline saved here cannot be recovered without another backup.")) return;
  const next = storyLibrary.rewindSnapshots.filter(s => s.snapshotId !== snapshotId);
  if (next.length === storyLibrary.rewindSnapshots.length) return;
  if (!commitRewindLibrary({ ...storyLibrary, rewindSnapshots: next, updatedAt: new Date().toISOString() })) return;
  renderRewindSnapshots();
}

function renderRewindSnapshots() {
  const list = $("rewindList");
  list.innerHTML = "";
  const saved = [...storyLibrary.rewindSnapshots]
    .sort((a,b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  if (!saved.length) { list.textContent = "No rewind snapshots yet."; return; }
  saved.forEach(snapshot => {
    const card = document.createElement("div");
    card.className = "library-card rewind-card";
    const main = document.createElement("div");
    main.className = "library-card-main";
    const title = document.createElement("div");
    title.className = "library-card-title";
    title.textContent = snapshot.title || "Untitled Story";
    const note = document.createElement("div");
    note.className = "library-card-note";
    const cut = Math.max(0, (snapshot.messages || []).length - Number(snapshot.keptCount || 0));
    note.textContent = `Saved ${formatTrashDate(snapshot.createdAt)} · ${cut} later message${cut === 1 ? "" : "s"} · original timeline preserved`;
    main.append(title, note);
    const actions = document.createElement("div");
    actions.className = "library-card-actions";
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "secondary";
    restore.textContent = "Restore as new story";
    restore.onclick = () => restoreRewindSnapshot(snapshot.snapshotId);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "warning";
    remove.textContent = "Delete snapshot";
    remove.onclick = () => deleteRewindSnapshot(snapshot.snapshotId);
    actions.append(restore, remove); card.append(main, actions); list.appendChild(card);
  });
}

function renderLibrary() {
  $("exportPreConnectBtn").hidden = !readPreConnectRecovery();
  const storyList = $("storyList");
  storyList.innerHTML = "";
  Object.entries(storyLibrary.stories)
    .filter(([, story]) => isLiveStory(story))
    .sort((a, b) => String(b[1].updatedAt).localeCompare(String(a[1].updatedAt)))
    .forEach(([id, story]) => {
      const card = document.createElement("div");
      card.className = `library-card${id === storyLibrary.activeId ? " active" : ""}`;
      const main = document.createElement("div");
      main.className = "library-card-main";
      const title = document.createElement("div");
      title.className = "library-card-title";
      title.textContent = story.scenario.title || "Untitled Story";
      const note = document.createElement("div");
      note.className = "library-card-note";
      note.textContent = `${story.messages.length} messages${id === storyLibrary.activeId ? " · Current" : ""}`;
      main.append(title, note);
      const actions = document.createElement("div");
      actions.className = "library-card-actions";
      if (id !== storyLibrary.activeId) {
        const open = document.createElement("button");
        open.type = "button"; open.className = "secondary"; open.textContent = "Open";
        open.onclick = () => { activateStory(id); renderLibrary(); };
        actions.appendChild(open);
      }
      if (liveStoryIds().length > 1) {
        const remove = document.createElement("button");
        remove.type = "button"; remove.className = "warning"; remove.textContent = "Delete";
        remove.onclick = () => deleteStory(id);
        actions.appendChild(remove);
      }
      card.append(main, actions);
      storyList.appendChild(card);
    });

  const profileList = $("profileList");
  profileList.innerHTML = storyLibrary.profiles.length ? "" : "No saved profiles yet.";
  storyLibrary.profiles.forEach(profile => {
    const card = document.createElement("div");
    card.className = "library-card";
    const main = document.createElement("div");
    main.className = "library-card-main";
    const title = document.createElement("div"); title.className = "library-card-title"; title.textContent = profile.name;
    const note = document.createElement("div"); note.className = "library-card-note"; note.textContent = profile.notes.slice(0, 80) || "No notes";
    main.append(title, note);
    const actions = document.createElement("div"); actions.className = "library-card-actions";
    const player = document.createElement("button"); player.type = "button"; player.className = "secondary"; player.textContent = "Use as player";
    player.onclick = () => {
      if (!confirm(`Use “${profile.name}” as your player? This replaces the current player name and notes for “${state.scenario.title || "this story"}”.`)) return;
      state.scenario.playerName = profile.name; state.scenario.playerNotes = profile.notes; save(); render(); $("libraryDialog").close();
    };
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "secondary"; edit.textContent = "Edit";
    edit.onclick = () => {
      editingProfileId = profile.id;
      $("profileName").value = profile.name;
      $("profileNotes").value = profile.notes;
      $("saveProfileBtn").textContent = "Save profile changes";
      $("profileName").focus();
    };
    const npc = document.createElement("button"); npc.type = "button"; npc.className = "secondary"; npc.textContent = "Add as NPC";
    npc.onclick = () => { state.scenario.npcNotes = [state.scenario.npcNotes, `${profile.name} — ${profile.notes}`].filter(Boolean).join("\n\n"); save(); $("libraryDialog").close(); };
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "warning"; remove.textContent = "Delete";
    remove.onclick = () => {
      if (!confirm(`Move the “${profile.name}” profile to Trash? You can restore it from there.`)) return;
      storyLibrary.trash.profiles.push({ trashId: makeId(), profile: { ...profile }, deletedAt: new Date().toISOString() });
      storyLibrary.profiles = storyLibrary.profiles.filter(p => p.id !== profile.id);
      if (editingProfileId === profile.id) {
        editingProfileId = null;
        $("saveProfileBtn").textContent = "Save new profile";
        $("profileName").value = ""; $("profileNotes").value = "";
      }
      save(); renderLibrary();
    };
    actions.append(player, edit, npc, remove); card.append(main, actions); profileList.appendChild(card);
  });
  renderRewindSnapshots();
  renderTrash();
}

function formatTrashDate(iso) {
  const date = new Date(iso);
  if (isNaN(date)) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
    date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function renderTrash() {
  const list = $("trashList");
  if (!list) return;
  list.innerHTML = "";
  const trashedStories = Object.entries(storyLibrary.stories)
    .filter(([, story]) => !isLiveStory(story))
    .sort((a, b) => String(b[1].deletedAt || "").localeCompare(String(a[1].deletedAt || "")));
  const trashedSessions = [...storyLibrary.trash.sessions]
    .sort((a, b) => String(b.clearedAt || "").localeCompare(String(a.clearedAt || "")));
  const trashedProfiles = [...storyLibrary.trash.profiles]
    .sort((a, b) => String(b.deletedAt || "").localeCompare(String(a.deletedAt || "")));
  if (!trashedStories.length && !trashedSessions.length && !trashedProfiles.length) {
    list.textContent = "Trash is empty.";
    return;
  }
  const addCard = (title, note, restoreLabel, onRestore, onDeleteForever) => {
    const card = document.createElement("div");
    card.className = "library-card trash-card";
    const main = document.createElement("div");
    main.className = "library-card-main";
    const titleEl = document.createElement("div"); titleEl.className = "library-card-title"; titleEl.textContent = title;
    const noteEl = document.createElement("div"); noteEl.className = "library-card-note"; noteEl.textContent = note;
    main.append(titleEl, noteEl);
    const actions = document.createElement("div"); actions.className = "library-card-actions";
    const restore = document.createElement("button"); restore.type = "button"; restore.className = "secondary"; restore.textContent = restoreLabel;
    restore.onclick = onRestore;
    const del = document.createElement("button"); del.type = "button"; del.className = "warning"; del.textContent = "Delete forever";
    del.onclick = onDeleteForever;
    actions.append(restore, del);
    card.append(main, actions);
    list.appendChild(card);
  };
  trashedStories.forEach(([id, story]) => addCard(
    story.scenario?.title || "Untitled Story",
    `Story · ${(story.messages || []).length} messages · deleted ${formatTrashDate(story.deletedAt)}`,
    "Restore",
    () => restoreStory(id),
    () => permanentlyDeleteStory(id)
  ));
  trashedSessions.forEach(entry => addCard(
    entry.title || "Untitled Story",
    `Cleared session · ${(entry.messages || []).length} messages · ${formatTrashDate(entry.clearedAt)}`,
    "Restore transcript",
    () => restoreSession(entry.trashId),
    () => permanentlyDeleteSession(entry.trashId)
  ));
  trashedProfiles.forEach(entry => addCard(
    entry.profile?.name || "Unnamed profile",
    `Profile · deleted ${formatTrashDate(entry.deletedAt)}`,
    "Restore",
    () => restoreProfile(entry.trashId),
    () => permanentlyDeleteProfile(entry.trashId)
  ));
}

function restoreSession(trashId) {
  const index = storyLibrary.trash.sessions.findIndex(entry => entry.trashId === trashId);
  if (index < 0) return;
  const entry = storyLibrary.trash.sessions[index];
  const targetId = isLiveStory(storyLibrary.stories[entry.storyId]) ? entry.storyId : null;
  if (targetId && (storyLibrary.stories[targetId].messages || []).length &&
      !confirm(`Restore this transcript into “${entry.title}”? It will replace the story's current messages.`)) return;
  if (targetId) {
    storyLibrary.stories[targetId].messages = (entry.messages || []).map(message => ({ ...message }));
    storyLibrary.stories[targetId].memory = { ...(entry.memory || {}) };
    storyLibrary.stories[targetId].updatedAt = new Date().toISOString();
    if (targetId === storyLibrary.activeId) {
      state.messages = storyLibrary.stories[targetId].messages.map(message => ({ ...message }));
      state.memory = { ...storyLibrary.stories[targetId].memory };
      render();
    }
  } else {
    const id = makeId();
    storyLibrary.stories[id] = makeStory(
      { ...defaults.scenario, title: `${entry.title || "Untitled Story"} (restored)` },
      (entry.messages || []).map(message => ({ ...message })),
      { ...(entry.memory || {}) },
      []
    );
    activateStory(id);
  }
  storyLibrary.trash.sessions.splice(index, 1);
  save(); renderLibrary();
}

function permanentlyDeleteSession(trashId) {
  if (!confirm("Delete this cleared transcript FOREVER? It cannot be recovered after this.")) return;
  storyLibrary.trash.sessions = storyLibrary.trash.sessions.filter(entry => entry.trashId !== trashId);
  save(); renderLibrary();
}

function restoreProfile(trashId) {
  const index = storyLibrary.trash.profiles.findIndex(entry => entry.trashId === trashId);
  if (index < 0) return;
  const entry = storyLibrary.trash.profiles[index];
  const profile = { ...entry.profile };
  if (storyLibrary.profiles.some(p => p.id === profile.id)) profile.id = makeId();
  storyLibrary.profiles.push(profile);
  storyLibrary.trash.profiles.splice(index, 1);
  save(); renderLibrary();
}

function permanentlyDeleteProfile(trashId) {
  if (!confirm("Delete this profile FOREVER? It cannot be recovered after this.")) return;
  storyLibrary.trash.profiles = storyLibrary.trash.profiles.filter(entry => entry.trashId !== trashId);
  save(); renderLibrary();
}

function createStory(duplicate = false) {
  save();
  const id = makeId();
  if (duplicate) {
    const title = `${state.scenario.title} — Copy`;
    storyLibrary.stories[id] = makeStory(
      { ...state.scenario, title },
      state.messages.map(message => ({ ...message })),
      { ...state.memory },
      state.guardLessons
    );
  } else {
    storyLibrary.stories[id] = makeStory({ ...defaults.scenario, title: "New Story" });
  }
  activateStory(id);
  renderLibrary();
  $("libraryDialog").close();
  loadScenarioForm();
  $("scenarioDialog").showModal();
}

function deleteStory(id) {
  const story = storyLibrary.stories[id];
  if (!story) return;
  const title = story.scenario?.title || "this story";
  if (!confirm(`Move “${title}” to Trash? Its transcript stays recoverable until you delete it forever.`)) return;
  clearPendingViolation();
  story.deletedAt = new Date().toISOString();
  if (id === storyLibrary.activeId) {
    const nextId = liveStoryIds().find(candidate => candidate !== id);
    if (!nextId) { delete story.deletedAt; return; } // UI blocks this; stay safe anyway
    storyLibrary.activeId = nextId;
    const current = storyLibrary.stories[nextId];
    state = { settings: state.settings, scenario: { ...current.scenario }, messages: [...current.messages], memory: { ...current.memory }, guardLessons: Array.isArray(current.guardLessons) ? [...current.guardLessons] : [] };
  }
  save(); render(); renderLibrary();
}

function restoreStory(id) {
  const story = storyLibrary.stories[id];
  if (!story?.deletedAt) return;
  delete story.deletedAt;
  story.updatedAt = new Date().toISOString();
  save(); renderLibrary();
}

function permanentlyDeleteStory(id) {
  const title = storyLibrary.stories[id]?.scenario?.title || "this story";
  if (!confirm(`Delete “${title}” FOREVER? Its transcript cannot be recovered after this.`)) return;
  delete storyLibrary.stories[id];
  save(); renderLibrary();
}

function isOpenRouterCreditError(message) {
  return /(?:insufficient\s+(?:credits?|balance)|out\s+of\s+credits?|credit\s+balance|payment\s+required|requires?\s+more\s+credits?|upgrade\s+to\s+a\s+paid\s+account)/i.test(String(message || ""));
}

function appendVisual(role, label, content, messageIndex = null) {
  const node = $("messageTemplate").content.firstElementChild.cloneNode(true);
  node.classList.add(role === "assistant" ? "assistant" : role);
  node.querySelector(".msg-meta").textContent = label;
  const body = node.querySelector(".msg-body");
  const displayContent = role === "assistant" ? cleanStoryReply(content) : String(content || "");
  const paragraphs = displayContent.trim().split(/\n+/).filter(Boolean);
  if (!paragraphs.length) {
    body.textContent = displayContent;
  } else {
    paragraphs.forEach(text => {
      const paragraph = document.createElement("p");
      paragraph.textContent = text.trim();
      body.appendChild(paragraph);
    });
  }
  if (role === "system" && /error/i.test(label) && isOpenRouterCreditError(displayContent)) {
    const creditLink = document.createElement("a");
    creditLink.className = "credit-link";
    creditLink.href = "https://openrouter.ai/settings/credits";
    creditLink.target = "_blank";
    creditLink.rel = "noopener noreferrer";
    creditLink.textContent = "Add OpenRouter credits ↗";
    body.appendChild(creditLink);
  }
  if (Number.isInteger(messageIndex) && messageIndex < state.messages.length - 1 &&
      (role === "user" || role === "assistant")) {
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    const rewind = document.createElement("button");
    rewind.type = "button";
    rewind.className = "rewind-action";
    rewind.textContent = "⏪";
    rewind.title = "Rewind to here";
    rewind.setAttribute("aria-label", `Rewind to after message ${messageIndex + 1}`);
    rewind.disabled = turnInFlight;
    rewind.onclick = () => rewindToMessage(messageIndex);
    actions.appendChild(rewind);
    node.appendChild(actions);
  }
  $("chat").appendChild(node);
}

async function requestAI(messages, options = {}) {
  const { workerUrl, appPassword, model, temperature, maxTokens } = state.settings;
  if (!workerUrl) {
    $("settingsDialog").showModal();
    throw new Error("Add your Worker URL first.");
  }

  const res = await fetch(workerUrl.replace(/\/$/, "") + "/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-App-Password": appPassword
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: Number(options.temperature ?? temperature),
      max_tokens: Number(options.maxTokens ?? maxTokens)
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Worker returned ${res.status}`);
  return data.content;
}

function buildTurnMessages(extraInstruction = "") {
  const recent = state.messages.slice(Math.min(state.memory.through, state.messages.length));
  // Some storytelling models echo or mishandle a system message placed after
  // the transcript. Keep every control instruction in the leading system turn.
  const recentPlayerTurn = latestUserText().slice(0, 1500);
  const turnControl = `NPC INITIATIVE WITH ABSOLUTE PLAYER OWNERSHIP:
The latest player-authored move has ALREADY happened and is complete:
${recentPlayerTurn}
Continue exactly after that move, never inventing the player's next move. NPCs may speak, act, plan, reveal established knowledge, make calls, and initiate plausible new events without waiting for permission from the player character.
If the latest move contains a question directed at an NPC, write that NPC's response now. When the NPC cannot answer definitively, let them state what they know, make a decision, or initiate a plausible way to find out. Never substitute silence or an out-of-story handoff for an NPC response.
Keep the scene moving through NPC choices and meaningful events without rushing an entire exchange. Stop before the player's next action, words, expression, perception, or thoughts. Never write ${state.scenario.playerName}'s next line or motion, however obvious. NPC dialogue may use "you"; narration may not.
Before returning, silently check every sentence. If it assigns a new action, line, thought, or reaction to ${state.scenario.playerName}, delete or rewrite that sentence from the NPC's viewpoint instead of halting the whole continuation.`;
  const correction = extraInstruction ? `\n\nONE-TURN CORRECTION\n${extraInstruction}` : "";
  const messages = [{ role: "system", content: `${systemPrompt()}\n\n${turnControl}${correction}` }];
  if (state.memory.summary) {
    messages.push({
      role: "system",
      content: `CONTINUITY MEMORY — established canon from earlier turns. Use it for continuity but do not invent details beyond it. Player-controlled facts remain facts only; never narrate new actions or reactions for the player.\n\n${state.memory.summary}`
    });
  }

  const storyTurns = recent.filter(message => message.role === "user" || message.role === "assistant");
  // Imported opening scenes start the transcript with an NPC turn. Some chat
  // providers reject a first assistant role. Add a model-only user prelude so
  // the real opening and player move retain their original, immutable roles.
  if (storyTurns[0]?.role === "assistant") {
    messages.push({
      role: "user",
      content: "SETUP CONTEXT ONLY: The following assistant message is a completed NPC scene, not a new event to replay. Continue after the player’s latest action. This setup note is not an action or dialogue by the player character."
    });
  }
  storyTurns.forEach(message => messages.push(message));
  return messages;
}

async function callAI(extraInstruction = "", options = {}) {
  return cleanStoryReply(await requestAI(buildTurnMessages(extraInstruction), options));
}

function showAgencyBlock(reply, repeat = false) {
  pendingViolation = reply;
  pendingViolationDetail = findAgencyViolation(reply);
  $("blockedReply").textContent = reply;
  $("blockedReply").contentEditable = "false";
  $("editBlockedBtn").textContent = "Edit & use · free";
  $("agencyNote").value = "";
  const trigger = $("agencyTrigger");
  if (pendingViolationDetail) {
    trigger.hidden = false;
    trigger.textContent = `Caught: ${pendingViolationDetail.type}\n“${pendingViolationDetail.excerpt}”`;
  } else {
    trigger.hidden = true;
    trigger.textContent = "";
  }
  $("agencyReason").textContent = repeat
    ? "The repaired reply still tried to narrate your character. It remains blocked and has not entered the story."
    : "The reply tried to narrate your character. It was blocked before entering the story or memory.";
  if (!$("agencyDialog").open) $("agencyDialog").showModal();
}

function acceptReply(reply) {
  turnNotice = null;
  state.messages.push({ role: "assistant", content: reply });
  save();
  render();
}

function acceptOrBlock(reply, repeat = false) {
  if (!String(reply || "").trim()) {
    // An empty completion (or a reply made only of stripped tags) must never
    // become a blank story card. Treat it like a generation error instead:
    // nothing is saved, and the user can retry the turn.
    turnNotice = { storyId: storyLibrary.activeId, label: "Empty reply", content: "The model returned an empty reply, so nothing was added to the story. Jace’s move is saved. Tap Retry to request Matteo’s reply again." };
    render();
    return false;
  }
  if (isNaturalHandoff(reply)) {
    // A pure handoff is not story content. Don't append a "Your move" card
    // that leaves a direct player question unanswered. Keep the player turn
    // intact and let Retry ask the NPC to respond without adding a second
    // copy of the user's action.
    pendingViolation = null;
    pendingViolationDetail = null;
    turnNotice = {
      storyId: storyLibrary.activeId,
      label: "NPC reply needed",
      content: "The model handed control back without moving the story. No reply was saved. Tap Retry to ask the NPC to respond; your last character action is already saved."
    };
    render();
    return false;
  }
  if (findAgencyViolation(reply)) {
    showAgencyBlock(reply, repeat);
    return false;
  }
  pendingViolation = null;
  acceptReply(reply);
  return true;
}

async function refreshMemory() {
  const KEEP_RECENT = 8;
  const cutoff = Math.max(0, state.messages.length - KEEP_RECENT);
  if (cutoff <= state.memory.through) {
    appendVisual("system", "Memory", "Nothing new to compress yet. RP Studio always keeps the latest four exchanges in full.");
    $("chat").scrollTop = $("chat").scrollHeight;
    return;
  }

  const olderMessages = state.messages.slice(state.memory.through, cutoff)
    .filter(message => message.role === "user" || message.role === "assistant");
  const transcript = olderMessages.map(m => `${m.role === "user" ? state.scenario.playerName : "NPC / Narrator"}:\n${m.content}`).join("\n\n");
  const memoryPrompt = `Create a compact continuity memory for an ongoing interactive-fiction role-play. Preserve only established canon needed to continue accurately: setting and current situation, chronology, NPC characterization and goals, relationship development, promises, discoveries, unresolved threads, boundaries, and player-authored facts. Clearly distinguish actions/dialogue the player established from NPC material. Mark completed scenes, phone calls, conversations, revelations, and exchanges as completed history; do not reproduce their dialogue or frame them as events that should happen again. This memory is reference-only and must never become new story prose. Never invent, embellish, moralize, or continue the scene. Use concise bullets and stay under 550 words. Return only one <memory>...</memory> block.\n\nEXISTING MEMORY:\n${state.memory.summary || "None yet."}\n\nNEW TRANSCRIPT TO ABSORB:\n${transcript}`;

  if (turnInFlight) return;
  setTurnInFlight(true);
  $("memoryBtn").textContent = "Remembering…";
  try {
    const raw = await requestAI([
      { role: "system", content: "You are a precise continuity editor. Summarize canon; do not write story prose." },
      { role: "user", content: memoryPrompt }
    ], { temperature: 0.2, maxTokens: 750 });
    const summary = cleanMemoryReply(raw);
    if (!summary) throw new Error("The model returned an empty memory.");
    state.memory = { summary, through: cutoff };
    save();
    render();
    appendVisual("system", "Memory refreshed", `Older context compressed. The model will now reread the continuity memory plus the latest four exchanges instead of the entire transcript.`);
    $("chat").scrollTop = $("chat").scrollHeight;
  } catch (err) {
    appendVisual("system", "Memory error", err.message);
  } finally {
    setTurnInFlight(false);
    $("memoryBtn").textContent = "Refresh memory";
  }
}

// A single in-flight lock covers every turn path (send, retry, both repairs,
// memory refresh) so concurrent generations can never interleave transcript
// order or burn extra API calls. The keyboard shortcut, every turn button, and
// render()'s button-state logic all respect it.
const TURN_LOCK_BUTTONS = ["sendBtn", "retryBtn", "hijackBtn", "continuityBtn", "memoryBtn", "repairAgencyBtn", "repairContinuityBtn"];
function setTurnInFlight(on) {
  turnInFlight = on;
  TURN_LOCK_BUTTONS.forEach(id => {
    const el = $(id);
    if (el) el.disabled = on;
  });
  document.querySelectorAll(".rewind-action").forEach(button => { button.disabled = on; });
}

function showTurnFailure(err) {
  const detail = String(err?.message || "The AI request failed.").trim();
  turnNotice = {
    storyId: storyLibrary.activeId,
    label: "AI reply failed",
    content: `${detail}\n\nYour character’s move is saved. Tap Retry to request the missing AI reply. Do not send your character’s action a second time.`
  };
  render();
}

async function send() {
  if (turnInFlight) return;
  const text = $("input").value.trim();
  if (!text) return;

  turnNotice = null;
  setTurnInFlight(true);
  $("sendBtn").textContent = "Writing…";
  try {
    state.messages.push({ role: "user", content: text });
    $("input").value = "";
    save();
    render();
    const reply = await callAI();
    acceptOrBlock(reply);
  } catch (err) {
    showTurnFailure(err);
  } finally {
    setTurnInFlight(false);
    $("sendBtn").textContent = "Send ➜";
    render();
  }
}

async function retry(agencyCorrection = false) {
  if (turnInFlight) return;
  turnNotice = null;
  const roles = state.messages.map(m => m.role);
  const assistantIdx = roles.lastIndexOf("assistant");
  const handoffIdx = roles.lastIndexOf("handoff");
  const userIdx = roles.lastIndexOf("user");
  if (userIdx < 0) return;
  const rejectedDraft = agencyCorrection && assistantIdx > userIdx ? state.messages[assistantIdx].content : "";
  if (assistantIdx > userIdx) {
    state.messages.splice(assistantIdx, 1);
  } else if (handoffIdx > userIdx) {
    state.messages.splice(handoffIdx, 1);
  }
  setTurnInFlight(true);
  save();
  render();

  const correction = agencyCorrection
    ? `REPAIR: The last assistant reply was rejected because it wrote actions or reactions for ${state.scenario.playerName}. This reply is not canon. Excerpt to avoid repeating: "${String(rejectedDraft).slice(0, 400).replace(/"/g, "'")}". Write a DIFFERENT NPC-only continuation from the latest completed player turn. NPCs can offer and wait; never choose a response for the player. End before any player action.`
    : "";
  try {
    const reply = await callAI(correction, correction ? { temperature: Math.min(Number(state.settings.temperature), 0.4) } : {});
    acceptOrBlock(reply);
  } catch (err) {
    showTurnFailure(err);
  } finally {
    setTurnInFlight(false);
    const finalRoles = state.messages.map(m => m.role);
    const finalUser = finalRoles.lastIndexOf("user");
    const finalAssistant = finalRoles.lastIndexOf("assistant");
    $("retryBtn").disabled = finalUser < 0;
    $("hijackBtn").disabled = finalAssistant < finalUser;
    $("continuityBtn").disabled = finalAssistant < finalUser;
  }
}

async function repairBlockedReply() {
  if (turnInFlight || !pendingViolation) return;
  const userNote = $("agencyNote").value.trim();
  if (userNote) {
    rememberGuardLesson(userNote);
    save();
  }
  setTurnInFlight(true);
  $("repairAgencyBtn").textContent = "Repairing…";
  try {
    const reply = await callAI(
      `REPAIR: The previous output was rejected for controlling ${state.scenario.playerName}. The rejected wording is not canon: "${String(pendingViolation).slice(0, 400).replace(/"/g, "'")}". ${userNote ? `User correction: ${userNote.slice(0, 400)}.` : ""} Write a NEW NPC-only continuation after the latest player turn. Describe only NPCs and objective events. Never write the player's dialogue, choices, movement, thoughts, expression, or reactions. End when the player must respond; do not imitate rejected text.`,
      { temperature: Math.min(Number(state.settings.temperature), 0.4) }
    );
    if (acceptOrBlock(reply, true)) $("agencyDialog").close();
  } catch (err) {
    $("agencyDialog").close();
    appendVisual("system", "Repair error", err.message);
    $("chat").scrollTop = $("chat").scrollHeight;
  } finally {
    setTurnInFlight(false);
    $("repairAgencyBtn").textContent = "Repair · uses 1 request";
  }
}

function openContinuityRepair() {
  const assistantIndex = state.messages.map(message => message.role).lastIndexOf("assistant");
  const userIndex = state.messages.map(message => message.role).lastIndexOf("user");
  if (assistantIndex < userIndex) return;
  $("continuityNote").value = "";
  $("continuityReply").textContent = state.messages[assistantIndex].content;
  $("continuityDialog").showModal();
}

async function repairContinuity() {
  const note = $("continuityNote").value.trim();
  if (!note) return alert("Tell RP Studio what contradicted the story first.");
  const assistantIndex = state.messages.map(message => message.role).lastIndexOf("assistant");
  const userIndex = state.messages.map(message => message.role).lastIndexOf("user");
  if (assistantIndex < userIndex) return;
  const rejectedReply = state.messages[assistantIndex].content;
  if (turnInFlight) return;
  rememberGuardLesson(note);
  state.messages.splice(assistantIndex, 1);
  save();
  render();
  setTurnInFlight(true);
  $("repairContinuityBtn").textContent = "Replacing…";
  try {
    const correction = `CONTINUITY REPAIR: Replace the rejected assistant turn from scratch. The user identified this contradiction: ${note}\n\nREJECTED TURN — evidence only, do not imitate or continue it:\n${rejectedReply}\n\nCorrect the contradiction instead of rationalizing, defending, or preserving it. Do not invent earlier dialogue, facial cues, intuition, surveillance, research, or off-page events to make the mistake seem intentional. Do not replay any completed scene, conversation, phone call, dialogue, revelation, or action from the transcript or continuity memory. Continue chronologically after the last valid event, using only established canon and NPC knowledge with an explicit established source. Continue from the user's last valid completed turn.`;
    const reply = await callAI(correction, { temperature: Math.min(Number(state.settings.temperature), 0.55) });
    $("continuityDialog").close();
    acceptOrBlock(reply);
  } catch (error) {
    state.messages.splice(assistantIndex, 0, { role: "assistant", content: rejectedReply });
    save();
    render();
    $("continuityDialog").close();
    appendVisual("system", "Continuity repair error", error.message);
  } finally {
    setTurnInFlight(false);
    $("repairContinuityBtn").textContent = "Replace reply · uses 1 request";
  }
}

function persistCloudSync() {
  try {
    localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify({
      enabled: Boolean(cloudSync.enabled),
      code: cloudSync.code || "",
      revision: Number(cloudSync.revision || 0),
      lastSyncedAt: cloudSync.lastSyncedAt || "",
      autoSync: cloudSync.autoSync !== false
    }));
  } catch (error) {
    console.warn("RP Studio: sync-state save failed:", error);
    showStorageBanner();
  }
}

function setSyncStatus(message, kind = "") {
  const el = $("syncStatus");
  if (!el) return;
  el.textContent = message;
  el.className = `sync-status${kind ? ` ${kind}` : ""}`;
}

function encodeBase64Url(bytes) {
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const normalized = String(value || "").trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function normalizeSyncCode(value) {
  return String(value || "").trim().replace(/\s+/g, "");
}

async function syncMaterial(codeValue = cloudSync.code) {
  const code = normalizeSyncCode(codeValue);
  let secret;
  try { secret = decodeBase64Url(code); } catch { throw new Error("That sync code is not valid."); }
  if (secret.length !== 32) throw new Error("That sync code is not valid.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", secret));
  const id = encodeBase64Url(digest);
  const key = await crypto.subtle.importKey("raw", secret, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { code, id, key };
}

function cloudPayload() {
  return {
    app: "RP Studio",
    formatVersion: 2,
    savedAt: storyLibrary.updatedAt || new Date().toISOString(),
    library: storyLibrary,
    preferences: {
      model: state.settings.model,
      temperature: state.settings.temperature,
      maxTokens: state.settings.maxTokens
    }
  };
}

async function encryptCloudPayload(payload, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return JSON.stringify({ version: 1, iv: encodeBase64Url(iv), data: encodeBase64Url(encrypted) });
}

async function decryptCloudPayload(ciphertext, key) {
  try {
    const envelope = JSON.parse(ciphertext);
    if (envelope.version !== 1) throw new Error("Unsupported encrypted format.");
    const iv = decodeBase64Url(envelope.iv);
    const encrypted = decodeBase64Url(envelope.data);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
    const payload = JSON.parse(new TextDecoder().decode(plaintext));
    if (payload?.app !== "RP Studio" || !payload?.library?.stories) throw new Error("Invalid RP Studio data.");
    return payload;
  } catch {
    throw new Error("The cloud copy could not be decrypted. Check that both devices use the exact same sync code.");
  }
}

function connectionFromForm() {
  return {
    workerUrl: ($("workerUrl")?.value || state.settings.workerUrl || "").trim(),
    appPassword: $("appPassword")?.value ?? state.settings.appPassword ?? "",
    model: ($("model")?.value || state.settings.model || "openrouter/free").trim(),
    temperature: Number($("temperature")?.value || state.settings.temperature || 0.9),
    maxTokens: Number($("maxTokens")?.value || state.settings.maxTokens || 900)
  };
}

function saveConnectionFromForm() {
  state.settings = connectionFromForm();
  try {
    localStorage.setItem("rp.settings", JSON.stringify(state.settings));
  } catch (error) {
    console.warn("RP Studio: settings save failed:", error);
    showStorageBanner();
  }
}

async function cloudRequest(method, body = null, codeValue = cloudSync.code) {
  saveConnectionFromForm();
  const { workerUrl, appPassword } = state.settings;
  if (!workerUrl) throw new Error("Add your Worker URL first.");
  if (!appPassword) throw new Error("Add your app password first.");
  const material = await syncMaterial(codeValue);
  const response = await fetch(`${workerUrl.replace(/\/$/, "")}/sync/${encodeURIComponent(material.id)}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-App-Password": appPassword
    },
    body: body === null ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Worker returned ${response.status}`);
    error.status = response.status;
    error.remoteRevision = Number(data.revision || 0);
    throw error;
  }
  return { data, material };
}

function applyCloudPayload(payload) {
  preserveCorruptBootKeys();
  const incoming = payload?.library;
  if (!incoming?.stories || !Object.keys(incoming.stories).length) {
    throw new Error("The cloud copy has no stories, so it was not applied. Your local stories are untouched.");
  }
  clearPendingViolation();
  storyLibrary = {
    version: Number(incoming.version || 1),
    activeId: incoming.stories[incoming.activeId] ? incoming.activeId : Object.keys(incoming.stories)[0],
    stories: incoming.stories,
    profiles: Array.isArray(incoming.profiles) ? incoming.profiles : [],
    rewindSnapshots: Array.isArray(incoming.rewindSnapshots) ? incoming.rewindSnapshots : [],
    trash: normalizeTrash(incoming.trash),
    updatedAt: incoming.updatedAt || payload.savedAt || new Date().toISOString()
  };
  if (!isLiveStory(storyLibrary.stories[storyLibrary.activeId])) {
    storyLibrary.activeId = liveStoryIds()[0];
  }
  const current = storyLibrary.stories[storyLibrary.activeId];
  state = {
    settings: {
      ...state.settings,
      model: payload.preferences?.model || state.settings.model,
      temperature: Number(payload.preferences?.temperature ?? state.settings.temperature),
      maxTokens: Number(payload.preferences?.maxTokens ?? state.settings.maxTokens)
    },
    scenario: { ...defaults.scenario, ...(current.scenario || {}) },
    messages: Array.isArray(current.messages) ? current.messages : [],
    memory: { ...defaults.memory, ...(current.memory || {}) },
    guardLessons: Array.isArray(current.guardLessons) ? current.guardLessons : []
  };
  try {
    localStorage.setItem("rp.settings", JSON.stringify(state.settings));
    localStorage.setItem("rp.stories", JSON.stringify(storyLibrary));
  } catch (error) {
    console.warn("RP Studio: local save failed:", error);
    showStorageBanner();
  }
  render();
  if ($("libraryDialog")?.open) renderLibrary();
  loadSettingsForm();
}

function scheduleCloudPush() {
  if (!cloudSync.enabled || !cloudSync.autoSync || !syncRuntime.ready || syncRuntime.busy) return;
  clearTimeout(syncRuntime.timer);
  syncRuntime.timer = setTimeout(() => pushCloudCopy(), 1200);
}

async function pushCloudCopy(options = {}) {
  if ((!syncRuntime.ready && !options.allowBeforeReady) || syncRuntime.busy || !cloudSync.enabled) return;
  syncRuntime.busy = true;
  setSyncStatus("Encrypting and uploading…", "working");
  let uploaded = false;
  try {
    // Snapshot the library timestamp BEFORE the PUT. Saves made during the
    // flight advance storyLibrary.updatedAt past this value, so stamping from
    // the live value afterwards would wrongly mark them as synced.
    const pushedAt = storyLibrary.updatedAt;
    const material = await syncMaterial();
    const payload = cloudPayload();
    const ciphertext = await encryptCloudPayload(payload, material.key);
    const { data } = await cloudRequest("PUT", {
      baseRevision: Number(cloudSync.revision || 0),
      ciphertext
    });
    cloudSync.revision = Number(data.revision || cloudSync.revision + 1);
    cloudSync.lastSyncedAt = pushedAt;
    persistCloudSync();
    setSyncStatus(`Synced securely · revision ${cloudSync.revision}`, "success");
    uploaded = true;
  } catch (error) {
    if (error.status === 409) {
      setSyncStatus("Both devices have changes. Nothing was overwritten—tap Sync now to choose which copy to keep.", "error");
    } else {
      setSyncStatus(`Sync paused: ${error.message}`, "error");
    }
  } finally {
    syncRuntime.busy = false;
  }
  // Anything saved while the push was in flight is still dirty — queue another
  // push instead of silently dropping it. (Only on success: a 409 must not
  // re-push in a loop.)
  if (uploaded && isLocalDirty()) scheduleCloudPush();
}

async function fetchCloudCopy(codeValue = cloudSync.code) {
  const { data, material } = await cloudRequest("GET", null, codeValue);
  const payload = await decryptCloudPayload(data.ciphertext, material.key);
  return { payload, revision: Number(data.revision || 0), material };
}

function isLocalDirty() {
  return !cloudSync.lastSyncedAt || String(storyLibrary.updatedAt || "") > String(cloudSync.lastSyncedAt || "");
}

async function createCloudSync() {
  saveConnectionFromForm();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  cloudSync = { enabled: true, code: encodeBase64Url(secret), revision: 0, lastSyncedAt: "", autoSync: $("autoSync").checked };
  $("syncCode").value = cloudSync.code;
  persistCloudSync();
  syncRuntime.ready = true;
  try { await navigator.clipboard.writeText(cloudSync.code); } catch { /* Copy button remains available. */ }
  setSyncStatus("Sync code created. Uploading this device’s library…", "working");
  await pushCloudCopy({ allowBeforeReady: true });
}

async function connectCloudSync() {
  saveConnectionFromForm();
  const code = normalizeSyncCode($("syncCode").value);
  await syncMaterial(code);
  if (!confirm("Download the encrypted cloud library to this device? This replaces the stories and profiles currently stored in this browser. Connection details remain local.")) return;
  // Do NOT auto-download JSON here. On iOS that navigation opens the file
  // preview and can cancel the pending fetch with "Load failed".
  setSyncStatus("Downloading and decrypting…", "working");
  syncRuntime.busy = true;
  try {
    let remote;
    try { remote = await fetchCloudCopy(code); }
    catch (error) {
      if (/^(?:Load failed|Failed to fetch|NetworkError)/i.test(String(error?.message || ""))) {
        throw new Error("Unable to reach the Worker from this browser. Nothing was replaced. Check your connection and Worker URL. If it continues, send the message, not your passwords.");
      }
      throw error;
    }
    // Snapshot locally only AFTER a valid encrypted cloud copy is obtained,
    // and BEFORE overwriting any local stories. No navigation or download.
    savePreConnectRecovery();
    cloudSync = {
      enabled: true,
      code: remote.material.code,
      revision: remote.revision,
      lastSyncedAt: remote.payload.library.updatedAt || remote.payload.savedAt || "",
      autoSync: $("autoSync").checked
    };
    applyCloudPayload(remote.payload);
    persistCloudSync();
    syncRuntime.ready = true;
    setSyncStatus(`Connected and downloaded · revision ${cloudSync.revision}. An iPad recovery copy is available in Story Library.`, "success");
  } finally {
    syncRuntime.busy = false;
  }
}

async function syncNow() {
  if (!cloudSync.enabled || !cloudSync.code) throw new Error("Create or connect a sync code first.");
  if (syncRuntime.busy) return;
  setSyncStatus("Checking the cloud copy…", "working");
  syncRuntime.busy = true;
  try {
    const remote = await fetchCloudCopy();
    const localDirty = isLocalDirty();
    if (remote.revision > Number(cloudSync.revision || 0)) {
      if (localDirty && !confirm("This device and the cloud both changed. Press OK to keep the newer cloud copy on this device, or Cancel to keep this device unchanged. Nothing will be overwritten automatically.")) {
        if (confirm("Keep this device's copy instead? It will be uploaded to the cloud as the newest version, replacing the cloud copy.")) {
          // Force-push: adopt the remote revision as our base so the PUT no
          // longer 409s, then upload this device's library.
          cloudSync.revision = remote.revision;
          syncRuntime.ready = true;
          persistCloudSync();
          syncRuntime.busy = false;
          await pushCloudCopy();
          return;
        }
        setSyncStatus("Conflict left untouched. Export a backup before choosing a copy.", "error");
        return;
      }
      applyCloudPayload(remote.payload);
      cloudSync.revision = remote.revision;
      cloudSync.lastSyncedAt = storyLibrary.updatedAt;
      persistCloudSync();
      syncRuntime.ready = true;
      setSyncStatus(`Downloaded newer cloud copy · revision ${cloudSync.revision}`, "success");
      return;
    }
    cloudSync.revision = remote.revision;
    syncRuntime.ready = true;
    persistCloudSync();
    if (localDirty) {
      syncRuntime.busy = false;
      await pushCloudCopy();
    } else {
      cloudSync.lastSyncedAt = storyLibrary.updatedAt;
      persistCloudSync();
      setSyncStatus(`Already up to date · revision ${cloudSync.revision}`, "success");
    }
  } finally {
    syncRuntime.busy = false;
  }
}

async function initializeCloudSync() {
  if (!cloudSync.enabled || !cloudSync.code) {
    setSyncStatus("Cloud sync is not connected.");
    return;
  }
  $("syncCode").value = cloudSync.code;
  $("autoSync").checked = cloudSync.autoSync !== false;
  setSyncStatus("Checking for changes from your other device…", "working");
  try {
    const remote = await fetchCloudCopy();
    const localDirty = isLocalDirty();
    if (remote.revision > Number(cloudSync.revision || 0)) {
      if (localDirty) {
        setSyncStatus("Both devices have changes. Nothing was overwritten—open Settings and tap Sync now.", "error");
        return;
      }
      applyCloudPayload(remote.payload);
      cloudSync.revision = remote.revision;
      cloudSync.lastSyncedAt = storyLibrary.updatedAt;
      persistCloudSync();
    } else {
      cloudSync.revision = remote.revision;
    }
    syncRuntime.ready = true;
    setSyncStatus(`Cloud sync ready · revision ${cloudSync.revision}`, "success");
    if (localDirty && remote.revision === cloudSync.revision) scheduleCloudPush();
  } catch (error) {
    setSyncStatus(`Sync paused: ${error.message}`, "error");
  }
}

function loadSettingsForm() {
  Object.entries(state.settings).forEach(([k,v]) => {
    const el = $(k);
    if (el) el.value = v;
  });
  $("syncCode").value = cloudSync.code || "";
  $("autoSync").checked = cloudSync.autoSync !== false;
  if (cloudSync.enabled) setSyncStatus(`Connected · revision ${cloudSync.revision}`, "success");
  else setSyncStatus("Cloud sync is not connected.");
}

function loadScenarioForm() {
  const map = {
    scenarioTitle: "title", playerName: "playerName", playerNotes: "playerNotes",
    npcNotes: "npcNotes", premise: "premise", styleNotes: "styleNotes", boundaryNotes: "boundaryNotes"
  };
  Object.entries(map).forEach(([id,k]) => $(id).value = state.scenario[k]);
  $("spiceScenario").value = normalizeSpiceBalance(state.scenario.spiceBalance);
  updateSpiceOutput("spiceScenario", "spiceScenarioValue");
  const select = $("playerProfile");
  select.innerHTML = '<option value="">Choose a profile…</option>';
  storyLibrary.profiles.forEach(profile => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    select.appendChild(option);
  });
  renderGuardLessons();
}

function renderGuardLessons() {
  const list = $("guardLessonList");
  if (!list) return;
  list.innerHTML = "";
  if (!state.guardLessons.length) {
    const empty = document.createElement("div");
    empty.className = "library-card-note";
    empty.textContent = "No learned corrections yet.";
    list.appendChild(empty);
    return;
  }
  state.guardLessons.forEach((lesson, index) => {
    const card = document.createElement("div");
    card.className = "library-card guard-lesson-card";
    const text = document.createElement("div");
    text.className = "guard-lesson-text";
    text.textContent = lesson;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "warning";
    remove.textContent = "Remove";
    remove.onclick = () => {
      state.guardLessons.splice(index, 1);
      save();
      renderGuardLessons();
    };
    card.append(text, remove);
    list.appendChild(card);
  });
}

// A browser-initiated file download can navigate an iOS in-app browser away
// from RP Studio. Downloads must happen only when the user explicitly taps
// an Export button, never automatically during an ongoing sync request.
function readPreConnectRecovery() {
  try {
    const result = JSON.parse(localStorage.getItem(PRE_CONNECT_RECOVERY_KEY) || "null");
    return result?.library?.stories ? result : null;
  } catch { return null; }
}
function savePreConnectRecovery() {
  // Keep the first original iPad library rather than replacing it if the
  // user retries connection. This snapshot lives outside cloud replacement.
  if (readPreConnectRecovery()) return;
  try {
    localStorage.setItem(PRE_CONNECT_RECOVERY_KEY, JSON.stringify({
      savedAt: new Date().toISOString(),
      library: storyLibrary
    }));
  } catch {
    showStorageBanner();
    throw new Error("Could not save the iPad recovery snapshot. Your stories were not replaced. Open Story Library and export a backup manually before trying Connect & download again.");
  }
}
function downloadBackupFile(filename, sourceLibrary = storyLibrary) {
  const payload = {
    app: "RP Studio",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    library: sourceLibrary
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportBackup() {
  save();
  downloadBackupFile(`RP-Studio-backup-${new Date().toISOString().slice(0, 10)}.json`);
}


const IMPORT_FIELDS = {
  title: "scenarioTitle", playerName: "playerName",
  playerNotes: "playerNotes", npcNotes: "npcNotes",
  premise: "premise", styleNotes: "styleNotes",
  boundaryNotes: "boundaryNotes", spiceBalance: "spiceScenario"
};
const IMPORT_LABELS = {
  title: "Title", playerName: "Player", playerNotes: "Player background",
  npcNotes: "AI characters", premise: "Premise",
  styleNotes: "Writing style", boundaryNotes: "Boundaries",
  spiceBalance: "Spice balance"
};
async function parseStoryImport(file) {
  if (!file || typeof file.text !== "function") throw new Error("Select an RP Studio .json import file.");
  if (file.size > 131072) throw new Error("Import files must be 128 KB or smaller.");
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { throw new Error("The file is not valid JSON."); }
  if (data?.app !== "RP Studio" || data.formatVersion !== 1 ||
      !["story-blueprint", "story-block"].includes(data.kind))
    throw new Error("Expected an RP Studio story blueprint or writing block (format version 1).");
  if (!data.fields || typeof data.fields !== "object" || Array.isArray(data.fields))
    throw new Error("The story import has no fields.");
  const keys = Object.keys(data.fields);
  if (!keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(IMPORT_FIELDS, key)))
    throw new Error("The import has no supported fields or contains unknown fields.");
  const fields = {};
  keys.forEach(key => {
    const value = data.fields[key];
    if (key === "spiceBalance") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)
        throw new Error("Spice balance must be a number between 0 and 100.");
      fields[key] = normalizeSpiceBalance(value);
    } else {
      if (typeof value !== "string" || value.length > 30000)
        throw new Error("The imported " + IMPORT_LABELS[key] + " must be text shorter than 30,000 characters.");
      fields[key] = value;
    }
  });
  if (data.kind === "story-blueprint" && (!fields.title?.trim() || !fields.playerName?.trim()))
    throw new Error("Complete blueprints require a title and a player name.");
  // A blueprint may include a finished opening NPC scene to seed the story timeline.
  // This is separate from editable Story Setup fields and never applies to writing blocks.
  const openingScene = data.openingScene;
  if (openingScene !== undefined) {
    if (data.kind !== "story-blueprint")
      throw new Error("Only full story blueprints may include an opening scene.");
    if (typeof openingScene !== "string" || !openingScene.trim() || openingScene.length > 10000)
      throw new Error("The opening scene must be nonempty text no longer than 10,000 characters.");
  }
  return {
    kind: data.kind,
    name: String(data.name || "Story import").slice(0, 100),
    fields,
    openingScene: openingScene ? openingScene.trim() : "",
    append: data.kind === "story-block" && data.apply === "append"
  };
}
function storyImportFields(fields) {
  return Object.keys(fields).map(key => IMPORT_LABELS[key]).join(", ");
}
// Full blueprints create an isolated story, optionally with a first NPC message.
// They never replace an existing story or its transcript.
async function importStoryBlueprint(file) {
  if (!file) return;
  try {
    if (turnInFlight) throw new Error("Wait until the current AI turn finishes.");
    const doc = await parseStoryImport(file);
    if (doc.kind !== "story-blueprint")
      throw new Error("This is a single writing block. Import it from Edit story instead.");
    const openingNote = doc.openingScene ? " An opening scene will appear as the first AI message." : "";
    if (!confirm(`Create a NEW story from "${doc.name}"? Importing: ${storyImportFields(doc.fields)}.${openingNote} Existing stories and transcripts will remain unchanged.`)) return;
    const id = makeId(), now = new Date().toISOString();
    const openingMessages = doc.openingScene ? [{ role: "assistant", content: doc.openingScene }] : [];
    const story = makeStory({ ...defaults.scenario, ...doc.fields }, openingMessages);
    const candidate = {
      ...storyLibrary, activeId: id,
      stories: { ...storyLibrary.stories, [id]: { ...story, updatedAt: now } },
      updatedAt: now
    };
    // A storage failure must never strand or erase the current story.
    try { localStorage.setItem("rp.stories", JSON.stringify(candidate)); }
    catch {
      showStorageBanner();
      throw new Error("Couldn't safely save a new story. Your existing stories were not changed. Free space or export a backup, then try again.");
    }
    storyLibrary = candidate;
    state = { settings: state.settings, ...story };
    clearPendingViolation();
    $("input").value = "";
    $("libraryDialog").close();
    scheduleCloudPush();
    render();
    alert(doc.openingScene
      ? "Story imported with its opening scene. Continue as your character! Your earlier story is still in the Story Library."
      : "New story imported! Your earlier story is still in the Story Library.");
  } catch(error) { alert("Blueprint import: " + error.message); }
  finally { $("importBlueprintFile").value = ""; }
}
// Partial imports change only the unsaved Story Setup form until Save story.
async function importStoryBlock(file) {
  if (!file) return;
  try {
    if (turnInFlight) throw new Error("Wait until the current AI turn finishes.");
    const doc = await parseStoryImport(file);
    const verb = doc.append ? "Append to" : "Load into";
    if (!confirm(`${verb} these Story Setup sections from "${doc.name}": ${storyImportFields(doc.fields)}? Nothing is saved until you press Save story.`)) return;
    Object.entries(doc.fields).forEach(([key, value]) => {
      const input = $(IMPORT_FIELDS[key]);
      if (key === "spiceBalance") input.value = normalizeSpiceBalance(value);
      else if (doc.append && key !== "title")
        input.value = [input.value.trim(), value.trim()].filter(Boolean).join("\n\n");
      else input.value = value;
    });
    updateSpiceOutput("spiceScenario", "spiceScenarioValue");
    alert("Block loaded. Review the Story Setup fields and tap Save story to apply.");
  } catch(error) { alert("Writing block import: " + error.message); }
  finally { $("importBlockFile").value = ""; }
}

async function importBackup(file) {
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const incoming = payload?.app === "RP Studio" ? payload.library : null;
    if (!incoming?.stories || !Object.keys(incoming.stories).length) throw new Error("That file is not a valid RP Studio backup.");
    if (!confirm("Import this backup? It will replace the stories and profiles currently saved in this browser. Your connection settings will stay unchanged.")) return;
    clearPendingViolation();
    storyLibrary = {
      version: 1,
      activeId: incoming.stories[incoming.activeId] ? incoming.activeId : Object.keys(incoming.stories)[0],
      stories: incoming.stories,
      profiles: Array.isArray(incoming.profiles) ? incoming.profiles : [],
      rewindSnapshots: Array.isArray(incoming.rewindSnapshots) ? incoming.rewindSnapshots : [],
      trash: normalizeTrash(incoming.trash)
    };
    const current = storyLibrary.stories[storyLibrary.activeId];
    state = {
      settings: state.settings,
      scenario: { ...defaults.scenario, ...(current.scenario || {}) },
      messages: Array.isArray(current.messages) ? current.messages : [],
      memory: { ...defaults.memory, ...(current.memory || {}) },
      guardLessons: Array.isArray(current.guardLessons) ? current.guardLessons : []
    };
    save(); render(); renderLibrary(); $("libraryDialog").close();
    alert("Backup imported successfully.");
  } catch (error) {
    alert(error.message || "The backup could not be imported.");
  } finally {
    $("importFile").value = "";
  }
}


// Reveal only on explicit interaction, never in logs, backups or cloud payloads.
// Close and background events re-mask secrets even if the app stays running.
function hideConnectionSecrets() {
  [["appPassword", "showAppPasswordBtn"], ["syncCode", "showSyncCodeBtn"]].forEach(([inputId, buttonId]) => {
    const input = $(inputId), button = $(buttonId);
    input.type = "password";
    button.textContent = "Show";
    button.setAttribute("aria-pressed", "false");
  });
}
function toggleConnectionSecret(inputId, buttonId) {
  const input = $(inputId), button = $(buttonId);
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  button.textContent = show ? "Hide" : "Show";
  button.setAttribute("aria-pressed", String(show));
}
$("showAppPasswordBtn").onclick = () => toggleConnectionSecret("appPassword", "showAppPasswordBtn");
$("showSyncCodeBtn").onclick = () => toggleConnectionSecret("syncCode", "showSyncCodeBtn");
$("copyAppPasswordBtn").onclick = async () => {
  const password = $("appPassword").value;
  if (!password) {
    $("passwordHelp").textContent = "No password is saved in this field.";
    return;
  }
  try {
    await navigator.clipboard.writeText(password);
    $("passwordHelp").textContent = "Password copied. Paste it into your password manager, then clear your clipboard when finished.";
  } catch {
    $("passwordHelp").textContent = "Clipboard access was blocked. Tap Show, then select the text to copy it manually.";
  }
};
$("settingsDialog").addEventListener("close", () => {
  hideConnectionSecrets();
  $("passwordHelp").textContent = "Reveal it only when you are ready to save it securely.";
});
document.addEventListener("visibilitychange", () => { if (document.hidden) hideConnectionSecrets(); });

$("settingsBtn").onclick = () => { hideConnectionSecrets(); loadSettingsForm(); $("settingsDialog").showModal(); };
$("libraryBtn").onclick = () => { renderLibrary(); $("libraryDialog").showModal(); };
$("editScenarioBtn").onclick = () => { loadScenarioForm(); $("scenarioDialog").showModal(); };
$("spiceQuick").addEventListener("input", () => updateSpiceOutput("spiceQuick", "spiceQuickValue"));
$("spiceQuick").addEventListener("change", () => {
  state.scenario.spiceBalance = normalizeSpiceBalance($("spiceQuick").value);
  updateSpiceOutput("spiceQuick", "spiceQuickValue");
  save();
});
$("spiceScenario").addEventListener("input", () => updateSpiceOutput("spiceScenario", "spiceScenarioValue"));
$("sendBtn").onclick = () => { if (!turnInFlight) send(); };
$("retryBtn").onclick = () => { if (!turnInFlight) retry(false); };
$("hijackBtn").onclick = () => { if (!turnInFlight) retry(true); };
$("continuityBtn").onclick = () => { if (!turnInFlight) openContinuityRepair(); };
$("memoryBtn").onclick = () => { if (!turnInFlight) refreshMemory(); };
$("repairAgencyBtn").onclick = repairBlockedReply;
$("editBlockedBtn").onclick = () => {
  const preview = $("blockedReply");
  if (preview.contentEditable !== "true") {
    preview.contentEditable = "true";
    preview.focus();
    $("editBlockedBtn").textContent = "Use edited reply · free";
    return;
  }
  const edited = preview.textContent.trim();
  if (!edited) return alert("The edited reply is empty.");
  if (acceptOrBlock(edited, true)) $("agencyDialog").close();
};
$("showBlockedBtn").onclick = () => {
  if (pendingViolation) acceptReply(pendingViolation);
  pendingViolation = null;
  $("agencyDialog").close();
};
$("discardBlockedBtn").onclick = () => {
  const note = $("agencyNote").value.trim();
  if (note) { rememberGuardLesson(note); save(); }
  pendingViolation = null;
  pendingViolationDetail = null;
  $("agencyDialog").close();
  render();
};
$("closeAgencyBtn").onclick = () => { $("agencyDialog").close(); };
$("repairContinuityBtn").onclick = repairContinuity;
$("closeContinuityBtn").onclick = () => $("continuityDialog").close();
$("cancelContinuityBtn").onclick = () => $("continuityDialog").close();
$("newStoryBtn").onclick = () => createStory(false);
$("duplicateStoryBtn").onclick = () => createStory(true);
$("exportBtn").onclick = exportBackup;
$("exportPreConnectBtn").onclick = () => {
  const backup = readPreConnectRecovery();
  if (!backup) return alert("No pre-connect recovery copy is stored on this device.");
  downloadBackupFile(`RP-Studio-pre-connect-recovery-${String(backup.savedAt || "").slice(0, 10) || new Date().toISOString().slice(0, 10)}.json`, backup.library);
};
$("importBlueprintBtn").onclick = () => { if (!turnInFlight) $("importBlueprintFile").click(); };
$("importBlueprintFile").onchange = (event) => importStoryBlueprint(event.target.files[0]);
$("importBlockBtn").onclick = () => { if (!turnInFlight) $("importBlockFile").click(); };
$("importBlockFile").onchange = (event) => importStoryBlock(event.target.files[0]);
$("importBtn").onclick = () => $("importFile").click();
$("importFile").onchange = (event) => importBackup(event.target.files[0]);
$("createSyncBtn").onclick = () => createCloudSync().catch(error => setSyncStatus(error.message, "error"));
$("connectSyncBtn").onclick = () => connectCloudSync().catch(error => setSyncStatus(error.message, "error"));
$("copySyncBtn").onclick = async () => {
  const code = normalizeSyncCode($("syncCode").value || cloudSync.code);
  if (!code) return setSyncStatus("Create or paste a sync code first.", "error");
  try {
    await navigator.clipboard.writeText(code);
    setSyncStatus("Sync code copied. Paste it into RP Studio on your other device.", "success");
  } catch {
    $("syncCode").focus();
    $("syncCode").select();
    setSyncStatus("The code is selected—use Copy from the browser menu.", "working");
  }
};
$("syncNowBtn").onclick = () => syncNow().catch(error => setSyncStatus(error.message, "error"));
$("autoSync").onchange = () => {
  cloudSync.autoSync = $("autoSync").checked;
  persistCloudSync();
  if (cloudSync.autoSync) scheduleCloudPush();
};
$("disconnectSyncBtn").onclick = () => {
  if (!cloudSync.enabled) return;
  if (!confirm("Disconnect cloud sync on this device? Your local stories and encrypted cloud copy will remain intact.")) return;
  clearTimeout(syncRuntime.timer);
  cloudSync = { enabled: false, code: "", revision: 0, lastSyncedAt: "", autoSync: true };
  syncRuntime.ready = false;
  persistCloudSync();
  $("syncCode").value = "";
  $("autoSync").checked = true;
  setSyncStatus("This device is disconnected. Local stories were not changed.");
};
$("saveProfileBtn").onclick = () => {
  const name = $("profileName").value.trim();
  const notes = $("profileNotes").value.trim();
  if (!name) return alert("Give the character profile a name first.");
  if (editingProfileId) {
    const target = storyLibrary.profiles.find(p => p.id === editingProfileId);
    if (target) { target.name = name; target.notes = notes; }
    editingProfileId = null;
    $("saveProfileBtn").textContent = "Save new profile";
  } else {
    storyLibrary.profiles.push({ id: makeId(), name, notes });
  }
  $("profileName").value = ""; $("profileNotes").value = "";
  save(); renderLibrary();
};
$("playerProfile").onchange = (event) => {
  const profile = storyLibrary.profiles.find(p => p.id === event.target.value);
  if (profile) { $("playerName").value = profile.name; $("playerNotes").value = profile.notes; }
};
$("input").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    if (!turnInFlight) send();
  }
});

$("saveSettingsBtn").onclick = (e) => {
  e.preventDefault();
  saveConnectionFromForm();
  save();
  $("settingsDialog").close();
};

$("saveScenarioBtn").onclick = (e) => {
  e.preventDefault();
  state.scenario = {
    title: $("scenarioTitle").value.trim() || "Untitled Story",
    spiceBalance: normalizeSpiceBalance($("spiceScenario").value),
    playerName: $("playerName").value.trim() || "Player",
    playerNotes: $("playerNotes").value.trim(),
    npcNotes: $("npcNotes").value.trim(),
    premise: $("premise").value.trim(),
    styleNotes: $("styleNotes").value.trim(),
    boundaryNotes: $("boundaryNotes").value.trim()
  };
  save();
  $("scenarioDialog").close();
  render();
};

$("clearBtn").onclick = () => {
  if (!confirm("Start a new session? This clears the current conversation and memory, but keeps your story setup and learned guardrails. The cleared transcript is kept in Trash in case you want it back.")) return;
  if (state.messages.length || state.memory.summary) {
    storyLibrary.trash.sessions.push({
      trashId: makeId(),
      storyId: storyLibrary.activeId,
      title: state.scenario.title || "Untitled Story",
      messages: state.messages.map(message => ({ ...message })),
      memory: { ...state.memory },
      clearedAt: new Date().toISOString()
    });
  }
  state.messages = [];
  state.memory = { ...defaults.memory };
  save();
  render();
};

$("recoveryExportBtn").onclick = exportBackup;
$("recoveryDismissBtn").onclick = () => { $("recoveryBanner").hidden = true; };
$("storageExportBtn").onclick = exportBackup;
$("storageDismissBtn").onclick = () => { $("storageBanner").hidden = true; };

render();
loadSettingsForm();
if (bootCorrupt.keys.length) showRecoveryBanner();
initializeCloudSync();
