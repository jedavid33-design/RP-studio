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
const makeStory = (scenario = defaults.scenario, messages = [], memory = defaults.memory) => ({
  scenario: { ...defaults.scenario, ...scenario },
  messages: Array.isArray(messages) ? messages : [],
  memory: { ...defaults.memory, ...memory },
  updatedAt: new Date().toISOString()
});

let storyLibrary;
try { storyLibrary = JSON.parse(localStorage.getItem("rp.stories") || "null"); } catch { storyLibrary = null; }
if (!storyLibrary || !storyLibrary.stories || !Object.keys(storyLibrary.stories).length) {
  const migratedId = makeId();
  storyLibrary = {
    version: 1,
    activeId: migratedId,
    stories: {
      [migratedId]: makeStory(
        JSON.parse(localStorage.getItem("rp.scenario") || "{}"),
        JSON.parse(localStorage.getItem("rp.messages") || "[]"),
        JSON.parse(localStorage.getItem("rp.memory") || "{}")
      )
    },
    profiles: []
  };
}
storyLibrary.profiles = Array.isArray(storyLibrary.profiles) ? storyLibrary.profiles : [];
if (!storyLibrary.stories[storyLibrary.activeId]) storyLibrary.activeId = Object.keys(storyLibrary.stories)[0];

let state = {
  settings: { ...defaults.settings, ...(JSON.parse(localStorage.getItem("rp.settings") || "{}")) },
  ...storyLibrary.stories[storyLibrary.activeId]
};
let pendingViolation = null;
const SYNC_STORAGE_KEY = "rp.cloudSync.v1";
let cloudSync;
try { cloudSync = JSON.parse(localStorage.getItem(SYNC_STORAGE_KEY) || "null"); } catch { cloudSync = null; }
cloudSync = {
  enabled: false,
  code: "",
  revision: 0,
  lastSyncedAt: "",
  autoSync: true,
  ...(cloudSync || {})
};
const syncRuntime = { ready: false, busy: false, timer: null };
storyLibrary.updatedAt = storyLibrary.updatedAt || Object.values(storyLibrary.stories)
  .map(story => story.updatedAt || "")
  .sort()
  .at(-1) || new Date().toISOString();

function save(options = {}) {
  localStorage.setItem("rp.settings", JSON.stringify(state.settings));
  const now = new Date().toISOString();
  storyLibrary.stories[storyLibrary.activeId] = {
    scenario: state.scenario,
    messages: state.messages,
    memory: state.memory,
    updatedAt: now
  };
  storyLibrary.updatedAt = now;
  localStorage.setItem("rp.stories", JSON.stringify(storyLibrary));
  if (!options.skipSync) scheduleCloudPush();
}

function activateStory(id) {
  if (!storyLibrary.stories[id]) return;
  save();
  storyLibrary.activeId = id;
  const story = storyLibrary.stories[id];
  state = { settings: state.settings, scenario: { ...story.scenario }, messages: [...story.messages], memory: { ...story.memory } };
  save();
  render();
}

