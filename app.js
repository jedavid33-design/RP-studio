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

let state = {
  settings: { ...defaults.settings, ...(JSON.parse(localStorage.getItem("rp.settings") || "{}")) },
  scenario: { ...defaults.scenario, ...(JSON.parse(localStorage.getItem("rp.scenario") || "{}")) },
  messages: JSON.parse(localStorage.getItem("rp.messages") || "[]"),
  memory: { ...defaults.memory, ...(JSON.parse(localStorage.getItem("rp.memory") || "{}")) }
};

function save() {
  localStorage.setItem("rp.settings", JSON.stringify(state.settings));
  localStorage.setItem("rp.scenario", JSON.stringify(state.scenario));
  localStorage.setItem("rp.messages", JSON.stringify(state.messages));
  localStorage.setItem("rp.memory", JSON.stringify(state.memory));
}

function systemPrompt() {
  const s = state.scenario;
  return `You are the GM, narrator, and all NPCs in a contained interactive fiction role-play.

STORY PREMISE
${s.premise}

PLAYER CHARACTER — EXCLUSIVELY USER CONTROLLED
Name: ${s.playerName}
Notes: ${s.playerNotes}

NPC / CAST NOTES
${s.npcNotes}

STYLE
${s.styleNotes}

BOUNDARIES / EXTRA RULES
${s.boundaryNotes}

ABSOLUTE PLAYER-AGENCY RULE
The user has exclusive control of ${s.playerName}. NEVER write, invent, imply, or decide ${s.playerName}'s dialogue, actions, gestures, facial expressions, thoughts, emotions, perceptions, intentions, choices, or physical reactions. Do not move ${s.playerName} through the scene. Do not finish ${s.playerName}'s sentences. Do not describe what ${s.playerName} "realizes," "feels," "notices," "wants," or "does." You may only refer to facts about ${s.playerName} that the user already established in their latest or prior messages.

This prohibition includes seemingly harmless connective prose. Never write constructions such as "she looks," "she follows," "she lets," "she leans," "her breath catches," "her body responds," or "they kiss" unless that exact player action was already established by the user. An NPC may initiate an action toward ${s.playerName}, but the prose must stop before deciding whether it lands, is welcomed, or produces any response.

Do not paraphrase, embellish, reinterpret, summarize, or narrate back the player's submitted dialogue or actions. Treat the user's latest message as completed canon and begin AFTER it. Outside NPC dialogue, avoid second-person narration entirely: do not write "you," "your," "you're," or sensory phrases such as "you see," "you hear," "you feel," "you notice," or "you catch." Describe only NPC behavior and objective environmental events. Never assign tone, volume, body language, sensation, attraction, familiarity, knowledge, or emotion to ${s.playerName}.

You control every NPC and the environment. Write NPC dialogue, actions, thoughts, and observations freely. You may narrate environmental events that happen around the player. Advance the plot through NPC choices, discoveries, interruptions, external events, and consequences — never by taking control of the player character.

Every response MUST end at a natural handoff point where ${s.playerName} can decide what to say/do next. If the scene cannot continue without deciding ${s.playerName}'s action, STOP instead of deciding it.

OUTPUT FORMAT — REQUIRED
Think and check the agency rules silently. Return only finished story prose enclosed in exactly one <story>...</story> block. Put no analysis, planning, self-check, preface, or commentary before or after the block. The text inside <story> must be ready to show the player directly.

Do not add meta commentary, choices, or OOC notes unless the user asks.`;
}

function cleanStoryReply(raw) {
  const text = String(raw || "").trim();
  const tagged = [...text.matchAll(/<story>([\s\S]*?)<\/story>/gi)];
  if (tagged.length) return tagged[tagged.length - 1][1].trim();

  // Conservative fallback for models that ignore the required tags but print
  // their planning around a clearly marked final draft.
  const draftMarker = text.toLowerCase().lastIndexOf("let's write:");
  let cleaned = draftMarker >= 0 ? text.slice(draftMarker + "let's write:".length).trim() : text;
  const trailingMeta = cleaned.search(/\n\s*\n(?:we must (?:ensure|check|avoid)|self-check:|analysis:)/i);
  if (trailingMeta >= 0) cleaned = cleaned.slice(0, trailingMeta).trim();
  return cleaned;
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
  $("memoryStatus").textContent = state.memory.summary
    ? `Memory covers ${state.memory.through} messages`
    : "Full transcript in context";
  const chat = $("chat");
  chat.innerHTML = "";

  if (!state.messages.length) {
    appendVisual("system", "Ready", `Story loaded. You control ${state.scenario.playerName}; the AI controls everyone else.\n\nWrite your opening move below.`);
  } else {
    state.messages.forEach(m => appendVisual(m.role, m.role === "user" ? state.scenario.playerName : "AI", m.content));
  }
  $("retryBtn").disabled = !state.messages.some(m => m.role === "assistant");
  $("hijackBtn").disabled = !state.messages.some(m => m.role === "assistant");
  chat.scrollTop = chat.scrollHeight;
}

