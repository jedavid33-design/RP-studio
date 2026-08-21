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

function save() {
  localStorage.setItem("rp.settings", JSON.stringify(state.settings));
  storyLibrary.stories[storyLibrary.activeId] = {
    scenario: state.scenario,
    messages: state.messages,
    memory: state.memory,
    updatedAt: new Date().toISOString()
  };
  localStorage.setItem("rp.stories", JSON.stringify(storyLibrary));
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
  const trailingMeta = cleaned.search(/\n\s*\n(?:we must (?:ensure|check|avoid)|self-check:|analysis:)/i);
  if (trailingMeta >= 0) cleaned = cleaned.slice(0, trailingMeta).trim();
  return cleaned;
}

function hasAgencyViolation(reply) {
  // NPC dialogue may address the player freely. Inspect narration only.
  const narrationOnly = String(reply || "")
    .replace(/“[^”]*”/gs, " ")
    .replace(/"[^"\n]*"/g, " ");
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
  const playerVerbs = "(?:is|was|remains?|remained|becomes?|became|steps?|stepped|moves?|moved|walks?|walked|follows?|followed|nods?|nodded|shakes?|shook|looks?|looked|glances?|glanced|watches?|watched|sees?|saw|hears?|heard|notices?|noticed|feels?|felt|thinks?|thought|wonders?|wondered|realizes?|realized|knows?|knew|wants?|wanted|needs?|needed|decides?|decided|chooses?|chose|reaches?|reached|takes?|took|accepts?|accepted|allows?|allowed|lets?|let|leans?|leaned|turns?|turned|pauses?|paused|hesitates?|hesitated|freezes?|froze|smiles?|smiled|frowns?|frowned|laughs?|laughed|breathes?|breathed|sighs?|sighed|gasps?|gasped|replies?|replied|says?|said|asks?|asked|answers?|answered|murmurs?|murmured|whispers?|whispered|speaks?|spoke|opens?|opened|closes?|closed|enters?|entered|leaves?|left|sits?|sat|stands?|stood|waits?|waited|listens?|listened|approaches?|approached|retreats?|retreated|recoils?|recoiled|reacts?|reacted|responds?|responded|stiffens?|stiffened|relaxes?|relaxed|shivers?|shivered|trembles?|trembled|swallows?|swallowed|blushes?|blushed|focuses?|focused|studies?|studied|considers?|considered|finds?|found|drifts?|drifted)";
  const playerAsSubject = new RegExp(`\\b${playerRef}\\b(?:\\s*,[^.!?]{0,45},)?\\s+(?:\\w+ly\\s+)?${playerVerbs}\\b`, "i");
  if (playerAsSubject.test(narrationOnly)) return true;

  // Internal state or involuntary body language assigned through a possessive.
  const controlledPossessive = "(?:eyes?|gaze|hands?|fingers?|breath|heart|pulse|stomach|body|mind|thoughts?|attention|expression|face|voice|grip|feet|knees?|shoulders?|posture|muscles?|skin|cheeks?|lips?|head)";
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
  const messages = [{ role: "system", content: systemPrompt() }];
  if (state.memory.summary) {
    messages.push({
      role: "system",
      content: `CONTINUITY MEMORY — established canon from earlier turns. Use it for continuity but do not invent details beyond it. Player-controlled facts remain facts only; never narrate new actions or reactions for the player.\n\n${state.memory.summary}`
    });
  }

  recent.forEach(message => messages.push(message));
  messages.push({
    role: "system",
    content: `NEXT NPC TURN: Continue after the user's completed move. Keep the narrative camera on named NPCs and objective environment. End when ${state.scenario.playerName} must respond.`
  });
  if (extraInstruction) {
    messages.push({
      role: "system",
      content: extraInstruction
    });
  }
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

function loadSettingsForm() {
  Object.entries(state.settings).forEach(([k,v]) => {
    const el = $(k);
    if (el) el.value = v;
  });
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
  state.settings = {
    workerUrl: $("workerUrl").value.trim(),
    appPassword: $("appPassword").value,
    model: $("model").value.trim() || "openrouter/free",
    temperature: Number($("temperature").value || 0.9),
    maxTokens: Number($("maxTokens").value || 900)
  };
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