function systemPrompt() {
  const s = state.scenario;
  return `ROLE CONTRACT
This is turn-based interactive fiction with a strict division of control.
- USER role: ${s.playerName}. The user's latest message is completed, immutable canon.
- ASSISTANT role: every NPC plus the objective environment.

NPC CAMERA
Continue only with NPC dialogue, NPC behavior, NPC thoughts, and objective events after the user's completed turn. The narrative camera may observe what NPCs do around ${s.playerName}, but it never supplies the player character's next action, words, thought, feeling, sensation, expression, perception, or decision. An NPC may address or approach the player in dialogue/action. Stop before the player's response is determined.

PLAYER POV FIREWALL
The user's prose may use first person, second person, or third person. Never mirror the user's player-character POV. In assistant narration, never use "you" or "your" and never use ${s.playerName} (or a pronoun referring to ${s.playerName}) as the subject of a new action, movement, posture, expression, sensation, perception, recognition, thought, feeling, conclusion, or decision. Treat every player action and position in the latest user message as finished and frozen at the handoff: do not extend it, restage it, paraphrase it, or add body language. Start with an NPC or an objective environmental event and write around the player. "You" may appear only inside NPC dialogue addressed to the player.

TURN SHAPE
Advance one meaningful beat through NPC choices or an external event, then hand control back naturally. Do not present a menu of choices. Do not repeat the user's prose. Write polished story prose only—no analysis, labels, instructions, or format tags.

STORY PREMISE
${s.premise}

PLAYER REFERENCE — FACTS ONLY, NOT AN ASSISTANT ROLE
${s.playerName}: ${s.playerNotes}

NPC / CAST
${s.npcNotes}

WRITING STYLE
${s.styleNotes}

CONTENT BOUNDARIES
${s.boundaryNotes}`;
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

function narrationWithoutDialogue(reply) {
  // Preserve line breaks and character positions while removing quoted speech.
  // This tolerates straight, curly, multiline, and partially unmatched quotes.
  const input = String(reply || "");
  let output = "";
  let closingQuote = "";
  for (const char of input) {
    if (closingQuote) {
      if (char === closingQuote) closingQuote = "";
      output += char === "\n" ? "\n" : " ";
      continue;
    }
    if (char === "“" || char === "„") {
      closingQuote = "”";
      output += " ";
    } else if (char === "\"") {
      closingQuote = "\"";
      output += " ";
    } else {
      output += char;
    }
  }
  return output;
}

function hasAgencyViolation(reply) {
  // NPC dialogue may address, challenge, or speculate about the player freely.
  // Only narration and dialogue explicitly attributed to the player are tested.
  const narrationOnly = narrationWithoutDialogue(reply);
  if (/\b(?:you|your|yours|yourself|you're|you've|you'll|you'd)\b/i.test(narrationOnly)) return true;

  const rawNameParts = String(state.scenario.playerName || "")
    .split(/\s+/)
    .filter(part => part.length > 1);
  if (!rawNameParts.length) return false;
  const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fullName = escapeRegex(rawNameParts.join(" "));
  const nameParts = rawNameParts.map(escapeRegex);
  const playerRef = `(?:${[fullName, ...nameParts].join("|")})`;

  // Player named as the subject of an action, perception, decision, speech,
  // movement, or state. Harmless object references such as "behind Jace" pass.
  const playerVerbs = "(?:steps?|stepped|moves?|moved|walks?|walked|follows?|followed|nods?|nodded|shakes?|shook|looks?|looked|glances?|glanced|watches?|watched|sees?|saw|hears?|heard|notices?|noticed|recognizes?|recognized|understands?|understood|remembers?|remembered|suspects?|suspected|feels?|felt|thinks?|thought|wonders?|wondered|realizes?|realized|knows?|knew|wants?|wanted|needs?|needed|decides?|decided|chooses?|chose|reaches?|reached|takes?|took|accepts?|accepted|allows?|allowed|lets?|let|leans?|leaned|turns?|turned|pauses?|paused|hesitates?|hesitated|freezes?|froze|smiles?|smiled|frowns?|frowned|laughs?|laughed|breathes?|breathed|sighs?|sighed|gasps?|gasped|replies?|replied|says?|said|asks?|asked|answers?|answered|murmurs?|murmured|whispers?|whispered|speaks?|spoke|opens?|opened|closes?|closed|enters?|entered|leaves?|left|sits?|sat|stands?|stood|waits?|waited|listens?|listened|approaches?|approached|retreats?|retreated|recoils?|recoiled|reacts?|reacted|responds?|responded|stiffens?|stiffened|relaxes?|relaxed|shivers?|shivered|trembles?|trembled|swallows?|swallowed|blushes?|blushed|focuses?|focused|studies?|studied|considers?|considered|finds?|found|drifts?|drifted)";
  const playerAsSubject = new RegExp(`\\b${playerRef}\\b(?:\\s*,[^.!?]{0,45},)?\\s+(?:\\w+ly\\s+)?${playerVerbs}\\b`, "i");
  if (playerAsSubject.test(narrationOnly)) return true;

  // Copulas need a complement. This catches "Jace is frightened" or
  // "Jace was walking" without falsely flagging identity clauses such as
  // "He knows exactly who Jace is."
  const controlledState = "(?:afraid|angry|anxious|aware|breathless|calm|confused|curious|dizzy|eager|embarrassed|frightened|frozen|frustrated|glad|happy|hesitant|hurt|nervous|overwhelmed|ready|relieved|sad|scared|shocked|silent|still|stunned|surprised|tense|terrified|tired|uncertain|uneasy|uncomfortable|unwilling|willing|worried|\\w+ing)";
  const playerState = new RegExp(`\\b${playerRef}\\b(?:\\s*,[^.!?]{0,45},)?\\s+(?:is|was|becomes?|became|remains?|remained)\\s+(?:not\\s+)?${controlledState}\\b`, "i");
  if (playerState.test(narrationOnly)) return true;

  // Internal state or involuntary body language assigned through a possessive.
  const controlledPossessive = "(?:eyes?|gaze|hands?|fingers?|breath|heart|pulse|stomach|body|mind|thoughts?|attention|expression|face|voice|grip|feet|footsteps?|knees?|shoulders?|posture|muscles?|skin|cheeks?|lips?|head)";
  const playerBody = new RegExp(`\\b${playerRef}(?:'s|’s)\\s+${controlledPossessive}\\b`, "i");
  if (playerBody.test(narrationOnly)) return true;

  // NPC narration that completes physical control of the player rather than
  // merely initiating or offering an action.
  const forcedContact = "(?:grabs?|seizes?|pulls?|pushes?|drags?|guides?|leads?|moves?|lifts?|carries?|pins?|restrains?|touches?|kisses?|holds?)";
  const playerAsControlledObject = new RegExp(`\\b${forcedContact}\\s+(?:${playerRef}|${playerRef}(?:'s|’s)\\s+(?:arm|hand|wrist|waist|face|chin|body))\\b`, "i");
  return playerAsControlledObject.test(narrationOnly);
}

function cleanMemoryReply(raw) {
  const text = String(raw || "").trim();
  const tagged = [...text.matchAll(/<memory>([\s\S]*?)<\/memory>/gi)];
  return (tagged.length ? tagged[tagged.length - 1][1] : text).trim();
}

function render() {
  $("storyTitle").textContent = state.scenario.title;
  $("playerChip").textContent = `You: ${state.scenario.playerName}`;
  $("hijackBtn").textContent = `Hands off ${state.scenario.playerName}`;
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
    state.messages.forEach(m => appendVisual(m.role, m.role === "user" ? state.scenario.playerName : "AI", m.content));
  }
  const lastUser = state.messages.map(m => m.role).lastIndexOf("user");
  const lastAssistant = state.messages.map(m => m.role).lastIndexOf("assistant");
  $("retryBtn").disabled = lastUser < 0;
  $("hijackBtn").disabled = lastAssistant < lastUser;
  chat.scrollTop = chat.scrollHeight;
}