function appendVisual(role, label, content) {
  const node = $("messageTemplate").content.firstElementChild.cloneNode(true);
  node.classList.add(role === "assistant" ? "assistant" : role);
  node.querySelector(".msg-meta").textContent = label;
  node.querySelector(".msg-body").textContent = content;
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

async function callAI() {
  const recent = state.messages.slice(Math.min(state.memory.through, state.messages.length));
  const messages = [{ role: "system", content: systemPrompt() }];
  if (state.memory.summary) {
    messages.push({
      role: "system",
      content: `CONTINUITY MEMORY — established canon from earlier turns. Use it for continuity but do not invent details beyond it. Player-controlled facts remain facts only; never narrate new actions or reactions for the player.\n\n${state.memory.summary}`
    });
  }

  const latestUser = [...recent].map(m => m.role).lastIndexOf("user");
  recent.forEach((message, index) => {
    if (index === latestUser) {
      messages.push({
        role: "system",
        content: `Immediate agency reminder: ${state.scenario.playerName} belongs exclusively to the user. Treat the next user message as completed canon, begin after it, and write only NPCs plus objective environment.`
      });
    }
    messages.push(message);
  });
  messages.push({
    role: "system",
    content: `FINAL TURN RULE — apply this to the response you are about to write: narrate only NPC choices/actions/dialogue and objective environment. Do not supply even one new action, sensation, expression, thought, emotion, or reaction for ${state.scenario.playerName}; do not paraphrase the user's move. End before ${state.scenario.playerName}'s next decision or response. Silently remove any sentence that violates this, then output only <story> prose.`
  });
  return cleanStoryReply(await requestAI(messages));
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
    appendVisual("system", "Memory refreshed", `Older context compressed. Magnum will now reread the continuity memory plus the latest four exchanges instead of the entire transcript.`);
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
    state.messages.push({ role: "assistant", content: reply });
    save();
    render();
  } catch (err) {
    appendVisual("system", "Error", err.message);
  } finally {
    $("sendBtn").disabled = false;
    $("sendBtn").textContent = "Send ➜";
  }
}

async function retry(agencyCorrection = false) {
  const idx = [...state.messages].map(m => m.role).lastIndexOf("assistant");
  if (idx < 0) return;
  const rejectedReply = state.messages[idx].content;
  state.messages.splice(idx, 1);
  save();
  render();

  $("retryBtn").disabled = true;
  $("hijackBtn").disabled = true;
  const correction = agencyCorrection ? {
    role: "system",
    content: `The rejected reply below violated player agency by narrating, paraphrasing, or assigning perceptions/reactions to ${state.scenario.playerName}. Rewrite the scene from scratch. Preserve the user's message as completed canon, begin after it, and write only NPC actions/dialogue plus objective environmental events. Do not use second-person narration outside quoted NPC dialogue. Do not repeat any player-controlled material. Think silently, then return ONLY the corrected story inside one <story>...</story> block with nothing before or after it.\n\nREJECTED REPLY:\n${rejectedReply}`
  } : null;
  try {
    let reply;
    if (correction) {
      state.messages.push(correction);
      reply = await callAI();
      state.messages.pop();
    } else {
      reply = await callAI();
    }
    state.messages.push({ role: "assistant", content: reply });
    save();
    render();
  } catch (err) {
    if (correction && state.messages.at(-1) === correction) state.messages.pop();
    appendVisual("system", "Error", err.message);
  } finally {
    $("retryBtn").disabled = false;
    $("hijackBtn").disabled = false;
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
}

$("settingsBtn").onclick = () => { loadSettingsForm(); $("settingsDialog").showModal(); };
$("editScenarioBtn").onclick = () => { loadScenarioForm(); $("scenarioDialog").showModal(); };
$("sendBtn").onclick = send;
$("retryBtn").onclick = () => retry(false);
$("hijackBtn").onclick = () => retry(true);
$("memoryBtn").onclick = refreshMemory;
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