function renderLibrary() {
  const storyList = $("storyList");
  storyList.innerHTML = "";
  Object.entries(storyLibrary.stories)
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
      if (Object.keys(storyLibrary.stories).length > 1) {
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
    player.onclick = () => { state.scenario.playerName = profile.name; state.scenario.playerNotes = profile.notes; save(); render(); $("libraryDialog").close(); };
    const npc = document.createElement("button"); npc.type = "button"; npc.className = "secondary"; npc.textContent = "Add as NPC";
    npc.onclick = () => { state.scenario.npcNotes = [state.scenario.npcNotes, `${profile.name} — ${profile.notes}`].filter(Boolean).join("\n\n"); save(); $("libraryDialog").close(); };
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "warning"; remove.textContent = "Delete";
    remove.onclick = () => { if (confirm(`Delete the ${profile.name} profile?`)) { storyLibrary.profiles = storyLibrary.profiles.filter(p => p.id !== profile.id); save(); renderLibrary(); } };
    actions.append(player, npc, remove); card.append(main, actions); profileList.appendChild(card);
  });
}

function createStory(duplicate = false) {
  save();
  const id = makeId();
  if (duplicate) {
    const title = `${state.scenario.title} — Copy`;
    storyLibrary.stories[id] = makeStory({ ...state.scenario, title }, [], defaults.memory);
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
  const title = storyLibrary.stories[id]?.scenario?.title || "this story";
  if (!confirm(`Delete “${title}” and its entire transcript?`)) return;
  delete storyLibrary.stories[id];
  if (id === storyLibrary.activeId) storyLibrary.activeId = Object.keys(storyLibrary.stories)[0];
  const current = storyLibrary.stories[storyLibrary.activeId];
  state = { settings: state.settings, scenario: { ...current.scenario }, messages: [...current.messages], memory: { ...current.memory } };
  save(); render(); renderLibrary();
}

function isOpenRouterCreditError(message) {
  return /(?:insufficient\s+(?:credits?|balance)|out\s+of\s+credits?|credit\s+balance|payment\s+required|requires?\s+more\s+credits?|upgrade\s+to\s+a\s+paid\s+account)/i.test(String(message || ""));
}

function appendVisual(role, label, content) {
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
  const turnControl = `NEXT-TURN CONTROL\nContinue after the user's completed move. Begin with a named NPC or an objective environmental event. Do not narrate, extend, restage, or perceive through ${state.scenario.playerName}. End when ${state.scenario.playerName} must respond.`;
  const correction = extraInstruction ? `\n\nONE-TURN CORRECTION\n${extraInstruction}` : "";
  const messages = [{ role: "system", content: `${systemPrompt()}\n\n${turnControl}${correction}` }];
  if (state.memory.summary) {
    messages.push({
      role: "system",
      content: `CONTINUITY MEMORY — established canon from earlier turns. Use it for continuity but do not invent details beyond it. Player-controlled facts remain facts only; never narrate new actions or reactions for the player.\n\n${state.memory.summary}`
    });
  }

  recent.forEach(message => messages.push(message));
  return messages;
}

async function callAI(extraInstruction = "", options = {}) {
  return cleanStoryReply(await requestAI(buildTurnMessages(extraInstruction), options));
}

function showAgencyBlock(reply, repeat = false) {
  pendingViolation = reply;
  $("blockedReply").textContent = reply;
  $("agencyReason").textContent = repeat
    ? "The repaired reply still tried to narrate your character. It remains blocked and has not entered the story."
    : "The reply tried to narrate your character. It was blocked before entering the story or memory.";
  if (!$("agencyDialog").open) $("agencyDialog").showModal();
}

function acceptReply(reply) {
  state.messages.push({ role: "assistant", content: reply });
  save();
  render();
}

function acceptOrBlock(reply, repeat = false) {
  if (hasAgencyViolation(reply)) {
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

  const olderMessages = state.messages.slice(state.memory.through, cutoff);
  const transcript = olderMessages.map(m => `${m.role === "user" ? state.scenario.playerName : "NPC / Narrator"}:\n${m.content}`).join("\n\n");
  const memoryPrompt = `Create a compact continuity memory for an ongoing interactive-fiction role-play. Preserve only established canon needed to continue accurately: setting and current situation, chronology, NPC characterization and goals, relationship development, promises, discoveries, unresolved threads, boundaries, and player-authored facts. Clearly distinguish actions/dialogue the player established from NPC material. Never invent, embellish, moralize, or continue the scene. Use concise bullets and stay under 550 words. Return only one <memory>...</memory> block.\n\nEXISTING MEMORY:\n${state.memory.summary || "None yet."}\n\nNEW TRANSCRIPT TO ABSORB:\n${transcript}`;

  $("memoryBtn").disabled = true;
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
    $("memoryBtn").disabled = false;
    $("memoryBtn").textContent = "Refresh memory";
  }
}

async function send() {
  const text = $("input").value.trim();
  if (!text) return;

  state.messages.push({ role: "user", content: text });
  $("input").value = "";
  save();
  render();

  $("sendBtn").disabled = true;
  $("sendBtn").textContent = "Writing…";
  try {
    const reply = await callAI();
    acceptOrBlock(reply);
  } catch (err) {
    appendVisual("system", "Error", err.message);
  } finally {
    $("sendBtn").disabled = false;
    $("sendBtn").textContent = "Send ➜";
  }
}

async function retry(agencyCorrection = false) {
  const roles = state.messages.map(m => m.role);
  const assistantIdx = roles.lastIndexOf("assistant");
  const userIdx = roles.lastIndexOf("user");
  if (userIdx < 0) return;
  if (assistantIdx > userIdx) {
    state.messages.splice(assistantIdx, 1);
  }
  save();
  render();

  $("retryBtn").disabled = true;
  $("hijackBtn").disabled = true;
  const correction = agencyCorrection
    ? `REPAIR REQUEST: The rejected draft crossed the role boundary. Write a fresh NPC turn after the user's last completed move. Keep the camera entirely on named NPCs and objective environmental events. Stop before ${state.scenario.playerName}'s response. Do not echo the rejected prose.`
    : "";
  try {
    const reply = await callAI(correction, correction ? { temperature: Math.min(Number(state.settings.temperature), 0.6) } : {});
    acceptOrBlock(reply);
  } catch (err) {
    appendVisual("system", "Error", err.message);
  } finally {
    const finalRoles = state.messages.map(m => m.role);
    const finalUser = finalRoles.lastIndexOf("user");
    const finalAssistant = finalRoles.lastIndexOf("assistant");
    $("retryBtn").disabled = finalUser < 0;
    $("hijackBtn").disabled = finalAssistant < finalUser;
  }
}

async function repairBlockedReply() {
  if (!pendingViolation) return;
  $("repairAgencyBtn").disabled = true;
  $("repairAgencyBtn").textContent = "Repairing…";
  try {
    const reply = await callAI(
      `REPAIR REQUEST: A draft was blocked for crossing the role boundary. Write a new NPC turn after the user's latest completed move. Use named NPCs and objective environmental events only. Stop before ${state.scenario.playerName} acts, thinks, feels, notices, answers, or decides.`,
      { temperature: Math.min(Number(state.settings.temperature), 0.6) }
    );
    if (acceptOrBlock(reply, true)) $("agencyDialog").close();
  } catch (err) {
    $("agencyDialog").close();
    appendVisual("system", "Repair error", err.message);
    $("chat").scrollTop = $("chat").scrollHeight;
  } finally {
    $("repairAgencyBtn").disabled = false;
    $("repairAgencyBtn").textContent = "Repair · uses 1 request";
  }
}

function persistCloudSync() {
  localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify({
    enabled: Boolean(cloudSync.enabled),
    code: cloudSync.code || "",
    revision: Number(cloudSync.revision || 0),
    lastSyncedAt: cloudSync.lastSyncedAt || "",
    autoSync: cloudSync.autoSync !== false
  }));
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
  localStorage.setItem("rp.settings", JSON.stringify(state.settings));
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
  const incoming = payload.library;
  storyLibrary = {
    version: Number(incoming.version || 1),
    activeId: incoming.stories[incoming.activeId] ? incoming.activeId : Object.keys(incoming.stories)[0],
    stories: incoming.stories,
    profiles: Array.isArray(incoming.profiles) ? incoming.profiles : [],
    updatedAt: incoming.updatedAt || payload.savedAt || new Date().toISOString()
  };
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
    memory: { ...defaults.memory, ...(current.memory || {}) }
  };
  localStorage.setItem("rp.settings", JSON.stringify(state.settings));
  localStorage.setItem("rp.stories", JSON.stringify(storyLibrary));
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
  try {
    const material = await syncMaterial();
    const payload = cloudPayload();
    const ciphertext = await encryptCloudPayload(payload, material.key);
    const { data } = await cloudRequest("PUT", {
      baseRevision: Number(cloudSync.revision || 0),
      ciphertext
    });
    cloudSync.revision = Number(data.revision || cloudSync.revision + 1);
    cloudSync.lastSyncedAt = storyLibrary.updatedAt;
    persistCloudSync();
    setSyncStatus(`Synced securely · revision ${cloudSync.revision}`, "success");
  } catch (error) {
    if (error.status === 409) {
      setSyncStatus("Both devices have changes. Nothing was overwritten—tap Sync now to choose which copy to keep.", "error");
    } else {
      setSyncStatus(`Sync paused: ${error.message}`, "error");
    }
  } finally {
    syncRuntime.busy = false;
  }
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
  setSyncStatus("Downloading and decrypting…", "working");
  syncRuntime.busy = true;
  try {
    const remote = await fetchCloudCopy(code);
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
    setSyncStatus(`Connected and downloaded · revision ${cloudSync.revision}`, "success");
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
  const select = $("playerProfile");
  select.innerHTML = '<option value="">Choose a profile…</option>';
  storyLibrary.profiles.forEach(profile => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    select.appendChild(option);
  });
}

function exportBackup() {
  save();
  const payload = {
    app: "RP Studio",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    library: storyLibrary
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `RP-Studio-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importBackup(file) {
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const incoming = payload?.app === "RP Studio" ? payload.library : null;
    if (!incoming?.stories || !Object.keys(incoming.stories).length) throw new Error("That file is not a valid RP Studio backup.");
    if (!confirm("Import this backup? It will replace the stories and profiles currently saved in this browser. Your connection settings will stay unchanged.")) return;
    storyLibrary = {
      version: 1,
      activeId: incoming.stories[incoming.activeId] ? incoming.activeId : Object.keys(incoming.stories)[0],
      stories: incoming.stories,
      profiles: Array.isArray(incoming.profiles) ? incoming.profiles : []
    };
    const current = storyLibrary.stories[storyLibrary.activeId];
    state = {
      settings: state.settings,
      scenario: { ...defaults.scenario, ...(current.scenario || {}) },
      messages: Array.isArray(current.messages) ? current.messages : [],
      memory: { ...defaults.memory, ...(current.memory || {}) }
    };
    save(); render(); renderLibrary(); $("libraryDialog").close();
    alert("Backup imported successfully.");
  } catch (error) {
    alert(error.message || "The backup could not be imported.");
  } finally {
    $("importFile").value = "";
  }
}

$("settingsBtn").onclick = () => { loadSettingsForm(); $("settingsDialog").showModal(); };
$("libraryBtn").onclick = () => { renderLibrary(); $("libraryDialog").showModal(); };
$("editScenarioBtn").onclick = () => { loadScenarioForm(); $("scenarioDialog").showModal(); };
$("sendBtn").onclick = send;
$("retryBtn").onclick = () => retry(false);
$("hijackBtn").onclick = () => retry(true);
$("memoryBtn").onclick = refreshMemory;
$("repairAgencyBtn").onclick = repairBlockedReply;
$("showBlockedBtn").onclick = () => {
  if (pendingViolation) acceptReply(pendingViolation);
  pendingViolation = null;
  $("agencyDialog").close();
};
$("discardBlockedBtn").onclick = () => { pendingViolation = null; $("agencyDialog").close(); render(); };
$("closeAgencyBtn").onclick = () => { $("agencyDialog").close(); };
$("newStoryBtn").onclick = () => createStory(false);
$("duplicateStoryBtn").onclick = () => createStory(true);
$("exportBtn").onclick = exportBackup;
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
  storyLibrary.profiles.push({ id: makeId(), name, notes });
  $("profileName").value = ""; $("profileNotes").value = "";
  save(); renderLibrary();
};
$("playerProfile").onchange = (event) => {
  const profile = storyLibrary.profiles.find(p => p.id === event.target.value);
  if (profile) { $("playerName").value = profile.name; $("playerNotes").value = profile.notes; }
};
$("input").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
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
  if (confirm("Start a new session? This clears the current conversation but keeps your story setup.")) {
    state.messages = [];
    state.memory = { ...defaults.memory };
    save();
    render();
  }
};

render();
loadSettingsForm();
initializeCloudSync();
